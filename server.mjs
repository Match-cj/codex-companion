import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, watch as watchFs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import * as Lark from '@larksuiteoapi/node-sdk';
import { relayFinalImages, validateImageRoot } from './image-relay.mjs';

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(scryptCallback);
const APP_VERSION = '0.7.39';
const NOTIFICATION_HISTORY_LIMIT = 200;

const appDir = process.env.CODEX_COMPANION_DATA_DIR
  ? path.resolve(process.env.CODEX_COMPANION_DATA_DIR)
  : path.join(process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'CodexCompanion');
const configPath = path.join(appDir, 'config.json');
const nativeAccountsPath = path.join(appDir, 'accounts.vault.json');
const nativeAccountsBackupPath = path.join(appDir, 'accounts.vault.backup.json');
const switcherAccountsPath = path.join(process.env.USERPROFILE || '', '.codex-switcher', 'accounts.json');
const liveAuthPath = path.join(process.env.USERPROFILE || '', '.codex', 'auth.json');
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const widgetScriptPath = path.join(sourceDir, 'Quota Widget WPF.ps1');
const widgetLauncherPath = path.join(sourceDir, 'Launch Quota Widget.vbs');
const dashboardHtml = await fs.readFile(new URL('./dashboard.html', import.meta.url), 'utf8');
const defaultConfig = {
  port: 17841,
  remoteAccessEnabled: false,
  remoteAccessTokenHash: '',
  feishuAllowedUserIds: [],
  feishuWebhookUrl: '',
  feishuAppId: '',
  feishuAppSecretProtected: '',
  feishuBoundChatId: '',
  feishuBoundThreadId: '',
  feishuImageRelayEnabled: true,
  feishuImageRelayRoot: '',
  stallMinutes: 3,
  quotaRefreshMinutes: 5,
  resetReminderMinutes: 15,
  publicDashboardUrl: '',
  accountAliases: {},
  accountBackend: 'native',
  codexDesktopTakeoverThreadIds: [],
};
let config = { ...defaultConfig };
let feishuPairingCode = randomBytes(12).toString('hex');
const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
function requestAccessError(req) {
  const local = isLoopback(req.socket.remoteAddress);
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { return '请求地址不合法'; }
  if (local && !['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return '仅允许使用本机地址访问';
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return '禁止跨站请求';
  if (!local) {
    if (!config.remoteAccessEnabled) return '远程访问未开启';
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const hash = createHash('sha256').update(token).digest('hex');
    if (!token || !/^[a-f0-9]{64}$/.test(config.remoteAccessTokenHash) || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(config.remoteAccessTokenHash, 'hex'))) return '请提供有效的远程访问口令';
  }
  return '';
}
function publicConfig() {
  return { port: config.port, feishuAppId: config.feishuAppId, feishuWebhookConfigured: !!config.feishuWebhookUrl,
    publicDashboardUrl: config.publicDashboardUrl, quotaRefreshMinutes: config.quotaRefreshMinutes, resetReminderMinutes: config.resetReminderMinutes,
    feishuImageRelayEnabled: !!config.feishuImageRelayEnabled, feishuImageRelayRoot: config.feishuImageRelayRoot || '' };
}
function publicDiagnostics() {
  const report = { format: 1, appVersion: APP_VERSION, createdAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    health: { taskEngineReady: !!codex?.proc, sessionMonitorReady: codexSessionWatcherReady,
      feishuState: publicFeishuState().state, webhookConfigured: !!config.feishuWebhookUrl,
      operatorVerified: !!config.feishuAllowedUserIds?.length, remoteEnabled: !!config.remoteAccessEnabled },
    counts: { accounts: accounts.length, activeBackendTasks: [...tasks.values()].filter(t => ['starting','running','waiting_confirmation'].includes(t.status)).length },
    privacy: '仅包含白名单状态和数量；不包含账号身份、路径、任务内容、原始日志、网络地址或任何凭据。' };
  report.issues = diagnosticIssues(report);
  return report;
}
function diagnosticIssues(report) {
  const issues = [], add = (code, severity, message) => issues.push({ code, severity, message });
  if (!report.counts.accounts) add('ACCOUNT_MISSING','warning','还没有添加账号：导入本机文件凭据或使用通用网页登录。');
  if (!report.health.taskEngineReady) add('ENGINE_NOT_READY','warning','后台任务引擎尚未就绪。请稍后刷新；持续失败时导出诊断。');
  if (!report.health.sessionMonitorReady) add('MONITOR_NOT_READY','warning','主对话记录监听尚未就绪，桌面任务完成通知可能不可用。');
  if (!report.health.webhookConfigured && report.health.feishuState === 'not_configured') add('FEISHU_OPTIONAL','info','飞书尚未配置：不影响本机使用；需要通知或手机回复时再设置。');
  else if (!['connected','not_configured'].includes(report.health.feishuState)) add('FEISHU_DISCONNECTED','warning','应用机器人尚未连接。检查飞书应用配置、发布状态及网络。');
  if (report.health.feishuState === 'connected' && !report.health.operatorVerified) add('OPERATOR_UNVERIFIED','warning','飞书回复控制未验证：复制本机指令，在群里 @ 自建应用机器人后发送。');
  if (report.health.remoteEnabled) add('REMOTE_HTTP','info','远程控制已开启。仅在可信私有网络使用；HTTP 本身不提供传输加密。');
  return issues;
}
let accounts = [];
let lastAccountRefreshAt = 0;
let officialRateLimits = null;
let deviceLogin = null;
let browserLogin = null;
let browserLoginInFlight = null;
let nativeSwitchInProgress = false;
const nativeWarmupsInProgress = new Set();
let taskEngineError = '';
let lastQuotaDelta = null;
let notificationDb = null;
let lastWindowsNotificationOrder = null;
let codexExitNotifiedAt = 0; // dedupe Codex 后台 crashed toast: same outage should alert once
const quotaNotifierState = new Map(); // key=`${accountId}:${label}` → {exhausted, resetSoon, resetAt}
const subscriptionNotifierState = new Map();
const nativeUsageCache = new Map();
const nativeUsageInFlight = new Map();
let nativeVaultWriteQueue = Promise.resolve();
const tasks = new Map();
const pendingApprovals = new Map();
let feishuClient = null;
let feishuWsClient = null;
let feishuState = { state: 'not_configured', error: '', connectedAt: 0 };
let codexSessionWatcher = null;
let codexSessionWatcherReady = false;
const codexSessionOffsets = new Map();
const codexSessionPartials = new Map();
const codexSessionDebounces = new Map();
const codexSessionKinds = new Map();
const codexSessionImagePaths = new Map();
const sessionActivities = new Map();
function observeSessionActivity(event, kind, threadId, cwd = '') {
  if (kind !== 'user' || !threadId || event?.type !== 'event_msg') return;
  const payload = event.payload || {};
  const previous = sessionActivities.get(threadId) || { id: threadId, source: 'desktop', status: 'unknown', title: '', cwd };
  const timestamp = Date.parse(event.timestamp || '');
  if (Number.isFinite(timestamp)) previous.lastObservedAt = timestamp;
  if (payload.type === 'user_message' && payload.message) previous.title = String(payload.message).slice(0, 100);
  if (payload.type === 'task_started') { previous.status = 'recorded_running'; previous.turnId = String(payload.turn_id || ''); }
  if (['task_complete', 'turn_aborted'].includes(payload.type)) {
    // A delayed completion for an older turn must not hide a newer active turn.
    if (!previous.turnId || !payload.turn_id || previous.turnId === String(payload.turn_id)) previous.status = payload.type === 'task_complete' ? 'completed' : 'interrupted';
  }
  sessionActivities.set(threadId, previous);
  if (sessionActivities.size > 300) sessionActivities.delete(sessionActivities.keys().next().value);
}
function publicTaskActivity() {
  const rows = new Map([...sessionActivities].filter(([, row]) => row.status === 'recorded_running'));
  for (const task of tasks.values()) {
    if (['starting', 'running', 'waiting_confirmation'].includes(task.status)) rows.set(String(task.id), {
      id: String(task.id), title: task.prompt || '', cwd: task.cwd || '', status: task.stopRequested && ['starting','running','waiting_confirmation'].includes(task.status) ? 'stop_requested' : task.status,
      source: task.remoteDesktopTakeover ? 'takeover' : 'companion', lastObservedAt: task.lastEventAt,
    });
    else if ((rows.get(String(task.id))?.lastObservedAt || 0) <= (task.lastEventAt || 0)) rows.delete(String(task.id));
  }
  return [...rows.values()].sort((a, b) => (b.lastObservedAt || 0) - (a.lastObservedAt || 0));
}
async function seedSessionActivity(file, kind, stat) {
  if (kind !== 'user' || Date.now() - stat.mtimeMs > 48 * 3600000) return;
  const handle = await fs.open(file, 'r');
  try {
    const size = Math.min(stat.size, 1024 * 1024), start = stat.size - size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (start) lines.shift();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event?.type === 'session_meta') observeSessionMeta(event.payload, sessionThreadId(file));
        observeSessionPrompt(event, sessionThreadId(file));
        observeSessionActivity(event, kind, sessionThreadId(file));
      } catch {}
    }
  } finally { await handle.close(); }
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const trim = (s, n) => String(s || '').length <= n ? String(s || '') : String(s || '').slice(-n);
const normalizeAppName = name => {
  const value = String(name || '').trim();
  if (!value) return '未分类';
  if (value === 'app') return 'Match Tools';
  if (value.startsWith('NotifyIconGeneratedAumid_') || /^\{[0-9a-f-]+\}$/i.test(value)) return '系统托盘应用';
  return value;
};
const ensureHistory = () => { if (!Array.isArray(config.notificationHistory)) config.notificationHistory = []; };
const pushHistory = (entry) => { ensureHistory(); config.notificationHistory.unshift(entry); if (config.notificationHistory.length > NOTIFICATION_HISTORY_LIMIT) config.notificationHistory.length = NOTIFICATION_HISTORY_LIMIT; };
const shanghaiDayKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value));
const sentQuotaNoticeToday = (...needles) => {
  ensureHistory();
  const today = shanghaiDayKey(Date.now());
  return config.notificationHistory.some(item => item.sent && item.appName === 'Codex 额度' && shanghaiDayKey(item.at) === today && needles.every(needle => String(item.body || '').includes(needle)));
};
const jsonReadErrors = new Map();
const readJson = async file => {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      jsonReadErrors.delete(file);
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
  jsonReadErrors.set(file, String(lastError?.message || lastError || '未知读取错误'));
  return {};
};
const saveConfig = () => fs.mkdir(appDir, { recursive: true }).then(() => fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8'));
function humanError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/invalid refresh token|token refresh|refresh token|token.{0,30}expired|token_expired/i.test(message)) return '这个账号的登录已经失效，请在 Companion 网页中重新登录后再刷新。';
  if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) return '连接不上本地服务，请确认 Codex Companion 正在运行。';
  if (message.includes('ENOENT')) return '找不到需要启动的程序，请确认 Codex CLI 已正确安装。';
  if (message.includes('超时')) return 'Codex 两分钟没有回应。任务可能卡住了，请稍后重试或重启 Companion。';
  if (message.includes('有任务正在运行')) return message;
  if (message.includes('Webhook')) return message;
  if (message.includes('HTTP 400')) return '账号或请求信息已经失效，请刷新账号；如果仍失败，请在 Companion 网页中重新登录。';
  if (message.includes('Country, region, or territory not supported') || message.includes('unsupported_country_region_territory')) return '登录网页已经通过，但后台没有走浏览器正在使用的代理线路。Companion 会改用系统代理重试；如果仍失败，请确认代理软件正在运行。';
  return `操作没有完成：${message}`;
}
function validFeishuWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) && url.pathname.includes('/open-apis/bot/v2/hook/');
  } catch { return false; }
}

