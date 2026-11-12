// 额度展示的「事实层」：只描述读数与时间，不判断浪不浪费、不建议任何动作。
// 后端算一次，浮窗与网页只读结果，避免两端各自取整、各自格式化再对不上。
// 全部是纯函数，时间由调用方注入，便于单测。

const pad2 = value => String(value).padStart(2, '0');

// 官方读数可能是小数；统一四舍五入，和客户端显示规则对齐。
// 例：已用 99.4% -> 剩余 1%，而不是截断成 0%。
export function roundRemaining(used) {
  if (used === null || used === undefined || used === '') return null;
  const value = Number(used);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - value)));
}

function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// 以前只写「14:19 重置」，看不出是哪天，两个重置时间根本没法比。
export function resetText(resetAt, now = Date.now()) {
  const seconds = Number(resetAt);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const dayDiff = Math.round((startOfDay(date.getTime()) - startOfDay(now)) / 86400000);
  if (dayDiff === 0) return `今天 ${clock}`;
  if (dayDiff === 1) return `明天 ${clock}`;
  if (dayDiff === -1) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

export function countdownText(resetAt, now = Date.now()) {
  const seconds = Number(resetAt) - now / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return '已重置';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${Math.max(1, minutes)}分`;
}

// 把两个重置点的差距摆出来即可，不预测「用不用得完」。
// 能不能用完取决于有没有活、网络稳不稳、活重不重，软件一个都不知道。
export function resetGapText(primaryReset, secondaryReset) {
  const primary = Number(primaryReset);
  const weekly = Number(secondaryReset);
  if (!Number.isFinite(primary) || !Number.isFinite(weekly) || primary <= 0 || weekly <= 0) return '';
  const diff = Math.abs(weekly - primary);
  if (diff < 1800) return '两次重置几乎同时 · 周额度整体重置时 5 小时额度一起清零';
  const days = Math.floor(diff / 86400);
  const hours = Math.round((diff % 86400) / 3600);
  const span = days > 0 ? (hours > 0 ? `约 ${days} 天 ${hours} 小时` : `约 ${days} 天`) : `约 ${hours} 小时`;
  return `两次重置相差${span} · 周额度整体重置时 5 小时额度一起清零`;
}

// 0% 到底还能不能跑一次：不猜，只提示可能失败。
export function zeroNote(remaining, label) {
  return remaining === 0 ? `${label}已见底，下一次请求可能失败` : '';
}

function slotFacts(usage, prefix, label, windowMinutes, now) {
  const used = usage?.[`${prefix}_used_percent`];
  const remaining = roundRemaining(used);
  const resetAt = Number(usage?.[`${prefix}_resets_at`]) || 0;
  const clock = resetText(resetAt, now);
  const startAt = resetAt - windowMinutes * 60;
  const lines = [];
  if (clock) {
    lines.push(`${label}窗口 ${resetText(startAt, now)} 开始 · ${clock} 重置`);
    lines.push(`还有 ${countdownText(resetAt, now)}`);
  }
  if (prefix === 'primary') {
    lines.push('固定窗口：期间的请求不会改变重置时间');
    lines.push('窗口空闲时不倒计时，第一次请求才开始计时');
  } else {
    lines.push('周额度整体重置时，5 小时额度会一起清零');
  }
  const note = zeroNote(remaining, label === '周' ? '周额度' : '5 小时额度');
  if (note) lines.push(note);
  return {
    used,
    remaining,
    resetAt,
    resetText: clock,
    countdown: countdownText(resetAt, now),
    windowText: lines.join('\n'),
    zeroNote: note,
  };
}

export function buildQuotaFacts(usage, now = Date.now()) {
  const value = usage || {};
  const primaryMinutes = Number(value.primary_window_minutes) > 0 ? Number(value.primary_window_minutes) : 300;
  const weeklyMinutes = Number(value.secondary_window_minutes) > 0 ? Number(value.secondary_window_minutes) : 10080;
  return {
    primary: slotFacts(value, 'primary', '5 小时', primaryMinutes, now),
    secondary: slotFacts(value, 'secondary', '周', weeklyMinutes, now),
    gapText: resetGapText(value.primary_resets_at, value.secondary_resets_at),
  };
}
