// 额度展示的「事实层」：只读数与时间，不判断浪不浪费、不建议任何动作。
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

// 以前只写「14:19 重置」，看不出是哪天。这里把日期算全，
// 具体显示「还剩多久」还是「几点重置」由前端决定，一次只显示一种。
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
  };
}