async function oauthPortStatus() {
  if (process.platform !== 'win32') return { requiredPort: 1455, free: true, owner: null, switcherPids: [], switcherPorts: [] };
  const script = `
$listener = Get-NetTCPConnection -State Listen -LocalPort 1455 -ErrorAction SilentlyContinue | Select-Object -First 1
$owner = if ($listener) { Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue } else { $null }
$switchers = @(Get-Process -Name 'codex-switcher' -ErrorAction SilentlyContinue)
$switcherIds = @($switchers | ForEach-Object { $_.Id })
$switcherPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $switcherIds -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)
[pscustomobject]@{
  requiredPort = 1455
  free = ($null -eq $listener)
  owner = if ($owner) { [pscustomobject]@{ name = $owner.ProcessName; pid = $owner.Id } } else { $null }
  switcherPids = $switcherIds
  switcherPorts = $switcherPorts
} | ConvertTo-Json -Compress -Depth 4
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  const result = JSON.parse(stdout.trim());
  result.switcherPids = Array.isArray(result.switcherPids) ? result.switcherPids : result.switcherPids ? [result.switcherPids] : [];
  result.switcherPorts = Array.isArray(result.switcherPorts) ? result.switcherPorts : result.switcherPorts ? [result.switcherPorts] : [];
  if (result.free) {
    result.bindable = await new Promise(resolve => {
      const tester = net.createServer();
      tester.unref();
      tester.once('error', error => resolve({ ok: false, code: error.code || '', message: error.message }));
      tester.listen(1455, '127.0.0.1', () => tester.close(() => resolve({ ok: true })));
    });
    if (!result.bindable.ok) {
      result.free = false;
      result.reserved = true;
      result.reason = result.bindable.code === 'EACCES'
        ? 'Windows 把 1455 放进了系统保留端口范围。它看起来没人占用，但程序无法使用。'
        : `1455 无法使用：${result.bindable.message}`;
    }
  } else result.bindable = { ok: false, code: 'IN_USE' };
  return result;
}
async function closeCodexDesktop() {
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
async function codexDesktopPids() {
  if (process.platform !== 'win32') return [];
  const script = `@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
    const value = JSON.parse(stdout.trim() || '[]');
    return (Array.isArray(value) ? value : value ? [value] : []).map(Number).filter(Number.isFinite);
  } catch { return []; }
}
async function isCodexDesktopRunning() {
  return (await codexDesktopPids()).length > 0;
}
function launchCodexDesktop() {
  if (process.platform !== 'win32') return;
  spawn('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}
const WIDGET_MUTEX_NAME = 'Global\\CodexCompanionQuotaWidget_v5';
const WIDGET_WINDOW_TITLE = 'Codex Companion 额度浮窗';

async function execPowershellShort(script) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  return stdout.trim();
}

async function isQuotaWidgetRunning() {
  if (process.platform !== 'win32') return false;
  const script = `try { $m = [System.Threading.Mutex]::OpenExisting('${WIDGET_MUTEX_NAME}'); if ($m -and $m.WaitOne(0, $false)) { $m.ReleaseMutex(); 'false' } else { 'true' } } catch { 'false' }`;
  try {
    const result = await execPowershellShort(script);
    return result === 'true';
  } catch { return false; }
}

async function findQuotaWidgetWindow() {
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

async function focusQuotaWidgetWindow(hwnd) {
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

async function killQuotaWidgetProcesses() {
  if (process.platform !== 'win32') return;
  const script = `Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*CodexCompanion\\Quota Widget WPF.ps1*' } | Stop-Process -Force -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\" | Where-Object { $_.CommandLine -like '*Launch Quota Widget*' } | Stop-Process -Force -ErrorAction SilentlyContinue;`;
  try { await execPowershellShort(script); } catch {}
}

let widgetOpenLock = false;
async function openQuotaWidget() {
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

function codexLaunch() {
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

class DeviceLoginSession {
  constructor(name = '') {
    this.name = String(name || '').trim();
    this.id = randomUUID();
    this.home = path.join(appDir, 'device-login', this.id);
    this.pending = new Map();
    this.nextId = 0;
    this.proc = null;
    this.loginId = null;
    this.state = { status: 'starting', message: '正在生成安全登录码……' };
  }
  publicState() { return { ...this.state, loginId: this.loginId }; }
  async start() {
    await fs.mkdir(this.home, { recursive: true });
    const { command, args } = codexLaunch();
    this.proc = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: this.home } });
    this.proc.stdout.setEncoding('utf8');
    let buffer = '';
    this.proc.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) this.receive(line); });
    this.proc.stderr.on('data', data => console.error('[device login]', String(data).trim()));
    this.proc.on('exit', code => {
      if (['starting', 'waiting'].includes(this.state.status)) this.state = { status: 'failed', message: `登录服务意外结束（代码 ${code ?? '-'}），请重试。` };
    });
    await this.request('initialize', { clientInfo: { name: 'codex_companion_login', title: 'Codex Companion Login', version: '0.1.7' } });
    this.send({ method: 'initialized', params: {} });
    const result = await this.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (result?.type !== 'chatgptDeviceCode') throw Error('Codex 没有返回设备登录码，请更新 Codex CLI 后重试。');
    this.loginId = result.loginId;
    this.state = { status: 'waiting', verificationUrl: result.verificationUrl, userCode: result.userCode, message: '请打开登录页并输入这个一次性代码。' };
    return this.publicState();
  }
  send(value) { this.proc?.stdin.write(`${JSON.stringify(value)}\n`); }
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} 超时`)); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }
  receive(line) {
    if (!line.trim()) return;
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id); clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(Error(message.error.message || JSON.stringify(message.error))); else pending.resolve(message.result);
      return;
    }
    if (message.method === 'account/login/completed' && (!this.loginId || message.params?.loginId === this.loginId)) this.finish(message.params || {});
  }
  async finish(result) {
    if (!result.success) {
      this.state = { status: 'failed', message: `登录没有完成：${result.error || 'OpenAI 没有接受这次登录，请重试。'}` };
      await this.cleanup(); return;
    }
    this.state = { status: 'importing', message: '登录成功，正在安全加入 Companion 账号库……' };
    try {
      const authPath = path.join(this.home, 'auth.json');
      let contents = '';
      for (let i = 0; i < 20 && !contents; i++) { try { contents = await fs.readFile(authPath, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 250)); } }
      if (!contents) throw Error('登录已通过，但没有找到账号凭据。请重试。');
      const imported = await importOrUpdateAccount(contents, this.name);
      this.state = { status: 'completed', accountName: imported?.name || imported?.email || this.name || '新账号', message: imported?.updated ? '原有账号的登录已经更新，可以继续使用。' : '新账号已加入账号列表，可以直接使用。' };
    } catch (error) {
      this.state = { status: 'failed', message: humanError(error) };
    } finally { await this.cleanup(); }
  }
  async cancel() {
    try { if (this.loginId) await this.request('account/login/cancel', { loginId: this.loginId }); } catch {}
    this.state = { status: 'canceled', message: '已取消这次登录。' };
    await this.cleanup();
  }
  async cleanup() {
    try { this.proc?.kill(); } catch {}
    const root = path.resolve(appDir, 'device-login') + path.sep;
    const target = path.resolve(this.home);
    if (target.startsWith(root)) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
}

async function startDeviceLogin(name) {
  if (deviceLogin && ['starting', 'waiting', 'importing'].includes(deviceLogin.state.status)) return deviceLogin.publicState();
  if (loginBusy()) throw Error('还有 Companion 任务正在运行或等待确认。请先处理任务，再登录或更新账号。');
  deviceLogin = new DeviceLoginSession(name);
  try { return await deviceLogin.start(); }
  catch (error) { deviceLogin.state = { status: 'failed', message: humanError(error) }; await deviceLogin.cleanup(); throw error; }
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}
function jwtExpiry(token) {
  const value = Number(decodeJwtPayload(token).exp);
  return Number.isFinite(value) ? value : 0;
}
async function atomicJsonWrite(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const replacementBackup = path.join(directory, `.${path.basename(file)}.${randomUUID()}.bak`);
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  try {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (process.platform === 'win32' && existsSync(file)) {
          const script = "$ErrorActionPreference='Stop';[IO.File]::Replace($env:COMPANION_ATOMIC_TEMP,$env:COMPANION_ATOMIC_DEST,$env:COMPANION_ATOMIC_BACKUP,$true);[IO.File]::Delete($env:COMPANION_ATOMIC_BACKUP)";
          await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true,
            encoding: 'utf8',
            env: { ...process.env, COMPANION_ATOMIC_TEMP: temporary, COMPANION_ATOMIC_DEST: file, COMPANION_ATOMIC_BACKUP: replacementBackup },
          });
        } else {
          await fs.rename(temporary, file);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
    throw lastError;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rm(replacementBackup, { force: true }).catch(() => {});
  }
}
function validNativeVault(vault) {
  return vault && vault.version === 1 && Array.isArray(vault.accounts)
    && vault.accounts.every(entry => entry && entry.id && typeof entry.protected_auth === 'string' && entry.protected_auth.length > 20);
}
async function readEffectiveNativeVault() {
  const primary = await readJson(nativeAccountsPath);
  if (validNativeVault(primary)) return { vault: primary, source: 'primary', error: '' };
  const primaryError = jsonReadErrors.get(nativeAccountsPath) || '主账号库格式无效';
  const backup = await readJson(nativeAccountsBackupPath);
  if (validNativeVault(backup)) return { vault: backup, source: 'backup', error: primaryError };
  const backupError = jsonReadErrors.get(nativeAccountsBackupPath) || '备份账号库格式无效';
  return { vault: {}, source: 'none', error: `主库：${primaryError}；备份：${backupError}` };
}
async function writeNativeVault(vault, { preserveCurrent = true } = {}) {
  if (!validNativeVault(vault)) throw Error('原生账号库校验失败，已阻止写入。');
  if (preserveCurrent && existsSync(nativeAccountsPath)) {
    const current = await readJson(nativeAccountsPath);
    if (validNativeVault(current)) await atomicJsonWrite(nativeAccountsBackupPath, current);
  }
  await atomicJsonWrite(nativeAccountsPath, vault);
  const written = await readJson(nativeAccountsPath);
  if (!validNativeVault(written) || written.accounts.length !== vault.accounts.length) throw Error('原生账号库写入后的完整性校验失败。');
}
async function backupNativeVault() {
  return queueNativeVaultWrite(async () => {
    const vault = await readJson(nativeAccountsPath);
    if (!validNativeVault(vault)) throw Error('当前原生账号库不可用，不能创建备份。');
    await atomicJsonWrite(nativeAccountsBackupPath, vault);
    return { ok: true, count: vault.accounts.length, backupUpdatedAt: new Date().toISOString() };
  });
}
async function restoreNativeVault() {
  return queueNativeVaultWrite(async () => {
    const backup = await readJson(nativeAccountsBackupPath);
    if (!validNativeVault(backup)) throw Error('没有找到可恢复的有效账号备份。');
    const current = await readJson(nativeAccountsPath);
    if (validNativeVault(current)) await atomicJsonWrite(path.join(appDir, 'accounts.vault.before-restore.json'), current);
    await writeNativeVault(backup, { preserveCurrent: false });
    nativeUsageCache.clear();
    return { ok: true, count: backup.accounts.length };
  });
}
const PORTABLE_BACKUP_TYPE = 'codex-companion-portable-backup';
const PORTABLE_BACKUP_AAD = Buffer.from('CodexCompanion/portable-backup/v1', 'utf8');
const PORTABLE_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1 });
function validatePortablePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw Error('迁移备份密码至少需要 8 个字符。');
  if (Buffer.byteLength(value, 'utf8') > 256) throw Error('迁移备份密码过长。');
  return value;
}
async function derivePortableBackupKey(password, salt) {
  return await scryptAsync(validatePortablePassword(password), salt, 32, { ...PORTABLE_SCRYPT, maxmem: 64 * 1024 * 1024 });
}
async function createPortableAccountBackup(password) {
  const vault = await readJson(nativeAccountsPath);
  if (!validNativeVault(vault) || !vault.accounts.length) throw Error('当前没有可导出的 Companion 账号。');
  const aliases = config.accountAliases && typeof config.accountAliases === 'object' && !Array.isArray(config.accountAliases) ? config.accountAliases : {};
  const portableAccounts = [];
  for (const entry of vault.accounts) {
    const auth = JSON.parse(await unprotectCredential(entry.protected_auth));
    if (!auth?.tokens?.access_token || !auth?.tokens?.refresh_token || !auth?.tokens?.id_token) throw Error(`账号 ${entry.email || entry.name || entry.id} 的凭据不完整，已停止导出。`);
    const { protected_auth, ...metadata } = entry;
    portableAccounts.push({ metadata, alias: String(aliases[entry.id] || ''), auth });
  }
  const plaintext = Buffer.from(JSON.stringify({ version: 1, created_at: new Date().toISOString(), accounts: portableAccounts }), 'utf8');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await derivePortableBackupKey(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(PORTABLE_BACKUP_AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      type: PORTABLE_BACKUP_TYPE,
      version: 1,
      encryption: { cipher: 'AES-256-GCM', kdf: 'scrypt', N: PORTABLE_SCRYPT.N, r: PORTABLE_SCRYPT.r, p: PORTABLE_SCRYPT.p, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      ciphertext: ciphertext.toString('base64'),
    };
  } finally { key.fill(0); plaintext.fill(0); }
}
function decodePortableField(value, expectedLength, label) {
  let decoded;
  try { decoded = Buffer.from(String(value || ''), 'base64'); } catch { throw Error(`迁移备份的${label}无效。`); }
  if (decoded.length !== expectedLength) throw Error(`迁移备份的${label}无效。`);
  return decoded;
}
async function decryptPortableAccountBackup(envelope, password) {
  if (!envelope || envelope.type !== PORTABLE_BACKUP_TYPE || envelope.version !== 1) throw Error('这不是受支持的 Codex Companion 迁移备份。');
  if (envelope.encryption?.cipher !== 'AES-256-GCM' || envelope.encryption?.kdf !== 'scrypt') throw Error('迁移备份使用了不支持的加密方式。');
  if (String(envelope.ciphertext || '').length > 8 * 1024 * 1024) throw Error('迁移备份文件过大。');
  const salt = decodePortableField(envelope.encryption.salt, 16, '盐值');
  const iv = decodePortableField(envelope.encryption.iv, 12, '随机数');
  const tag = decodePortableField(envelope.encryption.tag, 16, '校验值');
  const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  const key = await derivePortableBackupKey(password, salt);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(PORTABLE_BACKUP_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (payload?.version !== 1 || !Array.isArray(payload.accounts) || !payload.accounts.length || payload.accounts.length > 100) throw Error('迁移备份内没有有效账号。');
    for (const account of payload.accounts) {
      if (!account?.auth?.tokens?.id_token || !account.auth.tokens.access_token || !account.auth.tokens.refresh_token) throw Error('迁移备份内有不完整的账号凭据。');
    }
    return payload;
  } catch (error) {
    if (/迁移备份/.test(String(error?.message || ''))) throw error;
    throw Error('密码不正确，或迁移备份已经损坏。');
  } finally { key.fill(0); if (plaintext) plaintext.fill(0); }
}
async function importPortableAccountBackup(envelope, password) {
  const payload = await decryptPortableAccountBackup(envelope, password);
  const imported = [];
  for (const item of payload.accounts) {
    const metadata = item.metadata || {};
    const account = await upsertNativeAccount(item.auth, { ...metadata, id: undefined, is_active: false, restoreDeleted: true });
    imported.push(account);
    const alias = String(item.alias || '').trim();
    if (alias) {
      if (!config.accountAliases || typeof config.accountAliases !== 'object' || Array.isArray(config.accountAliases)) config.accountAliases = {};
      config.accountAliases[account.id] = alias.slice(0, 40);
    }
  }
  await saveConfig();
  accounts = await loadNativeAccountsSnapshot();
  refreshAccounts({ forceNative: true, awaitNative: false }).catch(error => console.error('[portable import refresh]', error.message));
  return { ok: true, imported: imported.length, accounts: accounts.length };
}
function runWithInput(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `凭据加密进程退出（${code}）`)));
    child.stdin.end(String(input || ''), 'utf8');
  });
}
async function dpapiTransform(value, protect) {
  if (process.platform !== 'win32') throw Error('原生账号库目前需要 Windows。');
  const script = protect
    ? "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$e=[Text.Encoding]::UTF8.GetBytes('CodexCompanion/auth/v1');[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$e=[Text.Encoding]::UTF8.GetBytes('CodexCompanion/auth/v1');[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  return runWithInput('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], value);
}
const protectCredential = value => dpapiTransform(String(value), true);
const unprotectCredential = value => dpapiTransform(String(value), false);

function publicFeishuState() {
  return {
    configured: Boolean(config.feishuAppId && config.feishuAppSecretProtected),
    state: feishuWsClient?.getConnectionStatus?.().state || feishuState.state,
    error: feishuState.error,
    connectedAt: feishuState.connectedAt,
    boundChat: Boolean(config.feishuBoundChatId),
    boundThreadId: config.feishuBoundThreadId || '',
    boundThreadName: config.feishuBoundThreadName || '',
  };
}

async function sendFeishuAppText(text, { replyTo = '', taskId = '' } = {}) {
  if (!feishuClient || !config.feishuBoundChatId) return { ok: false, reason: 'app-bot-not-ready' };
  const data = { content: JSON.stringify(buildFeishuPost(text)), msg_type: 'post' };
  const response = replyTo
    ? await feishuClient.im.v1.message.reply({ path: { message_id: replyTo }, data })
    : await feishuClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: config.feishuBoundChatId } });
  if (response?.code) throw Error(response.msg || `飞书消息发送失败（${response.code}）`);
  const messageId = response?.data?.message_id;
  if (messageId && taskId) {
    const links = config.feishuMessageThreads && typeof config.feishuMessageThreads === 'object' ? config.feishuMessageThreads : {};
    links[messageId] = taskId;
    config.feishuMessageThreads = Object.fromEntries(Object.entries(links).slice(-100));
    saveConfig().catch(() => {});
  }
  return { ok: true, messageId };
}

async function downloadFeishuImage(messageId, imageKey) {
  if (!feishuClient || !messageId || !imageKey) throw Error('图片消息缺少可下载的资源标识。');
  const resource = await feishuClient.im.v1.messageResource.get({
    params: { type: 'image' },
    path: { message_id: messageId, file_key: imageKey },
  });
  const rawType = resource?.headers?.get?.('content-type') || resource?.headers?.['content-type'] || '';
  const extension = /png/i.test(rawType) ? '.png' : /webp/i.test(rawType) ? '.webp' : /gif/i.test(rawType) ? '.gif' : '.jpg';
  const imageDir = path.join(appDir, 'feishu-images');
  await fs.mkdir(imageDir, { recursive: true });
  const safeId = String(messageId).replace(/[^a-z0-9_-]/gi, '_');
  const imagePath = path.join(imageDir, `${safeId}${extension}`);
  await resource.writeFile(imagePath);
  const cleanup = setTimeout(() => fs.unlink(imagePath).catch(() => {}), 60 * 60 * 1000);
  cleanup.unref?.();
  return imagePath;
}

async function sendFeishuResultImage(bytes, replyTo, taskId) {
  if (!feishuClient || !replyTo) throw Error('应用机器人或本轮通知未就绪。');
  const uploaded = await feishuClient.im.v1.image.create({ data: { image_type: 'message', image: bytes } });
  const imageKey = uploaded?.image_key || uploaded?.data?.image_key;
  if (uploaded?.code || !imageKey) throw Error('图片上传失败，请检查机器人资源权限。');
  const response = await feishuClient.im.v1.message.reply({ path: { message_id: replyTo }, data: { msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) } });
  if (response?.code || !response?.data?.message_id) throw Error('图片消息发送失败。');
  const links = config.feishuMessageThreads || {};
  links[response.data.message_id] = taskId;
  config.feishuMessageThreads = Object.fromEntries(Object.entries(links).slice(-100));
  await saveConfig();
}

async function notifyTurnResult(text, { taskId, turnId, finalText, imagePaths = [] }) {
  if (!await markCodexTurnComplete(turnId)) return;
  const quota = await currentQuotaText();
  const notice = await notify(`${text}\n\n${quota}`, { appName: 'Codex 任务', taskId });
  if (!notice.ok || !notice.messageId) return;
  await relayFinalImages({ text: finalText, paths: imagePaths, trustedPaths: imagePaths, enabled: config.feishuImageRelayEnabled === true, root: config.feishuImageRelayRoot || '',
    send: bytes => sendFeishuResultImage(bytes, notice.messageId, taskId),
    report: async body => {
      pushHistory({ at: Date.now(), appName: 'Codex 图片', body, sent: false, reason: 'image-relay-failed' });
      await saveConfig();
    } });
}

function wrapFeishuText(value, maxLength = 110) {
  const source = String(value || '').trim();
  if (!source) return [];
  const sentences = source.split(/(?<=[。！？；])/u);
  const lines = [];
  for (const sentence of sentences) {
    let rest = sentence.trim();
    while (rest.length > maxLength) { lines.push(rest.slice(0, maxLength)); rest = rest.slice(maxLength); }
    if (rest) lines.push(rest);
  }
  return lines;
}

function buildFeishuPost(text) {
  const rawLines = trim(text, 3800).split(/\r?\n/);
  const title = String(rawLines.shift() || 'Codex Companion').trim().slice(0, 80) || 'Codex Companion';
  const content = [];
  for (const raw of rawLines) {
    if (!raw.trim()) { content.push([{ tag: 'text', text: ' ' }]); continue; }
    for (const line of wrapFeishuText(raw)) content.push([{ tag: 'text', text: line }]);
  }
  if (!content.length) content.push([{ tag: 'text', text: ' ' }]);
  return { zh_cn: { title, content } };
}

async function inferNotificationTaskId(text, preferred = '') {
  if (preferred) return String(preferred);
  const body = String(text || '');
  const embedded = body.match(/任务：([0-9a-f-]{20,})/i)?.[1];
  if (embedded) return embedded;
  for (const task of tasks.values()) {
    const title = String(task.prompt || '').trim();
    if (title && body.includes(title)) return task.id;
  }
  if (codex?.proc) {
    try {
      const threads = await codex.listThreads(20, '');
      const match = threads.find(thread => {
        const title = String(thread.name || thread.preview || '').trim();
        return title.length >= 3 && body.includes(title);
      });
      if (match) return String(match.id);
    } catch {}
  }
  if (config.feishuBoundThreadName && body.includes(config.feishuBoundThreadName)) return String(config.feishuBoundThreadId || '');
  return String(config.feishuBoundThreadId || '');
}

async function chooseLatestThread() {
  if (!codex?.proc) throw Error('任务引擎正在重连，请稍后重试。');
  const threads = await codex.listThreads(20, '');
  if (!threads.length) throw Error('没有找到可绑定的 Codex 对话。');
  return threads.find(thread => thread.status?.type === 'active') || threads[0];
}

async function bindLatestFeishuThread() {
  const thread = await chooseLatestThread();
  config.feishuBoundThreadId = String(thread.id);
  config.feishuBoundThreadName = String(thread.name || thread.preview || '最近的 Codex 对话');
  await saveConfig();
  return { id: config.feishuBoundThreadId, name: config.feishuBoundThreadName };
}

async function handleFeishuMessage(data) {
  try {
    const message = data?.message || {};
    if (data?.sender?.sender_type === 'app') return;
    const senderId = String(data?.sender?.sender_id?.open_id || '');
    const allow = Array.isArray(config.feishuAllowedUserIds) ? config.feishuAllowedUserIds : [];
    let incomingText = '';
    try { incomingText = String(JSON.parse(message.content || '{}').text || '').replace(/@_user_\d+/g, '').trim(); } catch {}
    if (!senderId) return;
    // First pairing requires a code shown only on this PC, never first-sender trust.
    if (!allow.includes(senderId)) {
      if (allow.length || incomingText !== `绑定 ${feishuPairingCode}`) return;
      config.feishuAllowedUserIds = [senderId];
      config.feishuBoundChatId = String(message.chat_id || '');
      feishuPairingCode = randomBytes(12).toString('hex');
      await saveConfig();
      const thread = await bindLatestFeishuThread();
      await sendFeishuAppText(`操作者验证成功，已绑定本群。\n默认回复对话：${thread.name}\n\n可同时监控多个任务。回复某条任务通知会继续该通知对应的对话；不引用通知的群消息进入默认对话。`, { replyTo: message.message_id, taskId: thread.id });
      return;
    }
    if (/^绑定\s+[a-f0-9]{24}$/i.test(incomingText)) return; // Never submit a replayed pairing secret as a task.
    const messageId = String(message.message_id || '');
    const received = Array.isArray(config.feishuReceivedMessageIds) ? config.feishuReceivedMessageIds.map(String) : [];
    if (messageId && received.includes(messageId)) return;
    if (messageId) {
      config.feishuReceivedMessageIds = [...received, messageId].slice(-200);
      await saveConfig();
    }
    let text = '';
    let input = [];
    if (message.message_type === 'text') {
      try { text = String(JSON.parse(message.content || '{}').text || '').trim(); } catch { return; }
      text = text.replace(/@_user_\d+/g, '').trim();
      if (!text) return;
      input = [{ type: 'text', text }];
    } else if (message.message_type === 'image') {
      let imageKey = '';
      try { imageKey = String(JSON.parse(message.content || '{}').image_key || '').trim(); } catch { return; }
      const imagePath = await downloadFeishuImage(messageId, imageKey);
      input = [{ type: 'text', text: '请查看并处理我从飞书回复的这张图片。' }, { type: 'localImage', path: imagePath }];
    } else return;
    const chatId = String(message.chat_id || '');
    if (!config.feishuBoundChatId && message.message_type !== 'text') {
      await sendFeishuAppText('请先发送“绑定”，再在 Codex 通知下回复图片。', { replyTo: message.message_id });
      return;
    }
    if (!config.feishuBoundChatId || /^(绑定|bind)$/i.test(text)) {
      config.feishuBoundChatId = chatId;
      const thread = await bindLatestFeishuThread();
      await sendFeishuAppText(`已绑定本群\n\n默认回复对话：${thread.name}\n\n这不是任务数量限制。回复任务通知会继续对应对话；不引用通知的消息才进入默认对话。`, { replyTo: message.message_id, taskId: thread.id });
      return;
    }
    if (chatId !== config.feishuBoundChatId) return;
    if (message.message_type === 'text' && isQuotaCommand(text)) {
      await sendFeishuAppText(await currentQuotaText(), { replyTo: message.message_id });
      return;
    }
    const links = config.feishuMessageThreads && typeof config.feishuMessageThreads === 'object' ? config.feishuMessageThreads : {};
    const threadId = links[message.parent_id] || links[message.root_id] || config.feishuBoundThreadId;
    if (!threadId) {
      await sendFeishuAppText('还没有绑定 Codex 对话，请先发送“绑定”。', { replyTo: message.message_id });
      return;
    }
    const task = await continueThreadFromFeishu(String(threadId), input);
    config.feishuBoundThreadId = task.id;
    config.feishuBoundThreadName = String(task.prompt || task.id);
    await saveConfig();
    const backgroundNote = task.remoteDesktopTakeover ? '\n\nCodex 正在后台处理；本轮结束后会自动重新打开桌面端。' : '';
    await sendFeishuAppText(`${message.message_type === 'image' ? '图片已发送' : '已发送'}到原 Codex 对话：${task.prompt || task.id}${backgroundNote}`, { replyTo: message.message_id, taskId: task.id });
  } catch (error) {
    console.error('[feishu reply]', error.message);
    try { await sendFeishuAppText(`没有成功继续 Codex 对话：${humanError(error)}`, { replyTo: data?.message?.message_id || '' }); } catch {}
  }
}

function isActiveWriterError(error) {
  return /already has an active writer|thread-store conflict/i.test(String(error?.message || error || ''));
}

async function continueThreadFromFeishu(threadId, input) {
  try {
    const task = await codex.resumeTask(threadId);
    await codex.continueTask(task, input);
    return task;
  } catch (error) {
    if (!isActiveWriterError(error) || !await isCodexDesktopRunning()) throw error;
  }

  await closeCodexDesktop();
  try {
    let task;
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        task = await codex.resumeTask(threadId);
        break;
      } catch (error) {
        lastError = error;
        if (!isActiveWriterError(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (!task) throw lastError || Error('Codex 桌面端仍在占用这个对话。');
    await codex.continueTask(task, input);
    task.remoteDesktopTakeover = true;
    await rememberDesktopTakeover(threadId);
    return task;
  } catch (error) {
    launchCodexDesktop();
    throw error;
  }
}

function desktopTakeoverIds() {
  return Array.isArray(config.codexDesktopTakeoverThreadIds) ? config.codexDesktopTakeoverThreadIds.map(String) : [];
}

async function rememberDesktopTakeover(threadId) {
  const ids = desktopTakeoverIds();
  if (!ids.includes(String(threadId))) config.codexDesktopTakeoverThreadIds = [...ids, String(threadId)].slice(-20);
  await saveConfig();
}

async function finishDesktopTakeover(threadId) {
  const ids = desktopTakeoverIds();
  if (!ids.includes(String(threadId))) return;
  config.codexDesktopTakeoverThreadIds = ids.filter(id => id !== String(threadId));
  await saveConfig();
  if (!config.codexDesktopTakeoverThreadIds.length) {
    setTimeout(async () => { if (!await isCodexDesktopRunning()) launchCodexDesktop(); }, 800);
  }
}

async function recoverInterruptedDesktopTakeovers() {
  if (!desktopTakeoverIds().length) return;
  config.codexDesktopTakeoverThreadIds = [];
  await saveConfig();
  if (!await isCodexDesktopRunning()) setTimeout(launchCodexDesktop, 800);
}

async function startFeishuLongConnection() {
  try { feishuWsClient?.close({ force: true }); } catch {}
  feishuClient = null; feishuWsClient = null;
  if (!config.feishuAppId || !config.feishuAppSecretProtected) {
    feishuState = { state: 'not_configured', error: '', connectedAt: 0 };
    return;
  }
  const appSecret = await unprotectCredential(config.feishuAppSecretProtected);
  const base = { appId: config.feishuAppId, appSecret };
  feishuClient = new Lark.Client(base);
  feishuState = { state: 'connecting', error: '', connectedAt: 0 };
  feishuWsClient = new Lark.WSClient({
    ...base,
    autoReconnect: true,
    handshakeTimeoutMs: 15000,
    loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => { feishuState = { state: 'connected', error: '', connectedAt: Date.now() }; },
    onReconnecting: () => { feishuState.state = 'reconnecting'; },
    onReconnected: () => { feishuState = { state: 'connected', error: '', connectedAt: Date.now() }; },
    onError: error => { feishuState = { ...feishuState, state: 'failed', error: humanError(error) }; },
  });
  const dispatcher = new Lark.EventDispatcher({}).register({ 'im.message.receive_v1': handleFeishuMessage });
  feishuWsClient.start({ eventDispatcher: dispatcher }).catch(error => { feishuState = { ...feishuState, state: 'failed', error: humanError(error) }; });
}
function authFileFromSwitcherAccount(account) {
  const source = account?.auth_data || {};
  if (!source.id_token || !source.access_token || !source.refresh_token) return null;
  return {
    tokens: {
      id_token: source.id_token,
      access_token: source.access_token,
      refresh_token: source.refresh_token,
      account_id: source.account_id || null,
    },
    last_refresh: new Date().toISOString(),
  };
}
async function nativeVaultStatus() {
  const effective = await readEffectiveNativeVault();
  const vault = effective.vault;
  const backup = await readJson(nativeAccountsBackupPath);
  const source = await readJson(switcherAccountsPath);
  const nativeCount = Array.isArray(vault.accounts) ? vault.accounts.length : 0;
  const sourceCount = Array.isArray(source.accounts) ? source.accounts.length : 0;
  return {
    ready: nativeCount > 0,
    nativeCount,
    sourceCount,
    complete: sourceCount > 0 && nativeCount >= source.accounts.filter(account => authFileFromSwitcherAccount(account)).length,
    encryption: 'Windows DPAPI CurrentUser',
    backupReady: validNativeVault(backup),
    backupCount: validNativeVault(backup) ? backup.accounts.length : 0,
    backupUpdatedAt: validNativeVault(backup) ? (await fs.stat(nativeAccountsBackupPath).catch(() => null))?.mtime?.toISOString() || null : null,
    source: effective.source,
    usingBackup: effective.source === 'backup',
    readError: effective.error,
    dataDirectory: appDir,
  };
}
// Account-storage diagnostics must never hold up the entire dashboard.
let lastPublicVaultStatus = null;
let publicVaultStatusPending = null;
async function boundedNativeVaultStatus() {
  if (!publicVaultStatusPending) {
    publicVaultStatusPending = nativeVaultStatus().then(value => {
      lastPublicVaultStatus = value;
      return value;
    }).catch(error => ({ ready: false, readError: humanError(error) }))
      .finally(() => { publicVaultStatusPending = null; });
  }
  let timer;
  try {
    return await Promise.race([
      publicVaultStatusPending,
      new Promise(resolve => { timer = setTimeout(() => resolve({ ...(lastPublicVaultStatus || { ready: false }), checking: true, readError: '账号库状态查询尚未完成，请稍后刷新。' }), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function queueNativeVaultWrite(action) {
  const next = nativeVaultWriteQueue.then(action, action);
  nativeVaultWriteQueue = next.catch(() => {});
  return next;
}
async function upsertNativeAccount(authContents, metadata = {}) {
  return queueNativeVaultWrite(async () => {
  const auth = typeof authContents === 'string' ? JSON.parse(authContents) : authContents;
  const tokens = auth?.tokens;
  if (!tokens?.id_token || !tokens?.access_token || !tokens?.refresh_token) throw Error('账号登录信息不完整，不能加入原生账号库。');
  const claims = decodeJwtPayload(tokens.id_token);
  const authClaims = claims['https://api.openai.com/auth'] || {};
  const accountId = tokens.account_id || authClaims.chatgpt_account_id || metadata.account_id || null;
  const email = claims.email || metadata.email || null;
  const stableKey = String(metadata.id || accountId || email || randomUUID());
  const identityKeys = [stableKey, accountId, email && String(email).toLowerCase()].filter(Boolean).map(String);
  const deletedKeys = Array.isArray(config.deletedAccountKeys) ? config.deletedAccountKeys.map(String) : [];
  if (metadata.restoreDeleted) {
    config.deletedAccountKeys = deletedKeys.filter(key => !identityKeys.includes(key));
  } else if (identityKeys.some(key => deletedKeys.includes(key))) {
    return null;
  }
  const vault = await readJson(nativeAccountsPath);
  if (!Array.isArray(vault.accounts)) vault.accounts = [];
  vault.version = 1;
  let entry = vault.accounts.find(item => String(item.id) === stableKey)
    || (accountId ? vault.accounts.find(item => item.account_id === accountId) : null)
    || (email ? vault.accounts.find(item => String(item.email || '').toLowerCase() === String(email).toLowerCase()) : null);
  const protectedAuth = await protectCredential(JSON.stringify(auth));
  const next = {
    id: entry?.id || stableKey,
    name: String(metadata.name || entry?.name || email || 'ChatGPT 账号'),
    email: email || entry?.email || null,
    account_id: accountId || entry?.account_id || null,
    plan_type: authClaims.chatgpt_plan_type || metadata.plan_type || entry?.plan_type || null,
    subscription_expires_at: authClaims.chatgpt_subscription_active_until || metadata.subscription_expires_at || entry?.subscription_expires_at || null,
    created_at: entry?.created_at || metadata.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_used_at: metadata.last_used_at || entry?.last_used_at || null,
    last_usage: entry?.last_usage || metadata.last_usage || null,
    last_usage_at: entry?.last_usage_at || metadata.last_usage_at || null,
    reset_count: metadata.reset_count ?? entry?.reset_count ?? null,
    reset_credits_expires_at: metadata.reset_credits_expires_at || entry?.reset_credits_expires_at || null,
    protected_auth: protectedAuth,
  };
  if (entry) Object.assign(entry, next); else vault.accounts.push(next);
  if (metadata.is_active || metadata.id === (await readJson(switcherAccountsPath)).active_account_id) vault.active_account_id = next.id;
  await writeNativeVault(vault);
  return { ...next, protected_auth: undefined };
  });
}
async function updateNativeAccountMetadata(id, patch) {
  return queueNativeVaultWrite(async () => {
    const vault = await readJson(nativeAccountsPath);
    if (!Array.isArray(vault.accounts)) return false;
    const entry = vault.accounts.find(item => String(item.id) === String(id));
    if (!entry) return false;
    Object.assign(entry, patch, { updated_at: new Date().toISOString() });
    await writeNativeVault(vault);
    return true;
  });
}
async function loadNativeAccountsSnapshot() {
  const { vault } = await readEffectiveNativeVault();
  if (!Array.isArray(vault.accounts)) return [];
  const aliases = config.accountAliases && typeof config.accountAliases === 'object' && !Array.isArray(config.accountAliases) ? config.accountAliases : {};
  const deletedKeys = new Set(Array.isArray(config.deletedAccountKeys) ? config.deletedAccountKeys.map(String) : []);
  return vault.accounts.filter(entry => ![entry.id, entry.account_id, entry.email && String(entry.email).toLowerCase()].filter(Boolean).some(key => deletedKeys.has(String(key)))).map(entry => {
    const alias = String(aliases[entry.id] || '').trim();
    return {
      id: entry.id,
      name: entry.email || entry.name,
      email: entry.email || null,
      plan_type: entry.plan_type || null,
      subscription_expires_at: entry.subscription_expires_at || null,
      reset_count: entry.reset_count ?? null,
      reset_credits_expires_at: entry.reset_credits_expires_at || null,
      is_active: String(vault.active_account_id || '') === String(entry.id),
      alias,
      display_name: alias || entry.name || entry.email,
      usage: entry.last_usage ? { ...entry.last_usage, cached: true } : {},
    };
  });
}
async function syncNativePublicMetadata(currentAccounts) {
  return queueNativeVaultWrite(async () => {
    const vault = await readJson(nativeAccountsPath);
    if (!Array.isArray(vault.accounts)) return;
    for (const account of currentAccounts) {
      const entry = vault.accounts.find(item => String(item.id) === String(account.id));
      if (!entry) continue;
      entry.name = account.name || entry.name;
      entry.email = account.email || entry.email;
      entry.plan_type = account.plan_type || entry.plan_type;
      entry.subscription_expires_at = account.subscription_expires_at || entry.subscription_expires_at;
      entry.reset_count = account.reset_count ?? entry.reset_count ?? null;
      if (Object.hasOwn(account, 'reset_credits_expires_at')) entry.reset_credits_expires_at = account.reset_credits_expires_at;
      entry.updated_at = new Date().toISOString();
      if (account.is_active) vault.active_account_id = entry.id;
    }
    await writeNativeVault(vault);
  });
}
async function syncMatchingLiveAuthToNativeVault() {
  if (!existsSync(liveAuthPath)) return false;
  const liveAuth = await readJson(liveAuthPath);
  const liveTokens = liveAuth?.tokens;
  if (!liveTokens?.id_token || !liveTokens?.access_token || !liveTokens?.refresh_token) return false;
  const liveClaims = decodeJwtPayload(liveTokens.id_token);
  const liveAccountId = liveTokens.account_id || liveClaims['https://api.openai.com/auth']?.chatgpt_account_id || null;
  const liveEmail = liveClaims.email ? String(liveClaims.email).toLowerCase() : null;
  const vault = await readJson(nativeAccountsPath);
  if (!Array.isArray(vault.accounts)) return false;
  const entry = vault.accounts.find(item => (liveAccountId && String(item.account_id || '') === String(liveAccountId))
    || (liveEmail && String(item.email || '').toLowerCase() === liveEmail));
  if (!entry) return false;
  const deletedKeys = new Set(Array.isArray(config.deletedAccountKeys) ? config.deletedAccountKeys.map(String) : []);
  if ([entry.id, entry.account_id, entry.email && String(entry.email).toLowerCase()].filter(Boolean).some(key => deletedKeys.has(String(key)))) return false;
  let storedAuth = null;
  try { storedAuth = JSON.parse(await unprotectCredential(entry.protected_auth)); } catch {}
  const storedTokens = storedAuth?.tokens || {};
  const liveExpiry = jwtExpiry(liveTokens.access_token);
  const storedExpiry = jwtExpiry(storedTokens.access_token);
  const sameTokens = liveTokens.access_token === storedTokens.access_token && liveTokens.refresh_token === storedTokens.refresh_token;
  if (sameTokens || (liveExpiry && storedExpiry && liveExpiry <= storedExpiry)) return false;
  await upsertNativeAccount(liveAuth, {
    ...entry,
    id: entry.id,
    is_active: String(vault.active_account_id || '') === String(entry.id),
  });
  nativeUsageCache.delete(String(entry.id));
  return true;
}
async function syncMatchingSwitcherAuthToNativeVault() {
  if (!existsSync(switcherAccountsPath)) return 0;
  const source = await readJson(switcherAccountsPath);
  if (!Array.isArray(source.accounts) || !source.accounts.length) return 0;
  const vault = await readJson(nativeAccountsPath);
  if (!Array.isArray(vault.accounts)) return 0;
  const deletedKeys = new Set(Array.isArray(config.deletedAccountKeys) ? config.deletedAccountKeys.map(String) : []);
  let updated = 0;
  for (const sourceAccount of source.accounts) {
    const auth = authFileFromSwitcherAccount(sourceAccount);
    if (!auth) continue;
    const claims = decodeJwtPayload(auth.tokens.id_token);
    const accountId = auth.tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id || sourceAccount.account_id || null;
    const email = claims.email || sourceAccount.email || null;
    const entry = vault.accounts.find(item => (accountId && String(item.account_id || '') === String(accountId))
      || (email && String(item.email || '').toLowerCase() === String(email).toLowerCase()));
    if (!entry) continue;
    if ([entry.id, entry.account_id, entry.email && String(entry.email).toLowerCase()].filter(Boolean).some(key => deletedKeys.has(String(key)))) continue;
    let storedAuth = null;
    try { storedAuth = JSON.parse(await unprotectCredential(entry.protected_auth)); } catch {}
    const sourceExpiry = jwtExpiry(auth.tokens.access_token);
    const storedExpiry = jwtExpiry(storedAuth?.tokens?.access_token);
    const sameTokens = auth.tokens.access_token === storedAuth?.tokens?.access_token && auth.tokens.refresh_token === storedAuth?.tokens?.refresh_token;
    if (sameTokens || (sourceExpiry && storedExpiry && sourceExpiry <= storedExpiry)) continue;
    await upsertNativeAccount(auth, {
      ...entry,
      id: entry.id,
      is_active: String(vault.active_account_id || '') === String(entry.id),
    });
    nativeUsageCache.delete(String(entry.id));
    updated += 1;
  }
  return updated;
}
async function syncExternalAuthToNativeVault() {
  await syncMatchingLiveAuthToNativeVault();
  await syncMatchingSwitcherAuthToNativeVault();
}
async function setNativeActiveAccount(id) {
  return queueNativeVaultWrite(async () => {
    const vault = await readJson(nativeAccountsPath);
    if (!Array.isArray(vault.accounts) || !vault.accounts.some(item => String(item.id) === String(id))) throw Error('原生账号库中没有这个账号。');
    vault.active_account_id = String(id);
    const entry = vault.accounts.find(item => String(item.id) === String(id));
    entry.last_used_at = new Date().toISOString();
    entry.updated_at = new Date().toISOString();
    await writeNativeVault(vault);
  });
}
async function deleteNativeAccount(id) {
  return queueNativeVaultWrite(async () => {
    const vault = await readJson(nativeAccountsPath);
    if (!validNativeVault(vault)) throw Error('原生账号库不可用，不能删除账号。');
    const index = vault.accounts.findIndex(item => String(item.id) === String(id));
    if (index < 0) throw Error('没有找到要删除的账号。');
    if (String(vault.active_account_id || '') === String(id)) throw Error('当前正在使用的账号不能删除，请先切换到其他账号。');
    const removed = vault.accounts[index];
    const deletedKeys = new Set(Array.isArray(config.deletedAccountKeys) ? config.deletedAccountKeys.map(String) : []);
    for (const key of [removed.id, removed.account_id, removed.email && String(removed.email).toLowerCase()].filter(Boolean)) deletedKeys.add(String(key));
    config.deletedAccountKeys = [...deletedKeys].slice(-300);
    if (config.accountAliases && typeof config.accountAliases === 'object') delete config.accountAliases[String(id)];
    // Persist the tombstone before changing the vault. If the process is interrupted,
    // a legacy source or recovery backup must not silently resurrect the deleted account.
    await saveConfig();
    vault.accounts.splice(index, 1);
    await writeNativeVault(vault);
    nativeUsageCache.delete(String(id));
    subscriptionNotifierState.delete(String(id));
    for (const key of [...quotaNotifierState.keys()]) {
      if (String(key).startsWith(`${id}:`)) quotaNotifierState.delete(key);
    }
    return { ok: true, id: String(id), name: removed.email || removed.name || '账号' };
  });
}
async function replaceLiveAuthAtomically(auth) {
  if (!auth?.tokens?.id_token || !auth?.tokens?.access_token || !auth?.tokens?.refresh_token) throw Error('目标账号凭据不完整，已取消切换。');
  const directory = path.dirname(liveAuthPath);
  const temporary = path.join(directory, `.auth.${randomUUID()}.switching.tmp`);
  const backup = path.join(directory, 'auth.json.companion.bak');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(auth, null, 2), { encoding: 'utf8', flag: 'wx' });
  let replaced = false;
  try {
    const script = "$ErrorActionPreference='Stop';$t=$env:COMPANION_TEMP_AUTH;$d=$env:COMPANION_LIVE_AUTH;$b=$env:COMPANION_BACKUP_AUTH;if([IO.File]::Exists($d)){if([IO.File]::Exists($b)){[IO.File]::Delete($b)};[IO.File]::Replace($t,$d,$b,$true)}else{[IO.File]::Move($t,$d)}";
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, COMPANION_TEMP_AUTH: temporary, COMPANION_LIVE_AUTH: liveAuthPath, COMPANION_BACKUP_AUTH: backup },
    });
    replaced = true;
    const actual = await readJson(liveAuthPath);
    const expectedId = auth.tokens.account_id || decodeJwtPayload(auth.tokens.id_token)['https://api.openai.com/auth']?.chatgpt_account_id;
    const actualId = actual.tokens?.account_id || decodeJwtPayload(actual.tokens?.id_token)['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!actual.tokens?.access_token || (expectedId && actualId !== expectedId)) throw Error('切换后账号身份校验失败。');
    return { backup };
  } catch (error) {
    if (replaced && existsSync(backup)) await fs.copyFile(backup, liveAuthPath).catch(() => {});
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
async function switchNativeAccount(id) {
  if (nativeSwitchInProgress) throw Error('另一次账号切换正在进行，请稍等。');
  nativeSwitchInProgress = true;
  try {
    const vault = await readJson(nativeAccountsPath);
    const target = Array.isArray(vault.accounts) ? vault.accounts.find(item => String(item.id) === String(id)) : null;
    if (!target?.protected_auth) throw Error('原生账号库中没有这个账号的加密凭据。');
    if (String(vault.active_account_id || '') === String(id)) return { alreadyActive: true };
    const previousActiveId = vault.active_account_id || null;
    const currentAuth = await readJson(liveAuthPath);
    if (currentAuth?.tokens?.access_token && previousActiveId) {
      const currentEntry = vault.accounts.find(item => String(item.id) === String(previousActiveId));
      await upsertNativeAccount(currentAuth, currentEntry || { id: previousActiveId });
    }
    const targetAuth = JSON.parse(await unprotectCredential(target.protected_auth));
    const replacement = await replaceLiveAuthAtomically(targetAuth);
    try {
      await setNativeActiveAccount(id);
    } catch (error) {
      if (existsSync(replacement.backup)) await fs.copyFile(replacement.backup, liveAuthPath);
      if (previousActiveId) await setNativeActiveAccount(previousActiveId).catch(() => {});
      throw error;
    }
    accounts = accounts.map(account => ({ ...account, is_active: String(account.id) === String(id) }));
    officialRateLimits = null;
    if (codex) { codex.close(); codex = null; }
    await startTaskEngine();
    refreshAccounts({ forceNative: true, awaitNative: false }).catch(error => console.error('[switch refresh]', humanError(error)));
    return { alreadyActive: false };
  } finally {
    nativeSwitchInProgress = false;
  }
}
async function validateNativeSwitchTarget(id) {
  const vault = await readJson(nativeAccountsPath);
  const target = Array.isArray(vault.accounts) ? vault.accounts.find(item => String(item.id) === String(id)) : null;
  if (!target?.protected_auth) throw Error('原生账号库中没有这个账号的加密凭据，请重新登录后再切换。');
  let auth;
  try { auth = JSON.parse(await unprotectCredential(target.protected_auth)); }
  catch { throw Error('目标账号的本机加密凭据无法读取，请重新登录这个账号。'); }
  if (!auth?.tokens?.id_token || !auth?.tokens?.access_token || !auth?.tokens?.refresh_token) throw Error('目标账号凭据不完整，请重新登录后再切换。');
  const claims = decodeJwtPayload(auth.tokens.id_token);
  const actualAccountId = auth.tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id || null;
  if (target.account_id && actualAccountId && String(target.account_id) !== String(actualAccountId)) throw Error('目标账号身份校验失败，请重新登录这个账号。');
  return { ok: true, id: String(target.id), name: target.email || target.name || String(target.id) };
}
async function migrateSwitcherAccountsToNativeVault() {
  const source = await readJson(switcherAccountsPath);
  if (!Array.isArray(source.accounts) || source.accounts.length === 0) throw Error('没有找到可迁移的 Codex Switcher 账号。');
  let imported = 0;
  let skipped = 0;
  for (const account of source.accounts) {
    const auth = authFileFromSwitcherAccount(account);
    if (!auth) { skipped += 1; continue; }
    const result = await upsertNativeAccount(auth, { ...account, is_active: source.active_account_id === account.id });
    if (result) imported += 1; else skipped += 1;
  }
  return { ok: true, imported, skipped, ...(await nativeVaultStatus()) };
}
async function verifyNativeVaultRoundTrip() {
  const marker = `codex-companion-${randomUUID()}`;
  return (await unprotectCredential(await protectCredential(marker))) === marker;
}
class IsolatedUsageSession {
  constructor(home) { this.home = home; this.proc = null; this.pending = new Map(); this.turnWaiters = new Map(); this.completedTurns = new Map(); this.nextId = 0; this.buffer = ''; }
  async start() {
    const { command, args } = codexLaunch();
    this.proc = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: this.home } });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() || '';
      for (const line of lines) this.receive(line);
    });
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', error => this.rejectAll(error));
    this.proc.on('exit', code => this.rejectAll(new Error(`独立额度进程已退出（${code ?? '-'}）`)));
    await this.request('initialize', { clientInfo: { name: 'codex_companion_usage', title: 'Codex Companion Usage', version: APP_VERSION } }, 30000);
    this.send({ method: 'initialized', params: {} });
  }
  send(value) { if (!this.proc?.stdin?.writable) throw Error('独立额度进程不可用。'); this.proc.stdin.write(`${JSON.stringify(value)}\n`); }
  request(method, params, timeoutMs = 45000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }
  receive(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'turn/completed') {
      const threadId = String(message.params?.threadId || '');
      if (!threadId) return;
      const waiter = this.turnWaiters.get(threadId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.turnWaiters.delete(threadId);
        waiter.resolve(message.params?.turn || {});
      } else this.completedTurns.set(threadId, message.params?.turn || {});
    }
  }
  waitForTurnCompleted(threadId, timeoutMs = 150000) {
    const key = String(threadId);
    if (this.completedTurns.has(key)) {
      const turn = this.completedTurns.get(key);
      this.completedTurns.delete(key);
      return Promise.resolve(turn);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.turnWaiters.delete(key); reject(new Error('最小预热请求等待完成超时')); }, timeoutMs);
      this.turnWaiters.set(key, { resolve, reject, timer });
    });
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.turnWaiters.clear();
  }
  async shutdown() {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 4000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      try { proc.kill(); } catch { clearTimeout(timer); resolve(); }
    });
  }
  close() { try { this.proc?.kill(); } catch {} this.proc = null; }
}
function officialUsageToLegacy(result) {
  const bucket = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  if (!bucket || typeof bucket !== 'object') throw Error('Codex 官方接口没有返回额度窗口。');
  const output = { usage_source: 'Companion 原生凭据 + Codex 官方接口' };
  const resetCredits = result?.rateLimitResetCredits;
  if (Number.isFinite(Number(resetCredits?.availableCount))) output.reset_count = Number(resetCredits.availableCount);
  const creditRows = Array.isArray(resetCredits?.credits) ? resetCredits.credits : [];
  const creditExpiries = creditRows
    .filter(credit => !credit?.status || String(credit.status).toLowerCase() === 'available')
    .map(credit => credit?.expiresAt ?? credit?.expires_at)
    .map(value => typeof value === 'number' ? new Date(value * 1000).toISOString() : value)
    .filter(value => value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const resetExpiry = creditExpiries[0] || resetCredits?.nextExpiresAt || resetCredits?.next_expires_at || resetCredits?.expiresAt || resetCredits?.expires_at;
  if (resetExpiry) output.reset_credits_expires_at = typeof resetExpiry === 'number' ? new Date(resetExpiry * 1000).toISOString() : resetExpiry;
  else if (Array.isArray(resetCredits?.credits)) output.reset_credits_expires_at = null;
  for (const [slot, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]]) {
    if (!window) continue;
    output[`${slot}_used_percent`] = window.usedPercent ?? null;
    output[`${slot}_resets_at`] = window.resetsAt ?? null;
    output[`${slot}_window_minutes`] = window.windowDurationMins ?? null;
  }
  if (output.primary_used_percent == null && output.secondary_used_percent == null) throw Error('Codex 官方接口暂时没有返回可用额度。');
  return output;
}
async function getJsonWithSecretHeaders(url, headers) {
  if (process.platform !== 'win32' || !existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe'))) {
    const response = await fetch(url, { headers });
    const body = await response.text();
    if (!response.ok) throw Error(`重置明细接口返回 HTTP ${response.status}`);
    return JSON.parse(body);
  }
  return await new Promise((resolve, reject) => {
    const curl = spawn('curl.exe', ['--silent', '--show-error', '--request', 'GET', '--header', '@-', '--write-out', '\nCODEX_HTTP_STATUS:%{http_code}', url], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = '';
    curl.stdout.setEncoding('utf8'); curl.stderr.setEncoding('utf8');
    curl.stdout.on('data', chunk => stdout += chunk); curl.stderr.on('data', chunk => stderr += chunk);
    curl.on('error', reject);
    curl.on('exit', code => {
      const marker = '\nCODEX_HTTP_STATUS:';
      const index = stdout.lastIndexOf(marker);
      if (index < 0) return reject(Error(stderr.trim() || `重置明细请求没有返回状态（${code ?? '-'}）`));
      const status = Number(stdout.slice(index + marker.length).trim());
      if (status < 200 || status >= 300) return reject(Error(`重置明细接口返回 HTTP ${status}`));
      try { resolve(JSON.parse(stdout.slice(0, index))); }
      catch { reject(Error('重置明细接口返回了无法识别的数据。')); }
    });
    curl.stdin.end(Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n') + '\n');
  });
}
async function readResetCreditDetails(auth) {
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id || decodeJwtPayload(auth?.tokens?.id_token)['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accessToken || !accountId) return null;
  const details = await getJsonWithSecretHeaders('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
    Authorization: `Bearer ${accessToken}`,
    'ChatGPT-Account-ID': accountId,
  });
  const credits = Array.isArray(details?.credits) ? details.credits.map(credit => ({
    status: credit?.status || null,
    expiresAt: credit?.expires_at || credit?.expiresAt || null,
  })) : null;
  return {
    availableCount: Number.isFinite(Number(details?.available_count)) ? Number(details.available_count) : undefined,
    credits,
  };
}
async function nativeAccountEntry(id) {
  const vault = await readJson(nativeAccountsPath);
  const entry = Array.isArray(vault.accounts) ? vault.accounts.find(item => String(item.id) === String(id)) : null;
  if (!entry?.protected_auth) throw Error('原生账号库中没有这个账号的加密凭据。');
  return entry;
}
async function runIsolatedNativeWarmup(entry) {
  const root = path.join(appDir, 'native-warmup');
  const home = path.join(root, randomUUID());
  const session = new IsolatedUsageSession(home);
  try {
    await fs.mkdir(home, { recursive: true });
    const auth = JSON.parse(await unprotectCredential(entry.protected_auth));
    if (!auth?.tokens?.access_token || !auth?.tokens?.refresh_token) throw Error('账号凭据不完整，无法预热。');
    await atomicJsonWrite(path.join(home, 'auth.json'), auth);
    await session.start();
    const started = await session.request('thread/start', {
      cwd: home,
      model: 'gpt-5.6-luna',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: 'codex_companion_warmup',
      baseInstructions: 'Reply with exactly OK.',
      developerInstructions: 'Do not use tools. Reply with exactly OK.',
    }, 60000);
    const threadId = started?.thread?.id;
    if (!threadId) throw Error('Codex 没有创建预热会话。');
    await session.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'OK' }],
      cwd: home,
      model: 'gpt-5.6-luna',
      effort: 'low',
      approvalPolicy: 'never',
    });
    const turn = await session.waitForTurnCompleted(threadId, 150000);
    if (turn?.status !== 'completed') throw Error(turn?.error?.message || `预热请求没有完成（${turn?.status || '未知状态'}）。`);
    const updatedAuth = await readJson(path.join(home, 'auth.json'));
    if (updatedAuth?.tokens?.access_token && JSON.stringify(updatedAuth) !== JSON.stringify(auth)) await upsertNativeAccount(updatedAuth, entry);
  } finally {
    await session.shutdown();
    const resolvedRoot = path.resolve(root) + path.sep;
    const resolvedHome = path.resolve(home);
    if (resolvedHome.startsWith(resolvedRoot)) await fs.rm(resolvedHome, { recursive: true, force: true }).catch(() => {});
  }
}
async function warmupNativeAccount(id) {
  const key = String(id);
  if (nativeWarmupsInProgress.has(key)) throw Error('这个账号正在预热，请稍等。');
  nativeWarmupsInProgress.add(key);
  try {
    const entry = await nativeAccountEntry(key);
    const publicAccount = accounts.find(item => String(item.id) === key);
    if (Number(publicAccount?.usage?.secondary_used_percent) >= 100) throw Error('这个账号的周额度已经耗尽，不能预热。');
    await runIsolatedNativeWarmup(entry);
    await updateNativeAccountMetadata(key, { last_warmup_at: new Date().toISOString() });
    nativeUsageCache.delete(key);
    await readNativeUsage(await nativeAccountEntry(key), true).catch(error => console.warn('[warmup refresh]', humanError(error)));
    await refreshAccounts({ awaitNative: true }).catch(() => {});
    return { id: key, name: entry.email || entry.name || key };
  } finally { nativeWarmupsInProgress.delete(key); }
}
async function readNativeUsageOnce(entry, force = false) {
  const cached = nativeUsageCache.get(String(entry.id));
  if (!force && cached && Date.now() - cached.at < 4 * 60 * 1000) return cached.usage;
  const root = path.join(appDir, 'native-usage');
  const home = path.join(root, randomUUID());
  const session = new IsolatedUsageSession(home);
  try {
    await fs.mkdir(home, { recursive: true });
    const decrypted = await unprotectCredential(entry.protected_auth);
    const auth = JSON.parse(decrypted);
    if (!auth?.tokens?.access_token || !auth?.tokens?.refresh_token) throw Error('原生账号凭据不完整。');
    await atomicJsonWrite(path.join(home, 'auth.json'), auth);
    await session.start();
    const result = await session.request('account/rateLimits/read', null, 45000);
    if (!Array.isArray(result?.rateLimitResetCredits?.credits)) {
      const refreshedAuth = await readJson(path.join(home, 'auth.json'));
      const details = await readResetCreditDetails(refreshedAuth).catch(error => {
        console.error('[reset credit details]', humanError(error));
        return null;
      });
      if (details) result.rateLimitResetCredits = { ...(result.rateLimitResetCredits || {}), ...details };
    }
    const usage = officialUsageToLegacy(result);
    nativeUsageCache.set(String(entry.id), { at: Date.now(), usage });
    await updateNativeAccountMetadata(entry.id, { last_usage: usage, last_usage_at: new Date().toISOString() });
    const updatedAuth = await readJson(path.join(home, 'auth.json'));
    if (updatedAuth?.tokens?.access_token && JSON.stringify(updatedAuth) !== JSON.stringify(auth)) {
      await upsertNativeAccount(updatedAuth, entry);
    }
    return usage;
  } finally {
    await session.shutdown();
    const resolvedRoot = path.resolve(root) + path.sep;
    const resolvedHome = path.resolve(home);
    if (resolvedHome.startsWith(resolvedRoot)) await fs.rm(resolvedHome, { recursive: true, force: true }).catch(() => {});
  }
}
async function readNativeUsage(entry, force = false) {
  const key = String(entry.id);
  const running = nativeUsageInFlight.get(key);
  if (running) return await running;
  const operation = readNativeUsageOnce(entry, force);
  nativeUsageInFlight.set(key, operation);
  try { return await operation; }
  finally { if (nativeUsageInFlight.get(key) === operation) nativeUsageInFlight.delete(key); }
}
async function readNativeUsages(force = false) {
  const vault = await readJson(nativeAccountsPath);
  if (!Array.isArray(vault.accounts) || !vault.accounts.length) return new Map();
  const deletedKeys = new Set(Array.isArray(config.deletedAccountKeys) ? config.deletedAccountKeys.map(String) : []);
  const visibleEntries = vault.accounts.filter(entry => ![entry.id, entry.account_id, entry.email && String(entry.email).toLowerCase()]
    .filter(Boolean).some(key => deletedKeys.has(String(key))));
  const pairs = await Promise.all(visibleEntries.map(async entry => {
    try { return [String(entry.id), await readNativeUsage(entry, force)]; }
    catch (error) { return [String(entry.id), { error: humanError(error), usage_source: 'Companion 原生凭据' }]; }
  }));
  return new Map(pairs);
}
async function importOrUpdateAccount(contents, requestedName) {
  const auth = JSON.parse(contents);
  const claims = decodeJwtPayload(auth?.tokens?.id_token);
  const authClaims = claims['https://api.openai.com/auth'] || {};
  const accountId = auth?.tokens?.account_id || authClaims.chatgpt_account_id || null;
  const email = claims.email || null;
  const vault = await readJson(nativeAccountsPath);
  const existing = Array.isArray(vault.accounts) ? vault.accounts.find(item => (accountId && item.account_id === accountId) || (email && String(item.email || '').toLowerCase() === String(email).toLowerCase())) : null;
  const imported = await upsertNativeAccount(auth, {
    id: existing?.id,
    restoreDeleted: true,
    name: String(requestedName || '').trim() || existing?.name || email || 'ChatGPT 账号',
    email,
    plan_type: authClaims.chatgpt_plan_type || existing?.plan_type || null,
    subscription_expires_at: authClaims.chatgpt_subscription_active_until || existing?.subscription_expires_at || null,
  });
  // Persisted login is complete even if external quota endpoints are slow.
  accounts = await loadNativeAccountsSnapshot().catch(() => accounts);
  refreshAccounts({ forceNative: true, awaitNative: false }).catch(() => console.error('[login quota refresh] failed'));
  return { ...imported, updated: Boolean(existing) };
}
function loginBusy() {
  return [...tasks.values()].some(task => ['starting', 'running', 'waiting_confirmation'].includes(task.status));
}
function base64Url(value) { return Buffer.from(value).toString('base64url'); }
function startBrowserLogin(name) {
  if (browserLoginInFlight) throw Error('正在处理本次登录，请等待结果，不要重复生成链接。');
  if (loginBusy()) throw Error('还有 Companion 任务正在运行或等待确认。请先处理任务，再登录或更新账号。');
  const verifier = base64Url(randomBytes(64));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = base64Url(randomBytes(32));
  const redirectUri = 'http://localhost:1455/auth/callback';
  const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
  const url = new URL('https://auth.openai.com/oauth/authorize');
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke', code_challenge: challenge, code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state, originator: 'codex_cli_rs' })) url.searchParams.set(key, value);
  browserLogin = { status: 'waiting', name: String(name || '').trim(), verifier, state, redirectUri, clientId, authUrl: url.toString(), startedAt: Date.now(), message: '请在登录页完成授权，然后复制最后打不开的 localhost 地址。' };
  return browserLoginPublic();
}
function browserLoginPublic() {
  if (!browserLogin) return { status: 'idle' };
  return { status: browserLogin.status, message: browserLogin.message || '', errorCode: browserLogin.errorCode || '',
    step: browserLogin.step || '', accountName: browserLogin.accountName || '',
    canRetrySave: browserLogin.status === 'failed' && !!browserLogin.pendingAuth,
    ...(browserLogin.status === 'waiting' ? { authUrl: browserLogin.authUrl } : {}) };
}
async function browserSystemProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) return '';
  try {
    const script = "$ErrorActionPreference='Stop';$target=[Uri]'https://auth.openai.com';$proxy=[Net.WebRequest]::GetSystemWebProxy().GetProxy($target);if($proxy -and $proxy.AbsoluteUri -ne $target.AbsoluteUri){[Console]::Out.Write($proxy.AbsoluteUri)}";
    const result = await execFileAsync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const url = new URL(String(result.stdout || '').trim());
    if (['http:','https:'].includes(url.protocol) && !url.username && !url.password) return url.toString();
  } catch {}
  return '';
}
async function postFormThroughSystemProxy(url, form) {
  if (process.platform !== 'win32' || !existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe'))) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.text() };
  }
  const proxy = await browserSystemProxy();
  return await new Promise((resolve, reject) => {
    const curl = spawn('curl.exe', ['--silent', '--show-error', '--connect-timeout','10','--max-time','30', ...(proxy ? ['--proxy',proxy] : []), '--request', 'POST', '--header', 'Content-Type: application/x-www-form-urlencoded', '--data-binary', '@-', '--write-out', '\nCODEX_HTTP_STATUS:%{http_code}', url], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = '';
    curl.stdout.setEncoding('utf8'); curl.stderr.setEncoding('utf8');
    curl.stdout.on('data', chunk => stdout += chunk); curl.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { curl.kill(); reject(Error('LOGIN_NETWORK_TIMEOUT')); }, 35000);
    curl.stdin.on('error', () => {});
    curl.on('error', () => { clearTimeout(timer); reject(Error('LOGIN_NETWORK_ERROR')); });
    curl.on('close', code => {
      clearTimeout(timer);
      const marker = '\nCODEX_HTTP_STATUS:';
      const index = stdout.lastIndexOf(marker);
      if (code !== 0 || index < 0) return reject(Error(code === 28 ? 'LOGIN_NETWORK_TIMEOUT' : 'LOGIN_NETWORK_ERROR'));
      resolve({ status: Number(stdout.slice(index + marker.length).trim()), body: stdout.slice(0, index) });
    });
    curl.stdin.end(form.toString());
  });
}
async function completeBrowserLogin(callbackUrl) {
  if (browserLogin?.status === 'completed') return browserLoginPublic();
  if (!browserLogin || !['waiting','importing','failed'].includes(browserLogin.status)) throw Error('这次网页登录已经失效，请重新点击“普通网页登录”。');
  const login = browserLogin;
  const fail = (code, message, terminal = true) => { login.errorCode = code; login.message = message; if (terminal) login.status = 'failed'; return Error(`[${code}] ${message}`); };
  if (Date.now() - login.startedAt > 15 * 60 * 1000) { delete login.pendingAuth; throw fail('LOGIN_EXPIRED','本次登录已超过15分钟，请重新生成登录链接。'); }
  if (browserLoginInFlight) return browserLoginInFlight;
  if (login.status === 'failed' && !login.pendingAuth) throw Error(`[${login.errorCode}] ${login.message} 请重新点击“通用网页登录”。`);
  let code = '';
  if (!login.pendingAuth) {
  let callback;
  try { callback = new URL(String(callbackUrl || '').trim()); } catch { throw fail('CALLBACK_INVALID','请复制最后的完整 localhost 回调地址。',false); }
  if (callback.protocol !== 'http:' || callback.hostname !== 'localhost' || callback.port !== '1455' || callback.pathname !== '/auth/callback') throw fail('CALLBACK_INVALID','地址不对，请复制最后的完整 localhost:1455 回调地址。',false);
  if (callback.searchParams.get('state') !== login.state) throw fail('CALLBACK_MISMATCH','该地址属于旧登录，请复制当前授权窗口最后的地址。',false);
  if (callback.searchParams.get('error')) throw fail('AUTH_DENIED','授权未通过，请重新生成链接并确认授权。');
  code = callback.searchParams.get('code');
  if (!code) throw fail('CALLBACK_INCOMPLETE','地址缺少授权结果，请在授权页面完成继续操作。',false);
  }
  login.status = 'importing'; login.errorCode = ''; login.step = login.pendingAuth ? 'save' : 'exchange';
  login.message = login.pendingAuth ? '授权已完成，正在加密保存账号……' : '授权地址已收到，正在连接 OpenAI 交换登录凭据（约35秒内返回结果）……';
  browserLoginInFlight = Promise.resolve().then(async () => {
    if (!login.pendingAuth) {
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: login.redirectUri, client_id: login.clientId, code_verifier: login.verifier });
      let response;
      try { response = await postFormThroughSystemProxy('https://auth.openai.com/oauth/token', form); }
      catch (error) { throw fail(error.message === 'LOGIN_NETWORK_TIMEOUT' || /timeout|abort/i.test(error.name || '') ? 'LOGIN_NETWORK_TIMEOUT' : 'LOGIN_NETWORK_ERROR','后台无法完成 OpenAI 登录连接，请检查代理/网络，然后重新生成登录链接。'); }
      let result = {}; try { result = JSON.parse(response.body); } catch {}
      if (response.status < 200 || response.status >= 300) {
        const remoteCode = typeof result.error === 'string' ? result.error : result.error?.code;
        if (remoteCode === 'invalid_grant') throw fail('AUTH_CODE_REJECTED','授权结果过期或已被使用，请重新生成链接，不要重复提交旧地址。');
        throw fail('TOKEN_HTTP_ERROR',`OpenAI 凭据交换未通过（HTTP ${Number(response.status) || 0}），请检查后台代理/网络或账号授权后重新生成链接。`);
      }
      if (!result.id_token || !result.access_token || !result.refresh_token) throw fail('TOKEN_INCOMPLETE','授权服务未返回完整登录凭据，请重新登录。');
      const claims = decodeJwtPayload(result.id_token);
      login.pendingAuth = JSON.stringify({ tokens: { id_token: result.id_token, access_token: result.access_token, refresh_token: result.refresh_token, account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || null }, last_refresh: new Date().toISOString() });
    }
    login.step = 'save'; login.message = '授权已完成，正在加密保存账号……';
    let imported;
    try { imported = await importOrUpdateAccount(login.pendingAuth, login.name); if (!imported?.id) throw Error('Missing saved account'); }
    catch { throw fail('ACCOUNT_SAVE_FAILED','授权成功，但本机账号保存失败。可点击“重试保存”，不用再次授权；若仍失败请发送此错误编号。'); }
    delete login.pendingAuth; delete login.verifier; delete login.authUrl;
    login.status = 'completed'; login.step = 'done'; login.accountName = imported.name || imported.email || '账号';
    login.message = `${imported.updated ? '原有账号登录已更新。' : '新账号已保存。'}额度正在后台读取，不影响账号录入。`;
    return browserLoginPublic();
  }).finally(() => { browserLoginInFlight = null; });
  return browserLoginInFlight;
}
function withoutLegacyQuotaWindows(usage = {}) {
  const result = { ...usage };
  for (const slot of ['primary', 'secondary']) {
    delete result[`${slot}_used_percent`];
    delete result[`${slot}_resets_at`];
    delete result[`${slot}_window_minutes`];
  }
  delete result.error;
  return result;
}
async function applyNativeUsageMap(nativeUsages) {
  if (!(nativeUsages instanceof Map) || !nativeUsages.size) return;
  accounts = accounts.map(account => {
    const nativeUsage = nativeUsages.get(String(account.id));
    if (!nativeUsage) return account;
    if (nativeUsage.error) return { ...account, usage: { ...(account.usage || {}), error: nativeUsage.error, usage_source: nativeUsage.usage_source } };
    return {
      ...account,
      reset_count: nativeUsage.reset_count ?? account.reset_count ?? null,
      reset_credits_expires_at: Object.hasOwn(nativeUsage, 'reset_credits_expires_at') ? nativeUsage.reset_credits_expires_at : account.reset_credits_expires_at || null,
      usage: { ...withoutLegacyQuotaWindows(account.usage), ...nativeUsage },
    };
  });
  await syncNativePublicMetadata(accounts).catch(error => console.error('[native metadata]', error.message));
  lastAccountRefreshAt = Date.now();
  await checkQuotaNotices();
}
async function refreshAccounts({ forceNative = false, awaitNative = false } = {}) {
  await syncExternalAuthToNativeVault().catch(error => console.error('[external auth sync]', humanError(error)));
  const nativePromise = readNativeUsages(forceNative).catch(error => { console.error('[native usage]', error.message); return new Map(); });
  const nativeSnapshot = await loadNativeAccountsSnapshot();
  accounts = nativeSnapshot;
  if (codex?.proc) {
    try {
      const response = await codex.request('account/rateLimits/read');
      officialRateLimits = response.rateLimitsByLimitId?.codex || response.rateLimits || null;
    } catch (e) {
      console.error('[official usage]', e.message);
    }
  }
  const active = accounts.find(account => account.is_active);
  if (active && officialRateLimits) {
    const usage = active.usage || {};
    const merged = { ...usage };
    for (const window of [officialRateLimits.primary, officialRateLimits.secondary].filter(Boolean)) {
      const matchingSlot = ['primary', 'secondary'].find(slot => Number(merged[`${slot}_window_minutes`]) === Number(window.windowDurationMins));
      const emptySlot = ['primary', 'secondary'].find(slot => merged[`${slot}_used_percent`] == null && merged[`${slot}_window_minutes`] == null);
      const slot = matchingSlot || emptySlot;
      if (!slot) continue;
      merged[`${slot}_used_percent`] ??= window.usedPercent ?? null;
      merged[`${slot}_resets_at`] ??= window.resetsAt ?? null;
      merged[`${slot}_window_minutes`] ??= window.windowDurationMins ?? null;
    }
    active.usage = { ...merged, usage_source: 'Companion 原生凭据 + Codex 官方接口' };
  }
  const aliases = config.accountAliases && typeof config.accountAliases === 'object' && !Array.isArray(config.accountAliases) ? config.accountAliases : {};
  accounts = accounts.map(account => {
    const alias = String(aliases[account.id] || '').trim();
    return { ...account, alias, display_name: alias || account.name };
  });
  lastAccountRefreshAt = Date.now();
  await checkQuotaNotices();
  if (awaitNative) await applyNativeUsageMap(await nativePromise);
  else nativePromise.then(applyNativeUsageMap).catch(error => console.error('[native usage apply]', error.message));
  return accounts;
}
async function notify(text, opts = {}) {
  if (!config.feishuWebhookUrl && !(feishuClient && config.feishuBoundChatId)) return { ok: false, reason: 'feishu-not-configured' };
  const appName = normalizeAppName(opts.appName);
  const blacklist = Array.isArray(config.notificationBlacklist) ? config.notificationBlacklist : [];
  if (blacklist.includes(appName)) {
    const entry = { at: Date.now(), appName, body: trim(text, 3800), sent: false, reason: 'muted' };
    pushHistory(entry);
    saveConfig().catch(() => {});
    return { ok: false, reason: 'muted' };
  }
  try {
    const embeddedTaskId = await inferNotificationTaskId(text, opts.taskId);
    let messageId = '';
    if (feishuClient && config.feishuBoundChatId) {
      messageId = (await sendFeishuAppText(text, { taskId: embeddedTaskId })).messageId || '';
    } else {
      const response = await fetch(config.feishuWebhookUrl, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ msg_type: 'post', content: { post: buildFeishuPost(text) } }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json().catch(() => ({}));
      if (result.code && result.code !== 0) throw new Error(result.msg || `飞书错误 ${result.code}`);
    }
    pushHistory({ at: Date.now(), appName, body: trim(text, 3800), sent: true });
    saveConfig().catch(() => {});
    return { ok: true, messageId };
  } catch (e) {
    pushHistory({ at: Date.now(), appName, body: trim(text, 3800), sent: false, reason: e.message });
    saveConfig().catch(() => {});
    console.error('[feishu]', e.message);
    return { ok: false, reason: e.message };
  }
}
function quotaLabel(windowMinutes, fallback) {
  const minutes = Number(windowMinutes);
  if (minutes === 300) return '5 小时额度';
  if (minutes === 10080) return '周额度';
  if (minutes === 43200) return '月额度';
  if (Number.isFinite(minutes) && minutes > 0) return `${minutes} 分钟额度`;
  return fallback;
}
function isQuotaCommand(value) {
  return /^(额度|查询额度|查额度|quota)$/i.test(String(value || '').replace(/\s+/g, ''));
}
function formatQuotaReset(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric * 1000) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN');
}
function formatQuotaStatus(account) {
  if (!account) return '当前没有可用账号，暂时无法读取额度。';
  const name = String(account.display_name || account.alias || account.name || account.email || '当前账号');
  const lines = [`当前账号：${name}`];
  if (account.usage?.error) {
    lines.push(`状态：${humanError(account.usage.error)}`);
    return lines.join('\n');
  }
  let found = false;
  for (const [slot, fallback] of [['primary', '5 小时额度'], ['secondary', '周额度']]) {
    const used = Number(account.usage?.[`${slot}_used_percent`]);
    if (!Number.isFinite(used)) continue;
    found = true;
    const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
    const label = quotaLabel(account.usage?.[`${slot}_window_minutes`], fallback);
    const reset = formatQuotaReset(account.usage?.[`${slot}_resets_at`]);
    lines.push(`${label}：剩余 ${remaining}%${reset ? ` · 重置 ${reset}` : ''}`);
  }
  if (!found) lines.push('额度：暂未读取到，请稍后再试。');
  return lines.join('\n');
}
async function currentQuotaText() {
  try {
    await refreshAccounts({ forceNative: true, awaitNative: true });
    return formatQuotaStatus(accounts.find(account => account.is_active));
  } catch (error) {
    console.error('[quota query]', error.message);
    return '额度：本次读取失败，请稍后再试。';
  }
}
function dashboardLink(fragment = '') {
  const base = String(config.publicDashboardUrl || '').trim().replace(/\/$/, '') || `http://127.0.0.1:${config.port}`;
  return `${base}/${fragment}`;
}
function confirmationDetails(method, params) {
  if (method?.includes('requestUserInput')) {
    return (params.questions || []).map(question => {
      const options = (question.options || []).map(option => option.label).join(' / ');
      return `${question.header || '问题'}：${question.question}${options ? `\n选项：${options}` : ''}`;
    }).join('\n');
  }
  return `原因：${params.reason || ''}\n命令：${Array.isArray(params.command) ? params.command.join(' ') : params.command || ''}`;
}
function observeQuotaRecovery(observations, key, used) {
  if (!Number.isFinite(used) || used < 0 || used > 100) return false;
  const previous = observations[key];
  observations[key] = used;
  return Number.isFinite(previous) && previous > 0 && used === 0;
}
async function checkQuotaNotices() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const restored = [];
  if (!config.quotaRecoveryObservations || typeof config.quotaRecoveryObservations !== 'object' || Array.isArray(config.quotaRecoveryObservations)) config.quotaRecoveryObservations = {};
  let recoveryObservationsChanged = false;
  const accountStillExists = account => accounts.some(current => String(current.id) === String(account.id));
  for (const account of accounts) {
    // A prior notification can yield to the HTTP handler. Re-check membership so an
    // account deleted while this scan is running cannot receive a later stale notice.
    if (!accountStillExists(account)) continue;
    const expiry = Date.parse(account.reset_credits_expires_at || '') / 1000;
    if (Number.isFinite(expiry) && expiry > nowSeconds) {
      const daysLeft = (expiry - nowSeconds) / 86400;
      const key = String(account.id);
      const previous = subscriptionNotifierState.get(key);
      const todayKey = shanghaiDayKey(Date.now());
      const alreadySentToday = sentQuotaNoticeToday(`账号：${account.name}`, '重置次数将在 7 天内到期');
      const state = previous && previous.expiresAt === expiry ? previous : { expiresAt: expiry, sent: {}, lastDay: alreadySentToday ? todayKey : null };
      if (daysLeft <= 7) {
        const dayKey = todayKey;
        if (state.lastDay !== dayKey) {
          state.lastDay = dayKey;
          subscriptionNotifierState.set(key, state);
          await notify(`Codex 重置次数将在 7 天内到期\n账号：${account.name}\n剩余次数：${account.reset_count ?? '--'}\n到期时间：${new Date(expiry * 1000).toLocaleString('zh-CN')}`, { appName: 'Codex 额度' });
        }
      }
      subscriptionNotifierState.set(key, state);
    }
    for (const [fallbackLabel, usedKey, resetKey, windowKey] of [
      ['主要额度', 'primary_used_percent', 'primary_resets_at', 'primary_window_minutes'],
      ['次要额度', 'secondary_used_percent', 'secondary_resets_at', 'secondary_window_minutes'],
    ]) {
      if (!accountStillExists(account)) break;
      const label = quotaLabel(account.usage?.[windowKey], fallbackLabel);
      const used = Number(account.usage?.[usedKey]);
      const resetAt = Number(account.usage?.[resetKey]);
      const key = `${account.id}:${label}`;
      const previous = quotaNotifierState.get(key);
      const state = previous || { state: 'normal', resetSoonNotified: false, resetCycle: resetAt || 0 };
      // Only observe fresh successful readings. Cached snapshots and failed reads
      // must not re-arm a recovery notice or turn a missing window into 100%.
      if (!account.usage?.cached && !account.usage?.error && account.usage?.[usedKey] != null) {
        const recoveryKey = `${account.id}:${Number(account.usage?.[windowKey]) || label}`;
        if (observeQuotaRecovery(config.quotaRecoveryObservations, recoveryKey, used)) {
          restored.push({ id: account.id, account: account.display_name || account.name, type: label });
        }
        recoveryObservationsChanged = true;
      }
      state.previousUsed = Number.isFinite(used) ? used : state.previousUsed;
      quotaNotifierState.set(key, state);

      if (Number.isFinite(used)) {
        // 检测 resetAt 滚动了（额度真的回到了起点），把状态归位 normal、下次的「即将重置」可再次发送
        if (Number.isFinite(resetAt) && state.resetCycle && resetAt > state.resetCycle) {
          quotaNotifierState.set(key, { ...state, state: 'normal', resetSoonNotified: false, resetCycle: resetAt });
        }
      }

      if (Number.isFinite(used) && used >= 100) {
        if (state.state !== 'exhausted') {
          quotaNotifierState.set(key, { ...(quotaNotifierState.get(key) || { resetCycle: resetAt || 0 }), state: 'exhausted', resetSoonNotified: false, previousUsed: used });
          const alreadySentToday = sentQuotaNoticeToday('Codex 额度已用尽', `账号：${account.name}`, `类型：${label}`);
          if (!alreadySentToday) await notify(`Codex 额度已用尽\n账号：${account.name}\n类型：${label}\n下次重置：${resetAt ? new Date(resetAt * 1000).toLocaleString('zh-CN') : '暂未返回'}\n\n${dashboardLink()}`, { appName: 'Codex 额度' });
        }
      } else if (Number.isFinite(used) && used < 100) {
        // 一旦额度回落到非 100%，清空已发过的状态机，下次再耗尽会重新通知
        if (state.state === 'exhausted') quotaNotifierState.set(key, { ...state, state: 'normal', resetSoonNotified: false, resetCycle: resetAt || state.resetCycle });
      }
      const remainingSeconds = resetAt - nowSeconds;
      if (resetAt > 0 && remainingSeconds > 0 && remainingSeconds <= config.resetReminderMinutes * 60) {
        const fresh = quotaNotifierState.get(key) || state;
        if (fresh.state !== 'exhausted' && !fresh.resetSoonNotified) {
          quotaNotifierState.set(key, { ...fresh, resetSoonNotified: true });
          await notify(`Codex 额度即将重置\n账号：${account.name}\n类型：${label}\n重置时间：${new Date(resetAt * 1000).toLocaleString('zh-CN')}`, { appName: 'Codex 额度' });
        }
      }
    }
  }
  // Save before sending: restarting Companion must not repeat the same recovery.
  if (recoveryObservationsChanged) await saveConfig();
  const currentRestored = restored.filter(item => accounts.some(account => String(account.id) === String(item.id)));
  if (currentRestored.length) {
    const lines = currentRestored.map(item => `账号：${item.account} · ${item.type} · 剩余 100%`).join('\n');
    await notify(`Codex 额度已恢复至 100%\n${lines}\n\n使用重置卡、官方重置或额度窗口重置都会触发此通知。`, { appName: 'Codex 额度' });
  }
}

