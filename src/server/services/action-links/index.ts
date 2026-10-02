import 'server-only';

// Owner action links (PLAN §7.4, D-13, D-26, D-45): the token-gated send and copy pages, the page
// beacon and the click heuristic. M4's edit and dismiss pages build on the same pieces. Import from here.
export { BEACON_NONCE_PATTERN, BEACON_TTL_MS, consumeBeacon, issueBeacon } from './beacon';
export { recordBeacon } from './beacon-click';
export type { BeaconOutcome, BeaconRequest } from './beacon-click';
export { CLICK_MIN_DELAY_MS, isPrefetchRequest, isScannerUserAgent, judgeClick, recordClick, SCANNER_USER_AGENT_PATTERNS } from './click';
export type { ClickRejection, ClickSignals, ClickVerdict, RecordClickInput } from './click';
export { loadSendContext } from './context';
export { ACTION_LINK_LIMITS, hitActionLinkLimits } from './limits';
export type { SendContext, SendContextResult } from './context';
export { resolveCopyLink } from './copy';
export type { CopyLinkRequest, CopyLinkState, CopyView } from './copy';
export { actionLinkPath } from './paths';
export type { ActionLinkAction } from './paths';
export { composeTarget, resolveSendLink } from './send';
export type { CopyReason, InterstitialView, SendLinkOutcome, SendLinkRequest } from './send';
