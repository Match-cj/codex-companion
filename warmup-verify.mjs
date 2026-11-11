// A warm-up used to be reported as successful as soon as the Codex turn
// completed -- the code never checked whether a 5-hour window actually
// started. If the account was showing a stale reset timestamp, the user saw
// "预热完成，窗口已开始计时" while nothing had moved. These pure helpers
// compare the window before and after and say what really happened.

function clock(seconds, now = Date.now()) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide whether a warm-up really opened a fresh 5-hour window.
 * Returns { started, reason, message, beforeResetAt, afterResetAt,
 *           resetAt, startedAt }.
 */
export function verifyWarmupWindow(before, after, { now = Date.now(), name = '' } = {}) {
  const nowSec = Math.floor(now / 1000);
  const beforeReset = numberOrNull(before?.primary_resets_at) || 0;
  const afterReset = numberOrNull(after?.primary_resets_at) || 0;
  const minutes = numberOrNull(after?.primary_window_minutes) || 300;
  const startedAt = afterReset ? afterReset - minutes * 60 : 0;
  const who = name ? `【${name}】` : '';
  const base = { beforeResetAt: beforeReset, afterResetAt: afterReset, resetAt: afterReset, startedAt };

  if (!afterReset) {
    return {
      ...base, started: false, reason: 'usage_unreadable',
      message: `${who}预热请求已发出，但额度时间还没读回来。稍后会自动刷新；这次结果已记入预热日志，不会假装成功。`,
    };
  }
  if (afterReset <= nowSec) {
    return {
      ...base, started: false, reason: 'usage_stale',
      message: `${who}预热请求已发出，读回来的还是上一次的旧额度（${clock(afterReset, now)} 已过）。稍后自动刷新即可看到新窗口；结果已记入预热日志。`,
    };
  }
  if (afterReset === beforeReset) {
    return {
      ...base, started: false, reason: 'window_unchanged',
      message: `${who}预热请求已发出，但 5 小时窗口没有从现在开始：重置时间仍是 ${clock(afterReset, now)}（预热前也是这个时间）。没有白白提前重置。常见原因是这个账号当时已经在计时、或这次请求没被计费；详情看预热日志，可稍后再试。`,
    };
  }
  return {
    ...base, started: true, reason: 'window_started',
    message: `${who}预热成功：5 小时窗口 ${clock(startedAt, now)} 开始 · ${clock(afterReset, now)} 重置（从这次请求开始计时）。`,
  };
}

export function isTransientWarmupError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /timeout|timed out|超时|etimedout|econn|enotfound|eai_again|fetch failed|network|网络|socket hang up|502|503|504/i.test(text);
}