function activeQuotaSnapshot() {
  const account = accounts.find(item => item.is_active);
  const used = Number(account?.usage?.primary_used_percent);
  if (!account || !Number.isFinite(used)) return null;
  return { accountId: account.id, accountName: account.name, used };
}

async function refreshQuotaFromBaseline(baseline, details = {}) {
  if (!baseline) return;
  let current = null;
  for (const waitMs of [2500, 20000]) {
    await new Promise(resolve => setTimeout(resolve, waitMs));
    try { await refreshAccounts(); } catch (error) { console.error('[task quota refresh]', error.message); continue; }
    current = activeQuotaSnapshot();
    if (!current || current.accountId !== baseline.accountId) return;
    if (current.used !== baseline.used) break;
  }
  if (!current) return;
  const deltaRemaining = Math.round((baseline.used - current.used) * 10) / 10;
  lastQuotaDelta = {
    id: randomUUID(), ...details, accountId: current.accountId,
    accountName: current.accountName, deltaRemaining, at: new Date().toISOString(),
  };
}

async function refreshQuotaAfterTask(task) {
  return refreshQuotaFromBaseline(task.quotaBaseline, { taskId: task.id, source: 'companion' });
}

function decodeXmlText(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function formatNotificationAppName(handlerId) {
  if (!handlerId) return '未知应用';
  const id = String(handlerId);
  if (id.includes('OpenAI.Codex')) return 'Codex';
  if (/^com\.matchtools\./i.test(id)) return 'Match Tools';
  if (/^WorkBuddy\./i.test(id)) return 'WorkBuddy';
  if (/^Adobe\.CreativeCloud/i.test(id)) return 'Adobe Creative Cloud';
  if (/^Microsoft\.ScreenSketch/i.test(id)) return 'Windows 截图工具';
  if (/^\{[0-9a-f-]+\}$/i.test(id)) return '系统托盘应用';
  // 把 Windows 包标识简化为可读名称，避免出现无意义的 app。
  const clean = id.replace(/!App$/, '').replace(/_[a-z0-9]{13}$/i, '');
  const parts = clean.split('.');
  const readable = parts.filter(part => !['com', 'app', 'microsoft', 'windows'].includes(part.toLowerCase())).pop();
  return readable || clean || id;
}

async function listCodexSessionFiles(directory, result = []) {
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await listCodexSessionFiles(fullPath, result);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(fullPath);
  }
  return result;
}

