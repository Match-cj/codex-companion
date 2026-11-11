// Codex 5-hour quota windows are anchored to the first request, not to the
// clock: while no window is open nothing is counting down, and the first
// request starts a fresh 5-hour window. Once it is running the reset timestamp
// never moves for later requests -- so warming up an already-running window
// cannot change the reset time, it only burns a little quota. That is the only
// case where a warm-up is pointless; on an idle account it starts the window.
//
// Keep this module pure so both the server and its tests can reason about the
// decision without starting a Codex process.

function clock(seconds, now = Date.now()) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function windowStart(usage) {
  const resetAt = numberOrNull(usage?.primary_resets_at);
  if (!resetAt) return 0;
  const minutes = numberOrNull(usage?.primary_window_minutes) || 300;
  return resetAt - minutes * 60;
}

/**
 * Decide whether a warm-up is worth sending at all.
 * Returns { action: 'allow' | 'skip', reason, resetAt, startedAt, message }.
 */
export function warmupDecision(usage, { now = Date.now(), accountName = '' } = {}) {
  const nowSec = Math.floor(now / 1000);
  const resetAt = numberOrNull(usage?.primary_resets_at) || 0;
  const startedAt = windowStart(usage);
  const running = resetAt > nowSec + 30;
  const fiveHourUsed = numberOrNull(usage?.primary_used_percent);
  const weeklyUsed = numberOrNull(usage?.secondary_used_percent);
  const who = accountName ? `【${accountName}】` : '';
  const base = { resetAt, startedAt };

  if (Number.isFinite(weeklyUsed) && weeklyUsed >= 100) {
    return { ...base, action: 'skip', reason: 'weekly_exhausted', message: `${who}周额度已用完，预热已跳过（没消耗额度）。` };
  }
  if (usage && typeof usage.error === 'string' && usage.error.trim()) {
    return { ...base, action: 'skip', reason: 'usage_error', message: `${who}额度暂时读不到，预热已跳过；请先刷新额度再试。` };
  }
  if (running && Number.isFinite(fiveHourUsed) && fiveHourUsed >= 100) {
    return { ...base, action: 'skip', reason: 'five_hour_exhausted', message: `${who}5 小时额度已用完，${clock(resetAt, now)} 重置。预热发不出去，已跳过（没消耗额度）。` };
  }
  // A full quota with a future reset timestamp is contradictory: an idle
  // account has no countdown at all, so that timestamp is a leftover from an
  // older window (or the API is still showing a stale value). Do NOT skip here
  // -- this is exactly the case where the user clicked 预热 on a fresh account
  // and nothing happened. Send the request and verify the window afterwards.
  if (running && !(Number.isFinite(fiveHourUsed) && fiveHourUsed > 0)) {
    return {
      ...base,
      action: 'allow',
      reason: 'window_running_idle',
      message: `${who}额度是满的，但界面上还留着一个旧的窗口时间（${clock(resetAt, now)} 重置）。空账号本来不倒计时，所以这次会真的发一次最小请求，并核对 5 小时窗口有没有从现在开始。`,
    };
  }
  if (running) {
    return {
      ...base,
      action: 'skip',
      reason: 'window_running',
      message: `${who}5 小时窗口 ${clock(startedAt, now)} 开始 · ${clock(resetAt, now)} 重置。\n预热不能提前重置，已跳过（没消耗额度）。`,
    };
  }
  return {
    ...base,
    action: 'allow',
    reason: resetAt ? 'window_expired' : 'no_window',
    message: `${who}现在没有在计时的 5 小时窗口：不用就一直不开始，用一次才从这次请求开始倒数 5 小时。预热会启动新窗口。`,
  };
}

/** Truthful feedback after a real warm-up, using the freshly read window. */
export function describeWarmupWindow(usage, { now = Date.now(), name = '' } = {}) {
  const resetAt = numberOrNull(usage?.primary_resets_at) || 0;
  const who = name ? `${name} ` : '';
  if (!resetAt) return `${who}已发送最小预热请求；额度窗口时间还没读回来，稍后会自动刷新。`;
  const startedAt = windowStart(usage);
  return `${who}已发送最小请求。\n5 小时窗口 ${clock(startedAt, now)} 开始 · ${clock(resetAt, now)} 重置（从这次请求开始计时，不会因预热提前）。`;
}
