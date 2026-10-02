import 'server-only';

// Fake mode's persistence of the in-memory fakes in `fake.state` (PLAN §4, D-29). The container wires it.
export { DEFAULT_FAKE_STATE_DEBOUNCE_MS, fakeStateKey, restoreFakeState, startFakeStatePersistence } from './persistence';
export type { FakeStatePersistence, FakeStatePersistenceOptions, FlushScheduler, SnapshotSource } from './persistence';
