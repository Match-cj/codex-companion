import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, watch as watchFs } from 'node:fs';
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
import { isQuotaExhaustedText, quotaLeft, quotaLeftText, pickQuotaSwitchTarget, findAccountByName, parseSwitchCommand } from './quota-switch.mjs';
import { buildQuotaFacts } from './quota-facts.mjs';
import { notificationRules, notificationEnabled, notificationType, resetReminderLeads, validateNotificationSettings, nextResetReminder, nextWasteReminder, parseExpirySeconds, planExpirySuffix, planExpiryStale } from './notification-settings.mjs';
import { recoverReplyTarget } from './feishu-reply-recovery.mjs';
import { desktopRetryState, desktopTakeoverAllowed, syncDesktopRetryWatcher, startDesktopRetryWatcher, stopDesktopRetryWatcher, setDesktopRetryNotifier } from './desktop-retry.mjs';
import { validateWebhooks, activeWebhookTargets, sendWebhooks, kindLabel as webhookKindLabel, friendlyWebhookReason } from './webhook-notify.mjs';
import { contextWarning, contextRatio, formatTokenCount, trimContextLedger } from './context-budget.mjs';
import { humanError } from './human-error.mjs';
import { base64Url, decodeJwtPayload, jwtExpiry, oauthPortStatus } from './auth-utils.mjs';
import { createFeishuInbox, inboxEntryFromEvent } from './feishu-inbox.mjs';
import { parseFeishuPost, isRichTextMessage } from './feishu-post.mjs';
import { stallNoticeDecision } from './stall-notice.mjs';
import { createNativeUsage } from './native-usage.mjs';
import { warmupDecision } from './warmup-policy.mjs';
import { verifyWarmupWindow, isTransientWarmupError } from './warmup-verify.mjs';
import { updateFailureRecord, updateRetryDecision, updateLogLine, trimUpdateLog, UPDATE_LOG_MAX_BYTES } from './update-diagnostics.mjs';
import { sweepStaleHomes } from './temp-homes.mjs';
import { classifyQuotaFailure, probeNetwork, networkNoticeDecision, readSystemProxy } from './network-health.mjs';
import { validNativeVault, createNativeVaultStore } from './native-vault.mjs';
import { DeviceLoginSession } from './device-login.mjs';
import { codexLaunch, closeCodexDesktop, codexDesktopPids, isCodexDesktopRunning, launchCodexDesktop, execPowershellShort, isQuotaWidgetRunning, findQuotaWidgetWindow, focusQuotaWidgetWindow, killQuotaWidgetProcesses, openQuotaWidget } from './desktop-client.mjs';
import { appDir, configPath, widgetSwitchTracePath, nativeAccountsPath, nativeAccountsBackupPath, switcherAccountsPath, liveAuthPath, widgetScriptPath, widgetLauncherPath, sourceDir } from './app-paths.mjs';
import { DEFAULT_FEED as DEFAULT_UPDATE_FEED, MANIFEST_NAME as UPDATE_MANIFEST_NAME, normalizeVersion, summarizeRelease, depsFingerprint, isSafeRelativePath, normalizeUpdateMode, idleUpdateDecision, DEFAULT_IDLE_SECONDS, DEFAULT_UPDATE_MODE } from './update.mjs';
import { protectCredential, unprotectCredential } from './credential-crypto.mjs';
import { encryptPortablePayload, decryptPortableAccountBackup } from './portable-backup.mjs';

const execFileAsync = promisify(execFile);
const APP_VERSION = '1.0.59';
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
  // 防浪费提醒：5 小时额度重置前还剩很多时提醒一次，别让会员费白花。
  wasteReminderLeadMinutes: 30,
  wasteReminderMinPercent: 30,
  autoContinue429: true,
  autoContinue429MaxAttempts: 3,
  // 额度用尽导致任务失败时：false = 发消息问你（默认），true = 自动换到有额度的账号并继续。
  autoSwitchAccountOnQuotaExhausted: false,
  // 最近在跑的对话：软件重启后靠它记住「回『切换』时该接着跑哪个」。
  lastActiveThreadId: '',
  lastActiveThreadAt: 0,
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
  updateMode: DEFAULT_UPDATE_MODE,
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
    autoSwitchAccountOnQuotaExhausted: config.autoSwitchAccountOnQuotaExhausted === true,
    updateMode: normalizeUpdateMode(config.updateMode), updateIdleMinutes: Math.round(DEFAULT_IDLE_SECONDS / 60),
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
// 会员到期提醒的去重台账：账号 id → { expiresAt, lastDay }
const planExpiryNotifierState = new Map();
const resetReminderTimers = new Map(); // timerKey=`${ledgerKey}:${leadMinutes}` → { resetAt, timer }

// 所有额度通知统一用备注名（没有备注才退回原始账号名/邮箱），避免同一账号两套称呼。
function accountDisplayName(account) {
  return account?.display_name || account?.name || account?.email || '未知账号';
}
function resetSoonMessage(account, label, lead, remainingMinutes, resetAt) {
  return `Codex 额度即将重置\n账号：${accountDisplayName(account)}\n类型：${label}\n提醒提前量：${lead >= 60 ? `${lead / 60} 小时` : `${lead} 分钟`}\n预计还有：${remainingMinutes} 分钟\n重置时间：${new Date(resetAt * 1000).toLocaleString('zh-CN')}`;
}

// 已知官方重置时间后，直接为每个提醒档位排一个精确定时器，
// 到点准点发送——否则只能等下一次额度刷新（最长约 5 分钟）才发现，
// 用户就会看到「提前量 15 分钟」但「预计还有 11 分钟」的矛盾。
function scheduleExactResetReminders(account, key, label, resetKey, resetAt, nowSeconds, windowMinutes) {
  if (!Number.isFinite(resetAt) || resetAt <= nowSeconds) return;
  for (const lead of resetReminderLeads(config)) {
    if (!Number.isInteger(lead) || lead <= 0 || (windowMinutes && lead > windowMinutes)) continue;
    const timerKey = `${key}:${lead}`;
    const delaySeconds = (resetAt - lead * 60) - nowSeconds;
    if (delaySeconds <= 0 || delaySeconds > 6 * 3600) continue; // 已进提醒窗口或太远，交给轮询兜底
    const existing = resetReminderTimers.get(timerKey);
    // 官方返回的重置时间偶尔会抖动一两秒；容差内视为同一周期，不重复排队。
    if (existing && Math.abs(existing.resetAt - resetAt) <= 120) continue;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      fireExactResetReminder({ key, timerKey, label, resetKey, resetAt, lead, accountId: account.id })
        .catch(error => console.error('[reset reminder]', error.message));
    }, Math.round(delaySeconds * 1000));
    timer.unref?.();
    resetReminderTimers.set(timerKey, { resetAt, timer });
  }
}

async function fireExactResetReminder({ key, timerKey, label, resetKey, resetAt, lead, accountId }) {
  resetReminderTimers.delete(timerKey);
  const account = accounts.find(item => String(item.id) === String(accountId));
  if (!account) return;
  const resetNow = Number(account.usage?.[resetKey]);
  if (!Number.isFinite(resetNow) || Math.abs(resetNow - resetAt) > 120) return; // 周期真的变了，交给轮询
  const remainingMinutes = Math.max(1, Math.ceil((resetNow * 1000 - Date.now()) / 60000));
  if (remainingMinutes > lead) return;
  config.quotaResetReminderLedger ||= {};
  const ledger = config.quotaResetReminderLedger;
  const previous = Math.abs(Number(ledger[key]?.resetAt) - resetAt) <= 120 ? ledger[key].sentMinutes || [] : [];
  if (previous.includes(lead)) return;
  ledger[key] = { resetAt, sentMinutes: [...new Set([...previous, lead])] };
  await saveConfig();
  await notify(resetSoonMessage(account, label, lead, remainingMinutes, resetAt), { appName: 'Codex 额度', notificationType: 'quota_reset_soon' });
}
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
// Feishu re-delivers reaction events after a websocket reconnect, and Companion
// itself adds an OK reaction when a task moves to the background. Both show up
// here as a second "continue" command unless they are filtered out.
const feishuReactionEvents = new Map();
const feishuReactionMessages = new Map();
const feishuBotReactions = new Map();
const REACTION_DEDUPE_MS = 10 * 60 * 1000;
function alreadySeenReaction(map, key, now, ttlMs = REACTION_DEDUPE_MS) {
  for (const [storedKey, at] of map) if (now - at > ttlMs) map.delete(storedKey);
  if (map.has(key)) return true;
  map.set(key, now);
  if (map.size > 500) map.delete(map.keys().next().value);
  return false;
}
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
  return `Codex Tools 手机菜单\n\n自动重试：${retry.enabled ? '开启' : '关闭'}${retry.enabled ? `（已点击 ${retry.hits} 次）` : ''}\n自动接管：${takeover}\n额度用尽自动换号：${config.autoSwitchAccountOnQuotaExhausted === true ? '开启' : '关闭（会先问你）'}\n运行中对话：${feishuRunningCount()} 个\n\n可直接回复下面的命令：\n· 自动重试 开启\n· 自动重试 关闭\n· 自动接管 开启\n· 自动接管 关闭\n· 切换（额度用尽时换到有额度的账号并继续）\n· 切换 账号名\n· 自动切换 开启\n· 自动切换 关闭\n· 账号（看每个账号还剩多少）\n· 状态\n· 自动重试（查状态）\n· 交接提示词\n· 刷新额度\n· 绑定最近对话\n· 新话题\n\n说明：自动重试只是按下桌面端自己的重试按钮，不改对话、不换模型；它开启时自动接管不再转入后台。`;
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
  // 默认不打扰：这条提醒默认关闭（网页「通知设置」里可开启），情况记在 desktopRetryState 里，「自动重试 状态」随时能查。
  notify(`这个「重试」不是模型繁忙，我没有自动点\n窗口：${window}\n错误内容：${detail}\n\n${advice}`, { appName: 'Codex 任务', notificationType: 'retry_unhelpful' }).catch(() => {});
});

