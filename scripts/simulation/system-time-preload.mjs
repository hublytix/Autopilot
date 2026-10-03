// Fakes this process's wall clock for the simulation's repeat run (PLAN §13 "The run is repeated with
// the system time set to 2030", §18; D-39). `npm run simulate` starts each repeat scenario as
// `node --import <this file> …` with SIMULATE_SYSTEM_TIME set to a year (`2030` means
// 2030-01-01T00:00:00Z) or an ISO instant. Without that variable this file does nothing.
//
// From the moment it loads, `Date.now()`, `new Date()`, `Date()` and `performance.timeOrigin` report
// a clock that started at that instant and advances with the process's monotonic clock, so the whole
// process sees the shifted time: Luxon's default "now", any app code that read the wall clock (lint
// forbids it; this run would expose it) and PGlite, whose Postgres `now()` comes from `Date.now()`
// through Emscripten (the audit-only `default now()` columns included). Dates built from a value
// (`new Date(ms)`, `Date.parse`, `Date.UTC`) are untouched; `instanceof Date` (also for dates Node
// itself creates) and subclasses keep working, because the replacement shares Date's prototype.
//
// It never reads the real wall clock: only the monotonic clock, for the elapsed time. That is why it
// is, with SystemClock, the only file exempt from the wall-clock lint rule (eslint.config.mjs).
// `globalThis[Symbol.for('autopilot.simulatedSystemTime')]` holds the start instant (ISO) once it is
// installed; scripts/simulate.ts refuses a repeat run without it.

const MARKER = Symbol.for('autopilot.simulatedSystemTime');

function parseStart(raw) {
  const start = Date.parse(/^\d{4}$/.test(raw) ? `${raw}-01-01T00:00:00.000Z` : raw);
  if (!Number.isFinite(start)) throw new Error(`SIMULATE_SYSTEM_TIME must be a year or an ISO instant, got ${JSON.stringify(raw)}`);
  return start;
}

function install(start) {
  const RealDate = globalThis.Date;
  const startedAt = process.hrtime.bigint();
  const now = () => start + Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  function SimulatedDate(...args) {
    // `Date()` called without `new` returns the current time as a string.
    if (new.target === undefined) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  }
  Object.setPrototypeOf(SimulatedDate, RealDate); // Date.parse, Date.UTC
  SimulatedDate.prototype = RealDate.prototype;
  SimulatedDate.now = now;
  globalThis.Date = SimulatedDate;

  // performance.now() stays relative; its origin moves so that origin + now() is the simulated time.
  const origin = start - performance.now();
  Object.defineProperty(globalThis.performance, 'timeOrigin', { value: origin, configurable: true, enumerable: true });

  globalThis[MARKER] = new RealDate(start).toISOString();
}

const raw = process.env.SIMULATE_SYSTEM_TIME?.trim();
if (raw !== undefined && raw !== '') install(parseStart(raw));