function sessionThreadId(file) {
  return path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] || '';
}

function sessionKindFromMeta(payload) {
  if (payload?.thread_source === 'subagent' || payload?.source?.subagent) return 'subagent';
  return String(payload?.thread_source || 'unknown');
}
function observeSessionPrompt(event, threadId) {
  if (event?.type !== 'response_item' || event.payload?.type !== 'message') return;
  const parts = Array.isArray(event.payload.content) ? event.payload.content.filter(item => item?.type === 'input_text').map(item => String(item.text || '')) : [];
  const raw = parts.join('\n');
  const request = raw.split(/##\s*My request\s*:/i)[1] || raw;
  const title = request.replace(/# Files mentioned by the user:[\s\S]*?(?=##\s*My request\s*:|$)/i, '').split(/\r?\n/).map(line => line.trim()).find(line => line && !/^<image\b/i.test(line)) || '';
  if (!title) return;
  const previous = sessionActivities.get(threadId) || { id: threadId, source: 'desktop', status: 'unknown', title: '', cwd: '' };
  if (!previous.title || previous.title === 'Codex') previous.title = title.slice(0, 100);
  sessionActivities.set(threadId, previous);
}
function observeSessionMeta(payload, threadId) {
  if (!payload || !threadId) return;
  const previous = sessionActivities.get(threadId) || { id: threadId, source: 'desktop', status: 'unknown', title: '', cwd: '' };
  if (payload.cwd) previous.cwd = String(payload.cwd);
  sessionActivities.set(threadId, previous);
}
function projectLabel(cwd = '') {
  const value = String(cwd || '').replace(/[\\/]+$/, '');
  return value ? path.basename(value) : 'Codex';
}
async function taskConversationLabel(taskId, fallback = '', cwd = '') {
  const activity = sessionActivities.get(String(taskId));
  let project = projectLabel(cwd || activity?.cwd || tasks.get(String(taskId))?.cwd);
  let conversation = String(fallback || activity?.title || tasks.get(String(taskId))?.prompt || '').trim();
  if (codex?.proc) {
    try {
      const thread = (await codex.listThreads(50, '')).find(item => String(item.id) === String(taskId));
      if (thread) {
        project = projectLabel(thread.cwd || cwd || activity?.cwd);
        conversation = String(thread.name || thread.preview || conversation).trim();
      }
    } catch {}
  }
  return `${project || 'Codex'}｜${conversation || String(taskId || '当前对话')}`;
}
async function completionNotice({ taskId, status, body, cwd = '' }) {
  const label = await taskConversationLabel(taskId, '', cwd);
  return `${label}\n\n${String(body || '').trim()}\n\n${dashboardLink(`#task=${encodeURIComponent(taskId || '')}`)}\n\n状态：${status}`;
}

async function readCodexSessionKind(file) {
  try {
    const handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(16384);
    let bytesRead = 0;
    try { ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0)); } finally { await handle.close(); }
    const prefix = buffer.subarray(0, bytesRead).toString('utf8');
    if (/"thread_source"\s*:\s*"subagent"|"source"\s*:\s*\{\s*"subagent"/i.test(prefix)) return 'subagent';
    const match = prefix.match(/"thread_source"\s*:\s*"([^"]+)"/i);
    return match?.[1] || 'unknown';
  } catch { return 'unknown'; }
}

