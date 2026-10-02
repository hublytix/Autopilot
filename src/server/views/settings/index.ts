import 'server-only';

// Read models for /dashboard/settings and its sub-pages (PLAN §3 views/, §7.5). Each takes the
// OwnerScope. The forms sub-page reuses views/onboarding's formsPageView (a HubSpot read).
export { disconnectPageView, settingsPageView } from './settings';
export type { DisconnectBillingView, DisconnectPageView, SelectedFormView, SettingsPageView } from './settings';
export { formsPageView } from '@/server/views/onboarding/forms';
export type { FormsPageView } from '@/server/views/onboarding/forms';
