// Every filesystem location Companion depends on, in one place.
//
// Keeping them here means no module has to re-derive %APPDATA% / %USERPROFILE%
// on its own and silently drift from the real store. Resolution rules are
// unchanged from the original inline version, including the data-dir override
// used by tests and portable installs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceDir = path.dirname(fileURLToPath(import.meta.url));

export const appDir = process.env.CODEX_COMPANION_DATA_DIR
  ? path.resolve(process.env.CODEX_COMPANION_DATA_DIR)
  : path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'CodexCompanion');

export const configPath = path.join(appDir, 'config.json');
export const widgetSwitchTracePath = path.join(appDir, 'widget-switch-trace.jsonl');
export const nativeAccountsPath = path.join(appDir, 'accounts.vault.json');
export const nativeAccountsBackupPath = path.join(appDir, 'accounts.vault.backup.json');
export const switcherAccountsPath = path.join(process.env.USERPROFILE || '', '.codex-switcher', 'accounts.json');
export const liveAuthPath = path.join(process.env.USERPROFILE || '', '.codex', 'auth.json');
export const widgetScriptPath = path.join(sourceDir, 'Quota Widget WPF.ps1');
export const widgetLauncherPath = path.join(sourceDir, 'Launch Quota Widget.vbs');