async function markCodexTurnComplete(turnId) {
  const id = String(turnId || '').trim();
  if (!id) return true;
  const completed = Array.isArray(config.codexCompletedTurnIds) ? config.codexCompletedTurnIds.map(String) : [];
  if (completed.includes(id)) return false;
  config.codexCompletedTurnIds = [...completed, id].slice(-300);
  await saveConfig();
  return true;
}

async function processCodexSessionAppend(file) {
  try {
    const stat = await fs.stat(file);
    let offset = codexSessionOffsets.get(file);
    if (offset == null) offset = 0;
    if (stat.size < offset) { offset = 0; codexSessionPartials.delete(file); }
    if (stat.size === offset) return;
    const length = stat.size - offset;
    const handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(length);
    try { await handle.read(buffer, 0, length, offset); } finally { await handle.close(); }
    codexSessionOffsets.set(file, stat.size);
    const combined = (codexSessionPartials.get(file) || '') + buffer.toString('utf8');
    const lines = combined.split(/\r?\n/);
    codexSessionPartials.set(file, lines.pop() || '');
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type === 'session_meta') {
        codexSessionKinds.set(file, sessionKindFromMeta(event.payload));
        observeSessionMeta(event.payload, sessionThreadId(file));
        continue;
      }
      observeSessionPrompt(event, sessionThreadId(file));
      observeSessionActivity(event, codexSessionKinds.get(file) || 'unknown', sessionThreadId(file));
      if (event?.type === 'event_msg' && event?.payload?.type === 'item_completed' && event.payload.item?.type === 'imageGeneration') {
        const savedPath = String(event.payload.item.savedPath || '').trim();
        const key = `${file}:${String(event.payload.turn_id || '')}`;
        if (savedPath) codexSessionImagePaths.set(key, [...new Set([...(codexSessionImagePaths.get(key) || []), savedPath])].slice(0, 6));
        continue;
      }
      if (event?.type !== 'event_msg' || event?.payload?.type !== 'task_complete') continue;
      const cachedKind = codexSessionKinds.get(file) || 'unknown';
      const freshKind = await readCodexSessionKind(file);
      const sessionKind = freshKind !== 'unknown' ? freshKind : cachedKind;
      codexSessionKinds.set(file, sessionKind);
      if (sessionKind !== 'user') {
        console.log(`[codex session monitor] ignored ${sessionKind} completion: ${sessionThreadId(file) || path.basename(file)}`);
        continue;
      }
      const turnId = String(event.payload.turn_id || '');
      const threadId = sessionThreadId(file);
      const message = String(event.payload.last_agent_message || '').trim();
      if (!message) continue;
      const imagePaths = codexSessionImagePaths.get(`${file}:${turnId}`) || [];
      codexSessionImagePaths.delete(`${file}:${turnId}`);
      await finishDesktopTakeover(threadId);
      await notifyTurnResult(await completionNotice({ taskId: threadId, status: 'completed', body: message, cwd: sessionActivities.get(threadId)?.cwd }), { taskId: threadId, turnId, finalText: message, imagePaths });
    }
  } catch (error) { console.error('[codex session monitor]', error.message); }
}

