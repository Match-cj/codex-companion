// Tells a dead VPN/proxy apart from an expired login when quota reads fail.
//
// The raw error thrown by the isolated Codex process is not enough to know
// *why* the network failed, so probeNetwork() does a cheap, bounded diagnosis:
// proxy port first, then OpenAI reachability, then general internet. Nothing
// here blocks the UI; the caller runs it in the background and only on change.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LOGIN_PATTERN = /登录.*失效|重新登录|invalid refresh token|refresh token|token.{0,30}(expired|revoked)|token_expired|token_revoked|unauthorized|401\b/i;
const NETWORK_PATTERN = /failed to fetch codex rate limits|error sending request for url|额度刷新失败|网络连接失败|网络或系统代理|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|connection reset|socket hang up|timed out|timeout|超时|代理|网络/i;

// A short label is what the floating window and the webpage show. The hint is
// for the one-off notification, where a single sentence is worth more than a
// stack of technical details.
const STATES = {
  proxy_down: {
    label: 'VPN / 代理没连上 · 额度暂未更新',
    hint: '检测到系统代理端口没有响应，通常是 VPN 或代理软件退出了。',
  },
  offline: {
    label: '电脑断网了 · 额度暂未更新',
    hint: '这台电脑现在连不上外网。',
  },
  openai_blocked: {
    label: '连不上 OpenAI · 检查 VPN',
    hint: '外网是通的，但 OpenAI 额度接口连不上，通常是 VPN 线路掉了。',
  },
  upstream: {
    label: 'OpenAI 额度接口暂时没回应',
    hint: '网络是通的，是 OpenAI 额度接口这一刻没有正常返回。',
  },
};

export function classifyQuotaFailure(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'ok', network: false, label: '', hint: '' };
  if (LOGIN_PATTERN.test(text)) return { kind: 'login', network: false, label: '', hint: '' };
  if (NETWORK_PATTERN.test(text)) return { kind: 'network', network: true, label: '', hint: '' };
  return { kind: 'other', network: false, label: '', hint: '' };
}

export function networkStateText(state) {
  return STATES[state] || { label: '网络异常 · 额度暂未更新', hint: '额度读取因为网络原因失败了。' };
}

// "http://127.0.0.1:7890", "127.0.0.1:7890", "socks5=127.0.0.1:7890" all
// show up in the wild; all we need is a host and a port to connect to.
export function parseProxyUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const candidate = text.includes('=') ? text.split('=').pop() : text;
  const withScheme = /^\w+:\/\//.test(candidate) ? candidate : `http://${candidate}`;
  try {
    const url = new URL(withScheme);
    const port = Number(url.port) || (/^https/i.test(url.protocol) ? 443 : 80);
    if (!url.hostname || !Number.isFinite(port)) return null;
    return { host: url.hostname, port, address: `${url.hostname}:${port}` };
  } catch { return null; }
}

export async function readSystemProxy({ env = process.env, platform = process.platform, run = execFileAsync } = {}) {
  // Windows' system proxy is the one a VPN / proxy client actually writes.
  // Environment variables come second: AI sessions and CI often inject their
  // own HTTP_PROXY, which has nothing to do with the user's VPN port.
  if (platform === 'win32') {
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const enabled = await run('reg', ['query', key, '/v', 'ProxyEnable'], { windowsHide: true });
      if (/0x1/.test(String(enabled?.stdout || ''))) {
        const configured = await run('reg', ['query', key, '/v', 'ProxyServer'], { windowsHide: true });
        const match = String(configured?.stdout || '').match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
        const fromRegistry = match && parseProxyUrl(match[1].split(';')[0]);
        if (fromRegistry) return fromRegistry;
      }
    } catch {}
  }
  return parseProxyUrl(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = ok => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port, host); } catch { finish(false); }
  });
}

// curl.exe respects a proxy we pass explicitly, unlike Node's built-in fetch.
function curlProbe(url, { proxy, timeoutMs = 4500, curlPath }) {
  return new Promise(resolve => {
    const seconds = Math.max(2, Math.ceil(timeoutMs / 1000));
    const args = ['-s', '-o', os.devNull, '-w', '%{http_code}', '--connect-timeout', '3', '--max-time', String(seconds), '--noproxy', ''];
    if (proxy) args.push('--proxy', proxy.address);
    args.push(url);
    let stdout = '';
    let finished = false;
    const done = ok => { if (finished) return; finished = true; resolve(ok); };
    try {
      const child = spawn(curlPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.once('error', () => done(false));
      child.once('exit', () => done(Number(String(stdout).trim()) > 0));
    } catch { done(false); }
  });
}

// Any HTTP status (even 401) means the route works; only a transport failure
// counts as "cannot reach". This is deliberately not an authenticated call.
export async function probeNetwork({
  proxy,
  timeoutMs = 4500,
  httpGet,
  tcpProbe = probeTcp,
  curlPath = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
    : 'curl',
} = {}) {
  const activeProxy = proxy === undefined ? await readSystemProxy() : proxy;
  const get = httpGet || (url => curlProbe(url, { proxy: activeProxy, timeoutMs, curlPath }));
  if (activeProxy && !await tcpProbe(activeProxy.host, activeProxy.port, 1500)) {
    return { state: 'proxy_down', ...networkStateText('proxy_down'), proxy: activeProxy.address };
  }
  if (await get('https://chatgpt.com/backend-api/wham/usage')) {
    return { state: 'upstream', ...networkStateText('upstream'), proxy: activeProxy?.address || '' };
  }
  if (!await get('https://www.baidu.com')) {
    return { state: 'offline', ...networkStateText('offline'), proxy: activeProxy?.address || '' };
  }
  return { state: 'openai_blocked', ...networkStateText('openai_blocked'), proxy: activeProxy?.address || '' };
}

// One notification on the way down and one on the way back, never a stream of
// them while the VPN stays broken. `state` is intentionally coarse: the fine
// grained diagnosis lives in the status payload for the UI.
export function networkNoticeDecision(previous, degraded, now, minGapMs = 10 * 60 * 1000) {
  const wasDown = previous?.state === 'down';
  if (degraded) {
    if (wasDown && now - (previous.notifiedAt || 0) < minGapMs) {
      return { notice: null, state: 'down', notifiedAt: previous.notifiedAt || 0 };
    }
    return { notice: 'down', state: 'down', notifiedAt: now };
  }
  if (wasDown) return { notice: 'recovered', state: 'ok', notifiedAt: now };
  return { notice: null, state: 'ok', notifiedAt: previous?.notifiedAt || 0 };
}
