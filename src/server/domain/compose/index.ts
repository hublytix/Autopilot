import 'server-only';

// Compose links (D-13, docs/research/06-compose-urls.md): pure builders, recipient safety, the
// per-client length check and the compose-target choice. Import from here.
export { buildCompose, buildMailto, COMPOSE_CLIENTS, fitsComposeLimit, InvalidRecipientError } from './build';
export type { ComposeClient, ComposeInput, ComposeLink, ComposeMessage, ComposeOptions, GmailForm, OutlookMode } from './build';
export { eol, oneLine, pct } from './encode';
export { checkRecipient, isBareAddress, pctAddr } from './recipient';
export type { BareAddress, RecipientCheck, RecipientProblem } from './recipient';
export { chooseComposeClient, isPhone } from './target';
export type { DeviceHints } from './target';
