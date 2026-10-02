import 'server-only';
import type { NotificationRegistry } from '@/server/services/notifications/renderers';
import { resumeVerifyNotify } from './notify-verification';

// The onboarding emails' resumers (PLAN §8.3 step 7, §8.4 step 2). `verify_notify` is registered
// here. The `settings_change` owner alert shares the `owner_alert` kind, whose one resumer lives in
// services/accounts (registerAccountNotifications) and hands settings-change keys to
// resumeSettingsChangeAlert, so registration order does not matter.

/** A `Registration` for src/server/jobs/handlers.ts (only the notification part is used). Safe to call twice. */
export function registerOnboardingNotifications(registries: { readonly notifications: NotificationRegistry }): void {
  const { notifications } = registries;
  if (notifications.resumer('verify_notify') === undefined) notifications.register('verify_notify', resumeVerifyNotify);
}
