// 使用一次「存起来的免费重置」：命令解析、选择与结果核对。
// 这里是纯函数，不碰网络、不碰凭据，方便单独测试。
// 兑换动作本身在 native-usage.mjs，飞书流程在 server.mjs。
import { roundRemaining, resetText } from './quota-facts.mjs';

export const RESET_CONFIRM_TTL_MS = 10 * 60 * 1000;

// 只认完整短句，避免把「这个按钮重置一下颜色」这类正常任务吃掉。
export function parseResetCommand(raw) {
  const text = String(raw || '').trim().replace(/[：:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/^(确认|确定|确认用重置|确定用重置|确认使用)$/.test(text)) return { action: 'confirm' };
  if (/^(取消|取消用重置|算了|不用了)$/.test(text)) return { action: 'cancel' };
  if (/^(重置次数|查重置|几次重置|重置查询)$/.test(text)) return { action: 'query' };
  const match = text.match(/^(用重置|使用重置|用掉重置|兑换重置|redeem)(?:\s+(.+))?$/i);
  if (match) return { action: 'redeem', targetName: (match[2] || '').trim() || null };
  return null;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function expiryMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function expiryText(value, now) {
  const ms = expiryMs(value);
  if (!ms) return '';
  const date = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 有多张卡时先花最快过期的那张。
export function selectResetCredit(credits, { now = Date.now() } = {}) {
  if (!Array.isArray(credits)) return null;
  const rows = credits.map(credit => ({
    id: String(credit?.id || credit?.creditId || credit?.credit_id || ''),
    status: String(credit?.status || 'available').toLowerCase(),
    expiresMs: expiryMs(credit?.expiresAt ?? credit?.expires_at ?? credit?.expires),
  })).filter(row => !row.status || row.status === 'available')
    .filter(row => row.expiresMs === null || row.expiresMs > now);
  rows.sort((a, b) => (a.expiresMs ?? Infinity) - (b.expiresMs ?? Infinity));
  return rows[0] || null;
}

// account/rateLimits/read 的原始结果 → 只需要这几个数，不把令牌带出去。
export function summarizeResetState(result) {
  const bucket = result?.rateLimitsByLimitId?.codex || result?.rateLimits || {};
  const creditsRoot = result?.rateLimitResetCredits || {};
  const count = numeric(creditsRoot?.availableCount ?? creditsRoot?.available_count);
  return {
    availableCount: count,
    credits: Array.isArray(creditsRoot?.credits) ? creditsRoot.credits : [],
    primaryUsed: numeric(bucket?.primary?.usedPercent ?? bucket?.primary?.used_percent),
    secondaryUsed: numeric(bucket?.secondary?.usedPercent ?? bucket?.secondary?.used_percent),
    primaryResetsAt: numeric(bucket?.primary?.resetsAt ?? bucket?.primary?.resets_at),
    secondaryResetsAt: numeric(bucket?.secondary?.resetsAt ?? bucket?.secondary?.resets_at),
  };
}

// 兑换是不可逆的：只承认看得到的变化，绝不把「请求发出去了」当成成功。
export function verifyResetRedemption(before = {}, after = {}) {
  const countBefore = numeric(before.availableCount);
  const countAfter = numeric(after.availableCount);
  const spent = countBefore !== null && countAfter !== null && countAfter < countBefore;
  const weeklyRecovered = numeric(before.secondaryUsed) !== null && numeric(after.secondaryUsed) !== null &&
    Number(after.secondaryUsed) + 1 < Number(before.secondaryUsed);
  const weeklyDeadlineMoved = numeric(before.secondaryResetsAt) !== null && numeric(after.secondaryResetsAt) !== null &&
    Math.abs(Number(after.secondaryResetsAt) - Number(before.secondaryResetsAt)) > 60;
  const ok = spent || weeklyRecovered || weeklyDeadlineMoved;
  const evidence = spent ? `可用次数 ${countBefore} → ${countAfter}`
    : weeklyRecovered ? `周额度已用 ${before.secondaryUsed}% → ${after.secondaryUsed}%`
      : weeklyDeadlineMoved ? '周额度自动回满时间已改变' : '';
  return {
    ok, spent, weeklyRecovered, weeklyDeadlineMoved, evidence,
    message: ok
      ? `已用掉一次重置，核对结果：${evidence}。`
      : '兑换请求已经发出，但没有读到额度或次数的变化，无法确认是否生效。别重复点，先到 Codex 的 /usage 里核对。',
  };
}

export function isPendingResetValid(pending, { now = Date.now() } = {}) {
  return Boolean(pending && pending.id && Number.isFinite(pending.at) && now - pending.at < RESET_CONFIRM_TTL_MS);
}

function accountLine(account) {
  const usage = account?.usage || {};
  const primary = roundRemaining(usage.primary_used_percent);
  const secondary = roundRemaining(usage.secondary_used_percent);
  const parts = [];
  if (primary !== null) parts.push(`5 小时剩 ${primary}%`);
  if (secondary !== null) parts.push(`周额度剩 ${secondary}%`);
  return parts.join(' · ') || '额度暂时没读到';
}

// 确认卡：把不可逆的代价一次讲清楚，不判断「划不划算」。
export function buildResetConfirmText({ name, account, credit, now = Date.now() } = {}) {
  const count = numeric(account?.reset_count);
  const creditExpiry = credit?.expiresMs ? expiryText(credit.expiresMs, now) : expiryText(account?.reset_credits_expires_at, now);
  const weeklyReset = account?.usage?.secondary_resets_at ? resetText(account.usage.secondary_resets_at, now) : '';
  const lines = [
    '准备用掉一次免费重置',
    `账号：${name}`,
    `现在：${accountLine(account)}`,
    `可用：${count === null ? '次数没读到' : `${count} 次`}${creditExpiry ? `（这张 ${creditExpiry} 到期）` : ''}`,
    '用完：两项额度立刻回满；周额度下次自动回满会改成从下一次提问起算 7 天' + (weeklyReset ? `（原定 ${weeklyReset} 那次不再来）` : ''),
    '这一步不能撤销。',
    '',
    '回复「确认」执行，回复「取消」放弃。10 分钟内有效。',
  ];
  return lines.join('\n');
}

export function buildResetQueryText(accounts, { now = Date.now() } = {}) {
  const rows = (Array.isArray(accounts) ? accounts : []).map(account => {
    const name = account?.display_name || account?.name || account?.email || String(account?.id || '账号');
    const mark = account?.is_active ? '●' : '○';
    const count = numeric(account?.reset_count);
    const expiry = expiryText(account?.reset_credits_expires_at, now);
    return `${mark} ${name}：${count === null ? '次数没读到' : `${count} 次`}${expiry ? ` · ${expiry} 到期` : ''}`;
  });
  return [
    '免费重置次数',
    rows.join('\n') || '还没有账号',
    '',
    '回复「用重置」或「用重置 账号名」用掉一次（会先让你确认）。',
  ].join('\n');
}

export function buildResetResultText({ name, verdict, before, after, uncertain = false } = {}) {
  if (uncertain) return `【${name}】兑换请求已发出，但没读到结果\n别重复点，先到 Codex 的 /usage 里核对次数和额度，确认没生效后再试一次。`;
  if (!verdict?.ok) return `【${name}】${verdict?.message || '没有确认到重置生效'}`;
  const secondary = roundRemaining(after?.secondaryUsed);
  const lines = [
    `【${name}】重置已用掉`,
    `核对：${verdict.evidence}`,
  ];
  if (secondary !== null) lines.push(`周额度现在剩 ${secondary}%`);
  lines.push('下次周额度自动回满：从你下一次提问起算 7 天。');
  return lines.join('\n');
}