async function handleFeishuControlCommand(text, message) {
  const command = String(text || '').trim().replace(/[：:]/g, ' ');
  // 账号接力指令：切换 / 切换 账号名 / 自动切换 开启|关闭 / 账号
  const parsedSwitch = parseSwitchCommand(command);
  if (parsedSwitch) {
    // 「切换这个按钮的颜色」这类正常任务句子不能当指令吃掉：只有短句或确实命中账号名才拦。
    const mentionsKnownAccount = parsedSwitch.action !== 'switch' || !parsedSwitch.targetName || !!findAccountByName(accounts, parsedSwitch.targetName);
    const shortEnough = command.replace(/\s+/g, '').length <= 12;
    if (mentionsKnownAccount || shortEnough) {
      if (await handleQuotaSwitchCommand(parsedSwitch, message)) return true;
    }
  }
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

async function handleFeishuMessage(data, { recovered = false } = {}) {
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
    if (!recovered && messageId && received.includes(messageId)) return;
    if (!recovered && messageId) {
      config.feishuReceivedMessageIds = [...received, messageId].slice(-200);
      await saveConfig();
    }
    let text = '';
    let input = [];
    const msgType = String(message.message_type || '');
    const isTextLike = msgType === 'text' || isRichTextMessage(msgType);
    if (msgType === 'text') {
      try { text = String(JSON.parse(message.content || '{}').text || '').trim(); } catch { return; }
      text = text.replace(/@_user_\d+/g, '').trim();
      if (!text) return;
      input = [{ type: 'text', text }];
    } else if (msgType === 'image') {
      let imageKey = '';
      try { imageKey = String(JSON.parse(message.content || '{}').image_key || '').trim(); } catch { return; }
      const imagePath = await downloadFeishuImage(messageId, imageKey);
      input = [{ type: 'text', text: '请查看并处理我从飞书回复的这张图片。' }, { type: 'localImage', path: imagePath }];
    } else if (isRichTextMessage(msgType)) {
      // One message can carry an @-mention, several screenshots and several
      // paragraphs. Send all of it to Codex instead of dropping it silently.
      const parsed = parseFeishuPost(message.content);
      text = parsed.text;
      if (!text && !parsed.imageKeys.length) {
        await sendFeishuAppText('收到了，但这条消息里没有能读出来的文字或图片。请直接发文字或截图。', { replyTo: message.message_id });
        return;
      }
      if (text) input.push({ type: 'text', text });
      for (const imageKey of parsed.imageKeys) {
        try { input.push({ type: 'localImage', path: await downloadFeishuImage(messageId, imageKey) }); }
        catch (error) { console.warn('[feishu post image]', error.message); }
      }
      if (!text) input.unshift({ type: 'text', text: '请查看并处理我从飞书回复的这些图片。' });
    } else {
      await sendFeishuAppText('这条消息的格式暂时读不了。请直接发文字、截图，或者文字加截图一起发。', { replyTo: message.message_id });
      return;
    }
    const chatId = String(message.chat_id || '');
    if (!config.feishuBoundChatId && !isTextLike) {
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
    if (isTextLike && typeof handleFeishuControlCommand === 'function' && await handleFeishuControlCommand(text, message)) return;
    if (isTextLike && isQuotaCommand(text)) {
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
    if (isTextLike && /^(新话题|重开话题|换个话题|rotate topic)$/i.test(text)) {
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
      // Feishu pushes this bot-added OK back to us as a reaction event. Register
      // it before the API call so it can never be mistaken for a user's "继续".
      feishuBotReactions.set(String(message.message_id), Date.now());
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
      const sentLabel = msgType === 'image' ? '图片已发送' : isRichTextMessage(msgType) ? '文字和图片已发送' : '已发送';
      await sendFeishuAppText(`${sentLabel}到原 Codex 对话：${task.prompt || task.id}`, { replyTo: message.message_id, taskId: task.id });
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
  if (typeof rememberActiveThread === 'function') rememberActiveThread(threadId);
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

// 额度用尽导致任务失败时的“账号接力”。
// 目标：不用打开电脑，在飞书里回一句「切换」就能换到有额度的账号并接着干。
function quotaAccountsOverview() {
  const active = accounts.find(account => account.is_active) || null;
  const others = accounts.filter(account => !account.is_active);
  return { active, others, target: pickQuotaSwitchTarget(accounts, active?.id || '') };
}

function activeQuotaSummaryText() {
  const active = accounts.find(account => account.is_active);
  return active ? `账号：${accountDisplayName(active)} · ${quotaLeftText(active)}` : '当前账号额度未知';
}

// 记住最近在跑的对话：软件重启后内存里的任务表会清空，但飞书里回「切换」时
// 还得知道该把哪个对话接着跑，所以把线索落盘。
let lastActiveThreadTimer = null;
function rememberActiveThread(threadId) {
  if (typeof config === 'undefined' || !config) return; // 单测会把这段切进没有 config 的沙箱
  const id = canonicalCodexThreadId(threadId);
  if (!id) return;
  const changed = config.lastActiveThreadId !== id;
  config.lastActiveThreadId = id;
  config.lastActiveThreadAt = Date.now();
  if (!changed) return;
  clearTimeout(lastActiveThreadTimer);
  lastActiveThreadTimer = setTimeout(() => saveConfig().catch(() => {}), 1500);
  lastActiveThreadTimer.unref?.();
}

function isThreadGoneError(error) {
  return /not found|no such|不存在|unknown thread|invalid thread/i.test(humanError(error));
}

// 要接着跑哪个对话：先信“回复的那条消息”指向的对话，再退回最近跑过的、正在跑的、绑定的。
function continuationThreadCandidates(preferred) {
  const list = [];
  const push = id => {
    const value = canonicalCodexThreadId(id);
    if (value && !list.includes(value)) list.push(value);
  };
  push(preferred);
  const lastAt = Number(config.lastActiveThreadAt || 0);
  if (config.lastActiveThreadId && Date.now() - lastAt < 24 * 60 * 60 * 1000) push(config.lastActiveThreadId);
  const live = [...tasks.values()].filter(task => ['running', 'retry_waiting', 'waiting_confirmation', 'queued'].includes(task.status));
  if (live.length === 1) push(live[0].id);
  push(config.feishuBoundThreadId);
  return list;
}

// 在当前账号上把某个对话接着跑：只需要对话 id，不依赖内存里的任务对象，
// 所以软件重启过、任务表清空也照样能续上。
async function continueOnCurrentAccount(threadId) {
  const wanted = canonicalCodexThreadId(threadId);
  const candidates = continuationThreadCandidates(threadId);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await continueThreadFromFeishu(candidate, [{ type: 'text', text: '继续往下推进，恢复本轮任务并完成剩余工作。' }], { manual: true });
      rememberActiveThread(candidate);
      return { continued: true, threadId: candidate, guessed: candidate !== wanted };
    } catch (error) {
      lastError = error;
      // 只有“这个对话真的不在了”才换下一个候选；其它错误（占用、权限）换对话只会更乱。
      if (!isThreadGoneError(error)) break;
    }
  }
  if (lastError) console.warn('[quota switch continue]', humanError(lastError));
  return { continued: false, reason: lastError ? humanError(lastError) : 'no-thread' };
}

async function performQuotaSwitch(target, { threadId = '', continueAfter = true } = {}) {
  const name = accountDisplayName(target);
  // 换号会重启 Codex 引擎，把正在跑的对话一起打断，所以必须等它们结束。
  const busy = [...tasks.values()].filter(task => String(task.id) !== String(threadId) && (task.status === 'running' || task.status === 'waiting_confirmation'));
  if (busy.length) throw Error(`还有 ${busy.length} 个对话在跑，现在换号会打断它们；等它们结束再回复「切换」。`);
  await switchNativeAccount(String(target.id));
  await refreshAccounts({ forceNative: true, awaitNative: true }).catch(error => console.error('[quota switch refresh]', humanError(error)));
  const activeNow = accounts.find(account => account.is_active);
  if (!activeNow || String(activeNow.id) !== String(target.id)) throw Error('账号切换后校验失败，当前账号没有改变，原账号仍可用。');
  if (!continueAfter) return { name, continued: false, reason: 'asked-not-to-continue' };
  return { name, ...await continueOnCurrentAccount(threadId) };
}

async function handleQuotaExhaustedFailure(task, { detail = '' } = {}) {
  const { active, others, target } = quotaAccountsOverview();
  const activeLine = active ? `${accountDisplayName(active)}（${quotaLeftText(active)}）` : '当前账号额度未知';
  const otherLines = others.map(account => `· ${accountDisplayName(account)}（${quotaLeftText(account)}）`).join('\n');
  const switchCount = Number(task.quotaSwitchCount || 0);

  if (config.autoSwitchAccountOnQuotaExhausted === true && target && switchCount < 3) {
    task.quotaSwitchCount = switchCount + 1;
    task.status = 'retry_waiting';
    task.output = `额度用尽，正在自动切换到 ${accountDisplayName(target)} 继续。`;
    await notify(`Codex 额度用尽，正在自动切换账号\n任务：${task.id}\n原账号：${activeLine}\n切换目标：${accountDisplayName(target)}（${quotaLeftText(target)}）\n\n切好后自动继续本轮任务，结果会发在这里。`, { appName: 'Codex 任务', taskId: task.id, notificationType: 'task_failed' }).catch(error => console.error('[quota switch notice]', error.message));
    try {
      const result = await performQuotaSwitch(target, { threadId: task.id, continueAfter: true });
      await notify(`已切换到 ${result.name}，继续这个任务\n任务：${task.id}${result.continued ? '' : '\n（没找到原对话，请在 Codex 里继续）'}`, { appName: 'Codex 任务', taskId: task.id, notificationType: 'task_started' }).catch(() => {});
      return true;
    } catch (error) {
      task.status = 'failed';
      const reason = humanError(error);
      const nextPick = quotaAccountsOverview();
      await notify(`自动切换账号失败，任务停在这里\n任务：${task.id}\n原因：${reason}${nextPick.target ? `\n可以回复「切换 ${accountDisplayName(nextPick.target)}」手动再试一次。` : ''}`, { appName: 'Codex 任务', taskId: task.id, notificationType: 'task_failed' }).catch(() => {});
      return true;
    }
  }

  const hint = target
    ? `建议切到：${accountDisplayName(target)}（${quotaLeftText(target)}）`
    : '现在没有其它账号还剩 5 小时额度，只能等额度重置。';
  const actions = target
    ? [
        '直接回复「切换」：自动选额度最多的账号，并接着这个对话继续（「切换账号」「切换账号并继续」也一样）',
        `回复「切换 ${accountDisplayName(target)}」：指定账号`,
        '回复「切换 账号名 不继续」：只换账号，不接着跑',
        '回复「自动切换 开启」：以后额度用尽自动换号',
      ].join('\n')
    : [
        '额度重置后回复「继续」就能接着干。',
        '回复「自动切换 开启」：以后有可用账号时自动换号。',
      ].join('\n');
  await notify(`Codex 额度用尽，任务中断\n任务：${task.id}\n中断账号：${activeLine}\n${hint}${otherLines ? '\n\n其它账号：\n' + otherLines : ''}\n\n${actions}${detail ? '\n\n原始提示：' + trim(detail, 400) : ''}`, { appName: 'Codex 任务', taskId: task.id, notificationType: 'task_failed' }).catch(error => console.error('[quota exhausted notice]', error.message));
  return true;
}

// 飞书里回复「切换」时使用：先定位这条回复对应的对话，再决定要不要继续。
async function handleQuotaSwitchCommand(parsed, message) {
  const { active, others, target } = quotaAccountsOverview();
  if (parsed.action === 'auto-status') {
    await sendFeishuAppText(`额度用尽自动切换：${config.autoSwitchAccountOnQuotaExhausted === true ? '已开启' : '已关闭（默认只提醒你）'}\n\n回复「自动切换 开启 / 关闭」可以修改。`, { replyTo: message.message_id });
    return true;
  }
  if (parsed.action === 'auto-toggle') {
    config.autoSwitchAccountOnQuotaExhausted = parsed.enabled;
    await saveConfig();
    await sendFeishuAppText(parsed.enabled
      ? '已开启：以后任务因为额度用尽失败时，会自动切到还有 5 小时额度的账号并继续，切完会在这里告诉你。'
      : '已关闭：额度用尽时只发消息问你，不会自动换号。回复「切换」可以手动换。', { replyTo: message.message_id });
    return true;
  }
  if (parsed.action === 'accounts') {
    const lines = accounts.map(account => {
      const plan = planExpirySuffix(account);
      return `${account.is_active ? '● ' : '○ '}${accountDisplayName(account)}：${quotaLeftText(account)}${plan ? `（${plan}）` : ''}`;
    }).join('\n');
    await sendFeishuAppText(`账号额度\n${lines || '还没有账号'}\n\n回复「切换」换到还有 5 小时额度的账号并继续当前对话。`, { replyTo: message.message_id });
    return true;
  }
  // action === 'switch'
  let chosen = target;
  if (parsed.targetName) {
    chosen = findAccountByName(accounts, parsed.targetName);
    if (!chosen) {
      const names = accounts.map(account => accountDisplayName(account)).join('、');
      await sendFeishuAppText(`没有找到「${parsed.targetName}」这个账号。\n现有账号：${names}\n\n回复「切换」可以自动选额度最多的账号。`, { replyTo: message.message_id });
      return true;
    }
  }
  if (!chosen) {
    await sendFeishuAppText(`现在没有其它账号还剩 5 小时额度，切换也跑不动。\n● 当前：${accountDisplayName(active)}（${quotaLeftText(active)}）\n\n可以等额度重置后回复「继续」。`, { replyTo: message.message_id });
    return true;
  }
  const chatThreadId = canonicalCodexThreadId(await resolveFeishuReplyThread(message).catch(() => '')) || '';
  const continuedText = resumed => resumed.continued
    ? (resumed.guessed
      ? '\n没认出你回复的是哪个对话，已接着最近跑过的那个继续；如果跑错地方，到 Codex 里手动打开要跑的对话回复「继续」即可。'
      : '\n已让它接着干，结果会发在这个对话里。')
    : `\n没找到可以接力的对话${resumed.reason && resumed.reason !== 'no-thread' ? `（${resumed.reason}）` : ''}；到 Codex 里回复「继续」即可。`;
  // 已经在这个账号上：不用换号。但说「切换/切换账号」本身就意味着“接着跑”，所以直接续跑。
  if (active && String(chosen.id) === String(active.id)) {
    if (parsed.continueAfter !== true) {
      await sendFeishuAppText(`当前已经是 ${accountDisplayName(chosen)}（${quotaLeftText(chosen)}），没有换号，也没有继续任务。`, { replyTo: message.message_id });
      return true;
    }
    const resumed = await continueOnCurrentAccount(chatThreadId);
    await sendFeishuAppText(`当前已经在 ${accountDisplayName(chosen)}（${quotaLeftText(chosen)}），不用换号。${continuedText(resumed)}`, { replyTo: message.message_id, taskId: resumed.threadId || chatThreadId || undefined });
    return true;
  }
  try {
    const result = await performQuotaSwitch(chosen, { threadId: chatThreadId, continueAfter: parsed.continueAfter === true });
    const where = parsed.continueAfter === true ? continuedText(result) : '\n按你的要求只换了账号，没有继续任务。';
    await sendFeishuAppText(`已切换到 ${result.name}（${quotaLeftText(chosen)}）${where}`, { replyTo: message.message_id, taskId: chatThreadId || result.threadId || undefined });
    return true;
  } catch (error) {
    await sendFeishuAppText(`切换失败：${humanError(error)}\n原账号没有改变，可以稍后重试。`, { replyTo: message.message_id });
    return true;
  }
}

function desktopTakeoverIds() {  return Array.isArray(config.codexDesktopTakeoverThreadIds) ? config.codexDesktopTakeoverThreadIds.map(String) : [];
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
    const now = Date.now();
    const eventId = String(data?.header?.event_id || data?.event_id || data?.eventId || event.event_id || '').trim();
    if (eventId && alreadySeenReaction(feishuReactionEvents, eventId, now)) return;
    const operatorType = String(event.operator_type || event.operatorType || event.user_id?.user_type || event.user_id?.userType || '').toLowerCase();
    if (['app', 'bot', 'openapi'].includes(operatorType)) return;
    const senderId = String(event.user_id?.open_id || event.user_id?.openId || event.operator_id?.open_id || event.operator_id?.openId || '');
    const allowed = Array.isArray(config.feishuAllowedUserIds) ? config.feishuAllowedUserIds.map(String) : [];
    const isOperator = allowed.length ? allowed.includes(senderId) : Boolean(senderId);
    const messageId = String(event.message_id || event.messageId || '').trim();
    if (!messageId || !config.feishuBoundChatId) return;
    // When a task moves to the background the bot adds an OK to the same
    // message. Feishu pushes that reaction back here; it is not a user command.
    const botReactedAt = feishuBotReactions.get(messageId) || 0;
    const humanOperator = Boolean(senderId) && !['app', 'bot', 'openapi'].includes(operatorType);
    if (botReactedAt && now - botReactedAt < 60000 && !(humanOperator && isOperator)) return;
    // Feishu re-delivers events after a reconnect. One reaction per message is
    // all the user ever intended, so later copies are silently dropped.
    if (alreadySeenReaction(feishuReactionMessages, `${messageId}:${emoji}`, now)) return;
    if (!isOperator) return;
    const links = config.feishuMessageThreads && typeof config.feishuMessageThreads === 'object' ? config.feishuMessageThreads : {};
    const historical=(config.notificationHistory||[]).find(item=>item.sent&&item.messageId===messageId)?.taskId;
    const threadId = canonicalCodexThreadId(links[messageId] || historical) || await resolveFeishuReplyThread({parent_id:messageId});
    if (!threadId) return;
    requestThreadId = threadId;
    const previous = feishuContinueRequests.get(threadId) || 0;
    // A duplicate within the same turn is ignored silently. Replying with a
    // second "please wait" message is what made one OK look like two reminders.
    if (now - previous < 45000) return;
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
async function receiveFeishuMessage(data, opts = {}) {
  const entry = inboxEntryFromEvent(data);
  if (entry) await feishuInbox.append(entry).catch(error => console.error('[feishu inbox]', humanError(error)));
  if (!opts.recovered && await replyFeishuInbox(data, entry)) return;
  return handleFeishuMessage(data, opts);
}

// A message that reached us but produced no reply used to be lost for good:
// its id was already in the dedupe list, so sending it again was the only fix.
// On startup we read those ids back from Feishu and replay the newest one, so
// the user never has to notice or resend anything. Only rich-text (post)
// messages qualify - those are exactly the ones the old parser dropped.
async function recoverUnansweredFeishuMessages() {
  if (!feishuClient || !config.feishuBoundChatId) return;
  const recent = (Array.isArray(config.feishuReceivedMessageIds) ? config.feishuReceivedMessageIds : []).map(String).slice(-12);
  const links = config.feishuMessageThreads && typeof config.feishuMessageThreads === 'object' ? config.feishuMessageThreads : {};
  const seen = new Set((Array.isArray(config.feishuRecoveredMessageIds) ? config.feishuRecoveredMessageIds : []).map(String));
  const candidates = recent.filter(id => id && !seen.has(id) && !links[id]);
  if (!candidates.length) return;
  // Mark everything up front: only the newest replayable message is resent,
  // and no later restart can replay the same instruction twice.
  config.feishuRecoveredMessageIds = [...seen, ...candidates].slice(-200);
  await saveConfig();
  const allow = (Array.isArray(config.feishuAllowedUserIds) ? config.feishuAllowedUserIds : []).map(String);
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const id of [...candidates].reverse()) {
    try {
      const response = await feishuClient.im.v1.message.get({ path: { message_id: id } });
      const item = response?.data?.items?.[0];
      if (!item || response?.code) continue;
      if (String(item.msg_type || '').toLowerCase() !== 'post') continue;
      if (String(item.sender?.sender_type || '') !== 'user') continue;
      const senderId = String(item.sender?.id || item.sender?.sender_id?.open_id || '');
      if (!allow.includes(senderId) || String(item.chat_id || '') !== String(config.feishuBoundChatId)) continue;
      const created = Number(item.create_time || 0);
      if (!created || created < cutoff) continue;
      const parsed = parseFeishuPost(item.body?.content);
      if (!parsed.ok || /^(收件箱|消息|最近消息|inbox|绑定|bind)$/i.test(parsed.text.trim())) continue;
      const data = {
        sender: { sender_type: 'user', sender_id: { open_id: senderId } },
        message: {
          message_id: id,
          chat_id: String(item.chat_id || ''),
          root_id: String(item.root_id || ''),
          parent_id: String(item.parent_id || ''),
          message_type: 'post',
          content: String(item.body?.content || '{}'),
        },
      };
      await receiveFeishuMessage(data, { recovered: true });
      console.log(`[feishu recover] 已自动补发一条没收到回复的图文消息 ${id}`);
      return;
    } catch (error) {
      console.warn('[feishu recover]', humanError(error));
    }
  }
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
    // 付费计划 + 到期时间已过 = 账号库里这张"旧卡"没同步到续费后的新信息（账号实际可用）。
    // 这种矛盾数据一律不下发，浮窗/网页/飞书/通知就不会有任何一处误报"已到期"；
    // 等客户端或账号切换带来新令牌后，真实到期时间会自动恢复显示。
    const stalePlan = planExpiryStale(entry);
    return {
      id: entry.id,
      name: entry.email || entry.name,
      email: entry.email || null,
      plan_type: entry.plan_type || null,
      subscription_expires_at: stalePlan ? null : (entry.subscription_expires_at || null),
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
    // Our own write to auth.json must not look like an external account switch.
    await rememberLocalAuth(targetAuth);
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
// 1455 被 Windows 收进系统保留范围时自动修复：弹一次管理员授权（UAC 点一次「是」），
// 永久保留 1455 给登录用，修完以后重启电脑也不会再犯。每天最多自动尝试一次，防止用户点「否」后反复弹窗。
let portRepair = { inFlight: false };
async function repairLoginPort({ interactive = false } = {}) {
  if (process.platform !== 'win32' || portRepair.inFlight) return { attempted: false, ok: false, reason: 'busy' };
  portRepair.inFlight = true;
  try {
    const before = await oauthPortStatus();
    if (!before || before.free !== false || !before.reserved) return { attempted: false, ok: true, reason: 'healthy' };
    const today = new Date().toISOString().slice(0, 10);
    if (config.loginPortFixLastAttempt === today && !interactive) return { attempted: false, ok: false, reason: 'rate-limited' };
    if (config.loginPortFixLastAttempt !== today) { config.loginPortFixLastAttempt = today; saveConfig().catch(() => {}); }
    const root = path.join(process.env.APPDATA || os.tmpdir(), 'CodexCompanion');
    mkdirSync(root, { recursive: true });
    const fixPath = path.join(root, 'fix-login-port.ps1');
    // 内容纯 ASCII，不需要 BOM。
    writeFileSync(fixPath, [
      "$ErrorActionPreference='SilentlyContinue'",
      'net stop winnat | Out-Null',
      'netsh int ipv4 add excludedportrange protocol=tcp startport=1455 numberofports=1 store=persistent | Out-Null',
      'net start winnat | Out-Null',
      "Set-Content -LiteralPath '" + root.replace(/'/g, "''") + "\\port-fix-done.txt' -Value done",
      ''
    ].join('\r\n'), 'utf8');
    const launch = "Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','" + fixPath.replace(/'/g, "''") + "')";
    let accepted = true;
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', launch], { windowsHide: true, timeout: 120000, maxBuffer: 8192 });
    } catch (error) {
      accepted = !/cancel|取消|canceled|denied|拒绝/i.test(String(error.message || ''));
    }
    // WinNAT 重启要几秒到几十秒，轮询等端口恢复可用。
    for (let i = 0; i < 14; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const after = await oauthPortStatus().catch(() => null);
      if (after && after.free !== false) return { attempted: true, ok: true };
    }
    return { attempted: true, ok: false, canceled: !accepted };
  } finally { portRepair.inFlight = false; }
}
async function startBrowserLogin(name) {
  if (browserLoginInFlight) throw Error('正在处理本次登录，请等待结果，不要重复生成链接。');
  if (loginBusy()) throw Error('还有 Companion 任务正在运行或等待确认。请先处理任务，再登录或更新账号。');
  // 登录全程要占用 localhost:1455 收回传。它被 Windows 保留或被别的程序占着时，
  // 网页登录和 Codex 客户端的「继续登录」会一起失败（os error 10013）。被保留时直接自动修复。
  const port = await oauthPortStatus();
  if (port && port.free === false) {
    if (port.reserved) {
      const repair = await repairLoginPort({ interactive: true });
      if (!repair.ok) {
        if (repair.canceled) throw Error('我弹出了修复授权窗口，但你点了「否」。再点一次登录，在弹窗里点「是」——只需这一次，以后永久生效。');
        throw Error('1455 被 Windows 收进了系统保留范围，自动修复还没成功。等半分钟再点一次登录；弹出的授权窗口点「是」即可。');
      }
    } else throw Error('1455 端口正被别的程序占用（可能是 Codex 客户端有一个登录没走完）。关掉对应程序或稍等片刻，再点登录。');
  }
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
function proxyFromEnv() {
  return String(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
}
async function browserSystemProxy() {
  // Windows 系统代理（VPN 客户端写进注册表）优先。旧实现一见到环境变量就
  // 直接放弃系统代理，AI 会话注入的 127.0.0.1:3215 之类端口会让更新下载
  // 明明有 VPN 却全部走直连，这正是同事点更新一直失败的一类根因。
  try {
    const parsed = await readSystemProxy();
    if (parsed?.address) return `http://${parsed.address}`;
  } catch {}
  return proxyFromEnv();
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
// A dead VPN used to look exactly like "暂时无法读取额度". Diagnose the cause
// in the background, show one short sentence in the UI, and notify only when
// the network actually goes down (and once more when it comes back).
let networkHealth = { state: 'ok', label: '', hint: '', checkedAt: 0, accounts: [], proxy: '' };
let networkNoticeState = { state: 'ok', notifiedAt: 0 };
let networkProbeLastAt = 0;
let networkProbeInFlight = null;
function degradedQuotaAccounts() {
  return accounts.filter(account => classifyQuotaFailure(account.usage?.error).network)
    .map(account => account.display_name || account.name || '未命名账号');
}
function updateNetworkHealth() {
  const degraded = degradedQuotaAccounts();
  if (!degraded.length) {
    if (networkHealth.state !== 'ok') networkHealth = { state: 'ok', label: '', hint: '', checkedAt: Date.now(), accounts: [], proxy: '' };
    const decision = networkNoticeDecision(networkNoticeState, false, Date.now());
    networkNoticeState = { state: decision.state, notifiedAt: decision.notifiedAt };
    if (decision.notice === 'recovered') {
      notify('网络已恢复，额度已经自动刷新。', { appName: 'Codex 额度', notificationType: 'network_down' }).catch(error => console.error('[network notice]', error.message));
      setTimeout(() => { refreshAccounts({ forceNative: true }).catch(() => {}); }, 8000).unref?.();
    }
    return;
  }
  const now = Date.now();
  if (networkProbeInFlight || now - networkProbeLastAt < 90 * 1000) return;
  networkProbeLastAt = now;
  networkHealth = { state: 'checking', label: '正在检查网络…', hint: '', checkedAt: now, accounts: degraded, proxy: '' };
  networkProbeInFlight = probeNetwork({ timeoutMs: 4500 })
    .then(result => {
      networkHealth = { ...result, checkedAt: Date.now(), accounts: degraded };
      const decision = networkNoticeDecision(networkNoticeState, true, Date.now());
      networkNoticeState = { state: decision.state, notifiedAt: decision.notifiedAt };
      if (decision.notice !== 'down') return;
      notify(`额度读不到了：${result.label}\n账号：${degraded.join('、')}\n原因：${result.hint}\n\n现在显示的是上一次成功读取的额度，不是额度用完了。Companion 会自动重试，网络恢复后自动刷新。`, { appName: 'Codex 额度', notificationType: 'network_down' }).catch(error => console.error('[network notice]', error.message));
    })
    .catch(error => { console.error('[network probe]', error.message); })
    .finally(() => { networkProbeInFlight = null; });
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
  updateNetworkHealth();
}
// 点一下浮窗/网页时真正去后台取最新额度：请求立刻返回，界面通过 /api/status 看进度。
// 强制读取原生额度可能要几十秒，所以不能让点击界面干等（会表现成“点了没反应”）。
let manualQuotaRefresh = { running: false, startedAt: 0, finishedAt: 0, error: '' };
function startManualQuotaRefresh() {
  if (manualQuotaRefresh.running) return { ...manualQuotaRefresh, started: false };
  const startedAt = Date.now();
  manualQuotaRefresh = { running: true, startedAt, finishedAt: 0, error: '' };
  const finish = error => {
    if (manualQuotaRefresh.startedAt !== startedAt || !manualQuotaRefresh.running) return;
    manualQuotaRefresh = { running: false, startedAt, finishedAt: Date.now(), error: error || '' };
  };
  refreshAccounts({ forceNative: true, awaitNative: true }).then(() => finish(''), error => {
    console.error('[click refresh]', error.message);
    finish(humanError(error));
  });
  // 原生读取偶尔卡住，别让界面永远停在“刷新中”。
  setTimeout(() => finish('刷新用时较长，已按现有数据继续。'), 70000).unref?.();
  return { ...manualQuotaRefresh, started: true };
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
  const notificationEmoji={quota_early:'🎉',quota_reset_soon:'⏰',quota_exhausted:'🚫',quota_expiry:'⌛',plan_expiry:'💳',quota_waste:'💰',network_down:'🌐',context_pressure:'📊',takeover_start:'🤖',task_retry:'🔁',task_approval:'🙋',task_stalled:'🐌',service_exit:'🛑',task_failed:'❌',task_completed:'✅',task_started:'▶️',windows:'🪟'};
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
  if (!planExpiryStale(account)) {
    const planExpiry = parseExpirySeconds(account?.subscription_expires_at);
    if (Number.isFinite(planExpiry)) {
      const when = new Date(planExpiry * 1000).toLocaleString('zh-CN', { hour12: false });
      lines.push(planExpiry <= Date.now() / 1000 ? `会员：已到期（${when}），部分模型可能用不了` : `会员：${account.plan_type || ''} 到期 ${when}（还剩 ${formatQuotaReset(planExpiry)}）`);
    }
  }
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
// 付费账号显示"已过期"但 plan 还是 plus/pro = 本地令牌旧了。限频（6 小时一次）触发强制刷新，
// 拿到新令牌后到期时间会自动纠正；任务运行中不打扰。
let stalePlanRefreshAt = 0;
function maybeRefreshStalePlanExpiry() {
  if (!accounts.some(account => planExpiryStale(account))) return;
  if (Date.now() - stalePlanRefreshAt < 6 * 3600 * 1000 || loginBusy()) return;
  stalePlanRefreshAt = Date.now();
  refreshAccounts({ forceNative: true, awaitNative: false }).catch(error => console.error('[stale plan refresh]', humanError(error)));
}
async function checkQuotaNotices() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  maybeRefreshStalePlanExpiry();
  const restored = [];
  if (!config.quotaRecoveryObservations || typeof config.quotaRecoveryObservations !== 'object' || Array.isArray(config.quotaRecoveryObservations)) config.quotaRecoveryObservations = {};
  let recoveryObservationsChanged = false;
  const accountStillExists = account => accounts.some(current => String(current.id) === String(account.id));
  for (const account of accounts) {
    // A prior notification can yield to the HTTP handler. Re-check membership so an
    // account deleted while this scan is running cannot receive a later stale notice.
    if (!accountStillExists(account)) continue;
    // 会员到期提醒：到期前 7 天每天一次，刚到期 48 小时内也提醒一次（很多人根本不知道过期了）。
    // 付费计划 + 显示已过期 = 本地令牌没刷新到最新（实际还能用），不提醒，改触发一次强制刷新。
    if (notificationEnabled(config, 'plan_expiry') && !planExpiryStale(account)) {
      const planExpiry = parseExpirySeconds(account.subscription_expires_at);
      const expired = Number.isFinite(planExpiry) && planExpiry <= nowSeconds;
      if (Number.isFinite(planExpiry) && (expired ? nowSeconds - planExpiry < 48 * 3600 : (planExpiry - nowSeconds) / 86400 <= 7)) {
        const key = `plan:${account.id}`;
        const todayKey = shanghaiDayKey(Date.now());
        const previous = planExpiryNotifierState.get(key);
        const state = previous && previous.expiresAt === planExpiry ? previous : { expiresAt: planExpiry, lastDay: null };
        if (state.lastDay !== todayKey) {
          const prefix = expired ? 'Codex 会员已到期' : 'Codex 会员即将到期';
          if (sentQuotaNoticeToday(prefix, `账号：${accountDisplayName(account)}`)) {
            state.lastDay = todayKey;
            planExpiryNotifierState.set(key, state);
          } else {
          state.lastDay = todayKey;
          planExpiryNotifierState.set(key, state);
          const when = new Date(planExpiry * 1000).toLocaleString('zh-CN');
          const planLabel = account.plan_type ? `会员类型：${account.plan_type}\n` : '';
          const message = expired
            ? `Codex 会员已到期\n账号：${accountDisplayName(account)}\n${planLabel}到期时间：${when}\n\n部分模型和额度已经跟着变了（比如报“模型不支持”）。请续费或换个还有效的账号。`
            : `Codex 会员即将到期\n账号：${accountDisplayName(account)}\n${planLabel}到期时间：${when}\n\n到期后模型和额度都会变化，请及时续费或调整用法。`;
          await notify(message, { appName: 'Codex 额度', notificationType: 'plan_expiry' });
          }
        } else {
          planExpiryNotifierState.set(key, state);
        }
      }
    }
    const expiry = Date.parse(account.reset_credits_expires_at || '') / 1000;
    if (Number.isFinite(expiry) && expiry > nowSeconds) {
      const daysLeft = (expiry - nowSeconds) / 86400;
      const key = String(account.id);
      const previous = subscriptionNotifierState.get(key);
      const todayKey = shanghaiDayKey(Date.now());
      const alreadySentToday = sentQuotaNoticeToday(`账号：${accountDisplayName(account)}`, '重置次数将在 7 天内到期');
      const state = previous && previous.expiresAt === expiry ? previous : { expiresAt: expiry, sent: {}, lastDay: alreadySentToday ? todayKey : null };
      if (daysLeft <= 7) {
        const dayKey = todayKey;
        if (state.lastDay !== dayKey) {
          state.lastDay = dayKey;
          subscriptionNotifierState.set(key, state);
          await notify(`Codex 重置次数将在 7 天内到期\n账号：${accountDisplayName(account)}\n剩余次数：${account.reset_count ?? '--'}\n到期时间：${new Date(expiry * 1000).toLocaleString('zh-CN')}`, { appName: 'Codex 额度' });
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
          const alreadySentToday = sentQuotaNoticeToday('Codex 额度已用尽', `账号：${accountDisplayName(account)}`, `类型：${label}`);
          if (!alreadySentToday) await notify(`Codex 额度已用尽\n账号：${accountDisplayName(account)}\n类型：${label}\n下次重置：${resetAt ? new Date(resetAt * 1000).toLocaleString('zh-CN') : '暂未返回'}\n\n${dashboardLink()}`, { appName: 'Codex 额度' });
        }
      } else if (Number.isFinite(used) && used < 100) {
        // 一旦额度回落到非 100%，清空已发过的状态机，下次再耗尽会重新通知
        if (state.state === 'exhausted') quotaNotifierState.set(key, { ...state, state: 'normal', resetSoonNotified: false, resetCycle: resetAt || state.resetCycle });
      }
      const remainingSeconds = resetAt - nowSeconds;
      // 防浪费提醒：5 小时额度快重置了但还剩很多，用不完就是浪费会员费。每个周期最多提醒一次。
      if (usedKey === 'primary_used_percent' && notificationEnabled(config, 'quota_waste') && !account.usage?.cached && !account.usage?.error && Number.isFinite(used) && Number.isFinite(resetAt) && resetAt > nowSeconds) {
        const remainingPercent = Math.max(0, Math.round(100 - used));
        config.quotaWasteReminderLedger ||= {};
        const fired = nextWasteReminder(config.quotaWasteReminderLedger, key, {
          resetAt, now: nowSeconds,
          leadMinutes: Number(config.wasteReminderLeadMinutes) || 30,
          minPercent: Number(config.wasteReminderMinPercent) || 30,
          remainingPercent, windowMinutes: Number(account.usage?.[windowKey]),
        });
        if (fired) {
          await saveConfig();
          await notify(`Codex 5 小时额度快重置了，还剩不少\n账号：${accountDisplayName(account)}\n剩余：${remainingPercent}% · 约 ${Math.max(1, Math.ceil(remainingSeconds / 60))} 分钟后重置\n\n不用完就浪费了，有重活抓紧安排。`, { appName: 'Codex 额度', notificationType: 'quota_waste' });
        }
      }
      if(notificationEnabled(config,'quota_reset_soon')) {
        config.quotaResetReminderLedger ||= {};
        const lead=nextResetReminder(config.quotaResetReminderLedger,key,{resetAt,now:nowSeconds,leads:resetReminderLeads(config),windowMinutes:Number(account.usage?.[windowKey])});
        if(lead!==null) {
          await saveConfig();
          await notify(resetSoonMessage(account,label,lead,Math.max(1,Math.ceil(remainingSeconds/60)),resetAt),{appName:'Codex 额度',notificationType:'quota_reset_soon'});
        }
        // 轮询兜底之外，为还没到点的档位排精确定时器，到点准点发。
        scheduleExactResetReminders(account,key,label,resetKey,resetAt,nowSeconds,Number(account.usage?.[windowKey]));
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
      turnOutput: '',
      turnFinalText: '',
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
      // A new turn starts from a clean slate. If turn/started never arrives
      // (session busy elsewhere, login expired...), stale output from the
      // previous turn would otherwise be reposted by the stall reminder.
      task.turnOutput = '';
      task.turnFinalText = '';
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
        // 单测会把这段代码切进 vm 沙箱，那里没有这个辅助函数，用 typeof 兜一下。
        if (typeof rememberActiveThread === 'function') rememberActiveThread(id);
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
        // 额度用尽：不是普通失败，交给账号接力逻辑（提示换号 / 自动换号）。这里必须
        // 在通用失败通知之前拦下，否则会同时发出两条互相矛盾的结论。
        if (task.status === 'failed' && isQuotaExhaustedText(`${turnError}\n${finalText}`)) {
          task.turnFinalText = `Codex 额度用尽，任务中断\n${activeQuotaSummaryText()}`;
          handleQuotaExhaustedFailure(task, { detail: turnError || finalText }).catch(error => console.error('[quota exhausted]', humanError(error)));
          finishDesktopTakeover(id).catch(error => console.error('[desktop relaunch]', error.message));
          refreshQuotaAfterTask(task).catch(error => console.error('[task quota]', error.message));
          return;
        }
        const capacityFailure = /selected model is at capacity|model is temporarily unavailable/i.test(`${turnError}\n${finalText}`);        const transientFailure = capacityFailure || /service unavailable|stream disconnected|stream closed before response\.completed|connection reset|socket hang up/i.test(`${turnError}\n${finalText}`);
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
    if (req.method==='GET'&&u.pathname==='/api/update/status') return send(res,200,await updateStatusPayload(u.searchParams.get('force')==='1'));
    if (req.method==='POST'&&u.pathname==='/api/update/apply') {
      if(!isLoopback(req.socket.remoteAddress))return send(res,403,{error:'更新只允许在本机操作'});
      const result=await applyUpdate();
      send(res,200,result);
      // Give the response time to flush, then step aside so the scheduled task
      // can bring the new version up.
      setTimeout(()=>process.exit(0),1200).unref?.();
      return;
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
      const updateSummary = cachedUpdateSummary();
      const updateWritable = await installDirWritableCached();
      return send(res,200,{
        version:APP_VERSION,
        warmupLogPath,
        taskEngineReady:!!codex?.proc,
        codexSessionMonitorReady: codexSessionWatcherReady,
        taskEngineError,
        lastQuotaDelta,
        config:publicConfig(),
        update:{
          available: Boolean(updateSummary?.available),
          latest: updateSummary?.latest || '',
          canApply: Boolean(updateSummary?.available && updateSummary.patch) && updateWritable,
          mode: normalizeUpdateMode(config.updateMode),
          applying: updateApplying,
          checkedAt: updateCache.checkedAt || null,
          error: updateCache.error || null,
          lastError: updateLastError,
          logPath: updateLogPath,
        },
        security:{ remoteEnabled: !!config.remoteAccessEnabled, local: isLoopback(req.socket.remoteAddress), allowedUserCount: (config.feishuAllowedUserIds || []).length, pairingCommand: isLoopback(req.socket.remoteAddress) && !(config.feishuAllowedUserIds || []).length ? `绑定 ${feishuPairingCode}` : null },
        feishu:publicFeishuState(),
        accounts:accounts.map(account=>({...account,quotaFacts:buildQuotaFacts(account.usage,Date.now())})),
        quotaRefresh:{ running:manualQuotaRefresh.running, startedAt:manualQuotaRefresh.startedAt, finishedAt:manualQuotaRefresh.finishedAt, error:manualQuotaRefresh.error },
        networkHealth,
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
    if (req.method==='POST'&&u.pathname==='/api/accounts/refresh'){
      if (data.quick === true) return send(res,200,{ok:true,...startManualQuotaRefresh()});
      await refreshAccounts({forceNative:true,awaitNative:true});return send(res,200,{ok:true,accounts});
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/import-local'){
      if (!isLoopback(req.socket.remoteAddress)) return send(res,403,{error:'导入本机账号只能在本机操作'});
      if(data.confirm!==true)throw Error('请确认将本机登录保存到 Companion 加密账号库');
      const auth=await readJson(liveAuthPath);
      if(!auth?.tokens?.id_token||!auth?.tokens?.access_token||!auth?.tokens?.refresh_token)throw Error('没有找到可导入的本机文件凭据，请使用通用网页登录。客户端已登录不代表凭据存储在文件中。');
      const account=await upsertNativeAccount(auth,{is_active:true});
      if(!account)throw Error('该账号已被删除。若确实需要恢复，请重新登录后添加。');
      await rememberLocalAuth(auth);
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
    if (req.method==='POST'&&u.pathname==='/api/browser-login/start') return send(res,200,await startBrowserLogin(data.name));
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
      const id=String(data.id);
      const account=accounts.find(item=>String(item.id)===id);
      if(!account)throw Error('没有找到这个账号，请刷新后再试。');
      const name=account.display_name||account.name||id;
      const before={...(account.usage||{})};
      const decision=warmupDecision(before,{accountName:name});
      await appendWarmupLog(`收到预热请求：${name} · 5 小时已用 ${before.primary_used_percent??'?'}% · 周已用 ${before.secondary_used_percent??'?'}% · 重置 ${fmtWarmupClock(before.primary_resets_at)} · 判定 ${decision.action}/${decision.reason}`);
      if(decision.action==='skip'){
        await appendWarmupLog(`已跳过 ${name}：${decision.message}`);
        return send(res,200,{ok:true,skipped:true,reason:decision.reason,resetAt:decision.resetAt,startedAt:decision.startedAt,message:decision.message,logPath:warmupLogPath});
      }
      try{
        const result=await warmupNativeAccount(id);
        const refreshed=accounts.find(item=>String(item.id)===id);
        const after=refreshed?.usage||{};
        const verdict=verifyWarmupWindow(before,after,{name:result.name||name});
        await appendWarmupLog(`${name} 请求完成：重置 ${fmtWarmupClock(before.primary_resets_at)} -> ${fmtWarmupClock(after.primary_resets_at)} · ${verdict.started?'窗口已启动':'窗口未启动'}/${verdict.reason}`,verdict.started?'INFO':'WARN');
        return send(res,200,{ok:verdict.started,started:verdict.started,skipped:false,...result,reason:verdict.reason,window:{resetAt:verdict.resetAt,startedAt:verdict.startedAt,beforeResetAt:verdict.beforeResetAt,afterResetAt:verdict.afterResetAt},message:verdict.message,logPath:warmupLogPath});
      }catch(error){
        const reason=humanError(error);
        const hint=isTransientWarmupError(error)?'这像是网络或超时问题，检查 VPN / 网络后再点一次即可。':'';
        await appendWarmupLog(`${name} 预热失败：${reason}`,'ERROR');
        return send(res,200,{ok:false,skipped:false,error:reason,logPath:warmupLogPath,message:`【${name}】预热没成功：${reason}\n这次没有启动 5 小时窗口，也没有提前重置。${hint}\n原因已记入 ${warmupLogPath}`});
      }
    }
    if (req.method==='POST'&&u.pathname==='/api/accounts/warmup-all'){
      if(data.confirm!==true)throw Error('批量预热会让全部可用账号发送一次最小请求，请先确认。');
      const snapshot=[...accounts];
      const results=[];
      await appendWarmupLog(`收到批量预热请求：${snapshot.length} 个账号`);
      for(const account of snapshot){
        const name=account.display_name||account.name;
        const before={...(account.usage||{})};
        const decision=warmupDecision(before,{accountName:name});
        if(decision.action==='skip'){
          await appendWarmupLog(`跳过 ${name}：${decision.reason}`);
          results.push({ok:true,skipped:true,id:String(account.id),name,reason:decision.reason,message:decision.message});
          continue;
        }
        try{
          const done=await warmupNativeAccount(String(account.id));
          const refreshed=accounts.find(item=>String(item.id)===String(account.id));
          const verdict=verifyWarmupWindow(before,refreshed?.usage||{},{name:done.name||name});
          await appendWarmupLog(`${name}：重置 ${fmtWarmupClock(before.primary_resets_at)} -> ${fmtWarmupClock(refreshed?.usage?.primary_resets_at)} · ${verdict.started?'窗口已启动':'窗口未启动'}/${verdict.reason}`,verdict.started?'INFO':'WARN');
          results.push({ok:verdict.started,skipped:false,...done,reason:verdict.reason,message:verdict.message});
        }
        catch(error){
          await appendWarmupLog(`${name} 预热失败：${humanError(error)}`,'ERROR');
          results.push({ok:false,id:String(account.id),name,error:humanError(error),message:`${name} 预热没成功：${humanError(error)}`});
        }
      }
      const succeeded=results.filter(item=>item.ok&&!item.skipped).length;
      const skipped=results.filter(item=>item.skipped).length;
      const notStarted=results.filter(item=>item.ok===false&&!item.error).length;
      const failedCount=results.filter(item=>!item.ok).length;
      const parts=[`已启动 ${succeeded} 个`];
      if(skipped)parts.push(`${skipped} 个窗口正在计时，已跳过（没耗额度）`);
      if(notStarted)parts.push(`${notStarted} 个请求发了但窗口没启动`);
      if(failedCount-notStarted>0)parts.push(`${failedCount-notStarted} 个失败`);
      return send(res,200,{ok:failedCount===0,total:results.length,succeeded,skipped,failedCount,results,logPath:warmupLogPath,message:`${parts.join('；')}。详情见 ${warmupLogPath}`});
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
      return send(res,200,{rules:notificationRules.map(rule=>({...rule,enabled:notificationEnabled(config,rule.id)})),resetReminderLeadMinutes:resetReminderLeads(config),stallMinutes:Number(config.stallMinutes)||3,wasteReminderLeadMinutes:Number(config.wasteReminderLeadMinutes)||30,wasteReminderMinPercent:Number(config.wasteReminderMinPercent)||30});
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
      if(Object.hasOwn(data,'updateMode')) config.updateMode=normalizeUpdateMode(data.updateMode);
      if(typeof data.autoSwitchAccountOnQuotaExhausted==='boolean') config.autoSwitchAccountOnQuotaExhausted=data.autoSwitchAccountOnQuotaExhausted;
      await saveConfig();
      if(Object.hasOwn(data,'autoTakeoverDesktopTransient')||Object.hasOwn(data,'desktopRetryAutoClick')||Object.hasOwn(data,'desktopRetryCooldownSeconds')) syncDesktopRetryWatcher(config);
      return send(res,200,{ok:true,desktopRetry:desktopRetryState(),webhooks:publicWebhooks(),updateMode:normalizeUpdateMode(config.updateMode),autoSwitchAccountOnQuotaExhausted:config.autoSwitchAccountOnQuotaExhausted===true});
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
function localAuthIdentity(auth) {
  const claims = decodeJwtPayload(auth?.tokens?.id_token || '') || {};
  const authClaims = claims['https://api.openai.com/auth'] || {};
  const accountId = auth?.tokens?.account_id || authClaims.chatgpt_account_id || null;
  const email = claims.email || null;
  return {
    accountId,
    email,
    identity: String(accountId || email || '').toLowerCase(),
    credentials: createHash('sha256').update(String(auth?.tokens?.refresh_token || '')).digest('hex').slice(0, 32),
  };
}

// Called when Companion itself wrote auth.json (account switch), so the watcher
// below does not mistake our own write for an external account change.
async function rememberLocalAuth(auth) {
  const { identity, credentials } = localAuthIdentity(auth);
  config.lastLocalAuthIdentity = identity;
  config.lastLocalAuthCredHash = credentials;
  await saveConfig().catch(() => {});
}

// Fresh-install convenience: if this machine is already logged in to the Codex
// client, pull those file credentials into the encrypted vault so the user skips
// manual login. Re-checked on startup and on a timer, so switching accounts in
// the Codex client brings the new account over too. An identity change follows
// the client (and moves the active account); a plain token refresh updates the
// stored credentials quietly so it never overrides a choice made in the UI.
// Accounts the user deleted are still refused by upsertNativeAccount.
async function autoImportLocalAuth() {
  try {
    const auth = await readJson(liveAuthPath).catch(() => null);
    if (!auth?.tokens?.id_token || !auth?.tokens?.access_token || !auth?.tokens?.refresh_token) return;
    const { accountId, email, identity, credentials } = localAuthIdentity(auth);
    const identityChanged = config.lastLocalAuthIdentity !== identity;
    const credentialsChanged = config.lastLocalAuthCredHash !== credentials;
    if (!identityChanged && !credentialsChanged) return;
    const known = await loadNativeAccountsSnapshot().catch(() => []);
    const isNew = !known.some(item =>
      (accountId && item.account_id === accountId)
      || (email && String(item.email || '').toLowerCase() === String(email).toLowerCase()));
    const account = await upsertNativeAccount(auth, (isNew || identityChanged) ? { is_active: true } : {});
    config.lastLocalAuthIdentity = identity;
    config.lastLocalAuthCredHash = credentials;
    config.autoImportLocalAuthDone = true; // kept for config compatibility
    await saveConfig();
    if (!account) return; // deleted on purpose: stay silent
    if (isNew) {
      nativeUsageCache.delete(String(account.id));
      await refreshAccounts({ forceNative: true, awaitNative: false }).catch(() => {});
      await notify(`已自动导入本机 Codex 登录\n账号：${account.name || account.email || 'ChatGPT 账号'}\n无需重新登录，额度约 1 分钟后显示。`, { appName: 'Codex Companion' });
      console.log('[auto import] imported local codex auth:', account.id);
    } else if (identityChanged) {
      nativeUsageCache.delete(String(account.id));
      await refreshAccounts({ forceNative: true, awaitNative: false }).catch(() => {});
      await notify(`已跟随 Codex 客户端切换账号\n当前账号：${account.name || account.email || 'ChatGPT 账号'}`, { appName: 'Codex Companion' });
      console.log('[auto import] followed account switch:', account.id);
    } else {
      console.log('[auto import] refreshed local codex credentials:', account.id);
    }
  } catch (error) {
    console.error('[auto import local auth]', error.message);
  }
}

// ---------------------------------------------------------------------------
// In-app updates
//
// A release carries two assets: the full installer (bundles Node + Codex CLI)
// and a small patch zip with just this project's own files. Everything below
// only touches the patch: download -> verify every hash -> back up -> replace ->
// restart through the scheduled task. If the new version does not show up after
// the restart, the next boot rolls the files back from _update-backup.
// ---------------------------------------------------------------------------
const updateFeedUrl = process.env.CC_UPDATE_FEED || DEFAULT_UPDATE_FEED;
const updateStatePath = path.join(sourceDir, 'update-state.json');
const updateBackupDir = path.join(sourceDir, '_update-backup');
// Releases are rare, but an idle machine updates within minutes of one landing,
// so the check has to be frequent enough to matter and still far inside the
// anonymous GitHub limit (60 requests an hour).
const updateCheckIntervalMs = 45 * 60 * 1000;
const updateIdleProbeIntervalMs = 5 * 60 * 1000;
let updateCache = { checkedAt: 0, release: null, summary: null, error: null };
let updateApplying = false;
let updateIdleErrorLogged = false;
// 更新失败以前只写进 server.stdout/stderr.log，而这两个文件每次启动都会被
// 重定向覆盖，重启后线索就没了。这里单独留一份追加日志和一条「最近一次失败」，
// 重启后仍能在浮窗/网页看到原因，也让自动重试有依据。
const updateLogPath = path.join(appDir, 'update.log');
const updateFailurePath = path.join(appDir, 'update-last-error.json');
let updateLastError = null;
let updateRetryInFlight = false;

async function appendUpdateLog(message, level = 'INFO') {
  try {
    await fs.mkdir(appDir, { recursive: true });
    await fs.appendFile(updateLogPath, updateLogLine(Date.now(), level, message), 'utf8');
    const stat = await fs.stat(updateLogPath).catch(() => null);
    if (stat && stat.size > UPDATE_LOG_MAX_BYTES * 1.5) {
      await fs.writeFile(updateLogPath, trimUpdateLog(await fs.readFile(updateLogPath, 'utf8'), UPDATE_LOG_MAX_BYTES), 'utf8');
    }
  } catch {}
}
// 预热失败以前同样只落在会被覆盖的 stdout/stderr 里，事后根本查不到「点了
// 为什么没反应」。单独留一份追加日志：决策、请求前后窗口时间、结果全记下。
const warmupLogPath = path.join(appDir, 'warmup.log');
function fmtWarmupClock(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '无';
  return new Date(value * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
async function appendWarmupLog(message, level = 'INFO') {
  try {
    await fs.mkdir(appDir, { recursive: true });
    await fs.appendFile(warmupLogPath, updateLogLine(Date.now(), level, message), 'utf8');
    const stat = await fs.stat(warmupLogPath).catch(() => null);
    if (stat && stat.size > UPDATE_LOG_MAX_BYTES * 1.5) {
      await fs.writeFile(warmupLogPath, trimUpdateLog(await fs.readFile(warmupLogPath, 'utf8'), UPDATE_LOG_MAX_BYTES), 'utf8');
    }
  } catch {}
}

async function loadUpdateFailure() {
  try { return JSON.parse(await fs.readFile(updateFailurePath, 'utf8')); } catch { return null; }
}
async function recordUpdateFailure(error, { from = APP_VERSION, to = '', stage = 'apply', attempts = 0 } = {}) {
  const record = updateFailureRecord(error, { at: Date.now(), from, to, stage, attempts });
  updateLastError = record;
  try { await fs.writeFile(updateFailurePath, JSON.stringify(record, null, 2), 'utf8'); } catch {}
  await appendUpdateLog(`更新失败 [${stage}] ${record.message}`, 'ERROR');
  return record;
}
async function clearUpdateFailure(message = '更新成功，已清除上次失败记录') {
  updateLastError = null;
  try { await fs.rm(updateFailurePath, { force: true }); } catch {}
  await appendUpdateLog(message);
}

async function fetchUpdateRelease(url, timeoutMs) {
  // 部分网络直连 api.github.com 不通而系统代理可用；Node 内置 fetch 不认系统代理，
  // 所以 fetch 失败后再用 Windows 自带 curl.exe 走系统代理/直连各试一次。
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `CodexCompanion/${APP_VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (fetchError) {
    const curlPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
    if (!(process.platform === 'win32' && existsSync(curlPath))) throw fetchError;
    const proxy = await browserSystemProxy();
    const argSets = proxy ? [['-x', proxy], []] : [[]];
    let lastError = fetchError;
    for (const extra of argSets) {
      try {
        const { stdout } = await execFileAsync(curlPath, [
          '-fsSL', '--connect-timeout', '10', '--max-time', String(Math.ceil(timeoutMs / 1000) + 5),
          '-A', `CodexCompanion/${APP_VERSION}`, '-H', 'accept: application/vnd.github+json',
          ...extra, url,
        ], { windowsHide: true, timeout: timeoutMs + 10000, maxBuffer: 1024 * 1024 });
        return JSON.parse(String(stdout).trim());
      } catch (error) { lastError = error; }
    }
    throw lastError;
  }
}

async function refreshUpdateRelease(force = false) {
  const fresh = updateCache.checkedAt && Date.now() - updateCache.checkedAt < updateCheckIntervalMs;
  if (!force && fresh && updateCache.release) return updateCache.release;
  try {
    const release = await fetchUpdateRelease(updateFeedUrl, 5000);
    const latest = normalizeVersion(release?.tag_name || release?.name || '');
    if (!updateCache.release || latest !== normalizeVersion(updateCache.release?.tag_name || '')) {
      await appendUpdateLog(`检查更新成功：最新 v${latest}（当前 v${APP_VERSION}）`);
    }
    updateCache = { checkedAt: Date.now(), release, summary: null, error: null };
    return release;
  } catch (error) {
    // Being offline or blocked must never be an error the user has to think about.
    const reason = humanError(error);
    updateCache = { ...updateCache, checkedAt: Date.now(), error: reason };
    await appendUpdateLog(`检查更新失败：${reason}`, 'WARN');
    return updateCache.release;
  }
}

// The badge has to answer from memory: /api/status is polled every few seconds
// by the widget and the page, and neither may wait on the network for it.
function cachedUpdateSummary() {
  if (!updateCache.release) return null;
  if (!updateCache.summary) updateCache.summary = summarizeRelease(updateCache.release, APP_VERSION);
  return updateCache.summary;
}

async function installDirWritable() {
  // 2 === W_OK. The installer lives under %LOCALAPPDATA%, so this is normally
  // true; a Program Files install needs the full installer instead.
  try { await fs.access(sourceDir, 2); return true; } catch { return false; }
}

let installWritableCache = { at: 0, value: true };
async function installDirWritableCached() {
  if (installWritableCache.at && Date.now() - installWritableCache.at < 10 * 60 * 1000) return installWritableCache.value;
  const value = await installDirWritable();
  installWritableCache = { at: Date.now(), value };
  return value;
}

// Windows tells us how long the mouse and keyboard have been untouched. That is
// the only reliable "is the human away" signal, and it decides whether a
// silent restart would interrupt anything.
const idleProbeScript = [
  "$ErrorActionPreference='Stop'",
  "$src='using System;using System.Runtime.InteropServices;public static class CCIdle{[StructLayout(LayoutKind.Sequential)]public struct LII{public uint cbSize;public uint dwTime;}[DllImport(\"user32.dll\")]static extern bool GetLastInputInfo(ref LII p);public static int Seconds(){LII i=new LII();i.cbSize=(uint)Marshal.SizeOf(i);if(!GetLastInputInfo(ref i))return -1;return (int)(((uint)Environment.TickCount-i.dwTime)/1000);}}'",
  'Add-Type -TypeDefinition $src',
  '[CCIdle]::Seconds()',
].join('; ');
let idleProbeCache = { at: 0, value: null };
async function systemIdleSeconds() {
  if (process.platform !== 'win32') return null;
  if (idleProbeCache.at && Date.now() - idleProbeCache.at < 30000) return idleProbeCache.value;
  let value = null;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', idleProbeScript], { timeout: 8000, windowsHide: true });
    const parsed = Number.parseInt(String(stdout).trim().split(/\r?\n/).pop(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) value = parsed;
  } catch (error) {
    if (!updateIdleErrorLogged) {
      updateIdleErrorLogged = true;
      console.error('[update] idle probe failed', humanError(error));
    }
  }
  idleProbeCache = { at: Date.now(), value };
  return value;
}

function activeTaskCount() {
  return [...tasks.values()].filter(task => ['starting', 'running', 'waiting_confirmation', 'retry_waiting'].includes(task.status)).length;
}

async function updateStatusPayload(force = false) {
  const release = await refreshUpdateRelease(force);
  const summary = summarizeRelease(release || {}, APP_VERSION);
  const writable = await installDirWritable();
  return {
    ...summary,
    mode: normalizeUpdateMode(config.updateMode),
    canApply: Boolean(summary.patch) && writable,
    checkedAt: updateCache.checkedAt,
    error: updateCache.error || null,
    lastError: updateLastError,
    logPath: updateLogPath,
    reason: !summary.available ? '' : (summary.requiresFullInstaller ? '这次更新包含依赖变化，需要下载完整安装包。' : (!writable ? '安装目录不可写，需要用安装包升级。' : '')),
  };
}

async function notifyOnceAboutUpdate(status) {
  if (!status.available) return;
  if (config.lastNotifiedUpdateVersion === status.latest) return;
  config.lastNotifiedUpdateVersion = status.latest;
  await saveConfig().catch(() => {});
  if (!status.canApply) {
    await notify(`有新版本 v${status.latest}（当前 v${status.current}）\n这次需要完整安装包，请打开 Companion 网页下载。`, { appName: 'Codex Companion' }).catch(() => {});
    return;
  }
  const size = `约 ${Math.max(1, Math.round((status.patch?.size || 0) / 1024))} KB`;
  const how = status.mode === 'auto'
    ? `空闲 ${Math.round(DEFAULT_IDLE_SECONDS / 60)} 分钟时会自动更新并重启；也可以点浮窗右上角的 ↑ 立即更新。`
    : `点浮窗右上角的 ↑ 立即更新（${size}），或打开网页点“立即更新”。`;
  await notify(`有新版本 v${status.latest}（当前 v${status.current}）\n${how}`, { appName: 'Codex Companion' }).catch(() => {});
}

// Runs on a timer: installs a known update once the machine is genuinely idle.
async function maybeAutoApplyUpdate(trigger = 'timer') {
  const mode = normalizeUpdateMode(config.updateMode);
  if (mode !== 'auto' || updateApplying) return;
  const summary = cachedUpdateSummary();
  if (!summary?.available) return;
  const base = {
    mode,
    available: true,
    canApply: Boolean(summary.patch) && await installDirWritableCached(),
    applying: updateApplying,
    runningTasks: activeTaskCount(),
    pendingApprovals: pendingApprovals.size,
  };
  // Cheap rejection first: with idleSeconds 0 the decision can only pass the
  // task/approval gates by answering 'user-active'. Anything else means blocked.
  const pre = idleUpdateDecision({ ...base, idleSeconds: 0 });
  if (!pre.apply && pre.reason !== 'user-active') {
    if (trigger === 'check') console.log(`[update] v${summary.latest} waits: ${pre.reason}`);
    return;
  }
  const decision = idleUpdateDecision({ ...base, idleSeconds: await systemIdleSeconds() });
  if (!decision.apply) {
    if (trigger === 'check') console.log(`[update] v${summary.latest} waits: ${decision.reason}`);
    return;
  }
  console.log(`[update] installing v${summary.latest} while idle`);
  await notify(`正在自动更新到 v${summary.latest}\n浮窗会重启，大约 10 秒后回来。`, { appName: 'Codex Companion' }).catch(() => {});
  await applyUpdate().catch(error => console.error('[update] auto install failed', humanError(error)));
}

async function downloadPatch(asset, target) {
  // 更新包在 GitHub 上。很多用户的网络直连 release 下载域名不通：系统代理、
  // 环境变量代理、直连、GitHub 接口下载、内置 fetch 依次都试一遍，每一路的
  // 结果都写进 update.log，失败后不用猜是哪一步断的。
  const curlPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  const useCurl = process.platform === 'win32' && existsSync(curlPath);
  const systemProxy = await browserSystemProxy();
  const envProxy = proxyFromEnv();
  const attempts = [];
  if (useCurl && systemProxy) attempts.push({ label: '系统代理', proxy: systemProxy });
  if (useCurl && envProxy && envProxy !== systemProxy) attempts.push({ label: '环境变量代理', proxy: envProxy });
  if (useCurl) attempts.push({ label: '直连', proxy: null });
  if (useCurl && asset.apiUrl) attempts.push({ label: 'GitHub 接口下载', proxy: systemProxy || envProxy || null, url: asset.apiUrl, api: true });
  attempts.push({ label: '内置下载', fetch: true });
  await appendUpdateLog(`开始下载补丁 ${asset.name}：${attempts.map(a => a.label).join(' / ')}；系统代理=${systemProxy || '无'}，环境变量代理=${envProxy || '无'}`);
  let lastError;
  for (const attempt of attempts) {
    try {
      const buffer = attempt.fetch
        ? await downloadPatchViaFetch(asset)
        : await downloadPatchViaCurl(curlPath, target, attempt.url || asset.url, attempt.proxy, attempt.api);
      if (asset.size && buffer.length !== asset.size) throw Error('更新包下载不完整');
      if (buffer.length > 64 * 1024 * 1024) throw Error('更新包体积异常，已停止');
      await fs.writeFile(target, buffer);
      await appendUpdateLog(`下载成功：${attempt.label}，${buffer.length} 字节`);
      return createHash('sha256').update(buffer).digest('hex');
    } catch (error) {
      lastError = error;
      const reason = humanError(error);
      console.error(`[update] patch download via ${attempt.label} failed:`, reason);
      await appendUpdateLog(`下载失败：${attempt.label} · ${reason}`, 'WARN');
    }
  }
  throw Error(`下载更新包失败（已试过 ${attempts.map(a => a.label).join('、')}）：${humanError(lastError)} 当前版本仍可正常使用，稍后会自动重试；也可以打开 Releases 页手动下载完整安装包。`);
}
function downloadPatchViaCurl(curlPath, target, url, proxy, api = false) {
  const args = ['-fsSL', '--retry', '1', '--connect-timeout', '8', '--max-time', '30', '-o', target, '-A', `CodexCompanion/${APP_VERSION}`];
  if (api) args.push('-H', 'accept: application/octet-stream');
  if (proxy) args.push('-x', proxy);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile(curlPath, args, { windowsHide: true, timeout: 70000, maxBuffer: 8192 }, error => {
      if (error) return reject(error);
      fs.readFile(target).then(resolve, reject);
    });
  });
}
async function downloadPatchViaFetch(asset) {
  const response = await fetch(asset.url, {
    headers: { 'user-agent': `CodexCompanion/${APP_VERSION}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`下载更新包失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function extractZip(zipPath, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  // Windows ships Expand-Archive with PowerShell 5.1, so no extra dependency.
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`,
  ], { timeout: 120000, windowsHide: true });
}

function validateUpdateManifest(manifest, expectedVersion) {
  if (!manifest || typeof manifest !== 'object') throw Error('更新清单无效。');
  if (normalizeVersion(manifest.version) !== normalizeVersion(expectedVersion)) throw Error('更新包版本与最新版本不一致，已停止。');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw Error('更新清单里没有文件。');
  if (manifest.files.length > 400) throw Error('更新清单文件数量异常，已停止。');
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file?.path)) throw Error(`更新清单包含非法路径：${file?.path}`);
    if (!/^[0-9a-f]{64}$/i.test(String(file?.sha256 || ''))) throw Error(`更新清单缺少校验值：${file?.path}`);
  }
  return manifest;
}

async function scheduleRestart(stageDir, targetVersion) {
  // The only sanctioned restart path is the scheduled task: it owns the process
  // tree, so the new backend survives this one exiting. The watchdog runs from
  // %TEMP% and rolls the files back if the new version never answers /api/health.
  const watchdog = path.join(sourceDir, 'Update Watchdog.ps1');
  if (!existsSync(watchdog)) return;
  const copy = path.join(stageDir, 'Update Watchdog.ps1');
  await fs.copyFile(watchdog, copy);
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', copy,
    '-InstallDir', sourceDir,
    '-TargetVersion', normalizeVersion(targetVersion),
    '-Port', String(config.port || 17841),
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function applyUpdate({ retry = false } = {}) {
  if (updateApplying) throw Error('更新正在进行中，请稍等。');
  let stageName = 'check';
  let target = '';
  updateApplying = true;
  try {
    const status = await updateStatusPayload(true);
    target = status.latest || '';
    if (!status.available) throw Error('当前已经是最新版本。');
    if (!status.patch) throw Error(status.reason || '这次更新需要下载完整安装包。');
    const stage = path.join(os.tmpdir(), 'CodexCompanionUpdate', `v${status.latest}-${Date.now()}`);
    await appendUpdateLog(`开始安装 v${status.latest}（当前 v${APP_VERSION}）${retry ? '· 自动重试' : '· 手动点击'}`);
    await fs.mkdir(stage, { recursive: true });
    const zipPath = path.join(stage, 'patch.zip');
    stageName = 'download';
    const actual = await downloadPatch(status.patch, zipPath);
    stageName = 'verify';
    if (status.patch.sha256 && actual !== status.patch.sha256) throw Error('更新包校验失败（SHA256 不一致），已停止。');
    await appendUpdateLog('补丁包 SHA256 校验通过');
    stageName = 'extract';
    const filesDir = path.join(stage, 'files');
    await extractZip(zipPath, filesDir);
    const manifest = validateUpdateManifest(
      JSON.parse(await fs.readFile(path.join(filesDir, UPDATE_MANIFEST_NAME), 'utf8')), status.latest);
    for (const file of manifest.files) {
      const bytes = await fs.readFile(path.join(filesDir, file.path));
      if (createHash('sha256').update(bytes).digest('hex') !== String(file.sha256).toLowerCase()) {
        throw Error(`文件校验失败：${file.path}`);
      }
    }
    const localPackage = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8'));
    if (manifest.depsFingerprint && manifest.depsFingerprint !== depsFingerprint(localPackage)) {
      throw Error('这次更新包含依赖变化，需要下载完整安装包。');
    }
    stageName = 'replace';
    await fs.rm(updateBackupDir, { recursive: true, force: true });
    await fs.mkdir(updateBackupDir, { recursive: true });
    const replaced = [];
    try {
      for (const file of manifest.files) {
        const target = path.join(sourceDir, file.path);
        if (existsSync(target)) {
          await fs.mkdir(path.dirname(path.join(updateBackupDir, file.path)), { recursive: true });
          await fs.copyFile(target, path.join(updateBackupDir, file.path));
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(filesDir, file.path), target);
        replaced.push(file.path);
      }
    } catch (error) {
      for (const relative of replaced) {
        const backup = path.join(updateBackupDir, relative);
        if (existsSync(backup)) await fs.copyFile(backup, path.join(sourceDir, relative)).catch(() => {});
      }
      throw Error(`替换文件失败，已还原：${humanError(error)}`);
    }
    stageName = 'restart';
    await fs.writeFile(updateStatePath, JSON.stringify({
      from: APP_VERSION, to: manifest.version, notes: status.notes,
      files: replaced, appliedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    await appendUpdateLog(`已替换 ${replaced.length} 个文件，调用重启看门狗`);
    await scheduleRestart(stage, manifest.version);
    return { ok: true, restarting: true, from: APP_VERSION, to: manifest.version };
  } catch (error) {
    await recordUpdateFailure(error, {
      from: APP_VERSION, to: target, stage: stageName,
      attempts: retry ? Number(updateLastError?.attempts || 0) + 1 : 0,
    });
    throw error;
  } finally {
    updateApplying = false;
  }
}

// Runs before anything else on boot: a finished update is confirmed and cleaned
// up, an unfinished one is rolled back so the app always starts on known files.
async function recoverUpdateState() {
  updateLastError = await loadUpdateFailure();
  if (!existsSync(updateStatePath)) {
    if (existsSync(updateBackupDir)) await fs.rm(updateBackupDir, { recursive: true, force: true }).catch(() => {});
    return;
  }
  try {
    const state = JSON.parse(await fs.readFile(updateStatePath, 'utf8'));
    if (normalizeVersion(state.to) === normalizeVersion(APP_VERSION)) {
      await fs.rm(updateStatePath, { force: true });
      await fs.rm(updateBackupDir, { recursive: true, force: true }).catch(() => {});
      console.log(`[update] applied v${state.from} -> v${state.to}`);
      await appendUpdateLog(`确认更新成功：v${state.from} -> v${state.to}`);
      await clearUpdateFailure(`更新到 v${APP_VERSION} 已确认成功，清除失败记录`);
      await notify(`已更新到 v${APP_VERSION}\n${state.notes || '常规修复与改进'}`, { appName: 'Codex Companion' }).catch(() => {});
      return;
    }
    for (const relative of Array.isArray(state.files) ? state.files : []) {
      if (!isSafeRelativePath(relative)) continue;
      const backup = path.join(updateBackupDir, relative);
      if (existsSync(backup)) await fs.copyFile(backup, path.join(sourceDir, relative)).catch(() => {});
    }
    await fs.rm(updateStatePath, { force: true });
    await fs.rm(updateBackupDir, { recursive: true, force: true }).catch(() => {});
    console.error(`[update] rolled back to v${APP_VERSION} (target was v${state.to})`);
    await recordUpdateFailure(Error('新版本启动后没有回应，更新已自动回滚。'), {
      from: state.from || APP_VERSION, to: state.to || '', stage: 'rollback',
      attempts: Number(updateLastError?.attempts || 0) + 1,
    });
    await notify(`更新到 v${state.to} 没有成功，已自动回滚到 v${APP_VERSION}。\n原因已写入更新日志，软件会自动重试；也可以在网页上点「立即更新」。`, { appName: 'Codex Companion' }).catch(() => {});
  } catch (error) {
    console.error('[update state]', error.message);
  }
}

async function main() {
  const storedConfig = await readJson(configPath);
  config = { ...defaultConfig, ...storedConfig };
  // Before anything else: confirm a finished in-place update, or undo a broken one.
  await recoverUpdateState();
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
  // 启动后检查一次 1455 端口：被 Windows 保留就自动修复（弹一次授权窗口），修一次永久生效。
  setTimeout(() => { repairLoginPort().catch(() => {}); }, 8000).unref?.();
  // Old isolated CODEX_HOME folders could not always be deleted while Codex
  // held sqlite handles. Sweep them once on startup (credentials wiped first),
  // then every run cleans up after itself so nothing accumulates again.
  setTimeout(() => {
    const roots = [path.join(appDir, 'native-usage'), path.join(appDir, 'native-warmup')];
    Promise.all(roots.map(root => sweepStaleHomes(root, { limit: 3000 })))
      .then(results => {
        const removed = results.reduce((sum, item) => sum + item.removed, 0);
        const wiped = results.reduce((sum, item) => sum + item.wiped, 0);
        if (removed || wiped) console.log(`[temp homes] 自动清理 ${removed} 个历史临时目录，抹掉 ${wiped} 份临时凭据`);
      })
      .catch(error => console.error('[temp homes]', error.message));
  }, 12000).unref?.();
  autoImportLocalAuth();
  // Pick up an account switch made in the Codex client without a restart.
  setInterval(autoImportLocalAuth, 5 * 60 * 1000).unref?.();
  // Update checks are lazy and quiet: the first one waits a minute so it never
  // delays startup, and a blocked network just leaves the badge hidden.
  setTimeout(() => {
    const checkUpdates = async () => {
      try {
        const status = await updateStatusPayload(true);
        await notifyOnceAboutUpdate(status);
        await maybeAutoApplyUpdate('check');
        // 上次点更新失败（多半是网络抖动）不用人再点一次：隔 10 分钟静默
        // 重试，最多 3 次；每次结果和原因都留在 update.log 里。
        const decision = updateRetryDecision({
          lastError: updateLastError, now: Date.now(),
          canApply: status.canApply, applying: updateApplying,
        });
        if (decision.retry && !updateRetryInFlight) {
          updateRetryInFlight = true;
          try {
            await appendUpdateLog(`上次更新失败，开始自动重试（第 ${Number(updateLastError?.attempts || 0) + 1} 次）`);
            const result = await applyUpdate({ retry: true });
            await appendUpdateLog(`自动重试安装成功 v${result.to}，准备重启`);
            setTimeout(() => process.exit(0), 1200).unref?.();
          } catch (error) {
            await appendUpdateLog(`自动重试仍失败：${humanError(error)}`, 'WARN');
          } finally { updateRetryInFlight = false; }
        }
      } catch (error) {
        await appendUpdateLog(`定时检查更新异常：${humanError(error)}`, 'WARN');
      }
    };
    checkUpdates();
    setInterval(checkUpdates, updateCheckIntervalMs).unref?.();
    // Idle is watched more often than the release feed: once a version is known
    // to exist, the only thing left to notice is the user walking away.
    setInterval(() => { maybeAutoApplyUpdate('idle').catch(() => {}); }, updateIdleProbeIntervalMs).unref?.();
  }, 60 * 1000).unref?.();
  // Keep the detected system proxy visible in /api/status, so a wrong VPN port
  // can be spotted without reproducing a network outage.
  readSystemProxy().then(proxy => { networkHealth = { ...networkHealth, proxy: proxy?.address || '' }; }).catch(() => {});
  startTaskEngine().catch(e => console.error('[task engine]', e.message));
  startFeishuLongConnection().catch(e => console.error('[feishu connection]', e.message));
  // Older versions silently dropped rich-text (image + text) Feishu messages.
  // Replay the newest one once after startup so it never has to be resent.
  setTimeout(() => { recoverUnansweredFeishuMessages().catch(e => console.error('[feishu recover]', e.message)); }, 20000).unref?.();
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
      const decision = stallNoticeDecision(t, { now: Date.now(), stallMinutes: Number(config.stallMinutes) || 3 });
      if (!decision.notify) continue;
      t.stallNotified = true;
      t.stallNotifiedAt = Date.now();
      t.stallFingerprint = decision.fingerprint;
      await notify(`Codex 任务长时间没有进展\n任务：${t.id}\n已无事件：${config.stallMinutes} 分钟\n\n${decision.body}\n${dashboardLink(`#task=${t.id}`)}`, { appName: 'Codex 任务', taskId: t.id });
    }
    if (Date.now() - lastAccountRefreshAt > config.quotaRefreshMinutes * 60000) {
      try { await refreshAccounts(); } catch (e) { console.error('[accounts]', e.message); }
    }
  }, 15000);
  process.on('SIGINT', () => { stopDesktopRetryWatcher(); codex.close(); try { codexSessionWatcher?.close(); } catch {} try { feishuWsClient?.close({ force: true }); } catch {} try { notificationDb?.close(); } catch {} server.close(); process.exit(0); });
}
main().catch(e=>{console.error(e);process.exit(1)});
