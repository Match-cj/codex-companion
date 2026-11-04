// Desktop retry watcher: presses the Codex client's own retry button when the
// upstream model reports "at capacity". The watcher only ever touches a button
// named Retry inside the Codex/ChatGPT desktop window, so the conversation,
// model and context stay exactly where the user left them.
//
// Pure helpers live here so the behaviour can be tested without Windows UI
// automation; only start/stop spawns the PowerShell watcher.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const watcherScriptPath = path.join(sourceDir, 'Desktop Retry Watcher.ps1');
const WATCHED_PROCESS_PATTERN = 'codex|chatgpt|openai';
const RESTART_DELAY_MS = 10000;

const state = {
  supported: process.platform === 'win32',
  enabled: false,
  running: false,
  startedAt: 0,
  hits: 0,
  lastHitAt: 0,
  lastWindow: '',
  lastMethod: '',
  lastWindowState: '',
  skipped: 0,
  ignored: 0,
  lastIgnoredAt: 0,
  lastIgnoredWindow: '',
  lastIgnoredText: '',
  lastError: '',
};

// Timestamps of recent clicks so the dashboard can show the real workload
// ("how many retries happened in the last 10 minutes") instead of only a
// cumulative number since process start.
const hitTimes = [];
let stallNotifier = null;
let lastIgnoredNotifiedAt = 0;

export function setDesktopRetryNotifier(fn) {
  stallNotifier = typeof fn === 'function' ? fn : null;
}

function recordHit() {
  const now = Date.now();
  hitTimes.push(now);
  if (hitTimes.length > 1000) hitTimes.splice(0, hitTimes.length - 1000);
}

function recentHits(withinMs) {
  const now = Date.now();
  let count = 0;
  for (let i = hitTimes.length - 1; i >= 0; i--) {
    if (now - hitTimes[i] > withinMs) break;
    count++;
  }
  return count;
}

let child = null;
let restartTimer = null;

export function desktopRetrySupported() {
  return process.platform === 'win32';
}

export function desktopRetryEnabled(config = {}) {
  return desktopRetrySupported() && config.desktopRetryAutoClick === true;
}

// Auto takeover closes the desktop client and resumes the thread in the
// background. It must never run at the same time as the click-through watcher:
// the watcher exists precisely to keep the turn inside the desktop client.
export function desktopTakeoverAllowed(config = {}) {
  if (config.autoTakeoverDesktopTransient === false) return false;
  return !desktopRetryEnabled(config);
}

export function desktopRetryCooldownSeconds(config = {}) {
  const value = Number(config.desktopRetryCooldownSeconds);
  if (!Number.isFinite(value)) return 8;
  return Math.min(120, Math.max(3, Math.round(value)));
}

export function parseDesktopRetryLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('{')) return null;
  let payload;
  try { payload = JSON.parse(text); } catch { return null; }
  if (!payload || typeof payload.type !== 'string') return null;
  return payload;
}

export function desktopRetryState() {
  return {
    ...state,
    hitsLast10Minutes: recentHits(600000),
    hitsLast60Minutes: recentHits(3600000),
  };
}

export function applyDesktopRetryEvent(payload) {
  if (!payload) return desktopRetryState();
  if (payload.type === 'hit') {
    state.hits += 1;
    state.lastHitAt = Date.now();
    state.lastWindow = String(payload.window || '').slice(0, 80);
    state.lastMethod = String(payload.method || '').slice(0, 20);
    state.lastWindowState = String(payload.windowState || '').slice(0, 20);
    recordHit();
    return;
  }
  // "ignored" means a retry button was found but its error is not a capacity
  // problem (a retired model, a broken request...), so pressing it cannot
  // help. The watcher left it alone and tells the user once in a while.
  if (payload.type === 'ignored') {
    state.ignored += 1;
    state.lastIgnoredAt = Date.now();
    state.lastIgnoredWindow = String(payload.window || '').slice(0, 80);
    state.lastIgnoredText = String(payload.text || '').slice(0, 160);
    const now = Date.now();
    if (stallNotifier && now - lastIgnoredNotifiedAt > 600000) {
      lastIgnoredNotifiedAt = now;
      try { stallNotifier({ window: state.lastIgnoredWindow, text: state.lastIgnoredText }); } catch { }
    }
    return;
  }
  // "mouse" means the button refused UI Automation, so the pointer had to be
  // used (and restored). Worth showing: it is the only case that can disturb
  // the user, and it tells us the client changed its UI.
  if (payload.type === 'skipped') {
    state.skipped += 1;
    return;
  }
  if (payload.type === 'error') state.lastError = String(payload.message || '').slice(0, 200);
  return desktopRetryState();
}

export function startDesktopRetryWatcher(config = {}) {
  if (!desktopRetryEnabled(config)) return desktopRetryState();
  if (child) return desktopRetryState();
  state.enabled = true;
  state.lastError = '';
  try {
    const parentStartTime = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
    child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', watcherScriptPath,
      '-ParentPid', String(process.pid),
      '-ParentStartTime', parentStartTime,
      '-CooldownSeconds', String(desktopRetryCooldownSeconds(config)),
      '-ProcessPattern', WATCHED_PROCESS_PATTERN,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    state.lastError = String(error?.message || error).slice(0, 200);
    child = null;
    return desktopRetryState();
  }
  state.running = true;
  state.startedAt = Date.now();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) applyDesktopRetryEvent(parseDesktopRetryLine(line));
  });
  child.stderr.on('data', chunk => {
    const text = String(chunk).trim();
    if (text) state.lastError = text.slice(0, 200);
  });
  child.on('exit', () => {
    child = null;
    state.running = false;
    if (!state.enabled) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (state.enabled && !child) startDesktopRetryWatcher(config);
    }, RESTART_DELAY_MS);
    restartTimer.unref?.();
  });
  child.on('error', error => { state.lastError = String(error?.message || error).slice(0, 200); });
  return desktopRetryState();
}

export function stopDesktopRetryWatcher() {
  state.enabled = false;
  clearTimeout(restartTimer);
  restartTimer = null;
  if (!child) { state.running = false; return desktopRetryState(); }
  try { child.kill(); } catch {}
  child = null;
  state.running = false;
  return desktopRetryState();
}

// Called whenever the config changes: start, stop or restart the watcher so it
// always matches what the user selected.
export function syncDesktopRetryWatcher(config = {}) {
  const wanted = desktopRetryEnabled(config);
  state.enabled = wanted;
  if (!wanted) { stopDesktopRetryWatcher(); return desktopRetryState(); }
  const cooldown = desktopRetryCooldownSeconds(config);
  // The cooldown is passed on start, so a change needs a fresh watcher.
  if (child && state.lastCooldown !== cooldown) stopDesktopRetryWatcher();
  state.lastCooldown = cooldown;
  return startDesktopRetryWatcher(config);
}
