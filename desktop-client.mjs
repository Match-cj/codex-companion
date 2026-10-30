// Everything that touches the Codex desktop client or the floating quota
// widget as operating-system processes: finding them, closing them, starting
// them, bringing the widget to the front.
//
// All of it is Windows-only by nature (taskkill, explorer shell:AppsFolder,
// WPF mutex), and all of it is pure process plumbing - no Companion state
// lives here, which is why it could be lifted out of server.mjs wholesale.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { humanError } from './human-error.mjs';

const execFileAsync = promisify(execFile);

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const widgetScriptPath = path.join(sourceDir, 'Quota Widget WPF.ps1');
export const widgetLauncherPath = path.join(sourceDir, 'Launch Quota Widget.vbs');

export const WIDGET_MUTEX_NAME = 'Global\\CodexCompanionQuotaWidget_v5';
export const WIDGET_WINDOW_TITLE = 'Codex Companion 额度浮窗';

export async function execPowershellShort(script) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  return stdout.trim();
}

// Locates the Codex CLI to run as a child process. Portable copy first, then
// the npm install, because a .cmd shim cannot be spawned without a shell.
export function codexLaunch() {
  if (process.platform === 'win32') {
    const portableCodex = path.join(sourceDir, 'runtime', 'codex', 'bin', 'codex.exe');
    if (existsSync(portableCodex)) return { command: portableCodex, args: ['app-server', '--stdio'] };
    // APPDATA is sometimes unset (e.g. when launched from a non-cmd shell); fall back to USERPROFILE.
    const appData = process.env.APPDATA
      || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '');
    const codexScript = appData ? path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : '';
    if (codexScript && existsSync(codexScript)) {
      return { command: process.execPath, args: [codexScript, 'app-server', '--stdio'] };
    }
    // npm installs codex as a .cmd shim; spawn() can't exec a .cmd without a shell, so route through cmd.exe.
    const codexCmd = appData ? path.join(appData, 'npm', 'codex.cmd') : '';
    if (codexCmd && existsSync(codexCmd)) {
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${codexCmd}" app-server --stdio`] };
    }
  }
  return { command: 'codex', args: ['app-server', '--stdio'] };
}

export async function codexDesktopPids() {
  if (process.platform !== 'win32') return [];
  const script = `@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
    const value = JSON.parse(stdout.trim() || '[]');
    return (Array.isArray(value) ? value : value ? [value] : []).map(Number).filter(Number.isFinite);
  } catch { return []; }
}

export async function isCodexDesktopRunning() {
  return (await codexDesktopPids()).length > 0;
}

// Closing the client is how Companion swaps the signed-in account: Codex only
// reads auth.json at startup.
export async function closeCodexDesktop() {
  if (process.platform !== 'win32') return { stopped: 0 };
  const before = await codexDesktopPids();
  if (!before.length) return { stopped: 0 };
  try {
    await execFileAsync('taskkill.exe', ['/IM', 'ChatGPT.exe', '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  } catch (error) {
    // taskkill may return a non-zero code when one child exits while the process tree is being closed.
    console.warn('[account switch] taskkill returned:', humanError(error));
  }
  const deadline = Date.now() + 15000;
  let remaining = await codexDesktopPids();
  while (remaining.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    remaining = await codexDesktopPids();
  }
  if (remaining.length) throw Error(`ChatGPT/Codex 没有完全关闭（仍有 ${remaining.length} 个进程），账号尚未切换。请手动退出客户端后重试。`);
  return { stopped: before.length };
}

export function launchCodexDesktop() {
  if (process.platform !== 'win32') return;
  spawn('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

export async function isQuotaWidgetRunning() {
  if (process.platform !== 'win32') return false;
  const script = `try { $m = [System.Threading.Mutex]::OpenExisting('${WIDGET_MUTEX_NAME}'); if ($m -and $m.WaitOne(0, $false)) { $m.ReleaseMutex(); 'false' } else { 'true' } } catch { 'false' }`;
  try {
    const result = await execPowershellShort(script);
    return result === 'true';
  } catch { return false; }
}

export async function findQuotaWidgetWindow() {
  if (process.platform !== 'win32') return null;
  const script = `Add-Type -TypeDefinition @\"
using System; using System.Runtime.InteropServices;
public class WidgetWindowFinder {
  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
\"@; $hwnd = [WidgetWindowFinder]::FindWindow($null, '${WIDGET_WINDOW_TITLE}'); if ($hwnd -eq [IntPtr]::Zero) { 'null' } elseif ([WidgetWindowFinder]::IsWindowVisible($hwnd)) { @{ visible = $true; hwnd = $hwnd.ToInt64() } | ConvertTo-Json -Compress } else { @{ visible = $false; hwnd = $hwnd.ToInt64() } | ConvertTo-Json -Compress }`;
  try {
    const result = await execPowershellShort(script);
    if (!result || result === 'null') return null;
    return JSON.parse(result);
  } catch { return null; }
}

export async function focusQuotaWidgetWindow(hwnd) {
  if (process.platform !== 'win32' || !hwnd) return false;
  const script = `Add-Type -TypeDefinition @\"
using System; using System.Runtime.InteropServices;
public class WidgetWindowFocus {
  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
\"@; $hwnd = [IntPtr]${hwnd}; [WidgetWindowFocus]::ShowWindow($hwnd, 9) | Out-Null; [WidgetWindowFocus]::BringWindowToTop($hwnd) | Out-Null; [WidgetWindowFocus]::SetForegroundWindow($hwnd) | Out-Null; 'ok'`;
  try {
    const result = await execPowershellShort(script);
    return result === 'ok';
  } catch { return false; }
}

export async function killQuotaWidgetProcesses() {
  if (process.platform !== 'win32') return;
  const script = `Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*CodexCompanion\\Quota Widget WPF.ps1*' } | Stop-Process -Force -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\" | Where-Object { $_.CommandLine -like '*Launch Quota Widget*' } | Stop-Process -Force -ErrorAction SilentlyContinue;`;
  try { await execPowershellShort(script); } catch {}
}

let widgetOpenLock = false;
export async function openQuotaWidget() {
  if (process.platform !== 'win32' || !existsSync(widgetScriptPath) || !existsSync(widgetLauncherPath)) throw Error('没有找到额度浮窗文件，请重新解压完整的 Companion。');
  if (widgetOpenLock) return { ok: true, alreadyOpen: true, message: '正在处理中，请稍候。' };
  widgetOpenLock = true;
  try {
    const running = await isQuotaWidgetRunning();
    if (running) {
      const win = await findQuotaWidgetWindow();
      if (win) await focusQuotaWidgetWindow(win.hwnd);
      return { ok: true, alreadyOpen: true, message: '额度浮窗已经在运行，并已置顶。' };
    }
    const child = spawn('wscript.exe', [widgetLauncherPath], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', (err) => { console.error('[widget] spawn failed:', err.message); });
    child.unref();
    return { ok: true, alreadyOpen: false };
  } finally {
    setTimeout(() => { widgetOpenLock = false; }, 2000);
  }
}
