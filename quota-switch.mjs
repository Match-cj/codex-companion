// 额度用尽后的账号接力：识别失败原因、挑一个还有额度的账号、解析飞书指令。
// 全部是纯函数，便于单测覆盖。
import { roundRemaining } from './quota-facts.mjs';

// Codex 在额度耗尽时给出的提示五花八门（桌面端 / CLI / API），这里统一定义。
const QUOTA_EXHAUSTED_PATTERNS = [
  /hit your usage limit/i,
  /usage limit (?:has been )?reached/i,
  /exceeded your current quota/i,
  /purchase more credits/i,
  /insufficient[_\s]?quota/i,
  /run out of credits|out of credits/i,
  /额度已用尽|用量已达上限|额度不足/,
];

export function isQuotaExhaustedText(text) {
  const value = String(text || '');
  if (!value) return false;
  return QUOTA_EXHAUSTED_PATTERNS.some(pattern => pattern.test(value));
}

// 返回剩余百分比；未知一律给 null，绝不把“读不到”当成“有额度”。
// 和浮窗/网页/客户端统一用四舍五入，避免 99.4% 被截断成 0% 而客户端显示 1%。

export function quotaLeft(account) {
  const usage = account?.usage || {};
  return {
    primary: roundRemaining(usage.primary_used_percent),
    weekly: roundRemaining(usage.secondary_used_percent),
  };
}

export function quotaLeftText(account) {
  const { primary, weekly } = quotaLeft(account);
  const parts = [];
  parts.push(primary === null ? '5 小时额度未知' : `5 小时剩 ${Math.round(primary)}%`);
  if (weekly !== null) parts.push(`周额度剩 ${Math.round(weekly)}%`);
  return parts.join(' · ');
}

// 挑一个能立刻干活的账号：5 小时额度和周额度都必须还有。
// 周额度读不到时只影响排序、不直接淘汰；但周额度明确见底的账号切过去照样失败，必须排除。
export function pickQuotaSwitchTarget(accounts, activeId) {
  const list = Array.isArray(accounts) ? accounts : [];
  const candidates = list
    .filter(account => account && String(account.id) !== String(activeId || ''))
    .map(account => ({ account, left: quotaLeft(account) }))
    .filter(item => item.left.primary !== null && item.left.primary > 0)
    .filter(item => item.left.weekly === null || item.left.weekly > 0)
    .sort((a, b) => {
      const weeklyA = a.left.weekly === null ? 100 : a.left.weekly;
      const weeklyB = b.left.weekly === null ? 100 : b.left.weekly;
      if (b.left.primary !== a.left.primary) return b.left.primary - a.left.primary;
      return weeklyB - weeklyA;
    });
  return candidates.length ? candidates[0].account : null;
}

export function accountMatchKey(account) {
  return [account?.display_name, account?.name, account?.email, account?.alias]
    .filter(Boolean).map(value => String(value).trim().toLowerCase());
}

// 按名字找账号：先精确匹配，再模糊包含。找不到返回 null，调用方要如实回复，不猜。
export function findAccountByName(accounts, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const list = Array.isArray(accounts) ? accounts : [];
  const exact = list.find(account => accountMatchKey(account).includes(wanted));
  if (exact) return exact;
  const partial = list.filter(account => accountMatchKey(account).some(key => key.includes(wanted) || wanted.includes(key)));
  return partial.length === 1 ? partial[0] : null;
}

// 飞书指令解析。返回 null 表示这条消息不是账号指令。
export function parseSwitchCommand(text) {
  const command = String(text || '').trim().replace(/[：:]/g, ' ').replace(/\s+/g, ' ');
  if (!command) return null;
  const autoSwitch = command.match(/^(?:自动切换|自动换号|额度用尽自动切换)\s*(开启|打开|开|on|关闭|关|off)?$/i);
  if (autoSwitch) {
    const value = String(autoSwitch[1] || '').toLowerCase();
    if (!value) return { action: 'auto-status' };
    return { action: 'auto-toggle', enabled: ['开启', '打开', '开', 'on'].includes(value) };
  }
  if (/^(?:账号|账号列表|账户|accounts?)$/i.test(command)) return { action: 'accounts' };
  // 口语里“切换 / 切换账号 / 切换账号并继续 / 换到品牌组 / 切 品牌组 继续”都是一个意思：
  // 换到有额度的账号并把这个对话接着跑下去。这里统一收敛成同一条指令。
  const switching = command.match(/^(?:切换|切|换号|换到|切到|切换到)\s*(.*)$/);
  if (!switching) return null;
  let rest = String(switching[1] || '').trim();
  let continueAfter = true;
  if (/不继续$/.test(rest)) {
    continueAfter = false;
    rest = rest.replace(/\s*不继续$/, '').trim();
  } else {
    // 尾部的“并继续 / 继续 / 接着干 / 然后继续”只是强调要接着跑，不是账号名。
    rest = rest.replace(/\s*(?:并继续|继续|接着干|然后继续|继续任务|接着跑)$/, '').trim();
  }
  // “切换到 品牌组”“切到品牌组”“换到账号 品牌组”这类口语也要认。
  rest = rest.replace(/^到\s*/, '').replace(/^(?:账号|账户)\s*/, '').replace(/\s*(?:账号|账户)$/, '').trim();
  // 只说了“切换账号/这个账号/其它账号”的，等于让系统自己挑。
  if (/^(?:这个|那个|其它|其他|别的|另一个)?账号$/.test(rest)) rest = '';
  return { action: 'switch', targetName: rest, continueAfter };
}
