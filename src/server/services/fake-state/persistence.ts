import 'server-only';
import { AsyncResource } from 'node:async_hooks';
import type { Db } from '@/server/db';
import { log } from '@/server/obs/log';

// Fake mode's memory across restarts (PLAN §4, §5 `fake.state`, D-29, D-53): the fake HubSpot portal
// and the fake Razorpay subscriptions keep their whole state in memory, as plain JSON. The container
// restores each snapshot from `fake.state` at boot and saves it again after every change, so a dev
// restart keeps the OAuth tokens stored (encrypted) in `hubspot_connections` valid at the fake, and
// the subscriptions billing refers to. Nothing here runs at import time.
//
// Writes are debounced (a burst of fake calls becomes one write per snapshot), serialised (one flush
// at a time, in order), skipped when the snapshot did not change, and go through the Db like every
// other statement. close() flushes what is pending. Tests and the simulation build the fakes without
// persistence.

/** A fake whose whole state is plain JSON: FakeHubSpot, FakeBilling. */
export interface SnapshotSource {
  snapshot(): unknown;
  /** Validates and adopts a stored snapshot; throws when it does not parse. */
  restore(state: unknown): void;
}

/** Schedules `run` after `ms`; returns the cancel. Injected by tests; default a non-blocking timer. */
export type FlushScheduler = (run: () => void, ms: number) => () => void;

export interface FakeStatePersistenceOptions<N extends string> {
  db: Db;
  /** The fakes to persist, by name. Each is stored under `fake.state` key `{name}_snapshot`. */
  sources: Readonly<Record<N, SnapshotSource>>;
  /** Quiet time after the last change before the write; default 200 ms. */
  debounceMs?: number | undefined;
  schedule?: FlushScheduler | undefined;
}

export interface FakeStatePersistence<N extends string> {
  /** Records that `name`'s state may have changed; a write follows after the debounce. */
  markChanged(name: N): void;
  /** Writes every changed snapshot now (after any write in flight). Never rejects. */
  flush(): Promise<void>;
  /** Cancels the pending debounce, flushes, and ignores later changes. */
  close(): Promise<void>;
}

export const DEFAULT_FAKE_STATE_DEBOUNCE_MS = 200;

/** The `fake.state` key holding `name`'s snapshot. */
export function fakeStateKey(name: string): string {
  return `${name}_snapshot`;
}

const defaultSchedule: FlushScheduler = (run, ms) => {
  const handle = setTimeout(run, ms);
  // A pending write never keeps the process alive; close() flushes it.
  handle.unref();
  return () => clearTimeout(handle);
};

const UPSERT = `insert into fake.state (key, value) values ($1, $2::jsonb)
                on conflict (key) do update set value = excluded.value`;

class Persistence<N extends string> implements FakeStatePersistence<N> {
  readonly #db: Db;
  readonly #sources: Readonly<Record<N, SnapshotSource>>;
  readonly #debounceMs: number;
  readonly #schedule: FlushScheduler;
  /** The JSON last written (or found at boot) per source: an unchanged snapshot is not written again. */
  readonly #written = new Map<N, string>();
  readonly #dirty = new Set<N>();
  /** Runs the debounced flush in the boot-time async context, never inside a caller's transaction scope. */
  readonly #flushFromTimer: () => void;
  #cancelTimer: (() => void) | null = null;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: FakeStatePersistenceOptions<N>, written: ReadonlyMap<N, string>) {
    this.#db = options.db;
    this.#sources = options.sources;
    this.#debounceMs = options.debounceMs ?? DEFAULT_FAKE_STATE_DEBOUNCE_MS;
    this.#schedule = options.schedule ?? defaultSchedule;
    for (const [name, json] of written) this.#written.set(name, json);
    this.#flushFromTimer = AsyncResource.bind(() => {
      this.#cancelTimer = null;
      void this.flush();
    });
  }

  markChanged(name: N): void {
    if (this.#closed) return;
    this.#dirty.add(name);
    this.#cancelTimer ??= this.#schedule(this.#flushFromTimer, this.#debounceMs);
  }

  flush(): Promise<void> {
    const run = this.#tail
      .then(() => this.#writeDirty())
      .catch((error: unknown) => {
        log.warn('fake state flush failed', { event: 'fake_state.flush_failed' }, error);
      });
    this.#tail = run;
    return run;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    await this.flush();
  }

  async #writeDirty(): Promise<void> {
    const names = [...this.#dirty];
    this.#dirty.clear();
    for (const name of names) {
      let json: string;
      try {
        json = JSON.stringify(this.#sources[name].snapshot());
      } catch (error) {
        log.warn('fake state snapshot failed', { event: 'fake_state.snapshot_failed', kind: name }, error);
        continue;
      }
      if (json === this.#written.get(name)) continue;
      try {
        await this.#db.query(UPSERT, [fakeStateKey(name), json]);
        this.#written.set(name, json);
      } catch (error) {
        // Kept dirty: the next change or flush (close() at the latest) tries again.
        this.#dirty.add(name);
        log.warn('fake state write failed', { event: 'fake_state.write_failed', kind: name }, error);
      }
    }
  }
}

/**
 * Restores each source from its stored snapshot. A snapshot that no longer parses (e.g. the fake's
 * format changed) is ignored with a warning: the source keeps its fixture state, and its next change
 * overwrites the stored one. Returns the JSON each source now holds (restored or fixture), for change
 * detection: a source that never changes is never written.
 */
export async function restoreFakeState<N extends string>(db: Db, sources: Readonly<Record<N, SnapshotSource>>): Promise<Map<N, string>> {
  const names = Object.keys(sources) as N[];
  const rows = await db.query<{ key: string; value: unknown }>('select key, value from fake.state where key = any($1::text[])', [
    names.map(fakeStateKey),
  ]);
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const written = new Map<N, string>();
  for (const name of names) {
    const key = fakeStateKey(name);
    const source = sources[name];
    if (stored.has(key)) {
      try {
        source.restore(stored.get(key));
        log.info('fake state restored', { event: 'fake_state.restored', kind: name });
      } catch (error) {
        log.warn('fake state snapshot ignored', { event: 'fake_state.restore_failed', kind: name }, error);
      }
    }
    written.set(name, JSON.stringify(source.snapshot()));
  }
  return written;
}

/** Restores every source (see restoreFakeState), then saves each change from now on. */
export async function startFakeStatePersistence<N extends string>(options: FakeStatePersistenceOptions<N>): Promise<FakeStatePersistence<N>> {
  const written = await restoreFakeState(options.db, options.sources);
  return new Persistence(options, written);
}
