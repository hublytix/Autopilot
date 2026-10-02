import 'server-only';

export { DEDUPE_WINDOW_MS, DEFAULT_MAX_DELAY_SECONDS, DEFAULT_MAX_DELIVERIES_PER_RUN, FakeScheduler } from './fake-scheduler';
export type {
  FakeDelivery,
  FakeDeliveryEffect,
  FakeDeliveryMatch,
  FakeDispatch,
  FakeDispatchResult,
  FakeFailureCallback,
  FakeOnFailure,
  FakeQueuedMessage,
  FakeSchedulerEvent,
  FakeSchedulerOptions,
} from './fake-scheduler';
