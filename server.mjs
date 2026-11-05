import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, watch as watchFs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import * as Lark from '@larksuiteoapi/node-sdk';
import { finalImagePaths, relayFinalImages, validateImageRoot } from './image-relay.mjs';
import { finalHtmlPaths, readRelayHtml } from './file-relay.mjs';
import { observeEarlyQuotaReset } from './quota-reset.mjs';
import { notificationRules, notificationEnabled, notificationType, resetReminderLeads, validateNotificationSettings, nextResetReminder } from './notification-settings.mjs';
import { recoverReplyTarget } from './feishu-reply-recovery.mjs';
import { desktopRetryState, desktopTakeoverAllowed, syncDesktopRetryWatcher, startDesktopRetryWatcher, stopDesktopRetryWatcher, setDesktopRetryNotifier } from './desktop-retry.mjs';
import { validateWebhooks, activeWebhookTargets, sendWebhooks, kindLabel as webhookKindLabel, friendlyWebhookReason } from './webhook-notify.mjs';
import { contextWarning, contextRatio, formatTokenCount, trimContextLedger } from './context-budget.mjs';
import { humanError } from './human-error.mjs';
import { base64Url, decodeJwtPayload, jwtExpiry, oauthPortStatus } from './auth-utils.mjs';
import { createFeishuInbox, inboxEntryFromEvent } from './feishu-inbox.mjs';
import { createNativeUsage } from './native-usage.mjs';
import { validNativeVault, createNativeVaultStore } from './native-vault.mjs';
import { DeviceLoginSession } from './device-login.mjs';
import { codexLaunch, closeCodexDesktop, codexDesktopPids, isCodexDesktopRunning, launchCodexDesktop, execPowershellShort, isQuotaWidgetRunning, findQuotaWidgetWindow, focusQuotaWidgetWindow, killQuotaWidgetProcesses, openQuotaWidget } from './desktop-client.mjs';
import { appDir, configPath, widgetSwitchTracePath, nativeAccountsPath, nativeAccountsBackupPath, switcherAccountsPath, liveAuthPath, widgetScriptPath, widgetLauncherPath } from './app-paths.mjs';
import { protectCredential, unprotectCredential } from './credential-crypto.mjs';
import { encryptPortablePayload, decryptPortableAccountBackup } from './portable-backup.mjs';

const execFileAsync = promisify(execFile);
const APP_VERSION = '1.0.35';
const NOTIFICATION_HISTORY_LIMIT = 200;