async function startCodexSessionMonitor() {
  const root = path.join(process.env.USERPROFILE || '', '.codex', 'sessions');
  if (!existsSync(root)) return;
  for (const file of await listCodexSessionFiles(root)) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat) {
      codexSessionOffsets.set(file, stat.size);
      codexSessionKinds.set(file, await readCodexSessionKind(file));
      await seedSessionActivity(file, codexSessionKinds.get(file), stat).catch(error => console.error('[activity seed]', error.message));
    }
  }
  try {
    codexSessionWatcher = watchFs(root, { recursive: true }, (_eventType, filename) => {
      if (!filename || !String(filename).endsWith('.jsonl')) return;
      const file = path.join(root, String(filename));
      clearTimeout(codexSessionDebounces.get(file));
      codexSessionDebounces.set(file, setTimeout(() => { codexSessionDebounces.delete(file); processCodexSessionAppend(file); }, 250));
    });
    codexSessionWatcher.on('error', error => { codexSessionWatcherReady = false; console.error('[codex session watcher]', error.message); });
    codexSessionWatcherReady = true;
  } catch (error) { console.error('[codex session watcher]', error.message); }
}

async function monitorWindowsNotifications() {
  if (process.platform !== 'win32') return;
  try {
    if (!notificationDb) {
      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
      notificationDb = new DatabaseSync(dbPath, { readOnly: true });
    }
    const newest = notificationDb.prepare('select max([Order]) latest from Notification').get()?.latest ?? 0;
    if (lastWindowsNotificationOrder == null) { lastWindowsNotificationOrder = newest; return; }
    const rows = notificationDb.prepare(
      `select n.[Order] itemOrder, cast(n.Payload as text) payload, h.PrimaryId as handlerId
       from Notification n
       join NotificationHandler h on n.HandlerId = h.RecordId
       where n.[Order] > ?
       order by n.[Order]`
    ).all(lastWindowsNotificationOrder);
    lastWindowsNotificationOrder = Math.max(lastWindowsNotificationOrder, newest);
    const baseline = rows.length ? activeQuotaSnapshot() : null;
    for (const row of rows) {
      const texts = [...String(row.payload || '').matchAll(/<text(?:\s[^>]*)?>([\s\S]*?)<\/text>/gi)].map(match => decodeXmlText(match[1])).filter(Boolean);
      if (!texts.length) continue;
      const appName = formatNotificationAppName(row.handlerId);
      if (codexSessionWatcherReady && appName === 'Codex') continue;
      await notify(`Windows 通知 · ${appName}\n${texts.join('\n')}`, { appName });
    }
    if (rows.length) refreshQuotaFromBaseline(baseline, { source: 'desktop', title: 'Windows 通知' }).catch(error => console.error('[desktop quota]', error.message));
  } catch (error) {
    console.error('[windows notifications]', error.message);
    try { notificationDb?.close(); } catch {}
    notificationDb = null;
  }
}

