import 'server-only';

// HubSpot signals and follow-up stops (PLAN §6.2, §9.5 steps 2-4, D-08, D-09, D-44): the contact
// read, applySignals (confirmed sends, replies, contact stops), markReplied, and the database half
// of evaluateStops' input. The pure rules live in domain/signals.ts and domain/stops.ts.
export { applySignals } from './apply';
export type { ApplySignalsOptions, ApplySignalsResult, SignalsCaller } from './apply';
export { markReplied, markRepliedInTx, resumePendingReplyEmail } from './mark-replied';
export type { MarkRepliedInput, MarkRepliedOptions, MarkRepliedResult, MarkRepliedTxResult, ReplyEmailOutcome } from './mark-replied';
export { MAX_ASSOCIATION_PAGES, readContactSignals, remapMergedContact } from './read';
export type { ContactSignalsRead, ReadContactSignalsOptions, SignalLeadRef } from './read';
export { loadStopState } from './stop-state';
export type { LoadStopStateInput } from './stop-state';
