// Quota reading and warm-up for accounts held in Companion's own vault.
//
// Every read runs inside a throwaway Codex process with its own CODEX_HOME, so
// switching accounts never disturbs the user's real Codex session and the
// refreshed credentials can be written back safely.
//
// The module owns no Companion state. Everything it needs is injected by
// createNativeUsage(): paths, vault helpers, the live `accounts` list and the
// caches. That is what keeps this file movable and testable.
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { humanError } from './human-error.mjs';
import { codexLaunch } from './desktop-client.mjs';
import { decodeJwtPayload } from './auth-utils.mjs';

export class IsolatedUsageSession {
  constructor(home, { version = '', launch = codexLaunch } = {}) {
    this.home = home;
    this.version = version;
    this.launch = launch;
    this.proc = null;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this.nextId = 0;
    this.buffer = '';
  }
  async start() {
    const { command, args } = this.launch();
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
    await this.request('initialize', { clientInfo: { name: 'codex_companion_usage', title: 'Codex Companion Usage', version: this.version } }, 30000);
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

// The official rate-limit payload uses different names than the legacy shape
// the dashboard and notifications were built on; translate here.
export function officialUsageToLegacy(result) {
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

// Secrets must never appear in a command line. curl reads the headers from
// stdin instead, which is also why curl is preferred over fetch here.
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
export async function readResetCreditDetails(auth) {
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

// Companion state lives in server.mjs; pass it in and get the quota helpers
// back. Getters are used for `config`/`accounts` because both are reassigned
// when configuration reloads or accounts refresh.
export function createNativeUsage({
  appDir,
  nativeAccountsPath,
  version = '',
  readJson,
  atomicJsonWrite,
  unprotectCredential,
  upsertNativeAccount,
  updateNativeAccountMetadata,
  getConfig,
  getAccounts,
  refreshAccounts,
  nativeUsageCache,
  nativeUsageInFlight,
  nativeWarmupsInProgress,
} = {}) {
  async function nativeAccountEntry(id) {
    const vault = await readJson(nativeAccountsPath);
    const entry = Array.isArray(vault.accounts) ? vault.accounts.find(item => String(item.id) === String(id)) : null;
    if (!entry?.protected_auth) throw Error('原生账号库中没有这个账号的加密凭据。');
    return entry;
  }
  async function runIsolatedNativeWarmup(entry) {
    const root = path.join(appDir, 'native-warmup');
    const home = path.join(root, randomUUID());
    const session = new IsolatedUsageSession(home, { version });
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
      const publicAccount = getAccounts().find(item => String(item.id) === key);
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
    if (!force && cached && Date.now() - cached.at < 4 * 60 * 1000) return { ...cached.usage, cached: true };
    const root = path.join(appDir, 'native-usage');
    const home = path.join(root, randomUUID());
    const session = new IsolatedUsageSession(home, { version });
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
      const usage = { ...officialUsageToLegacy(result), observed_at: Date.now() / 1000 };
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
    const deletedKeys = new Set(Array.isArray(getConfig().deletedAccountKeys) ? getConfig().deletedAccountKeys.map(String) : []);
    const visibleEntries = vault.accounts.filter(entry => ![entry.id, entry.account_id, entry.email && String(entry.email).toLowerCase()]
      .filter(Boolean).some(key => deletedKeys.has(String(key))));
    const pairs = await Promise.all(visibleEntries.map(async entry => {
      try { return [String(entry.id), await readNativeUsage(entry, force)]; }
      catch (error) { return [String(entry.id), { error: humanError(error), usage_source: 'Companion 原生凭据' }]; }
    }));
    return new Map(pairs);
  }
  return { nativeAccountEntry, warmupNativeAccount, readNativeUsage, readNativeUsages, readNativeUsageOnce };
}