class CodexServer {
  constructor() { this.pending = new Map(); this.nextId = 0; this.turns = new Map(); this.proc = null; this.intentionalClose = false; }
  async start() {
    const { command, args } = codexLaunch();
    this.proc = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8'); let buf = '';
    this.proc.stdout.on('data', chunk => { buf += chunk; const lines = buf.split(/\r?\n/); buf = lines.pop() || ''; for (const line of lines) this.receive(line); });
    this.proc.stderr.on('data', d => console.error('[codex]', String(d).trim()));
    this.proc.on('error', err => { console.error('[codex]', err.message); this.proc = null; taskEngineError = `任务引擎启动失败：${humanError(err)}。账号和额度页面仍可使用。`; });
    this.proc.on('exit', async code => {
      if (this.proc) this.proc = null;
      if (this.intentionalClose) return;
      taskEngineError = `任务引擎已停止（代码 ${code ?? '-'}），后台会自动重连。账号和额度页面仍可使用。`;
      for (const task of tasks.values()) if (task.status === 'running' || task.status === 'waiting_confirmation') task.status = 'failed';
      const now = Date.now();
      if (now - codexExitNotifiedAt > 10 * 60 * 1000) {
        codexExitNotifiedAt = now;
        await notify(`Codex 后台服务已退出\n退出代码：${code ?? '-'}\n正在运行的任务已标记失败。`, { appName: 'Codex 后台' });
      }
    });
    await this.request('initialize', { clientInfo: { name: 'codex_companion', title: 'Codex Companion', version: APP_VERSION } });
    this.send({ method: 'initialized', params: {} });
    taskEngineError = '';
  }
  send(value) { this.proc.stdin.write(`${JSON.stringify(value)}\n`); }
  request(method, params) { const id = ++this.nextId; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, 120000); this.pending.set(id, { resolve, reject, timer }); this.send({ method, id, params }); }); }
  async startTask(prompt, cwd) {
    const r = await this.request('thread/start', { cwd, serviceName: 'codex_companion' });
    const id = r.thread.id; const task = { id, cwd, prompt, status: 'starting', output: '', startedAt: new Date().toISOString(), lastEventAt: Date.now(), stallNotified: false, turnImagePaths: [] };
    tasks.set(id, task);
    await this.request('turn/start', { threadId: id, input: [{ type: 'text', text: prompt }], cwd });
    task.status = 'running'; return task;
  }
  async listThreads(limit = 20, searchTerm = '') {
    const params = {
      limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
    };
    if (String(searchTerm || '').trim()) params.searchTerm = String(searchTerm).trim();
    const result = await this.request('thread/list', params);
    return Array.isArray(result.data) ? result.data : [];
  }
  async resumeTask(threadId) {
    const existing = tasks.get(threadId);
    if (existing) return existing;
    const result = await this.request('thread/resume', { threadId });
    const thread = result.thread || {};
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const agentMessages = turns.flatMap(turn => Array.isArray(turn.items) ? turn.items : []).filter(item => item?.type === 'agentMessage' && item.text).map(item => item.text);
    const activeTurn = [...turns].reverse().find(turn => turn?.status === 'inProgress' && turn.id);
    const task = {
      id: threadId,
      cwd: String(result.cwd || thread.cwd || process.cwd()),
      prompt: String(thread.name || thread.preview || '已有 Codex 对话'),
      status: activeTurn ? 'running' : 'completed',
      output: trim(agentMessages.at(-1) || '', 5000),
      startedAt: new Date(Number(thread.createdAt || Date.now() / 1000) * 1000).toISOString(),
      lastEventAt: Date.now(),
      stallNotified: false,
      resumed: true,
    };
    tasks.set(threadId, task);
    if (activeTurn) this.turns.set(threadId, activeTurn.id);
    return task;
  }
  async continueTask(task, input) {
    if ((task.stopRequested || this.stopRequests?.has(task.id)) && ['starting','running','waiting_confirmation'].includes(task.status)) throw Error('停止请求尚未确认，请等本轮结束后再追加任务。');
    task.stopRequested = false;
    const items = Array.isArray(input) ? input : [{ type: 'text', text: String(input || '') }];
    const active = this.turns.get(task.id);
    if (active) await this.request('turn/steer', { threadId: task.id, input: items, expectedTurnId: active });
    else { task.turnImagePaths = []; await this.request('turn/start', { threadId: task.id, input: items, cwd: task.cwd }); }
    task.status = 'running'; task.lastEventAt = Date.now(); task.stallNotified = false;
  }
  async stopTask(task) {
    if (!['starting','running','waiting_confirmation'].includes(task.status) || task.stopRequested) return;
    const turn = this.turns.get(task.id);
    if (!turn) throw Error('尚未获取本轮任务标识，不能确认停止。请稍后重试，不会直接标记为已停止。');
    this.stopRequests ||= new Map();
    if (this.stopRequests.has(task.id)) return this.stopRequests.get(task.id);
    const pending = this.request('turn/interrupt', { threadId: task.id, turnId: turn }).then(() => {
      // RPC acceptance is not proof the turn has ended; wait for completion event.
      if (['starting','running','waiting_confirmation'].includes(task.status)) task.stopRequested = true;
    }).finally(() => this.stopRequests.delete(task.id));
    this.stopRequests.set(task.id, pending);
    return pending;
  }
  receive(line) {
    if (!line.trim()) return; let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); clearTimeout(p.timer); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error))); else p.resolve(msg.result); return; }
    const p = msg.params || {}; const id = p.threadId;
    if (id && tasks.has(id)) {
      const task = tasks.get(id); task.lastEventAt = Date.now();
      if (msg.method === 'turn/started' && p.turn?.id) { this.turns.set(id, p.turn.id); task.turnOutput = ''; task.turnFinalText = ''; task.turnImagePaths = []; }
      if (msg.method?.includes('agentMessage/delta')) { task.output += p.delta || ''; task.turnOutput = (task.turnOutput || '') + (p.delta || ''); }
      if (msg.method === 'item/completed' && p.item?.type === 'imageGeneration' && p.item.savedPath) task.turnImagePaths = [...new Set([...(task.turnImagePaths || []), String(p.item.savedPath)])].slice(0, 6);
      if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary') task.turnFinalText = String(p.item.text || '');
      if (msg.method === 'turn/completed') {
        this.turns.delete(id); task.stopRequested = false;
        task.status = p.turn?.status === 'completed' ? 'completed' : p.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
        const finalText = task.turnFinalText || task.turnOutput || '';
        completionNotice({ taskId: id, status: task.status, body: trim(finalText, 3000), cwd: task.cwd }).then(notice => notifyTurnResult(notice, { taskId: id, turnId: p.turn?.id, finalText: task.status === 'completed' ? task.turnFinalText || '' : '', imagePaths: task.turnImagePaths || [] })).catch(error => console.error('[task notification]', error.message));
        finishDesktopTakeover(id).catch(error => console.error('[desktop relaunch]', error.message));
        refreshQuotaAfterTask(task).catch(error => console.error('[task quota]', error.message));
      }
    }
    if (msg.id !== undefined && (msg.method?.includes('requestApproval') || msg.method?.includes('requestUserInput'))) { const task = id ? tasks.get(id) : null; if (task) { task.status = 'waiting_confirmation'; task.lastEventAt = Date.now(); } pendingApprovals.set(String(msg.id), { id: String(msg.id), method: msg.method, params: p, taskId: id }); notify(`Codex 等待确认\n任务：${id || '-'}\n类型：${msg.method}\n${confirmationDetails(msg.method, p)}\n\n${trim(task?.output, 1800)}\n\n请打开控制台：${dashboardLink(`#approval=${msg.id}`)}`, { appName: 'Codex 任务', taskId: id }); }
  }
  respondApproval(requestId, decision, answers = {}) { const request = pendingApprovals.get(String(requestId)); if (!request) throw new Error('确认请求已经失效'); const result = request.method.includes('requestUserInput') ? { answers } : { decision }; this.send({ id: Number(requestId), result }); pendingApprovals.delete(String(requestId)); const task = request.taskId ? tasks.get(request.taskId) : null; if (task) task.status = 'running'; }
  close() { this.intentionalClose = true; try { this.proc?.kill(); } catch {} }
}
let codex;

function html() { return `<!doctype html><meta charset="utf-8"><title>Codex Companion</title><style>body{font:14px system-ui;margin:24px;max-width:1000px;background:#10131a;color:#eef}button,input,textarea{font:inherit;padding:8px;margin:4px;border-radius:6px;border:1px solid #465064;background:#181e2a;color:#eef}textarea{width:96%;height:90px}.card{display:inline-block;vertical-align:top;background:#1a2230;border:1px solid #33415a;border-radius:10px;padding:12px;margin:5px;min-width:200px}.task{background:#18202c;padding:10px;border-radius:8px;margin:8px 0;white-space:pre-wrap}.muted{color:#9ba8bc}</style><h1>Codex Companion</h1><p class=muted>只监控由本程序启动的 Codex 任务 · 本机访问</p><h2>账号与额度</h2><button onclick="refresh()">刷新额度</button><div id=accounts></div><h2>启动任务</h2><input id=cwd placeholder="工作目录" style="width:70%"><br><textarea id=prompt placeholder="任务内容"></textarea><br><button onclick="start()">启动 Codex 任务</button><h2>任务</h2><div id=tasks></div><h2>设置</h2><input id=feishu placeholder="飞书机器人 Webhook URL" style="width:70%"><button onclick="save()">保存</button><script>
async function api(u,o={}){let r=await fetch(u,{headers:{'Content-Type':'application/json'},...o});let j=await r.json();if(j.error)alert(j.error);return j}function fmt(x){return x?new Date(x*1000).toLocaleString():'-'}function render(s){accounts.innerHTML=(s.accounts||[]).map(a=>{let u=a.usage||{};return '<div class=card><b>'+a.name+'</b> <span class=muted>'+ (a.plan_type||'')+'</span><br>5小时：'+(u.primary_used_percent??'-')+'%<br>重置：'+fmt(u.primary_resets_at)+'<br>周：'+(u.secondary_used_percent??'-')+'%<br>重置：'+fmt(u.secondary_resets_at)+'<br><button onclick="sw(\''+a.id+'\')">切换</button></div>'}).join('');tasks.innerHTML=Object.values(s.tasks||{}).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).map(t=>'<div class=task><b>'+t.id+'</b> '+t.status+'<br>'+t.cwd+'<br>'+((t.output||'').slice(-2400))+'<br><button onclick="cont(\''+t.id+'\')">继续/追加</button><button onclick="stop(\''+t.id+'\')">停止</button></div>').join('')||'<span class=muted>暂无任务</span>';feishu.value=s.config.feishuWebhookUrl||''}async function load(){render(await api('/api/status'))}async function refresh(){await api('/api/accounts/refresh',{method:'POST',body:'{}'});load()}async function sw(id){await api('/api/accounts/switch',{method:'POST',body:JSON.stringify({id})});load()}async function start(){await api('/api/task',{method:'POST',body:JSON.stringify({prompt:promptEl.value,cwd:cwd.value})});promptEl.value='';load()}async function cont(id){let t=window.prompt('追加给 Codex 的文字（留空表示继续）','');if(t!==null){await api('/api/task/'+id+'/continue',{method:'POST',body:JSON.stringify({text:t||'继续完成当前任务，并汇报结果。'})});load()}}async function stop(id){await api('/api/task/'+id+'/stop',{method:'POST',body:'{}'});load()}async function save(){await api('/api/config',{method:'POST',body:JSON.stringify({feishuWebhookUrl:feishu.value})});alert('已保存')}const promptEl=document.getElementById('prompt'),cwd=document.getElementById('cwd'),feishu=document.getElementById('feishu');load();setInterval(load,5000)</script>`; }