// 路径常量统一在 app-paths.mjs，加密在 credential-crypto.mjs / portable-backup.mjs。
const dashboardHtml = await fs.readFile(new URL('./dashboard.html', import.meta.url), 'utf8');
const feishuInbox = createFeishuInbox({ dir: appDir });
// The handoff wording lives in one place: the page shows it and Feishu can send
// it, so the two can never drift apart.
export const HANDOFF_PROMPT = '请把当前对话做一次收尾交接，只输出这份摘要，不要改动任何文件、不要继续做新任务：\n1. 已完成的工作（按改动的文件或模块列要点）\n2. 关键决策与约定（技术选型、命名规则、不能动的地方）\n3. 未完成事项与下一步\n4. 新对话需要知道的背景（当前进度、卡在哪）\n用中文，控制在 400 字以内。';
// replaceAll 是关键：占位符在页面里出现两次（typeof 判断 + 三元取值）。
// 以前用 replace() 只换掉第一个，第二个留在原处变成未定义变量，整页脚本当场崩掉。
// $ 替换成 $$ 防止 JSON 文本里的 $ 被当成替换模式特殊符号。
const dashboardPage = dashboardHtml.replaceAll('HANDOFF_PROMPT_TEXT', JSON.stringify(HANDOFF_PROMPT).replaceAll('$', '$$$$'));
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
  feishuNotificationThreadMode: 'task',
  feishuTopicRootSchemaVersion: 2,
  feishuTaskTopicChats: {},
  feishuContinueEmoji: 'OK',
  feishuMentionOperator: true,
  feishuImageRelayEnabled: true,
  feishuImageRelayRoot: '',
  stallMinutes: 3,
  quotaRefreshMinutes: 5,
  resetReminderMinutes: 15,
  autoContinue429: true,
  autoContinue429MaxAttempts: 3,
  autoContinueTransient: true,
  autoContinueTransientMaxAttempts: 10,
  autoTakeoverDesktopTransient: true,
  desktopRetryAutoClick: false,
  desktopRetryCooldownSeconds: 8,
  desktopRetryQuietMinutes: 10,
  windowsNotifyForward: false,
  windowsNotifyApps: [],
  windowsNotifyIncludeBody: false,
  webhooks: [],
  contextPressureLedger: {},
  autoFallbackModel: '',
  feishuIncludeDashboardLink: false,
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
function maskedWebhookUrl(raw) {
  try {
    const parsed = new URL(String(raw || ''));
    const tail = parsed.pathname.replace(/\/+$/, '').slice(-4);
    return tail ? `${parsed.origin}/…${tail}` : parsed.origin;
  } catch { return ''; }
}
// Never echo a webhook secret back to the page: show the host and the tail only.
function publicWebhooks() {
  return (Array.isArray(config.webhooks) ? config.webhooks : []).map((target, index) => ({
    id: String(target.id || `${target.kind}-${index + 1}`),
    kind: target.kind,
    kindLabel: webhookKindLabel(target.kind),
    name: target.name || webhookKindLabel(target.kind),
    enabled: target.enabled !== false,
    urlHint: maskedWebhookUrl(target.url),
    lastOkAt: Number(target.lastOkAt || 0),
    lastError: String(target.lastError || '').slice(0, 160),
  }));
}
function publicConfig() {
  return { port: config.port, feishuAppId: config.feishuAppId, feishuWebhookConfigured: !!config.feishuWebhookUrl,
    publicDashboardUrl: config.publicDashboardUrl, quotaRefreshMinutes: config.quotaRefreshMinutes, resetReminderMinutes: config.resetReminderMinutes,
    feishuNotificationThreadMode: config.feishuNotificationThreadMode === 'task' ? 'task' : 'flat',
    feishuContinueEmoji: ['OK','THUMBSUP','DONE','CHECK'].includes(config.feishuContinueEmoji) ? config.feishuContinueEmoji : 'OK',
    feishuMentionOperator: config.feishuMentionOperator !== false,
    autoTakeoverDesktopTransient: config.autoTakeoverDesktopTransient !== false,
    desktopRetryAutoClick: config.desktopRetryAutoClick === true,
    desktopRetryCooldownSeconds: Number(config.desktopRetryCooldownSeconds || 8),
    desktopRetryQuietMinutes: Number(config.desktopRetryQuietMinutes || 10),
    feishuImageRelayEnabled: !!config.feishuImageRelayEnabled, feishuImageRelayRoot: config.feishuImageRelayRoot || '',
    webhooks: publicWebhooks() };
}
function publicDiagnostics() {
  const recentNotifications = Array.isArray(config.notificationHistory) ? config.notificationHistory.slice(0, 50) : [];
  const topicRoots = config.feishuTaskTopicRoots && typeof config.feishuTaskTopicRoots === 'object' ? config.feishuTaskTopicRoots : {};
  const topicChats = config.feishuTaskTopicChats && typeof config.feishuTaskTopicChats === 'object' ? config.feishuTaskTopicChats : {};
  const report = { format: 1, appVersion: APP_VERSION, createdAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    health: { taskEngineReady: !!codex?.proc, sessionMonitorReady: codexSessionWatcherReady,
      feishuState: publicFeishuState().state, webhookConfigured: !!config.feishuWebhookUrl,
      operatorVerified: !!config.feishuAllowedUserIds?.length, remoteEnabled: !!config.remoteAccessEnabled },
    counts: { accounts: accounts.length, activeBackendTasks: [...tasks.values()].filter(t => ['starting','running','waiting_confirmation'].includes(t.status)).length,
      feishuTopicRoots: Object.keys(topicRoots).length, feishuTopicRootsForBoundChat: Object.keys(topicRoots).filter(id => topicChats[id] === config.feishuBoundChatId).length,
      recentNotificationFailures: recentNotifications.filter(item => !item.sent).length },
    privacy: '仅包含白名单状态和数量；不包含账号身份、路径、任务内容、原始日志、网络地址或任何凭据。' };
  report.issues = diagnosticIssues(report);
  return report;
}
function publicDiagnosticBundle() {
  const history = Array.isArray(config.notificationHistory) ? config.notificationHistory : [];
  return {
    format: 2,
    diagnostics: publicDiagnostics(),
    notificationDelivery: history.slice(0, 30).map(item => ({ at: item.at, appName: normalizeAppName(item.appName), sent: !!item.sent, reason: item.reason || '' })),
    recovery: {
      retry429: config.autoContinue429 !== false,
      retry429MaxAttempts: Number(config.autoContinue429MaxAttempts || 3),
      retryTransient: config.autoContinueTransient !== false,
      retryTransientMaxAttempts: Number(config.autoContinueTransientMaxAttempts || 10),
      takeoverDesktopTransient: desktopTakeoverAllowed(config),
      desktopRetryAutoClick: config.desktopRetryAutoClick === true,
      fallbackModel: '',
    },
    feishu: {
      configured: !!(config.feishuAppId && config.feishuAppSecretProtected),
      state: publicFeishuState().state,
      boundChat: !!config.feishuBoundChatId,
      topicMode: config.feishuNotificationThreadMode === 'task',
      topicRootCount: Object.keys(config.feishuTaskTopicRoots || {}).length,
    },
    privacy: '不包含账号身份、凭据、文件路径、任务内容、对话内容、群聊 ID、消息 ID 或原始日志。',
  };
}
function diagnosticIssues(report) {
  const issues = [], add = (code, severity, message) => issues.push({ code, severity, message });
  if (!report.counts.accounts) add('ACCOUNT_MISSING','warning','还没有添加账号：导入本机文件凭据或使用通用网页登录。');
  if (!report.health.taskEngineReady) add('ENGINE_NOT_READY','warning','后台任务引擎尚未就绪。请稍后刷新；持续失败时导出诊断。');
  if (!report.health.sessionMonitorReady) add('MONITOR_NOT_READY','warning','主对话记录监听尚未就绪，桌面任务完成通知可能不可用。');
  if (!report.health.webhookConfigured && report.health.feishuState === 'not_configured') add('FEISHU_OPTIONAL','info','飞书尚未配置：不影响本机使用；需要通知或手机回复时再设置。');
  else if (!['connected','not_configured'].includes(report.health.feishuState)) add('FEISHU_DISCONNECTED','warning','应用机器人尚未连接。检查飞书应用配置、发布状态及网络。');
  if (report.health.feishuState === 'connected' && !report.health.operatorVerified) add('OPERATOR_UNVERIFIED','warning','飞书回复控制未验证：复制本机指令，在群里 @ 自建应用机器人后发送。');
  if (report.health.feishuState === 'connected' && report.counts.feishuTopicRoots > report.counts.feishuTopicRootsForBoundChat) add('TOPIC_MAPPING_STALE','warning','检测到旧群聊或旧版本的话题映射；点击“一键自检并修复”可安全重建。');
  if (report.counts.recentNotificationFailures) add('NOTIFICATION_FAILURES','warning',`最近 50 条通知中有 ${report.counts.recentNotificationFailures} 条未送达，请在“飞书通知”中查看历史或发送测试消息。`);
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
const codexSessionRewrites = new Map();
// Events already present when the watcher starts are historical evidence, not
// a new desktop reply.  Keep the cutoff so opening an old project cannot
// replay its entire JSONL history into Feishu.
let codexSessionMonitorStartedAt = Date.now();
const codexSessionPartials = new Map();
const codexSessionDebounces = new Map();
const codexSessionKinds = new Map();
const codexSessionIdentities = new Map();
const codexSessionImagePaths = new Map();
const codexSessionHtmlPaths = new Map();
const codexSessionTopicsAnnounced = new Set();
const codexSessionContextStats = new Map();
const codexSessionAutoTakeovers = new Set();
// A desktop session can append the same failed completion repeatedly while the
// UI is still open. Keep a per-thread guard as well as the per-turn key so one
// capacity failure cannot create an endless Feishu notification loop.
const codexSessionAutoTakeoverThreads = new Set();
const feishuTopicCreationLocks = new Map();
const sessionActivities = new Map();
// Reactions can be delivered more than once by Feishu (and users may tap OK
// repeatedly). Keep one continue request in flight per conversation so a
// single failed turn does not become several competing writers.
const feishuContinueRequests = new Map();
function observeSessionActivity(event, kind, threadId, cwd = '') {
  if (kind !== 'user' || !threadId || event?.type !== 'event_msg') return;
  const payload = event.payload || {};
  const previous = sessionActivities.get(threadId) || { id: threadId, source: 'desktop', status: 'unknown', title: '', cwd };
  const timestamp = Date.parse(event.timestamp || '');
  if (Number.isFinite(timestamp)) previous.lastObservedAt = timestamp;
  if (payload.type === 'user_message' && payload.message) {
    const title = conversationTitle(payload.message);
    if (title) previous.title = title;
  }
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
async function appendWidgetSwitchTrace(entry = {}) {
  const row = { at: new Date().toISOString(), stage: String(entry.stage || 'unknown'), account: String(entry.account || '').slice(0, 12), detail: String(entry.detail || '').slice(0, 240) };
  await fs.mkdir(appDir, { recursive: true });
  await fs.appendFile(widgetSwitchTracePath, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}
async function readWidgetSwitchTrace() {
  try {
    const lines = (await fs.readFile(widgetSwitchTracePath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).slice(-100);
    return lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function validFeishuWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) && url.pathname.includes('/open-apis/bot/v2/hook/');
  } catch { return false; }
}

async function startDeviceLogin(name) {
  if (deviceLogin && ['starting', 'waiting', 'importing'].includes(deviceLogin.state.status)) return deviceLogin.publicState();
  if (loginBusy()) throw Error('还有 Companion 任务正在运行或等待确认。请先处理任务，再登录或更新账号。');
  deviceLogin = new DeviceLoginSession(name, { homeRoot: appDir, importAccount: (contents, name) => importOrUpdateAccount(contents, name) });
  try { return await deviceLogin.start(); }
  catch (error) { deviceLogin.state = { status: 'failed', message: humanError(error) }; await deviceLogin.cleanup(); throw error; }
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
let nativeVaultStore = null;
function getNativeVaultStore() {
  if (!nativeVaultStore) {
    nativeVaultStore = createNativeVaultStore({
      accountsPath: nativeAccountsPath,
      backupPath: nativeAccountsBackupPath,
      readJson,
      jsonReadErrors,
      atomicJsonWrite,
      queueWrite: action => queueNativeVaultWrite(action),
      afterRestore: async () => nativeUsageCache.clear(),
    });
  }
  return nativeVaultStore;
}
async function readEffectiveNativeVault() { return getNativeVaultStore().readEffective(); }
async function writeNativeVault(vault, options) { return getNativeVaultStore().write(vault, options); }
async function backupNativeVault() { return getNativeVaultStore().backup(); }
async function restoreNativeVault() { return getNativeVaultStore().restore(); }
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
  return encryptPortablePayload(portableAccounts, password);
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
  const post = buildFeishuPost(text);
  const operatorId = config.feishuMentionOperator !== false && Array.isArray(config.feishuAllowedUserIds) ? String(config.feishuAllowedUserIds[0] || '') : '';
  if (operatorId && post?.zh_cn?.content) post.zh_cn.content.unshift([{ tag: 'at', user_id: operatorId, user_name: '操作者' }, { tag: 'text', text: ' ' }]);
  const data = { content: JSON.stringify(post), msg_type: 'post' };
  const response = replyTo
    ? await feishuClient.im.v1.message.reply({ path: { message_id: replyTo }, data: { ...data, reply_in_thread: true } })
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
  const response = await feishuClient.im.v1.message.reply({ path: { message_id: replyTo }, data: { msg_type: 'image', content: JSON.stringify({ image_key: imageKey }), reply_in_thread: true } });
  if (response?.code || !response?.data?.message_id) throw Error('图片消息发送失败。');
  const links = config.feishuMessageThreads || {};
  links[response.data.message_id] = taskId;
  config.feishuMessageThreads = Object.fromEntries(Object.entries(links).slice(-100));
  await saveConfig();
}

async function sendFeishuResultFile(file, replyTo, taskId) {
  if (!feishuClient || !replyTo) throw Error('应用机器人或本轮通知未就绪。');
  const uploaded = await feishuClient.im.v1.file.create({ data: { file_type: 'stream', file_name: file.name, file: file.bytes } });
  const fileKey = uploaded?.file_key || uploaded?.data?.file_key;
  if (uploaded?.code || !fileKey) throw Error('文件上传失败，请检查机器人资源权限。');
  const response = await feishuClient.im.v1.message.reply({ path: { message_id: replyTo }, data: { msg_type: 'file', content: JSON.stringify({ file_key: fileKey }), reply_in_thread: true } });
  if (response?.code || !response?.data?.message_id) throw Error('文件消息发送失败。');
  const links = config.feishuMessageThreads || {};
  links[response.data.message_id] = taskId;
  config.feishuMessageThreads = Object.fromEntries(Object.entries(links).slice(-100));
  await saveConfig();
}

async function notifyTurnResult(text, { taskId, turnId, finalText, imagePaths = [], htmlPaths = [], cwd = '' }) {
  if (!await markCodexTurnComplete(turnId)) return;
  const quota = await currentQuotaText();
  const resultType=/\n\n状态：失败\s*$/.test(text)?'task_failed':'task_completed';
  const notice = await notify(`${text}\n\n${quota}`, { appName: 'Codex 任务', taskId, notificationType:resultType });
  if (!notice.ok || !notice.messageId) return;
  // Codex often returns generated images as ordinary Markdown links rather
  // than image syntax. Include those paths here so they are relayed even when
  // the session event did not expose an `imageGeneration` item.
  const textImagePaths = finalImagePaths(finalText, []);
  const allImagePaths = [...new Set([...(imagePaths || []), ...textImagePaths])].slice(0, 6);
  await relayFinalImages({ text: finalText, paths: allImagePaths, trustedPaths: allImagePaths, enabled: config.feishuImageRelayEnabled === true, root: config.feishuImageRelayRoot || '',
    send: bytes => sendFeishuResultImage(bytes, notice.messageId, taskId),
    report: async body => {
      pushHistory({ at: Date.now(), appName: 'Codex 图片', body, sent: false, reason: 'image-relay-failed', retryKind: 'image', replyTo: notice.messageId, taskId, imagePaths: allImagePaths });
      await saveConfig();
    } });
  const htmlCandidates = typeof finalHtmlPaths === 'function' ? finalHtmlPaths(finalText, htmlPaths) : htmlPaths;
  for (const filePath of htmlCandidates) {
    try {
      const file = await readRelayHtml(filePath, { trusted: htmlPaths.map(String).includes(filePath) || Boolean(cwd && path.relative(cwd, filePath) && !path.isAbsolute(path.relative(cwd, filePath))), root: cwd });
      await sendFeishuResultFile(file, notice.messageId, taskId);
    } catch (error) {
      pushHistory({ at: Date.now(), appName: 'Codex 文件', body: `HTML 未回传：${path.basename(filePath)}`, sent: false, reason: error.message });
      await saveConfig();
    }
  }
}

async function announceDesktopConversation(threadId) {
  const id = canonicalCodexThreadId(threadId);
  if (!id || codexSessionTopicsAnnounced.has(id)) return;
  const roots = config.feishuTaskTopicRoots && typeof config.feishuTaskTopicRoots === 'object' ? config.feishuTaskTopicRoots : {};
  const chats = config.feishuTaskTopicChats && typeof config.feishuTaskTopicChats === 'object' ? config.feishuTaskTopicChats : {};
  if (existingFeishuTaskTopic(id)) { codexSessionTopicsAnnounced.add(id); return; }
  codexSessionTopicsAnnounced.add(id);
  const activity = sessionActivities.get(id);
  const label = await taskConversationLabel(id, activity?.title || '', activity?.cwd || '');
  // Feishu uses the first post line as the topic title. Put the stable
  // project/conversation label there so topic lists remain distinguishable.
  await notify(`${label}\nCodex 对话已开始\n任务：${id}\n后续完成、图片、HTML 和 429 通知都会进入这个话题。`, { appName: 'Codex 任务', taskId: id, notificationType:'task_started' });
}

async function ensureFeishuTaskTopic(threadId) {
  const id = String(threadId || '').trim();
  if (!id || config.feishuNotificationThreadMode !== 'task' || !feishuClient || !config.feishuBoundChatId) return;
  const roots = config.feishuTaskTopicRoots && typeof config.feishuTaskTopicRoots === 'object' ? config.feishuTaskTopicRoots : {};
  const chats = config.feishuTaskTopicChats && typeof config.feishuTaskTopicChats === 'object' ? config.feishuTaskTopicChats : {};
  if (roots[id] && chats[id] === config.feishuBoundChatId) return;
  await announceDesktopConversation(id);
}

function existingFeishuTaskTopic(threadId) {
  const id = canonicalCodexThreadId(threadId);
  if (!id) return '';
  const roots = config.feishuTaskTopicRoots || {}, chats = config.feishuTaskTopicChats || {};
  if (roots[id] && chats[id] === config.feishuBoundChatId) return String(roots[id]);
  const alias = Object.keys(roots).find(key => chats[key] === config.feishuBoundChatId && canonicalCodexThreadId(key) === id);
  if (alias) return String(roots[alias]);
  return '';
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
  // Generic notifications (for example Windows system notifications and quota
  // alerts) must remain top-level messages.  Falling back to the bound Codex
  // conversation here incorrectly attached unrelated notices to that topic.
  return '';
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

async function rotateFeishuTopic(threadId) {
  const id = canonicalCodexThreadId(threadId);
  if (!id) throw Error('没有识别到要重开话题的 Codex 对话。');
  const roots = config.feishuTaskTopicRoots && typeof config.feishuTaskTopicRoots === 'object' ? config.feishuTaskTopicRoots : {};
  const chats = config.feishuTaskTopicChats && typeof config.feishuTaskTopicChats === 'object' ? config.feishuTaskTopicChats : {};
  delete roots[id];
  delete chats[id];
  for (const key of Object.keys(roots)) if (canonicalCodexThreadId(key) === id) { delete roots[key]; delete chats[key]; }
  config.feishuTaskTopicRoots = roots;
  config.feishuTaskTopicChats = chats;
  codexSessionTopicsAnnounced.delete(id);
  await saveConfig();
  return { ok: true, threadId: id };
}

async function forgetFeishuThreadMapping(threadId) {
  const id = String(threadId || '').trim();
  if (!id) return;
  if (String(config.feishuBoundThreadId || '') === id) {
    config.feishuBoundThreadId = '';
    config.feishuBoundThreadName = '';
  }
  const roots = config.feishuTaskTopicRoots && typeof config.feishuTaskTopicRoots === 'object' ? config.feishuTaskTopicRoots : {};
  const chats = config.feishuTaskTopicChats && typeof config.feishuTaskTopicChats === 'object' ? config.feishuTaskTopicChats : {};
  delete roots[id]; delete chats[id];
  config.feishuTaskTopicRoots = roots; config.feishuTaskTopicChats = chats;
  const links = config.feishuMessageThreads && typeof config.feishuMessageThreads === 'object' ? config.feishuMessageThreads : {};
  config.feishuMessageThreads = Object.fromEntries(Object.entries(links).filter(([, value]) => String(value) !== id));
  codexSessionTopicsAnnounced.delete(id);
  await saveConfig();
}

function feishuRunningCount() {
  const ids = new Set([...tasks.values()]
    .filter(task => ['starting', 'running', 'waiting_confirmation', 'retry_waiting'].includes(task.status))
    .map(task => String(task.id)));
  for (const row of publicTaskActivity()) ids.add(String(row.id));
  return ids.size;
}

function feishuMenuText() {
  const takeover = desktopTakeoverAllowed(config) ? '开启' : '关闭';
  const retry = desktopRetryState();
  return `Codex Tools 手机菜单\n\n自动重试：${retry.enabled ? '开启' : '关闭'}${retry.enabled ? `（已点击 ${retry.hits} 次）` : ''}\n自动接管：${takeover}\n运行中对话：${feishuRunningCount()} 个\n\n可直接回复下面的命令：\n· 自动重试 开启\n· 自动重试 关闭\n· 自动接管 开启\n· 自动接管 关闭\n· 状态\n· 自动重试（查状态）\n· 交接提示词\n· 刷新额度\n· 绑定最近对话\n· 新话题\n\n说明：自动重试只是按下桌面端自己的重试按钮，不改对话、不换模型；它开启时自动接管不再转入后台。`;
}

function desktopRetryStatusText() {
  const retry = desktopRetryState();
  const lines = [`自动重试：${retry.enabled ? '开启' : '关闭'}`];
  if (!retry.supported) return `${lines[0]}\n\n这个功能只在 Windows 桌面端可用。`;
  if (retry.enabled) {
    lines.push(`后台监视器：${retry.running ? '运行中' : '没在跑（可能刚启动或被关掉了）'}`);
    lines.push(`已自动点击：${retry.hits} 次（最近 10 分钟 ${retry.hitsLast10Minutes || 0} 次，最近 1 小时 ${retry.hitsLast60Minutes || 0} 次）`);
    if (retry.lastHitAt) lines.push(`最近一次：${new Date(retry.lastHitAt).toLocaleString('zh-CN', { hour12: false })}`);
    if (retry.lastMethod) lines.push(`点击方式：${retry.lastMethod === 'mouse' ? '鼠标（用完已放回原位）' : '系统消息，不动鼠标'}`);
    if (retry.skipped) lines.push(`因为你在用鼠标，跳过 ${retry.skipped} 次`);
    if (retry.lastIgnoredAt) lines.push(`最近没点：不是模型繁忙的重试（${retry.lastIgnoredText || '没读到错误原文'}），需要你手动处理`);
    if (retry.lastError) lines.push(`最近错误：${retry.lastError}`);
    lines.push(`繁忙提示：已静默，每 ${Math.max(1, Math.round(Number(config.desktopRetryQuietMinutes) || 10))} 分钟最多提醒一次`);
  }
  return lines.join('\n');
}

// The watcher found a retry button whose error is not a capacity problem
// (for example a conversation opened under a different login/provider). Clicking
// cannot help, so it stays away and says so - once every 10 minutes at most.
setDesktopRetryNotifier(({ window, text }) => {
  const detail = String(text || '').trim() || '（没能读到错误原文，可能需要你在客户端里看一眼）';
  let advice = '点了也不会好。最常见的是模型不可用或账号/登录方式不匹配，需要你在客户端里处理一下。';
  if (/provider/i.test(detail)) {
    advice = '这是账号/登录方式不匹配：这个对话是用另一种登录方式创建的。按提示切回原来的登录方式/账号（在两个账号之间切换试试），或新开一个对话，就能继续。';
  } else if (/model\s*(is\s*)?(unavailable|deprecated|retired)|模型.*(不可用|停用|下线|太旧|过旧|已弃用)/i.test(detail)) {
    advice = '这个对话用的模型已经不可用。在底部模型下拉里换一个可用模型即可继续，不用点重试。';
  }
  notify(`这个「重试」不是模型繁忙，我没有自动点\n窗口：${window}\n错误内容：${detail}\n\n${advice}`, { appName: 'Codex 任务', notificationType: 'task_approval' }).catch(() => {});
});

async function handleFeishuControlCommand(text, message) {
  const command = String(text || '').trim().replace(/[：:]/g, ' ');
  if (/^(菜单|menu|设置|帮助|help)$/i.test(command)) {
    await sendFeishuAppText(feishuMenuText(), { replyTo: message.message_id });
    return true;
  }
  // "自动重试" on its own is a question, not a command: people mostly want to
  // know whether it is still watching before they trust it.
  if (/^(自动重试|重试|点重试)\s*(状态|情况|怎么样|status)?$/i.test(command)) {
    await sendFeishuAppText(`${desktopRetryStatusText()}\n\n${feishuMenuText()}`, { replyTo: message.message_id });
    return true;
  }
  if (/^(自动重试|重试|点重试)\s*(开启|打开|开|on)$/i.test(command)) {
    config.desktopRetryAutoClick = true;
    await saveConfig();
    syncDesktopRetryWatcher(config);
    await sendFeishuAppText('自动重试已开启。桌面端提示模型繁忙时会自动按下重试按钮，不改动对话内容、不更换模型；自动接管已同时停用。\n\n' + feishuMenuText(), { replyTo: message.message_id });
    return true;
  }
  if (/^(自动重试|重试|点重试)\s*(关闭|关|off)$/i.test(command)) {
    config.desktopRetryAutoClick = false;
    await saveConfig();
    syncDesktopRetryWatcher(config);
    await sendFeishuAppText('自动重试已关闭。以后需要你自己点击桌面端的重试按钮。\n\n' + feishuMenuText(), { replyTo: message.message_id });
    return true;
  }
  if (/^(自动接管|接管)\s*(开启|打开|开|on)$/i.test(command)) {
    if (config.desktopRetryAutoClick === true) {
      await sendFeishuAppText('自动重试正在开启，两者不能同时工作。请先回复「自动重试 关闭」再开启自动接管。', { replyTo: message.message_id });
      return true;
    }
    config.autoTakeoverDesktopTransient = true;
    await saveConfig();
    await sendFeishuAppText('自动接管已开启。模型容量不足时会自动转入后台，用当前模型重试；过程静默，只发送开始和最终结果。\n\n' + feishuMenuText(), { replyTo: message.message_id });
    return true;
  }
  if (/^(自动接管|接管)\s*(关闭|关|off)$/i.test(command)) {
    config.autoTakeoverDesktopTransient = false;
    await saveConfig();
    await sendFeishuAppText('自动接管已关闭。桌面端遇到模型容量不足时不会自动转入后台。\n\n' + feishuMenuText(), { replyTo: message.message_id });
    return true;
  }
  if (/^(状态|status)$/i.test(command)) {
    await sendFeishuAppText(`Codex Tools 当前状态\n\n${desktopRetryStatusText()}\n自动接管：${desktopTakeoverAllowed(config) ? '开启' : '关闭'}\n运行中对话：${feishuRunningCount()} 个\n当前账号：${accounts.find(account => account.is_active)?.display_name || accounts.find(account => account.is_active)?.name || '未识别'}\n\n${feishuMenuText()}`, { replyTo: message.message_id });
    return true;
  }
  if (/^(交接提示词|交接摘要|收尾提示词|收尾)$/i.test(command)) {
    await sendFeishuAppText(`${HANDOFF_PROMPT}\n\n把它粘到 Codex 里，它会输出一份交接摘要；把摘要复制出来，新建对话粘进去就能接着干。`, { replyTo: message.message_id });
    return true;
  }
  if (/^(刷新额度|额度|quota)$/i.test(command)) {
    await sendFeishuAppText(await currentQuotaText(), { replyTo: message.message_id });
    return true;
  }
  if (/^(绑定最近对话|绑定最近任务)$/i.test(command)) {
    const thread = await bindLatestFeishuThread();
    await sendFeishuAppText(`已绑定最近的 Codex 对话：${thread.name}`, { replyTo: message.message_id, taskId: thread.id });
    return true;
  }
  return false;
}

async function handleFeishuMessage(data) {
  let replyMessageId = '';
  let selectedThreadId = '';
  try {
    const message = data?.message || {};
    replyMessageId = String(message.message_id || '');
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
    if (message.message_type === 'text' && typeof handleFeishuControlCommand === 'function' && await handleFeishuControlCommand(text, message)) return;
    if (message.message_type === 'text' && isQuotaCommand(text)) {
      await sendFeishuAppText(await currentQuotaText(), { replyTo: message.message_id });
      return;
    }
    // Resolve old aliases and explicit reply history; never redirect an
    // unrecognized topic to an unrelated default conversation.
    const threadId = await resolveFeishuReplyThread(message);
    selectedThreadId = String(threadId || '');
    if (!threadId) {
      await sendFeishuAppText('无法识别这条消息所属的原 Codex 对话，未转发到其他任务。请从对应任务的结果通知回复，或在本机控制台核对绑定。', { replyTo: message.message_id });
      return;
    }
    if (message.message_type === 'text' && /^(新话题|重开话题|换个话题|rotate topic)$/i.test(text)) {
      await rotateFeishuTopic(threadId);
      await sendFeishuAppText('已为这个 Codex 对话关闭旧话题映射。下一条完成结果会自动创建新的飞书话题，旧话题保留不变。', { replyTo: message.message_id, taskId: threadId });
      return;
    }
    if (typeof ensureFeishuTaskTopic === 'function') await ensureFeishuTaskTopic(String(threadId));
    const task = await continueThreadFromFeishu(String(threadId), input, { manual: true });
    config.feishuBoundThreadId = task.id;
    config.feishuBoundThreadName = String(task.prompt || task.id);
    await saveConfig();
    const backgroundNote = task.remoteDesktopTakeover ? '\n\nCodex 正在后台处理；本轮结束后会自动重新打开桌面端。' : '';
    const incomingLinks = config.feishuMessageThreads && typeof config.feishuMessageThreads === 'object' ? config.feishuMessageThreads : {};
    incomingLinks[String(message.message_id)] = String(task.id);
    config.feishuMessageThreads = Object.fromEntries(Object.entries(incomingLinks).slice(-100));
    await saveConfig();
    if (task.remoteDesktopTakeover) {
      let reacted = false;
      try {
        const reaction = await feishuClient?.im?.v1?.messageReaction?.create({
          path: { message_id: String(message.message_id) },
          data: { reaction_type: { emoji_type: 'OK' } },
        });
        reacted = !reaction?.code;
      } catch (error) { console.warn('[feishu reaction]', error.message); }
      if (!reacted) await sendFeishuAppText('Codex 正在后台处理；本轮结束后会自动重新打开桌面端。', { replyTo: message.message_id, taskId: task.id });
    } else {
      await sendFeishuAppText(`${message.message_type === 'image' ? '图片已发送' : '已发送'}到原 Codex 对话：${task.prompt || task.id}`, { replyTo: message.message_id, taskId: task.id });
    }
  } catch (error) {
    console.error('[feishu reply]', error.message);
    const notFound = /thread\s+not\s+found|找不到.*对话|对话不存在/i.test(String(error?.message || error || ''));
    const message = notFound
      ? '后台暂时无法载入这条通知对应的 Codex 对话，尚不能确认对话已删除。原话题映射已保留，未转发到其他任务。请在本机控制台检查原对话或稍后重试。'
      : `没有成功继续 Codex 对话：${humanError(error)}`;
    try { await sendFeishuAppText(message, { replyTo: replyMessageId, taskId:selectedThreadId }); } catch {}
  }
}

function isActiveWriterError(error) {
  return /already has an active writer|thread-store conflict/i.test(String(error?.message || error || ''));
}

function feishuReplyThreadId(message) {
  const root=String(message.root_id||message.rootId||'').trim();
  const parent=String(message.parent_id||message.parentId||'').trim();
  const roots=config.feishuTaskTopicRoots||{},links=config.feishuMessageThreads||{};
  const topic=Object.entries(roots).find(([,value])=>(root&&String(value)===root)||(parent&&String(value)===parent))?.[0];
  const historical=(config.notificationHistory||[]).find(item=>item.sent&&item.messageId&&(item.messageId===root||item.messageId===parent))?.taskId;
  const anchor=config.feishuReplyTopicAnchors?.[root];
  const recovered=anchor&&anchor.chatId===config.feishuBoundChatId?anchor.threadId:'';
  const candidate=topic||recovered||links[root]||links[parent]||historical||(!root&&!parent?config.feishuBoundThreadId:'');
  return canonicalCodexThreadId(candidate);
}

async function resolveFeishuReplyThread(message) {
  let threadId=feishuReplyThreadId(message);
  let rootId=String(message.root_id||message.rootId||'');
  if(!threadId&&feishuClient){
    const recovered=await recoverReplyTarget({message,chatId:config.feishuBoundChatId,appId:config.feishuAppId,canonical:canonicalCodexThreadId,
      fetchMessage:async id=>{
        let timer;
        try{return await Promise.race([feishuClient.im.v1.message.get({path:{message_id:id}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('message-read-timeout')),8000)})])}
        finally{clearTimeout(timer)}
      }});
    threadId=recovered.threadId;rootId=recovered.rootId||rootId;
    console.log(`[feishu reply recovery] ${recovered.reason}; resolved=${Boolean(threadId)}`);
  }
  if(threadId&&rootId){
    // Repair outbound routing too, but never replace an already chosen topic.
    if (!existingFeishuTaskTopic(threadId)) {
      (config.feishuTaskTopicRoots ||= {})[threadId] = rootId;
      (config.feishuTaskTopicChats ||= {})[threadId] = config.feishuBoundChatId;
      await saveConfig();
    }
    const anchors=config.feishuReplyTopicAnchors||{};
    if(anchors[rootId]?.threadId!==threadId||anchors[rootId]?.chatId!==config.feishuBoundChatId){
      anchors[rootId]={threadId,chatId:config.feishuBoundChatId};
      config.feishuReplyTopicAnchors=Object.fromEntries(Object.entries(anchors).slice(-1000));
      await saveConfig();
    }
  }
  return threadId;
}

async function continueThreadFromFeishu(threadId, input, { manual = false } = {}) {
  threadId=canonicalCodexThreadId(threadId);
  if (manual) codexSessionAutoTakeoverThreads.delete(String(threadId));
  try {
    const task = await codex.resumeTask(threadId);
    if (manual) { task.autoRetryTransientCount = 0; task.autoRetry429Count = 0; }
    await codex.continueTask(task, input);
    return task;
  } catch (error) {
    if (!isActiveWriterError(error) || !await isCodexDesktopRunning()) throw error;
  }

  await closeCodexDesktop();
  await rememberDesktopTakeover(threadId);
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
    if (manual) { task.autoRetryTransientCount = 0; task.autoRetry429Count = 0; }
    task.remoteDesktopTakeover = true;
    // Register before turn/start: a fast completion can precede its RPC reply.
    await codex.continueTask(task, input);
    return task;
  } catch (error) {
    await finishDesktopTakeover(threadId);
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

async function handleFeishuReaction(data) {
  let requestThreadId = '';
  try {
    const event = data?.event || data || {};
    const emoji = String(event.reaction_type?.emoji_type || event.reactionType?.emojiType || '').toUpperCase();
    const expected = String(config.feishuContinueEmoji || 'OK').toUpperCase();
    if (!emoji || emoji !== expected) return;
    const operatorType = String(event.operator_type || event.operatorType || event.user_id?.user_type || '').toLowerCase();
    if (operatorType === 'app' || operatorType === 'bot') return;
    const senderId = String(event.user_id?.open_id || event.user_id?.openId || event.operator_id?.open_id || event.operator_id?.openId || '');
    if (senderId && Array.isArray(config.feishuAllowedUserIds) && !config.feishuAllowedUserIds.map(String).includes(senderId)) return;
    const messageId = String(event.message_id || event.messageId || '').trim();
    if (!messageId || !config.feishuBoundChatId) return;
    const links = config.feishuMessageThreads && typeof config.feishuMessageThreads === 'object' ? config.feishuMessageThreads : {};
    const historical=(config.notificationHistory||[]).find(item=>item.sent&&item.messageId===messageId)?.taskId;
    const threadId = canonicalCodexThreadId(links[messageId] || historical) || await resolveFeishuReplyThread({parent_id:messageId});
    if (!threadId) return;
    requestThreadId = threadId;
    const now = Date.now();
    const previous = feishuContinueRequests.get(threadId) || 0;
    if (now - previous < 45000) {
      await sendFeishuAppText('这个对话刚刚已经收到“继续”请求，请等待本轮结果后再重试。', { replyTo: messageId, taskId: threadId });
      return;
    }
    feishuContinueRequests.set(threadId, now);
    const task = await continueThreadFromFeishu(threadId, [{ type: 'text', text: '继续往下推进' }], { manual: true });
    await sendFeishuAppText('已收到表情，继续推进这个 Codex 对话。', { replyTo: messageId, taskId: task.id });
    setTimeout(() => { if (feishuContinueRequests.get(threadId) === now) feishuContinueRequests.delete(threadId); }, 45000).unref?.();
  } catch (error) {
    console.error('[feishu reaction command]', error.message);
    if (requestThreadId) feishuContinueRequests.delete(requestThreadId);
  }
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
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': data => receiveFeishuMessage(data),
    'im.message.reaction.created_v1': handleFeishuReaction,
  });
  feishuWsClient.start({ eventDispatcher: dispatcher }).catch(error => { feishuState = { ...feishuState, state: 'failed', error: humanError(error) }; });
}
// Every incoming message is written to a local file before anything else
// happens: an AI running on this PC can then read it, without waiting for a
// Feishu admin to approve an app.
async function receiveFeishuMessage(data) {
  const entry = inboxEntryFromEvent(data);
  if (entry) await feishuInbox.append(entry).catch(error => console.error('[feishu inbox]', humanError(error)));
  if (await replyFeishuInbox(data, entry)) return;
  return handleFeishuMessage(data);
}
// "收件箱" lets the phone read back what this PC received.
async function replyFeishuInbox(data, entry) {
  if (!/^(收件箱|消息|最近消息|inbox)$/i.test(String(entry?.text || '').trim())) return false;
  const senderId = String(data?.sender?.sender_id?.open_id || '');
  const allow = Array.isArray(config.feishuAllowedUserIds) ? config.feishuAllowedUserIds : [];
  if (!allow.includes(senderId)) return false;
  const recent = await feishuInbox.recent(10);
  // 手机上打不开本机路径，所以这里直接把内容发全：每条最多 400 字，整条控制在 2200 字内。
  let budget = 2200;
  const shown = [];
  for (const item of recent) {
    const text = String(item.text || '').replace(/\s+/g, ' ').trim() || '（无文字内容）';
    const when = new Date(Number(item.at) || Date.now());
    const stamp = when.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const clipped = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    const line = `${shown.length + 1}. ${stamp} ${clipped}`;
    if (shown.length && line.length > budget) break;
    budget -= line.length;
    shown.push(line);
  }
  const hidden = recent.length - shown.length;
  const body = shown.length ? shown.join('\n') : '还没有收到任何消息。';
  const tail = [
    hidden > 0 ? `还有 ${hidden} 条没显示完（内容较长），完整记录在本机：${feishuInbox.paths.mdPath}` : '',
    `想让 AI 处理：让 Codex / WorkBuddy 读取 ${feishuInbox.paths.mdPath}`,
  ].filter(Boolean).join('\n');
  await sendFeishuAppText(`飞书消息收件箱（最近 ${shown.length} 条${hidden ? ` / 共 ${recent.length} 条` : ''}）\n\n${body}${tail ? `\n\n${tail}` : ''}`, { replyTo: entry.messageId });
  return true;
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

// Native-account quota reads and warm-up live in native-usage.mjs. They run in
// a throwaway Codex process, so the state they need is injected: vault paths,
// caches and the live account list (both re-assigned elsewhere, hence getters).
const {
  nativeAccountEntry,
  warmupNativeAccount,
  readNativeUsage,
  readNativeUsages,
} = createNativeUsage({
  appDir,
  nativeAccountsPath,
  version: APP_VERSION,
  readJson,
  atomicJsonWrite,
  unprotectCredential,
  upsertNativeAccount,
  updateNativeAccountMetadata,
  getConfig: () => config,
  getAccounts: () => accounts,
  refreshAccounts,
  nativeUsageCache,
  nativeUsageInFlight,
  nativeWarmupsInProgress,
});
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
  // Fresh responses must not inherit freshness flags/timestamps from the
  // persisted startup snapshot. Incoming data supplies its own provenance.
  delete result.cached;
  delete result.observed_at;
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
function applyWebhookDelivery(results = []) {
  if (!Array.isArray(config.webhooks) || !results.length) return;
  const now = Date.now();
  for (const result of results) {
    const target = config.webhooks.find(item => String(item.id) === String(result.id));
    if (!target) continue;
    if (result.ok) { target.lastOkAt = now; target.lastError = ''; }
    else { target.lastErrorAt = now; target.lastError = friendlyWebhookReason(result.reason).slice(0, 200); }
  }
  saveConfig().catch(() => {});
}
async function notify(text, opts = {}) {
  const type=notificationType(text,opts.appName,opts.notificationType);
  if(type && !notificationEnabled(config,type)) {
    pushHistory({at:Date.now(),appName:normalizeAppName(opts.appName),body:trim(text,3800),sent:false,reason:'type-disabled',notificationType:type});
    saveConfig().catch(()=>{});
    return {ok:false,reason:'type-disabled'};
  }
  const notificationEmoji={quota_early:'🎉',quota_reset_soon:'⏰',quota_exhausted:'🚫',quota_expiry:'⌛',context_pressure:'📊',takeover_start:'🤖',task_retry:'🔁',task_approval:'🙋',task_stalled:'🐌',service_exit:'🛑',task_failed:'❌',task_completed:'✅',task_started:'▶️',windows:'🪟'};
  if(type&&notificationEmoji[type]) text=`${notificationEmoji[type]} ${text}`;
  const appName = normalizeAppName(opts.appName);
  const extraTargets = Array.isArray(config.webhooks) ? config.webhooks.filter(item => item && item.enabled !== false && item.url) : [];
  const hasFeishu = !!(config.feishuWebhookUrl || (feishuClient && config.feishuBoundChatId));
  if (!hasFeishu && !extraTargets.length) return { ok: false, reason: 'feishu-not-configured' };
  const blacklist = Array.isArray(config.notificationBlacklist) ? config.notificationBlacklist : [];
  if (blacklist.includes(appName)) {
    const entry = { at: Date.now(), appName, body: trim(text, 3800), sent: false, reason: 'muted' };
    pushHistory(entry);
    saveConfig().catch(() => {});
    return { ok: false, reason: 'muted' };
  }
  let releaseTopicLock = null;
  try {
    const embeddedTaskId = canonicalCodexThreadId(await inferNotificationTaskId(text, opts.taskId));
    let messageId = '';
    let feishuError = null;
    let webhookDelivered = 0;
    if (hasFeishu) try {
    if (feishuClient && config.feishuBoundChatId) {
      const topicMode = config.feishuNotificationThreadMode === 'task';
      const roots = config.feishuTaskTopicRoots && typeof config.feishuTaskTopicRoots === 'object' ? config.feishuTaskTopicRoots : {};
      const chats = config.feishuTaskTopicChats && typeof config.feishuTaskTopicChats === 'object' ? config.feishuTaskTopicChats : {};
      let replyTo = topicMode ? existingFeishuTaskTopic(embeddedTaskId) : '';
      if (topicMode && embeddedTaskId && !replyTo) {
        const previous = feishuTopicCreationLocks.get(embeddedTaskId) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        feishuTopicCreationLocks.set(embeddedTaskId, current);
        await previous;
        releaseTopicLock = () => {
          release?.();
          if (feishuTopicCreationLocks.get(embeddedTaskId) === current) feishuTopicCreationLocks.delete(embeddedTaskId);
        };
        // Another completion may have created the root while this call waited.
        replyTo = existingFeishuTaskTopic(embeddedTaskId);
      }
      const compactText = replyTo
        ? String(text).replace(/^\s*(?:任务|对话)：[0-9a-f-]{20,}\s*$/gmi, '').replace(/\n{3,}/g, '\n\n').trim()
        : text;
      let sent;
      try {
        sent = await sendFeishuAppText(compactText, { replyTo, taskId: embeddedTaskId });
      } catch (error) {
        if (!replyTo || !topicMode || !embeddedTaskId) throw error;
        // A transport/permission failure is not proof the topic was deleted.
        // Preserve its mapping; explicit topic rotation remains available.
        console.warn('[feishu topic] reply failed; existing topic preserved');
        throw error;
      }
      messageId = sent.messageId || '';
      if (topicMode && embeddedTaskId && messageId && !replyTo) {
        roots[embeddedTaskId] = messageId;
        chats[embeddedTaskId] = config.feishuBoundChatId;
        config.feishuTaskTopicRoots = Object.fromEntries(Object.entries(roots).slice(-100));
        config.feishuTaskTopicChats = Object.fromEntries(Object.entries(chats).filter(([id]) => config.feishuTaskTopicRoots[id]).slice(-100));
        await saveConfig();
        // Feishu only exposes a dedicated topic window after the root has a
        // reply. Create one short marker so every task is immediately findable
        // as a topic, even before its first completion/image reply.
        await sendFeishuAppText('已建立此 Codex 任务话题。', { replyTo: messageId, taskId: embeddedTaskId });
      }
      releaseTopicLock?.();
      releaseTopicLock = null;
    } else {
      const response = await fetch(config.feishuWebhookUrl, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ msg_type: 'post', content: { post: buildFeishuPost(text) } }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json().catch(() => ({}));
      if (result.code && result.code !== 0) throw new Error(result.msg || `飞书错误 ${result.code}`);
    }
    } catch (error) {
      // A Feishu hiccup must not swallow the other channels.
      feishuError = error;
      releaseTopicLock?.();
      releaseTopicLock = null;
      console.warn('[notify] feishu failed:', error.message);
    }
    if (extraTargets.length) {
      const delivery = await sendWebhooks(extraTargets, text, { appName, title: opts.title || appName });
      webhookDelivered = delivery.ok;
      applyWebhookDelivery(delivery.results);
    }
    if (feishuError && !webhookDelivered) throw feishuError;
    pushHistory({ at: Date.now(), appName, body: trim(text, 3800), sent: true, taskId: embeddedTaskId || '', messageId: messageId || '' });
    saveConfig().catch(() => {});
    return { ok: true, messageId };
  } catch (e) {
    // Do not leave a per-task creation lock held if the Feishu API rejects a
    // root or the network drops while creating it.
    releaseTopicLock?.();
    pushHistory({ at: Date.now(), appName, body: trim(text, 3800), sent: false, reason: e.message, taskId: String(opts.taskId || '') });
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
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(value)) / 1000;
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.floor(timestamp - Date.now() / 1000);
  if (seconds <= 0) return '已重置';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${Math.max(1, minutes)}分`;
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
        if (observeEarlyQuotaReset(config.quotaRecoveryObservations, recoveryKey, { used, resetAt, observedAt: Number(account.usage.observed_at) || nowSeconds })) {
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
      if(notificationEnabled(config,'quota_reset_soon')) {
        config.quotaResetReminderLedger ||= {};
        const lead=nextResetReminder(config.quotaResetReminderLedger,key,{resetAt,now:nowSeconds,leads:resetReminderLeads(config),windowMinutes:Number(account.usage?.[windowKey])});
        if(lead!==null) {
          await saveConfig();
          await notify(`Codex 额度即将重置\n账号：${account.display_name||account.name}\n类型：${label}\n提醒提前量：${lead>=60?`${lead/60} 小时`:`${lead} 分钟`}\n预计还有：${Math.max(1,Math.ceil(remainingSeconds/60))} 分钟\n重置时间：${new Date(resetAt*1000).toLocaleString('zh-CN')}`,{appName:'Codex 额度',notificationType:'quota_reset_soon'});
        }
      }
    }
  }
  // Save before sending: restarting Companion must not repeat the same recovery.
  if (recoveryObservationsChanged) await saveConfig();
  const currentRestored = restored.filter(item => accounts.some(account => String(account.id) === String(item.id)));
  if (currentRestored.length) {
    const lines = currentRestored.map(item => `账号：${item.account} · ${item.type} · 剩余 100%`).join('\n');
    await notify(`Codex 额度已提前恢复至 100%\n${lines}\n\n检测到额度在原定重置时间之前恢复，可能是官方调整或手动重置；仅凭额度数据无法区分来源。`, { appName: 'Codex 额度' });
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
  if (codexSessionIdentities.has(file)) return codexSessionIdentities.get(file);
  return path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] || '';
}

function canonicalCodexThreadId(threadId) {
  const id=String(threadId||'').trim();
  if(!id)return '';
  for(const [file,canonical] of codexSessionIdentities) {
    if(path.basename(file).endsWith(`${id}.jsonl`))return canonical;
  }
  return id;
}

function rememberSessionIdentity(file, payload) {
  const id = String(payload?.id || '').trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  codexSessionIdentities.set(file, id);
  if (sessionKindFromMeta(payload) !== 'user') return;
  const alias = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] || '';
  if (!alias || alias === id) return;
  const roots = config.feishuTaskTopicRoots || {};
  const chats = config.feishuTaskTopicChats || {};
  if (roots[alias] && chats[alias] === config.feishuBoundChatId && (!roots[id] || chats[id] !== config.feishuBoundChatId)) {
    roots[id] = roots[alias]; chats[id] = chats[alias];
    config.feishuTaskTopicRoots = roots; config.feishuTaskTopicChats = chats;
  }
  for (const [messageId, taskId] of Object.entries(config.feishuMessageThreads || {})) {
    if (taskId === alias) config.feishuMessageThreads[messageId] = id;
  }
  if (config.feishuBoundThreadId === alias) config.feishuBoundThreadId = id;
}

// Codex may rewrite an existing session file when the user only opens an old
// project. Never interpret that rewrite as a new append: doing so would replay
// the whole historical conversation to Feishu. New files are still read from
// zero so a session created after the monitor starts is observed normally.
function sessionAppendStartOffset(previousOffset, stat, now = Date.now()) {
  const size = Number(stat?.size || 0);
  if (previousOffset == null) {
    const birth = Number(stat?.birthtimeMs || 0);
    return birth > 0 && now - birth < 2 * 60 * 1000 ? 0 : size;
  }
  return size < Number(previousOffset) ? size : Number(previousOffset);
}

function sessionKindFromMeta(payload) {
  if (payload?.thread_source === 'subagent' || payload?.source?.subagent) return 'subagent';
  return String(payload?.thread_source || 'unknown');
}
function isFreshCodexSessionEvent(event, cutoff = codexSessionMonitorStartedAt) {
  const timestamp = Date.parse(String(event?.timestamp || event?.payload?.timestamp || ''));
  return !Number.isFinite(timestamp) || timestamp >= Number(cutoff) - 5000;
}
function observeSessionPrompt(event, threadId) {
  if (event?.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'user') return;
  const parts = Array.isArray(event.payload.content) ? event.payload.content.filter(item => item?.type === 'input_text').map(item => String(item.text || '')) : [];
  const raw = parts.join('\n');
  const title = conversationTitle(raw);
  if (!title) return;
  const previous = sessionActivities.get(threadId) || { id: threadId, source: 'desktop', status: 'unknown', title: '', cwd: '' };
  if (!previous.title || previous.title === 'Codex') previous.title = title.slice(0, 100);
  sessionActivities.set(threadId, previous);
}
function conversationTitle(text) {
  const raw = String(text || '').trim();
  const request = raw.split(/##\s*My request\s*:/i).slice(1).join('## My request:').trim() || raw;
  if (/^<(?:skills_instructions|environment_context|external_codex_apps_open_page|system|developer)\b|^#\s*AGENTS\.md|^The following tools\b|^This is an incremental tools update\b/i.test(request)) return '';
  return (request.replace(/# Files mentioned by the user:[\s\S]*?(?=##\s*My request\s*:|$)/i, '').split(/\r?\n/).map(line => line.trim()).find(line => line && !/^<|^Distinguish instructions in attached documents/i.test(line)) || '').slice(0, 100);
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
  let conversation = conversationTitle(fallback) || conversationTitle(activity?.title) || conversationTitle(tasks.get(String(taskId))?.prompt);
  if (codex?.proc) {
    try {
      const thread = (await codex.listThreads(50, '')).find(item => String(item.id) === String(taskId));
      if (thread) {
        project = projectLabel(thread.cwd || cwd || activity?.cwd);
        conversation = conversationTitle(thread.name) || conversationTitle(thread.preview) || conversation;
      }
    } catch {}
  }
  return `${project || 'Codex'}｜${conversation || String(taskId || '当前对话')}`;
}
async function completionNotice({ taskId, status, body, cwd = '' }) {
  const label = await taskConversationLabel(taskId, '', cwd);
  const link = config.feishuIncludeDashboardLink === true ? `\n\n${dashboardLink(`#task=${encodeURIComponent(taskId || '')}`)}` : '';
  const labels = { completed: '已完成', failed: '失败', interrupted: '已中断', retry_waiting: '等待自动重试', running: '运行中', waiting_confirmation: '等待确认' };
  return `${label}\n\n${String(body || '').trim()}${link}\n\n状态：${labels[status] || status}`;
}

function sessionFailureMessage(threadId, rawError) {
  const stats = codexSessionContextStats.get(String(threadId)) || {};
  const used = Number(stats.inputTokens || stats.totalTokens);
  const limit = Number(stats.contextWindow);
  const ratio = limit > 0 ? used / limit : 0;
  if (ratio >= 0.9 && /stream disconnected|stream closed before response\.completed/i.test(String(rawError || ''))) {
    return `Codex 对话过长，压缩上下文时中断。\n已使用约 ${Math.round(used / 1000)}k / ${Math.round(limit / 1000)}k token（${Math.round(ratio * 100)}%）。\n\n继续重试或切换模型通常不能解决。请新建对话，并让旧对话先生成交接摘要后再继续。`;
  }
  return `Codex 任务失败：${humanError(rawError || '没有收到完整的完成结果。')}`;
}

async function readCodexSessionKind(file) {
  try {
    const handle = await fs.open(file, 'r');
    const chunks=[];let total=0;
    // session_meta includes instructions and can be far larger than 16 KB.
    // Read complete lines, with a hard 4 MB cap; never parse a truncated prefix.
    try {
      while(total<4*1024*1024){
        const buffer=Buffer.alloc(Math.min(16384,4*1024*1024-total));
        const {bytesRead}=await handle.read(buffer,0,buffer.length,total);
        if(!bytesRead)break;
        const chunk=buffer.subarray(0,bytesRead);chunks.push(chunk);total+=bytesRead;
        if(chunk.includes(10))break;
      }
    } finally { await handle.close(); }
    const prefix = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'');
    for (const line of prefix.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'session_meta') { rememberSessionIdentity(file, event.payload); return sessionKindFromMeta(event.payload); }
      } catch {}
    }
    return 'unknown';
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
    const previousOffset = codexSessionOffsets.get(file);
    const rewrite = codexSessionRewrites.get(file);
    if (rewrite) {
      // A rewrite can arrive in several fs.watch callbacks. Keep advancing the
      // offset while the file is changing, but never parse those historical
      // bytes as fresh conversation events.
      if (stat.size !== rewrite.lastSize) {
        rewrite.lastSize = stat.size;
        rewrite.until = Date.now() + 1500;
      }
      codexSessionOffsets.set(file, stat.size);
      codexSessionPartials.delete(file);
      if (Date.now() < rewrite.until) return;
      codexSessionRewrites.delete(file);
      return;
    }
    const offset = sessionAppendStartOffset(previousOffset, stat);
    if (previousOffset == null || stat.size < Number(previousOffset)) {
      codexSessionOffsets.set(file, offset);
      codexSessionPartials.delete(file);
      if (stat.size < Number(previousOffset || 0)) {
        codexSessionRewrites.set(file, { lastSize: stat.size, until: Date.now() + 1500 });
      }
      if (offset === stat.size) return;
    }
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
        rememberSessionIdentity(file, event.payload);
        codexSessionKinds.set(file, sessionKindFromMeta(event.payload));
        observeSessionMeta(event.payload, sessionThreadId(file));
        continue;
      }
      if (!isFreshCodexSessionEvent(event)) continue;
      if ((codexSessionKinds.get(file) || 'unknown') !== 'user') continue;
      observeSessionPrompt(event, sessionThreadId(file));
      observeSessionActivity(event, codexSessionKinds.get(file) || 'unknown', sessionThreadId(file));
      if (event?.type === 'event_msg' && event?.payload?.type === 'token_count') {
        const info = event.payload.info || {};
        const usage = info.total_token_usage || info.last_token_usage || {};
        codexSessionContextStats.set(sessionThreadId(file), {
          inputTokens: Number(usage.input_tokens || 0), totalTokens: Number(usage.total_tokens || 0), contextWindow: Number(info.model_context_window || 0), at: Date.now(),
        });
      }
      if (event?.type === 'response_item' && event.payload?.type === 'message' && event.payload.role === 'user' && conversationTitle((event.payload.content || []).map(item => item.text || '').join('\n'))) {
        announceDesktopConversation(sessionThreadId(file)).catch(error => console.error('[codex topic]', error.message));
      }
      if (event?.type === 'event_msg' && event?.payload?.type === 'item_completed' && event.payload.item?.type === 'imageGeneration') {
        const savedPath = String(event.payload.item.savedPath || '').trim();
        const key = `${file}:${String(event.payload.turn_id || '')}`;
        if (savedPath) codexSessionImagePaths.set(key, [...new Set([...(codexSessionImagePaths.get(key) || []), savedPath])].slice(0, 6));
        continue;
      }
      if (event?.type === 'event_msg' && event?.payload?.type === 'item_completed' && event.payload.item?.savedPath && /\.html?$/i.test(String(event.payload.item.savedPath))) {
        const key = `${file}:${String(event.payload.turn_id || '')}`;
        const savedPath = String(event.payload.item.savedPath);
        codexSessionHtmlPaths.set(key, [...new Set([...(codexSessionHtmlPaths.get(key) || []), savedPath])].slice(0, 6));
        continue;
      }
      if (event?.type !== 'event_msg' || event?.payload?.type !== 'task_complete') continue;
      const cachedKind = codexSessionKinds.get(file) || 'unknown';
      const freshKind = await readCodexSessionKind(file);
      const sessionKind = freshKind !== 'unknown' ? freshKind : cachedKind;
      codexSessionKinds.set(file, sessionKind);
      // Only the user's main conversation owns completion notifications.
      if (sessionKind !== 'user') {
        console.log(`[codex session monitor] ignored ${sessionKind} completion: ${sessionThreadId(file) || path.basename(file)}`);
        continue;
      }
      const turnId = String(event.payload.turn_id || '');
      const threadId = sessionThreadId(file);
      const message = String(event.payload.last_agent_message || '').trim();
      const rawError = String(event.payload.error?.message || event.payload.error || '').trim();
      const eventText = `${message}\n${rawError}\n${JSON.stringify(event.payload)}`;
      const rateLimited = /(?:\b429\b|too many requests|exceeded retry limit)/i.test(JSON.stringify(event.payload));
      if (rateLimited) {
        await notify(`Codex 任务因 429 限流中断\n对话：${threadId}\n请在这条通知下添加快捷表情继续，或稍后在 Codex 中重试。\n${dashboardLink(`#task=${encodeURIComponent(threadId)}`)}`, { appName: 'Codex 任务', taskId: threadId });
        continue;
      }
      const capacityFailure = /selected model is at capacity|model is temporarily unavailable/i.test(eventText);
      const takeoverKey = `${file}:${turnId}`;
      // The watcher is already pressing Retry on the user's behalf, so a
      // capacity failure is the normal state, not news. Stay quiet and only
      // speak up when it has been stuck for a while.
      if (capacityFailure && config.desktopRetryAutoClick === true) {
        const silenceKey = String(threadId);
        const quietMs = Math.min(120, Math.max(1, Number(config.desktopRetryQuietMinutes) || 10)) * 60000;
        const seen = capacityRetrySilence.get(silenceKey);
        const nowMs = Date.now();
        if (!seen) {
          capacityRetrySilence.set(silenceKey, { firstAt: nowMs, count: 1, notifiedAt: 0 });
        } else {
          seen.count += 1;
          if (nowMs - seen.firstAt >= quietMs) {
            seen.firstAt = nowMs;
            seen.notifiedAt = nowMs;
            await notify(`Codex 还在排队，已自动重试 ${seen.count} 次\n对话：${threadId}\n\n服务端仍然繁忙，但额度没有问题。它会在有空位时自动继续，你不用管；等这一轮真正跑完我再通知你。\n（每 ${Math.round(quietMs / 60000)} 分钟最多提醒一次）`, { appName: 'Codex 任务', taskId: threadId });
          }
        }
        maybeWarnContextPressure(threadId).catch(error => console.error('[context pressure]', error.message));
        continue;
      }
      capacityRetrySilence.delete(String(threadId));
      if (capacityFailure && desktopTakeoverAllowed(config) && !desktopTakeoverIds().includes(String(threadId)) && !codexSessionAutoTakeovers.has(takeoverKey) && !codexSessionAutoTakeoverThreads.has(String(threadId))) {
        codexSessionAutoTakeovers.add(takeoverKey);
        codexSessionAutoTakeoverThreads.add(String(threadId));
        await notify(`检测到 Codex 模型暂时繁忙，开始自动接管并重试\n对话：${threadId}`, { appName: 'Codex 任务', taskId: threadId });
        try {
          await continueThreadFromFeishu(String(threadId), [{ type: 'text', text: '继续当前任务，恢复本轮工作并完成剩余内容。' }]);
        } catch (error) {
          await notify(`自动接管重试没有成功：${humanError(error)}\n对话：${threadId}`, { appName: 'Codex 任务', taskId: threadId });
        }
        continue;
      }
      // Once a desktop conversation has been handed to the backend, the old
      // desktop JSONL may repeat its failed completion. The backend owns the
      // final notification; never forward those stale repeats to Feishu.
      if (capacityFailure && desktopTakeoverIds().includes(String(threadId))) continue;
      if (!message) {
        if (rawError) {
          const cwd = sessionActivities.get(threadId)?.cwd || '';
          const body = sessionFailureMessage(threadId, rawError);
          await notifyTurnResult(await completionNotice({ taskId: threadId, status: 'failed', body, cwd }), { taskId: threadId, turnId, finalText: '', imagePaths: [], htmlPaths: [], cwd });
          maybeWarnContextPressure(threadId).catch(error => console.error('[context pressure]', error.message));
        }
        continue;
      }
      const imagePaths = codexSessionImagePaths.get(`${file}:${turnId}`) || [];
      const htmlPaths = codexSessionHtmlPaths.get(`${file}:${turnId}`) || [];
      codexSessionImagePaths.delete(`${file}:${turnId}`);
      codexSessionHtmlPaths.delete(`${file}:${turnId}`);
      await finishDesktopTakeover(threadId);
      const cwd = sessionActivities.get(threadId)?.cwd || '';
      await notifyTurnResult(await completionNotice({ taskId: threadId, status: 'completed', body: message, cwd }), { taskId: threadId, turnId, finalText: message, imagePaths, htmlPaths, cwd });
      maybeWarnContextPressure(threadId).catch(error => console.error('[context pressure]', error.message));
    }
  } catch (error) { console.error('[codex session monitor]', error.message); }
}

// While the desktop watcher is pressing Retry for the user, a capacity failure
// is expected noise - one notification per retry would bury everything else.
const capacityRetrySilence = new Map();

async function maybeWarnContextPressure(threadId) {
  const stats = codexSessionContextStats.get(String(threadId));
  if (!stats) return false;
  const ratio = contextRatio(stats);
  if (!ratio) return false;
  const ledger = config.contextPressureLedger && typeof config.contextPressureLedger === 'object' ? { ...config.contextPressureLedger } : {};
  const level = contextWarning(ledger, String(threadId), ratio);
  if (!level) return false;
  config.contextPressureLedger = trimContextLedger(ledger);
  await saveConfig();
  const used = Number(stats.inputTokens || stats.totalTokens || 0);
  const limit = Number(stats.contextWindow || 0);
  const label = await taskConversationLabel(threadId);
  const advice = level >= 95
    ? '已经贴着上限了。这个对话下一次压缩很可能中断，建议现在就让它交接，然后新建对话继续。'
    : level >= 85
      ? '建议让这个对话先生成交接摘要，再新建对话继续；继续堆内容会变慢、变贵。'
      : '还可以继续，但记着：重试一次就要把整段上下文重发一次。';
  await notify(`${label}\n\n上下文已用约 ${formatTokenCount(used)} / ${formatTokenCount(limit)} token（${Math.round(ratio * 100)}%）\n\n${advice}`, { appName: 'Codex 对话', taskId: threadId, notificationType: 'context_pressure' });
  return true;
}
async function startCodexSessionMonitor() {
  const root = path.join(process.env.USERPROFILE || '', '.codex', 'sessions');
  if (!existsSync(root)) return;
  codexSessionMonitorStartedAt = Date.now();
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

async function repairCompanion() {
  const actions = [];
  const roots = config.feishuTaskTopicRoots && typeof config.feishuTaskTopicRoots === 'object' ? config.feishuTaskTopicRoots : {};
  const chats = config.feishuTaskTopicChats && typeof config.feishuTaskTopicChats === 'object' ? config.feishuTaskTopicChats : {};
  const kept = Object.fromEntries(Object.entries(roots).filter(([id]) => chats[id] === config.feishuBoundChatId));
  if (Object.keys(kept).length !== Object.keys(roots).length) {
    config.feishuTaskTopicRoots = kept;
    config.feishuTaskTopicChats = Object.fromEntries(Object.keys(kept).map(id => [id, config.feishuBoundChatId]));
    await saveConfig();
    actions.push('已清理旧群聊/旧版本的话题映射');
  }
  if (!codex?.proc) { await startTaskEngine(); actions.push('已重新连接后台任务引擎'); }
  if (config.feishuAppId && config.feishuAppSecretProtected && !['connected','connecting','reconnecting'].includes(publicFeishuState().state)) {
    await startFeishuLongConnection();
    actions.push('已重新连接飞书长连接');
  }
  if (!codexSessionWatcherReady) { await startCodexSessionMonitor(); actions.push('已重新启动 Codex 对话监听'); }
  if (!actions.length) actions.push('当前服务和话题映射正常，无需修改');
  return { ok: true, actions, diagnostics: publicDiagnostics() };
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
    if (!rows.length) return;
    if (config.windowsNotifyForward !== true) return;
    const whitelist = Array.isArray(config.windowsNotifyApps) ? config.windowsNotifyApps.map(n => String(n || '').trim()).filter(Boolean) : [];
    const baseline = activeQuotaSnapshot();
    let forwarded = 0, overflow = 0;
    for (const row of rows) {
      const texts = [...String(row.payload || '').matchAll(/<text(?:\s[^>]*)?>([\s\S]*?)<\/text>/gi)].map(match => decodeXmlText(match[1])).filter(Boolean);
      if (!texts.length) continue;
      const appName = formatNotificationAppName(row.handlerId);
      if (codexSessionWatcherReady && appName === 'Codex') continue;
      if (whitelist.length && !whitelist.includes(appName)) continue;
      if (forwarded >= 12) { overflow++; continue; }
      // 默认只发标题（第一条文本）；正文开关打开后才带全部内容，避免私聊内容整段转发。
      const content = config.windowsNotifyIncludeBody === true ? texts.join('\n') : texts[0];
      await notify(`Windows 通知 · ${appName}\n${content}`, { appName });
      forwarded++;
    }
    if (overflow) await notify(`Windows 通知 · 汇总\n本轮还有 ${overflow} 条通知未转发（单轮最多 12 条），防止刷屏。`, { appName: 'Windows 通知' });
    refreshQuotaFromBaseline(baseline, { source: 'desktop', title: 'Windows 通知' }).catch(error => console.error('[desktop quota]', error.message));
  } catch (error) {
    console.error('[windows notifications]', error.message);
    try { notificationDb?.close(); } catch {}
    notificationDb = null;
  }
}

async function listWindowsNotificationApps() {
  try {
    if (!notificationDb) {
      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
      notificationDb = new DatabaseSync(dbPath, { readOnly: true });
    }
    const rows = notificationDb.prepare(
      `select h.PrimaryId as handlerId, count(*) as total
       from Notification n join NotificationHandler h on n.HandlerId = h.RecordId
       group by h.PrimaryId order by total desc limit 60`
    ).all();
    const agg = new Map();
    for (const row of rows) {
      const name = formatNotificationAppName(row.handlerId);
      if (!name || name === 'Codex') continue;
      const slot = agg.get(name) || { name, count: 0 };
      slot.count += Number(row.total) || 0;
      agg.set(name, slot);
    }
    return { ok: true, apps: [...agg.values()].sort((a, b) => b.count - a.count) };
  } catch (error) {
    try { notificationDb?.close(); } catch {}
    notificationDb = null;
    return { ok: false, apps: [], error: humanError(error) };
  }
}

class CodexServer {
  constructor() { this.pending = new Map(); this.nextId = 0; this.turns = new Map(); this.retryTimers = new Map(); this.proc = null; this.intentionalClose = false; }
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
    const id = r.thread.id; (this.loadedThreads ||= new Set()).add(id); const task = { id, cwd, prompt, status: 'starting', output: '', startedAt: new Date().toISOString(), lastEventAt: Date.now(), stallNotified: false, turnImagePaths: [], turnHtmlPaths: [] };
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
    if (existing && this.loadedThreads?.has(threadId)) return existing;
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
    (this.loadedThreads ||= new Set()).add(threadId);
    if (activeTurn) this.turns.set(threadId, activeTurn.id);
    return task;
  }
  async continueTask(task, input) {
    const model = arguments[2]?.model || '';
    if ((task.stopRequested || this.stopRequests?.has(task.id)) && ['starting','running','waiting_confirmation'].includes(task.status)) throw Error('停止请求尚未确认，请等本轮结束后再追加任务。');
    task.stopRequested = false;
    const items = Array.isArray(input) ? input : [{ type: 'text', text: String(input || '') }];
    const active = this.turns.get(task.id);
    if (active) await this.request('turn/steer', { threadId: task.id, input: items, expectedTurnId: active });
    else {
      task.turnImagePaths = [];
      const params = { threadId: task.id, input: items, cwd: task.cwd };
      if (model) params.model = model;
      await this.request('turn/start', params);
      task.retryModel = model || '';
    }
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
      if (msg.method === 'turn/started' && p.turn?.id) { this.turns.set(id, p.turn.id); task.turnOutput = ''; task.turnFinalText = ''; task.turnImagePaths = []; task.turnHtmlPaths = []; }
      if (msg.method?.includes('agentMessage/delta')) { task.output += p.delta || ''; task.turnOutput = (task.turnOutput || '') + (p.delta || ''); }
      if (msg.method === 'item/completed' && p.item?.type === 'imageGeneration' && p.item.savedPath) task.turnImagePaths = [...new Set([...(task.turnImagePaths || []), String(p.item.savedPath)])].slice(0, 6);
      if (msg.method === 'item/completed' && p.item?.savedPath && /\.html?$/i.test(String(p.item.savedPath))) task.turnHtmlPaths = [...new Set([...(task.turnHtmlPaths || []), String(p.item.savedPath)])].slice(0, 6);
      if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary') task.turnFinalText = String(p.item.text || '');
      if (msg.method === 'turn/completed') {
        this.turns.delete(id); task.stopRequested = false;
        task.status = p.turn?.status === 'completed' ? 'completed' : p.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
        const finalText = task.turnFinalText || task.turnOutput || '';
        const turnError = String(p.turn?.error?.message || p.turn?.error || p.turn?.lastError || '');
        const rateLimited = /(?:\b429\b|too many requests|exceeded retry limit)/i.test(`${turnError}\n${finalText}`);
        if (task.status === 'failed' && rateLimited && config.autoContinue429 !== false) {
          const maxAttempts = Math.min(Math.max(Number(config.autoContinue429MaxAttempts) || 3, 1), 10);
          task.autoRetry429Count = Number(task.autoRetry429Count || 0) + 1;
          if (task.autoRetry429Count <= maxAttempts) {
            const delayMs = Math.min(120000, 15000 * task.autoRetry429Count);
            task.status = 'retry_waiting';
            task.output = `Codex 遇到 429 限流，${Math.round(delayMs / 1000)} 秒后自动继续（第 ${task.autoRetry429Count}/${maxAttempts} 次）。`;
            notify(`Codex 遇到 429 限流，正在自动重试\n任务：${id}\n${Math.round(delayMs / 1000)} 秒后自动发送“继续”\n第 ${task.autoRetry429Count}/${maxAttempts} 次`, { appName: 'Codex 任务', taskId: id });
            clearTimeout(this.retryTimers.get(id));
            this.retryTimers.set(id, setTimeout(async () => {
              this.retryTimers.delete(id);
              try { await this.continueTask(task, [{ type: 'text', text: '继续往下推进，恢复本轮任务并完成剩余工作。' }]); }
              catch (error) { task.status = 'failed'; task.turnFinalText = `自动继续失败：${humanError(error)}`; completionNotice({ taskId: id, status: task.status, body: task.turnFinalText, cwd: task.cwd }).then(notice => notifyTurnResult(notice, { taskId: id, turnId: `retry-${Date.now()}`, finalText: '', imagePaths: [] })).catch(e => console.error('[task retry notification]', e.message)); }
            }, delayMs));
            return;
          }
          task.turnFinalText = `429 Too Many Requests，已自动继续 ${maxAttempts} 次仍未恢复。请稍后重试或在飞书回复“继续”。`;
        }
        const capacityFailure = /selected model is at capacity|model is temporarily unavailable/i.test(`${turnError}\n${finalText}`);
        const transientFailure = capacityFailure || /service unavailable|stream disconnected|stream closed before response\.completed|connection reset|socket hang up/i.test(`${turnError}\n${finalText}`);
        if (task.status === 'failed' && transientFailure && config.autoContinueTransient !== false) {
          const configuredAttempts = Number(config.autoContinueTransientMaxAttempts) || 10;
          const maxAttempts = capacityFailure
            ? Math.min(Math.max(configuredAttempts, 10), 20)
            : Math.min(Math.max(configuredAttempts, 1), 20);
          task.autoRetryTransientCount = Number(task.autoRetryTransientCount || 0) + 1;
          if (task.autoRetryTransientCount <= maxAttempts) {
            const delayMs = 20000;
            task.status = 'retry_waiting';
            const fallbackModel = '';
            task.output = `Codex 暂时不可用，${Math.round(delayMs / 1000)} 秒后自动重试（第 ${task.autoRetryTransientCount}/${maxAttempts} 次）。`;
            notify(`Codex 暂时不可用，正在自动重试\n任务：${id}\n${Math.round(delayMs / 1000)} 秒后重试\n第 ${task.autoRetryTransientCount}/${maxAttempts} 次`, { appName: 'Codex 任务', taskId: id, notificationType:'task_retry' });
            clearTimeout(this.retryTimers.get(id));
            this.retryTimers.set(id, setTimeout(async () => {
              this.retryTimers.delete(id);
              try { await this.continueTask(task, [{ type: 'text', text: '继续往下推进，恢复本轮任务并完成剩余工作。' }], { model: fallbackModel }); }
              catch (error) { task.status = 'failed'; task.turnFinalText = `自动继续失败：${humanError(error)}`; completionNotice({ taskId: id, status: task.status, body: task.turnFinalText, cwd: task.cwd }).then(notice => notifyTurnResult(notice, { taskId: id, turnId: `retry-${Date.now()}`, finalText: '', imagePaths: [] })).catch(e => console.error('[task retry notification]', e.message)); }
            }, delayMs));
            return;
          }
          task.turnFinalText = `模型或连接暂时不可用，已自动重试 ${maxAttempts} 次仍未恢复。请稍后回复“继续”。`;
        }
        if (task.status === 'failed' && !task.turnFinalText) {
          const reason = turnError ? humanError(turnError) : '没有收到完整的完成结果。请查看桌面端错误提示后再重试。';
          task.turnFinalText = `Codex 任务失败：${reason}`;
          if (task.turnOutput && task.turnOutput !== task.turnFinalText) {
            task.turnFinalText += `\n\n失败前最后输出：\n${trim(task.turnOutput, 1800)}`;
          }
        }
        const noticeBody = task.turnFinalText || finalText;
        if (task.status !== 'completed' || task.turnFinalText || task.turnImagePaths?.length || task.turnHtmlPaths?.length) {
          const resultBody = task.status === 'completed' ? task.turnFinalText || '本轮结果文件已生成。' : noticeBody;
          completionNotice({ taskId: id, status: task.status, body: trim(resultBody, 3000), cwd: task.cwd }).then(notice => notifyTurnResult(notice, { taskId: id, turnId: p.turn?.id, finalText: task.status === 'completed' ? task.turnFinalText || '' : '', imagePaths: task.turnImagePaths || [], htmlPaths: task.turnHtmlPaths || [], cwd: task.cwd })).catch(error => console.error('[task notification]', error.message));
        }
        finishDesktopTakeover(id).catch(error => console.error('[desktop relaunch]', error.message));
        refreshQuotaAfterTask(task).catch(error => console.error('[task quota]', error.message));
      }
    }
    if (msg.id !== undefined && (msg.method?.includes('requestApproval') || msg.method?.includes('requestUserInput'))) { const task = id ? tasks.get(id) : null; if (task) { task.status = 'waiting_confirmation'; task.lastEventAt = Date.now(); } pendingApprovals.set(String(msg.id), { id: String(msg.id), method: msg.method, params: p, taskId: id }); notify(`Codex 等待确认\n任务：${id || '-'}\n类型：${msg.method}\n${confirmationDetails(msg.method, p)}\n\n${trim(task?.output, 1800)}\n\n请打开控制台：${dashboardLink(`#approval=${msg.id}`)}`, { appName: 'Codex 任务', taskId: id }); }
  }
  respondApproval(requestId, decision, answers = {}) { const request = pendingApprovals.get(String(requestId)); if (!request) throw new Error('确认请求已经失效'); const result = request.method.includes('requestUserInput') ? { answers } : { decision }; this.send({ id: Number(requestId), result }); pendingApprovals.delete(String(requestId)); const task = request.taskId ? tasks.get(request.taskId) : null; if (task) task.status = 'running'; }
  close() { this.intentionalClose = true; for (const timer of this.retryTimers.values()) clearTimeout(timer); this.retryTimers.clear(); try { this.proc?.kill(); } catch {} }
}
let codex;

function html() { return `<!doctype html><meta charset="utf-8"><title>Codex Companion</title><style>body{font:14px system-ui;margin:24px;max-width:1000px;background:#10131a;color:#eef}button,input,textarea{font:inherit;padding:8px;margin:4px;border-radius:6px;border:1px solid #465064;background:#181e2a;color:#eef}textarea{width:96%;height:90px}.card{display:inline-block;vertical-align:top;background:#1a2230;border:1px solid #33415a;border-radius:10px;padding:12px;margin:5px;min-width:200px}.task{background:#18202c;padding:10px;border-radius:8px;margin:8px 0;white-space:pre-wrap}.muted{color:#9ba8bc}</style><h1>Codex Companion</h1><p class=muted>只监控由本程序启动的 Codex 任务 · 本机访问</p><h2>账号与额度</h2><button onclick="refresh()">刷新额度</button><div id=accounts></div><h2>启动任务</h2><input id=cwd placeholder="工作目录" style="width:70%"><br><textarea id=prompt placeholder="任务内容"></textarea><br><button onclick="start()">启动 Codex 任务</button><h2>任务</h2><div id=tasks></div><h2>设置</h2><input id=feishu placeholder="飞书机器人 Webhook URL" style="width:70%"><button onclick="save()">保存</button><script>
async function api(u,o={}){let r=await fetch(u,{headers:{'Content-Type':'application/json'},...o});let j=await r.json();if(j.error)alert(j.error);return j}function fmt(x){return x?new Date(x*1000).toLocaleString():'-'}function render(s){accounts.innerHTML=(s.accounts||[]).map(a=>{let u=a.usage||{};return '<div class=card><b>'+a.name+'</b> <span class=muted>'+ (a.plan_type||'')+'</span><br>5小时：'+(u.primary_used_percent??'-')+'%<br>重置：'+fmt(u.primary_resets_at)+'<br>周：'+(u.secondary_used_percent??'-')+'%<br>重置：'+fmt(u.secondary_resets_at)+'<br><button onclick="sw(\''+a.id+'\')">切换</button></div>'}).join('');tasks.innerHTML=Object.values(s.tasks||{}).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).map(t=>'<div class=task><b>'+t.id+'</b> '+t.status+'<br>'+t.cwd+'<br>'+((t.output||'').slice(-2400))+'<br><button onclick="cont(\''+t.id+'\')">继续/追加</button><button onclick="stop(\''+t.id+'\')">停止</button></div>').join('')||'<span class=muted>暂无任务</span>';feishu.value=s.config.feishuWebhookUrl||''}async function load(){render(await api('/api/status'))}async function refresh(){await api('/api/accounts/refresh',{method:'POST',body:'{}'});load()}async function sw(id){await api('/api/accounts/switch',{method:'POST',body:JSON.stringify({id})});load()}async function start(){await api('/api/task',{method:'POST',body:JSON.stringify({prompt:promptEl.value,cwd:cwd.value})});promptEl.value='';load()}async function cont(id){let t=window.prompt('追加给 Codex 的文字（留空表示继续）','');if(t!==null){await api('/api/task/'+id+'/continue',{method:'POST',body:JSON.stringify({text:t||'继续完成当前任务，并汇报结果。'})});load()}}async function stop(id){await api('/api/task/'+id+'/stop',{method:'POST',body:'{}'});load()}async function save(){await api('/api/config',{method:'POST',body:JSON.stringify({feishuWebhookUrl:feishu.value})});alert('已保存')}const promptEl=document.getElementById('prompt'),cwd=document.getElementById('cwd'),feishu=document.getElementById('feishu');load();setInterval(load,5000)</script>`; }

async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, version: APP_VERSION });
  // Static login page contains no account data; every data/control API is gated.
  if (req.method === 'GET' && req.url === '/') return send(res, 200, dashboardPage, 'text/html; charset=utf-8');
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
      const bytes=Buffer.from(JSON.stringify(publicDiagnosticBundle(),null,2));
      const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,13).replace('T','-');
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store','content-disposition':`attachment; filename="CodexCompanion-diagnostics-${stamp}.json"`});
      return res.end(bytes);
    }
    if (req.method==='POST'&&u.pathname==='/api/diagnostics/repair') {
      if(!isLoopback(req.socket.remoteAddress))return send(res,403,{error:'一键修复仅允许本机操作'});
      return send(res,200,await repairCompanion());
    }
    if (req.method==='POST'&&u.pathname==='/api/feishu/topics/rebuild') {
      if(!isLoopback(req.socket.remoteAddress))return send(res,403,{error:'话题重建仅允许本机操作'});
      config.feishuTaskTopicRoots = {};
      config.feishuTaskTopicChats = {};
      config.feishuTopicRootSchemaVersion = 2;
      codexSessionTopicsAnnounced.clear();
      await saveConfig();
      return send(res,200,{ok:true,message:'已清空旧话题映射。下一个任务完成或新对话消息会自动创建新的飞书话题。'});
    }
    if (req.method==='POST'&&u.pathname==='/api/feishu/topics/rotate') {
      if(!isLoopback(req.socket.remoteAddress))return send(res,403,{error:'重开话题仅允许本机操作'});
      const result=await rotateFeishuTopic(String(data.taskId||''));
      return send(res,200,{...result,message:'旧话题已保留；这个对话的下一条结果会创建新的话题。'});
    }
    if (req.method==='GET'&&u.pathname==='/') return send(res,200,dashboardPage,'text/html; charset=utf-8');
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
        desktopRetry: desktopRetryState(),
        diagnosticIssues:publicDiagnostics().issues,
        approvals:[...pendingApprovals.values()],
        deviceLogin:deviceLogin?.publicState()||null,
        browserLogin:browserLoginPublic(),
        nativeVault:await boundedNativeVaultStatus(),
        network:{addresses:config.remoteAccessEnabled?addrs:[], tailscaleIp:config.remoteAccessEnabled?tailscale:null, port}
      });
    }
    if (req.method==='POST'&&u.pathname==='/api/shutdown'){
      if(!isLoopback(req.socket.remoteAddress))return send(res,403,{error:'退出 Companion 只能在本机操作'});
      send(res,200,{ok:true,message:'Companion 正在退出。'});
      setTimeout(()=>{
        try{codex?.close();}catch{}
        try{codexSessionWatcher?.close();}catch{}
        try{feishuWsClient?.close({force:true});}catch{}
        try{notificationDb?.close();}catch{}
        try{server.close();}catch{}
        process.exit(0);
      },120).unref?.();
      return;
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
      task.autoRetryTransientCount=0;task.autoRetry429Count=0;
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
    if (req.method==='GET'&&u.pathname==='/api/widget/switch-trace') return send(res,200,{ok:true,rows:await readWidgetSwitchTrace()});
    if (req.method==='POST'&&u.pathname==='/api/widget/switch-trace') {
      if (!isLoopback(req.socket.remoteAddress)) return send(res,403,{error:'浮窗诊断只能在本机写入'});
      return send(res,200,{ok:true,row:await appendWidgetSwitchTrace(data)});
    }
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
    if (req.method==='GET'&&u.pathname==='/api/notifications/settings') {
      return send(res,200,{rules:notificationRules.map(rule=>({...rule,enabled:notificationEnabled(config,rule.id)})),resetReminderLeadMinutes:resetReminderLeads(config),stallMinutes:Number(config.stallMinutes)||3});
    }
    if (req.method==='POST'&&u.pathname==='/api/notifications/settings') {
      const changes=validateNotificationSettings(data);
      config={...config,...changes,notificationTypes:{...(config.notificationTypes||{}),...(changes.notificationTypes||{})}};
      await saveConfig();
      return send(res,200,{ok:true});
    }
    if(req.method==='POST'&&u.pathname==='/api/system/uninstall-page') {
      if(!isLoopback(req.socket.remoteAddress))return send(res,403,{error:'只能在本机打开卸载页面。'});
      if(process.platform!=='win32')throw Error('此入口仅支持 Windows。');
      await new Promise((resolve,reject)=>{
        const child=spawn('explorer.exe',['ms-settings:appsfeatures'],{detached:true,windowsHide:true,stdio:'ignore'});
        child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()});
      });
      return send(res,200,{ok:true,message:'已打开 Windows 已安装的应用，请搜索 Codex Companion 并选择卸载。'});
    }
    if (req.method==='POST'&&u.pathname==='/api/config'){
      if(data.feishuWebhookUrl)config.feishuWebhookUrl=String(data.feishuWebhookUrl);
      if(Object.hasOwn(data,'publicDashboardUrl'))config.publicDashboardUrl=String(data.publicDashboardUrl||'');
      if(data.feishuNotificationThreadMode==='task'||data.feishuNotificationThreadMode==='flat') config.feishuNotificationThreadMode=data.feishuNotificationThreadMode;
      if(typeof data.feishuMentionOperator==='boolean') config.feishuMentionOperator=data.feishuMentionOperator;
      if(typeof data.autoTakeoverDesktopTransient==='boolean') config.autoTakeoverDesktopTransient=data.autoTakeoverDesktopTransient;
      if(typeof data.desktopRetryAutoClick==='boolean') config.desktopRetryAutoClick=data.desktopRetryAutoClick;
      if(Number.isFinite(Number(data.desktopRetryCooldownSeconds))) config.desktopRetryCooldownSeconds=Math.min(120,Math.max(3,Math.round(Number(data.desktopRetryCooldownSeconds))));
      if(Number.isFinite(Number(data.desktopRetryQuietMinutes))) config.desktopRetryQuietMinutes=Math.min(120,Math.max(1,Math.round(Number(data.desktopRetryQuietMinutes))));
      if(['OK','THUMBSUP','DONE','CHECK'].includes(String(data.feishuContinueEmoji||'').toUpperCase())) config.feishuContinueEmoji=String(data.feishuContinueEmoji).toUpperCase();
      if(Object.hasOwn(data,'webhooks')) config.webhooks=validateWebhooks(data.webhooks)||[];
      await saveConfig();
      if(Object.hasOwn(data,'autoTakeoverDesktopTransient')||Object.hasOwn(data,'desktopRetryAutoClick')||Object.hasOwn(data,'desktopRetryCooldownSeconds')) syncDesktopRetryWatcher(config);
      return send(res,200,{ok:true,desktopRetry:desktopRetryState(),webhooks:publicWebhooks()});
    }
    if (req.method==='POST'&&u.pathname==='/api/webhooks/add'){
      const draft={kind:String(data.kind||''),name:String(data.name||''),url:String(data.url||''),token:String(data.token||''),enabled:true};
      const existing=Array.isArray(config.webhooks)?config.webhooks:[];
      const [added]=validateWebhooks([draft]);
      const key=target=>`${target.kind}|${target.url}|${target.token}`;
      if(existing.some(target=>key(target)===key(added)))throw Error('这个通知渠道已经添加过了，不用重复添加。');
      added.id=`wh-${Date.now().toString(36)}`;
      config.webhooks=[...existing,added];
      await saveConfig();
      return send(res,200,{ok:true,id:added.id,name:added.name,webhooks:publicWebhooks()});
    }
    if (req.method==='POST'&&u.pathname==='/api/webhooks/remove'){
      const id=String(data.id||'');
      const before=Array.isArray(config.webhooks)?config.webhooks.length:0;
      config.webhooks=(Array.isArray(config.webhooks)?config.webhooks:[]).filter(target=>String(target.id)!==id);
      if(config.webhooks.length===before)throw Error('没有找到这个通知渠道，可能已经被删除了。');
      await saveConfig();
      return send(res,200,{ok:true,webhooks:publicWebhooks()});
    }
    if (req.method==='POST'&&u.pathname==='/api/webhooks/toggle'){
      const id=String(data.id||'');
      const target=(Array.isArray(config.webhooks)?config.webhooks:[]).find(item=>String(item.id)===id);
      if(!target)throw Error('没有找到这个通知渠道。');
      target.enabled=data.enabled!==false;
      await saveConfig();
      return send(res,200,{ok:true,webhooks:publicWebhooks()});
    }
    if (req.method==='POST'&&u.pathname==='/api/webhooks/test'){
      const targets=activeWebhookTargets(config);
      if(!targets.length)throw Error('还没有可用的通知渠道，请先添加一个并保持启用。');
      const delivery=await sendWebhooks(targets,`Codex Companion 通知测试\n\n以后任务完成、失败、等待确认、长时间无进展、额度不足时，会发到这个渠道。\n时间：${new Date().toLocaleString('zh-CN')}`,{appName:'Codex Companion',title:'Codex Companion 通知测试'});
      applyWebhookDelivery(delivery.results);
      if(!delivery.ok)throw Error(`测试发送失败：${delivery.results.filter(item=>!item.ok).map(item=>`${item.name}（${friendlyWebhookReason(item.reason)}）`).join('；')}`);
      return send(res,200,{ok:true,message:`已发送到 ${delivery.ok} 个渠道。`,results:delivery.results});
    }
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
    if (req.method==='GET'&&u.pathname==='/api/windows-notifications'){
      const scan = await listWindowsNotificationApps();
      return send(res,200,{ok:true,enabled:config.windowsNotifyForward===true,includeBody:config.windowsNotifyIncludeBody===true,apps:Array.isArray(config.windowsNotifyApps)?config.windowsNotifyApps:[],knownApps:scan.apps,scanOk:scan.ok,scanError:scan.error||''});
    }
    if (req.method==='POST'&&u.pathname==='/api/windows-notifications'){
      if (data.enabled!==undefined) config.windowsNotifyForward=data.enabled===true;
      if (data.includeBody!==undefined) config.windowsNotifyIncludeBody=data.includeBody===true;
      if (data.apps!==undefined){
        if(!Array.isArray(data.apps)) throw Error('应用列表格式不正确');
        config.windowsNotifyApps=data.apps.map(n=>String(n||'').trim()).filter(Boolean).slice(0,30);
      }
      await saveConfig();
      return send(res,200,{ok:true,enabled:config.windowsNotifyForward===true,includeBody:config.windowsNotifyIncludeBody===true,apps:config.windowsNotifyApps});
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
    if (req.method==='POST'&&u.pathname==='/api/notifications/retry'){
      ensureHistory();
      const at=Number(data.at);
      const target=config.notificationHistory.find(item=>Number(item.at)===at);
      if(!target)throw Error('这条通知记录已经不存在，请刷新后重试。');
      if(target.sent)throw Error('这条通知已经发送成功，无需重发。');
      if(target.reason==='muted')throw Error('这类通知当前处于静音状态，请先恢复通知。');
      if (target.retryKind === 'image') {
        if (!target.replyTo || !Array.isArray(target.imagePaths) || !target.imagePaths.length) throw Error('图片重试信息不完整，请重新执行任务。');
        const result = await relayFinalImages({ text: '', paths: target.imagePaths, trustedPaths: target.imagePaths, enabled: true, root: config.feishuImageRelayRoot || '',
          send: bytes => sendFeishuResultImage(bytes, target.replyTo, target.taskId || ''), report: async () => {} });
        if (!result.sent) throw Error('图片仍未发送，请确认文件没有被删除且机器人具备图片权限。');
        target.sent = true; target.reason = 'retried'; target.retryKind = '';
        await saveConfig();
        return send(res, 200, { ok: true, message: `图片已重新发送（${result.sent} 张）。` });
      }
      const result=await notify(String(target.body||''),{appName:target.appName,taskId:target.taskId||''});
      if(!result.ok)throw Error(result.reason||'飞书仍未接收，请检查连接状态。');
      return send(res,200,{ok:true,message:'通知已经重新发送。'});
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
    if (req.method==='GET'&&u.pathname==='/api/feishu/inbox'){
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 30, 1), 200);
      const items = await feishuInbox.recent(limit);
      return send(res, 200, { items, paths: feishuInbox.paths });
    }
    if (req.method==='POST'&&u.pathname==='/api/feishu/inbox/clear'){
      await feishuInbox.clear();
      return send(res, 200, { ok: true, message: '本机飞书消息收件箱已清空。' });
    }
    const m=u.pathname.match(/^\/api\/task\/([^/]+)\/(continue|stop)$/);if(req.method==='POST'&&m){const t=tasks.get(m[1]);if(!t)throw Error('任务不存在');if(m[2]==='continue')await codex.continueTask(t,String(data.text||'继续完成当前任务，并汇报结果。'));else await codex.stopTask(t);return send(res,200,{ok:true});}
    const a=u.pathname.match(/^\/api\/approval\/([^/]+)$/);if(req.method==='POST'&&a){codex.respondApproval(a[1],String(data.decision||'accept'),data.answers||{});return send(res,200,{ok:true});}
    return send(res,404,{error:'Not found'});
  } catch(e){console.error('[request]',e);return send(res,400,{error:humanError(e)});}
}
function send(res,status,value,type='application/json; charset=utf-8'){const b=Buffer.from(typeof value==='string'?value:JSON.stringify(value));res.writeHead(status,{'content-type':type,'content-length':b.length});res.end(b);}

async function startTaskEngine(){if(codex?.proc)return;codex=new CodexServer();try{await codex.start()}catch(e){taskEngineError=humanError(e);console.error('[task engine]',e.message);codex.close();codex.proc=null;}}
async function main() {
  const storedConfig = await readJson(configPath);
  config = { ...defaultConfig, ...storedConfig };
  if (storedConfig.feishuTopicRootSchemaVersion !== 2) {
    // Roots created by older releases did not record their chat. Reusing one
    // can report success while the result lands in an old/hidden topic. Keep a
    // recoverable snapshot, then let each conversation create one fresh root.
    config.feishuLegacyTaskTopicRoots = config.feishuTaskTopicRoots || {};
    config.feishuTaskTopicRoots = {};
    config.feishuTaskTopicChats = {};
    config.feishuTopicRootSchemaVersion = 2;
    await saveConfig();
  }
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
  startDesktopRetryWatcher(config);
  // A conversation that existed before the monitor started has no new
  // response_item event to trigger topic creation. Reconcile the currently
  // bound conversation once after Feishu connects so it also gets a topic.
  setTimeout(() => {
    if (config.feishuBoundThreadId) announceDesktopConversation(config.feishuBoundThreadId).catch(error => console.error('[codex topic reconcile]', error.message));
  }, 5000).unref?.();
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
  process.on('SIGINT', () => { stopDesktopRetryWatcher(); codex.close(); try { codexSessionWatcher?.close(); } catch {} try { feishuWsClient?.close({ force: true }); } catch {} try { notificationDb?.close(); } catch {} server.close(); process.exit(0); });
}
main().catch(e=>{console.error(e);process.exit(1)});
