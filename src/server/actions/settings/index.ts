import 'server-only';

// Server Action bodies for /dashboard/settings (PLAN §3 actions/, §7.5). Pages import each action from
// the 'use server' module (./settings); the bodies and result codes live in ./controls.
export {
  DISCONNECT_BILLING_CODES,
  DISCONNECT_UNINSTALL_CODES,
  runDisconnect,
  runSaveForms,
  runSavePreferences,
  runSettingsPause,
  SETTINGS_DISCONNECT_PATH,
  SETTINGS_FORMS_PATH,
  SETTINGS_PATH,
  SETTINGS_RESULT_CODES,
} from './controls';
export type { SettingsResultCode } from './controls';