async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, version: APP_VERSION });
  // Static login page contains no account data; every data/control API is gated.
  if (req.method === 'GET' && req.url === '/') return send(res, 200, dashboardHtml, 'text/html; charset=utf-8');
  const accessError = requestAccessError(req);
  if (accessError) return send(res, 401, { error: accessError });
  const u = new URL(req.url, `http://${req.headers.host}`);
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let size = 0; const chunks = []; const timer = setTimeout(() => reject(Error('请求读取超时')), 15000);
      req.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { clearTimeout(timer); reject(Error('请求内容超过 2MB 限制')); } else chunks.push(chunk); });
      req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', error => { clearTimeout(timer); reject(error); });
    });
  } catch(error) { return send(res, 413, { error: error.message }); }
  let data={}; try { data=body?JSON.parse(body):{}; } catch { return send(res,400,{error:'请求内容不是有效 JSON'}); }
  try {
    if (req.method==='GET'&&u.pathname==='/api/diagnostics') {
      if(!isLoopback(req.socket.remoteAddress))return send(res,403,{error:'诊断导出仅允许本机操作'});
      const bytes=Buffer.from(JSON.stringify(publicDiagnostics(),null,2));
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store','content-disposition':'attachment; filename="CodexCompanion-diagnostics.json"'});
      return res.end(bytes);
    }
    if (req.method==='GET'&&u.pathname==='/') return send(res,200,dashboardHtml,'text/html; charset=utf-8');
    if (req.method==='GET'&&u.pathname==='/api/status'){
      const nets = os.networkInterfaces();
      const addrs = [];
      for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
          if (ni.family === 'IPv4' && !ni.internal) addrs.push({ name, address: ni.address });
        }
      }
      const tailscale = addrs.find(a => a.address.startsWith('100.'))?.address || null;
      const port = config.port;
      return send(res,200,{
        version:APP_VERSION,
        taskEngineReady:!!codex?.proc,
        codexSessionMonitorReady: codexSessionWatcherReady,
        taskEngineError,
        lastQuotaDelta,
        config:publicConfig(),
        security:{ remoteEnabled: !!config.remoteAccessEnabled, local: isLoopback(req.socket.remoteAddress), allowedUserCount: (config.feishuAllowedUserIds || []).length, pairingCommand: isLoopback(req.socket.remoteAddress) && !(config.feishuAllowedUserIds || []).length ? `绑定 ${feishuPairingCode}` : null },
        feishu:publicFeishuState(),
        accounts,
        tasks:Object.fromEntries(tasks),
        taskActivity:{ rows: publicTaskActivity(), monitorReady: codexSessionWatcherReady, note: '桌面任务依据最近本地记录显示，不是客户端实时运行保证；历史记录只用于展示，不补发通知。' },
        diagnosticIssues:publicDiagnostics().issues,
        approvals:[...pendingApprovals.values()],
        deviceLogin:deviceLogin?.publicState()||null,
        browserLogin:browserLoginPublic(),
        nativeVault:await boundedNativeVaultStatus(),
        network:{addresses:config.remoteAccessEnabled?addrs:[], tailscaleIp:config.remoteAccessEnabled?tailscale:null, port}
      });
    }
    if (req.method==='POST'&&u.pathname==='/api/task'){if(!codex?.proc)throw Error('任务引擎正在重连，请稍等十几秒再试；账号、额度和切换功能不受影响。');const prompt=String(data.prompt||'').trim();if(!prompt)throw Error('请填写任务内容');const cwd=String(data.cwd||'').trim()||process.cwd();try{await refreshAccounts()}catch{}const baseline=activeQuotaSnapshot();const t=await codex.startTask(prompt,cwd);t.quotaBaseline=baseline;await notify(`Codex 任务已启动\n任务：${t.id}\n目录：${t.cwd}`, { appName: 'Codex 任务', taskId: t.id });return send(res,200,{ok:true,id:t.id});}
    if (req.method==='GET'&&u.pathname==='/api/threads'){
      if(!codex?.proc)throw Error('任务引擎正在重连，请稍后刷新。');
      const threads=await codex.listThreads(u.searchParams.get('limit'),u.searchParams.get('q'));
      return send(res,200,{ok:true,threads});
    }
    const threadContinue=u.pathname.match(/^\/api\/threads\/([^/]+)\/continue$/);
    if(req.method==='POST'&&threadContinue){
      if(!codex?.proc)throw Error('任务引擎正在重连，请稍后重试。');
      const text=String(data.text||'').trim();if(!text)throw Error('请填写要发送的内容。');
      try{await refreshAccounts()}catch{}
      const task=await codex.resumeTask(decodeURIComponent(threadContinue[1]));
      task.quotaBaseline=activeQuotaSnapshot();
      await codex.continueTask(task,text);
      return send(res,200,{ok:true,id:task.id,message:'已在原对话中继续，不会新建对话。'});
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/refresh'){await refreshAccounts({forceNative:true,awaitNative:true});return send(res,200,{ok:true,accounts});}
    if (req.method==='POST'&&u.pathname==='/api/accounts/import-local'){
      if (!isLoopback(req.socket.remoteAddress)) return send(res,403,{error:'导入本机账号只能在本机操作'});
      if(data.confirm!==true)throw Error('请确认将本机登录保存到 Companion 加密账号库');
      const auth=await readJson(liveAuthPath);
      if(!auth?.tokens?.id_token||!auth?.tokens?.access_token||!auth?.tokens?.refresh_token)throw Error('没有找到可导入的本机文件凭据，请使用通用网页登录。客户端已登录不代表凭据存储在文件中。');
      const account=await upsertNativeAccount(auth,{is_active:true});
      if(!account)throw Error('该账号已被删除。若确实需要恢复，请重新登录后添加。');
      nativeUsageCache.delete(String(account.id));
      await refreshAccounts({forceNative:true,awaitNative:false});
      return send(res,200,{ok:true,message:'已导入本机账号，额度正在后台刷新。'});
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/migrate-native'){
      if(!await verifyNativeVaultRoundTrip())throw Error('Windows 凭据加密自检失败，已停止迁移。');
      return send(res,200,await migrateSwitcherAccountsToNativeVault());
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/vault/backup') return send(res,200,await backupNativeVault());
    if (req.method==='POST'&&u.pathname==='/api/accounts/vault/restore'){
      const result=await restoreNativeVault();
      await refreshAccounts({forceNative:true,awaitNative:true});
      return send(res,200,{...result,accounts});
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/portable-backup/export'){
      const backup=await createPortableAccountBackup(data.password);
      const bytes=Buffer.from(JSON.stringify(backup,null,2),'utf8');
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'content-disposition':`attachment; filename="CodexCompanion-accounts-${new Date().toISOString().slice(0,10)}.ccbackup"`,'cache-control':'no-store'});
      res.end(bytes);return;
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/portable-backup/import'){
      const envelope=typeof data.backup==='string'?JSON.parse(data.backup):data.backup;
      return send(res,200,await importPortableAccountBackup(envelope,data.password));
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/alias'){
      const id=String(data.id||'').trim();
      const alias=String(data.alias||'').trim();
      if(!id||!accounts.some(account=>String(account.id)===id))throw Error('账号不存在，请刷新后重试。');
      if(alias.length>40)throw Error('备注名最多 40 个字符。');
      if(!config.accountAliases||typeof config.accountAliases!=='object'||Array.isArray(config.accountAliases))config.accountAliases={};
      if(alias)config.accountAliases[id]=alias;else delete config.accountAliases[id];
      accounts=accounts.map(account=>String(account.id)===id?{...account,alias,display_name:alias||account.name}:account);
      await saveConfig();
      return send(res,200,{ok:true,account:accounts.find(account=>String(account.id)===id)});
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/delete'){
      const id=String(data.id||'').trim();
      if(data.confirm!==true)throw Error('删除账号需要明确确认。');
      const result=await deleteNativeAccount(id);
      if(config.accountAliases&&typeof config.accountAliases==='object'){delete config.accountAliases[id];await saveConfig();}
      accounts=await loadNativeAccountsSnapshot();
      return send(res,200,{...result,accounts});
    }
    if (req.method==='GET'&&u.pathname==='/api/oauth/status') return send(res,200,await oauthPortStatus());
    if (req.method==='POST'&&u.pathname==='/api/device-login/start') return send(res,200,await startDeviceLogin(data.name));
    if (req.method==='GET'&&u.pathname==='/api/device-login/status') return send(res,200,deviceLogin?.publicState()||{status:'idle'});
    if (req.method==='POST'&&u.pathname==='/api/device-login/cancel'){if(deviceLogin)await deviceLogin.cancel();return send(res,200,{ok:true});}
    if (req.method==='POST'&&u.pathname==='/api/browser-login/start') return send(res,200,startBrowserLogin(data.name));
    if (req.method==='POST'&&u.pathname==='/api/browser-login/complete') return send(res,200,await completeBrowserLogin(data.callbackUrl));
    if (req.method==='POST'&&u.pathname==='/api/browser-login/cancel'){if(browserLoginInFlight)throw Error('正在交换或保存账号，请等待结果后再取消。');browserLogin={status:'canceled',message:'已取消这次登录。'};return send(res,200,{ok:true});}
    if (req.method==='POST'&&u.pathname==='/api/widget/open') return send(res,200,await openQuotaWidget());
    if (req.method==='GET'&&u.pathname==='/api/codex/status') return send(res,200,{running:await isCodexDesktopRunning()});
    if (req.method==='POST'&&u.pathname==='/api/accounts/switch'){
      const target=await validateNativeSwitchTarget(String(data.id));
      if(data.validateOnly===true)return send(res,200,{...target,validated:true});
      if([...tasks.values()].some(t=>t.status==='running'||t.status==='waiting_confirmation'))throw Error('有任务正在运行或等待确认，请结束后再切换账号。');
      const closeCodex=data.closeCodex===true;
      console.log(`[account switch] requested via ${data.source==='widget'?'widget':'web'}; close desktop=${closeCodex}`);
      const closed=closeCodex?await closeCodexDesktop():{stopped:0};
      if(closeCodex)console.log(`[account switch] desktop closed: ${closed.stopped} process(es)`);
      if(!(await nativeVaultStatus()).ready)throw Error('还没有可切换的 Companion 原生账号。请先登录账号。');
      try{
        const result=await switchNativeAccount(String(data.id));
        console.log(`[account switch] completed: ${target.name}; already active=${result.alreadyActive}`);
        const activeSnapshot = await loadNativeAccountsSnapshot();
        const activeAccountId = activeSnapshot.find(account => account.is_active)?.id || '';
        if (String(activeAccountId) !== String(data.id)) throw Error('账号切换写入后校验失败，当前账号没有改变；原账号仍保持不变。');
        return send(res,200,{ok:true,activeAccountId:String(activeAccountId),message:result.alreadyActive?'已经是当前账号，ChatGPT/Codex 正在打开。':'账号已由 Companion 安全切换，ChatGPT/Codex 正在重新打开。'});
      }finally{
        launchCodexDesktop();
      }
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/warmup'){
      if(data.confirm!==true)throw Error('预热会发送一次最小请求并启动额度窗口，请先确认。');
      const result=await warmupNativeAccount(String(data.id));
      return send(res,200,{ok:true,...result,message:`${result.name} 已完成最小预热，5 小时窗口已开始计时。`});
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/warmup-all'){
      if(data.confirm!==true)throw Error('批量预热会让全部可用账号发送一次最小请求，请先确认。');
      const snapshot=[...accounts];
      const results=[];
      for(const account of snapshot){
        try{results.push({ok:true,...await warmupNativeAccount(String(account.id))});}
        catch(error){results.push({ok:false,id:String(account.id),name:account.display_name||account.name,error:humanError(error)});}
      }
      const succeeded=results.filter(item=>item.ok).length;
      return send(res,200,{ok:succeeded>0,total:results.length,succeeded,failedCount:results.length-succeeded,results,message:`已预热 ${succeeded}/${results.length} 个账号。`});
    }
    if (req.method==='POST'&&u.pathname==='/api/security'){
      if (!isLoopback(req.socket.remoteAddress)) return send(res,403,{error:'安全设置只能在本机修改'});
      if (data.remoteEnabled === true && !config.remoteAccessTokenHash && !data.remoteToken) throw Error('开启远程访问前需要设置口令');
      if (data.remoteToken) {
        if (String(data.remoteToken).length < 24) throw Error('远程口令至少 24 个字符，建议使用随机口令');
        config.remoteAccessTokenHash = createHash('sha256').update(String(data.remoteToken)).digest('hex');
      }
      if (typeof data.remoteEnabled === 'boolean') config.remoteAccessEnabled = data.remoteEnabled;
      if (data.resetFeishuOperator === true) { config.feishuAllowedUserIds = []; feishuPairingCode = randomBytes(12).toString('hex'); }
      await saveConfig();return send(res,200,{ok:true,message:'安全设置已保存。远程访问开关需重启软件后生效。'});
    }
    if (req.method==='POST'&&u.pathname==='/api/images/settings') {
      if (!isLoopback(req.socket.remoteAddress)) return send(res,403,{ok:false,error:'图片授权仅允许在本机修改。'});
      if (typeof data.enabled !== 'boolean') throw Error('请选择开启或关闭。');
      if (data.enabled && data.confirm !== true) throw Error('需要明确确认图片上传授权。');
      const requestedRoot = String(data.root || '').trim();
      const root = data.enabled && requestedRoot ? await validateImageRoot(requestedRoot) : '';
      config.feishuImageRelayEnabled = data.enabled; config.feishuImageRelayRoot = root;
      await saveConfig(); return send(res,200,{ok:true});
    }
    if (req.method==='POST'&&u.pathname==='/api/config'){if(data.feishuWebhookUrl)config.feishuWebhookUrl=String(data.feishuWebhookUrl);config.publicDashboardUrl=String(data.publicDashboardUrl||'');await saveConfig();return send(res,200,{ok:true});}
    if (req.method==='POST'&&u.pathname==='/api/feishu/setup'){const webhook=String(data.feishuWebhookUrl||'').trim();if(!validFeishuWebhook(webhook))throw Error('Webhook 地址格式不对。请复制飞书自定义机器人提供的完整 HTTPS 地址。');const previous=config.feishuWebhookUrl;config.feishuWebhookUrl=webhook;const result=await notify(`Codex Companion 通知测试成功\n\n以后任务完成、失败、等待确认、长时间无进展或额度不足时，我会通知到这个群。\n\n时间：${new Date().toLocaleString('zh-CN')}`, { appName: 'Codex Companion' });if(!result.ok){config.feishuWebhookUrl=previous;throw Error('飞书没有接收测试消息。请检查 Webhook 是否完整，以及机器人安全设置是否允许发送。')}await saveConfig();return send(res,200,{ok:true,message:'已经保存，测试消息也发送成功了。'});}
    if (req.method==='POST'&&u.pathname==='/api/feishu/test'){if(!config.feishuWebhookUrl&&!(feishuClient&&config.feishuBoundChatId))throw Error('请先配置 Webhook，或连接并绑定应用机器人');const result=await notify(`Codex Companion 飞书通知测试成功\n时间：${new Date().toLocaleString('zh-CN')}\n${dashboardLink()}`, { appName: 'Codex Companion' });if(!result.ok)throw Error('飞书没有接收测试消息，请检查机器人配置和连接状态');return send(res,200,{ok:true});}
    if (req.method==='GET'&&u.pathname==='/api/feishu/app/status') return send(res,200,{ok:true,...publicFeishuState()});
    if (req.method==='POST'&&u.pathname==='/api/feishu/app/setup'){
      const appId=String(data.appId||'').trim();const appSecret=String(data.appSecret||'').trim();
      if(!/^cli_[a-z0-9]+$/i.test(appId))throw Error('App ID 格式不正确，应以 cli_ 开头。');
      if(!appSecret&&!(config.feishuAppId===appId&&config.feishuAppSecretProtected))throw Error('首次配置需要填写 App Secret。');
      config.feishuAppId=appId;
      if(appSecret)config.feishuAppSecretProtected=await protectCredential(appSecret);
      await saveConfig();await startFeishuLongConnection();
      return send(res,200,{ok:true,message:'应用机器人配置已保存，正在建立飞书长连接。请在机器人所在群发送“绑定”。',...publicFeishuState()});
    }
    if (req.method==='POST'&&u.pathname==='/api/feishu/thread/bind-latest'){
      const thread=await bindLatestFeishuThread();
      return send(res,200,{ok:true,thread,message:`已绑定最近的 Codex 对话：${thread.name}`});
    }
    if (req.method==='GET'&&u.pathname==='/api/notifications/apps'){
      ensureHistory();
      const blacklist = Array.isArray(config.notificationBlacklist) ? config.notificationBlacklist : [];
      const agg = new Map();
      for (const entry of config.notificationHistory) {
        const name = normalizeAppName(entry.appName);
        const slot = agg.get(name) || { name, total: 0, sent: 0, muted: 0, lastSentAt: 0, lastBody: '' };
        slot.total += 1;
        if (entry.sent) { slot.sent += 1; if ((entry.at || 0) > slot.lastSentAt) { slot.lastSentAt = entry.at || 0; slot.lastBody = entry.body || ''; } }
        else slot.muted += 1;
        agg.set(name, slot);
      }
      // 加入当前已知的所有 Codex 内部类目（即便 history 还没发过），方便用户提前勾选
      const seeds = ['Codex 任务', 'Codex 额度', 'Codex 后台', 'Codex Companion'];
      for (const s of seeds) if (!agg.has(s)) agg.set(s, { name: s, total: 0, sent: 0, muted: 0, lastSentAt: 0, lastBody: '' });
      const apps = [...agg.values()].map(a => ({ ...a, muted: blacklist.includes(a.name) })).sort((a, b) => b.lastSentAt - a.lastSentAt || a.name.localeCompare(b.name));
      return send(res, 200, { apps, blacklist });
    }
    if (req.method==='GET'&&u.pathname==='/api/notifications/history'){
      ensureHistory();
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 50, 1), 200);
      return send(res, 200, { history: config.notificationHistory.slice(0, limit) });
    }
    if (req.method==='POST'&&u.pathname==='/api/notifications/blacklist'){
      const name = normalizeAppName(data.name);
      if (!name || name === '未分类') throw Error('请提供应用名称');
      const want = Boolean(data.mute);
      const list = Array.isArray(config.notificationBlacklist) ? config.notificationBlacklist : [];
      config.notificationBlacklist = list.filter(n => n !== name);
      if (want) config.notificationBlacklist.push(name);
      await saveConfig();
      return send(res, 200, { ok: true, blacklist: config.notificationBlacklist });
    }
    if (req.method==='POST'&&u.pathname==='/api/notifications/clear'){
      config.notificationHistory = [];
      await saveConfig();
      return send(res, 200, { ok: true });
    }
    const m=u.pathname.match(/^\/api\/task\/([^/]+)\/(continue|stop)$/);if(req.method==='POST'&&m){const t=tasks.get(m[1]);if(!t)throw Error('任务不存在');if(m[2]==='continue')await codex.continueTask(t,String(data.text||'继续完成当前任务，并汇报结果。'));else await codex.stopTask(t);return send(res,200,{ok:true});}
    const a=u.pathname.match(/^\/api\/approval\/([^/]+)$/);if(req.method==='POST'&&a){codex.respondApproval(a[1],String(data.decision||'accept'),data.answers||{});return send(res,200,{ok:true});}
    return send(res,404,{error:'Not found'});
  } catch(e){console.error('[request]',e);return send(res,400,{error:humanError(e)});}
}
function send(res,status,value,type='application/json; charset=utf-8'){const b=Buffer.from(typeof value==='string'?value:JSON.stringify(value));res.writeHead(status,{'content-type':type,'content-length':b.length});res.end(b);}

async function startTaskEngine(){if(codex?.proc)return;codex=new CodexServer();try{await codex.start()}catch(e){taskEngineError=humanError(e);console.error('[task engine]',e.message);codex.close();codex.proc=null;}}
async function main() {
  config = { ...defaultConfig, ...await readJson(configPath) };
  if (config.imageRelayDefaultVersion !== 1) {
    config.feishuImageRelayEnabled = true;
    config.imageRelayDefaultVersion = 1;
    await saveConfig();
  }
  config.accountBackend = 'native';
  await recoverInterruptedDesktopTakeovers();
  accounts = await loadNativeAccountsSnapshot();
  const server = http.createServer(handle);
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') console.error(`Companion 已经在运行：http://127.0.0.1:${config.port}/`);
    else console.error(error);
    process.exit(1);
  });
  // Listen on all interfaces so Tailscale / LAN phones can reach the dashboard.
  // Tailscale gives 100.x addresses that route through the user's private mesh.
  server.listen(config.port, config.remoteAccessEnabled ? '0.0.0.0' : '127.0.0.1', () => {
    const nets = os.networkInterfaces();
    const urls = [];
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${config.port}/`);
      }
    }
    console.log(`Codex Companion v${APP_VERSION}`);
    console.log(`  Local:   http://127.0.0.1:${config.port}/`);
    for (const u of urls) console.log(`  Network: ${u}`);
    const ts = urls.find(u => u.includes('100.'));
    if (ts) console.log(`  Tailscale detected: ${ts}`);
  });
  refreshAccounts().catch(e => console.error('[accounts]', e.message));
  startTaskEngine().catch(e => console.error('[task engine]', e.message));
  startFeishuLongConnection().catch(e => console.error('[feishu connection]', e.message));
  startCodexSessionMonitor().catch(e => console.error('[codex session monitor]', e.message));
  monitorWindowsNotifications();
  setInterval(async () => {
    if (!codex?.proc) startTaskEngine().catch(e => console.error('[task engine]', e.message));
    monitorWindowsNotifications();
    for (const t of tasks.values()) {
      if (t.status !== 'running' || t.stallNotified) continue;
      if (Date.now() - t.lastEventAt <= config.stallMinutes * 60000) continue;
      t.stallNotified = true;
      await notify(`Codex 任务长时间没有进展\n任务：${t.id}\n已无事件：${config.stallMinutes} 分钟\n\n${trim(t.output, 1800)}\n${dashboardLink(`#task=${t.id}`)}`, { appName: 'Codex 任务', taskId: t.id });
    }
    if (Date.now() - lastAccountRefreshAt > config.quotaRefreshMinutes * 60000) {
      try { await refreshAccounts(); } catch (e) { console.error('[accounts]', e.message); }
    }
  }, 15000);
  process.on('SIGINT', () => { codex.close(); try { codexSessionWatcher?.close(); } catch {} try { feishuWsClient?.close({ force: true }); } catch {} try { notificationDb?.close(); } catch {} server.close(); process.exit(0); });
}
main().catch(e=>{console.error(e);process.exit(1)});
