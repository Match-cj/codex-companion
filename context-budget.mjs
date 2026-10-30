// Context water level.
//
// A long Codex conversation keeps growing: every retry re-sends the whole
// transcript, and once the window fills up the client starts compacting, which
// is exactly where "stream disconnected while compacting" comes from. Warning
// once per conversation per level is enough; compacting (or a new conversation)
// naturally drops the ratio and re-arms the warning.

export const CONTEXT_LEVELS = [70, 85, 95];

export function formatTokenCount(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return `${Math.round(number / 100000) / 10}M`;
  if (number >= 1000) return `${Math.round(number / 1000)}k`;
  return String(Math.round(number));
}

export function contextRatio(stats = {}) {
  const used = Number(stats.inputTokens || stats.totalTokens || 0);
  const limit = Number(stats.contextWindow || 0);
  if (!(used > 0) || !(limit > 0)) return 0;
  return used / limit;
}

// Returns the level to warn about, or 0. Mutates `ledger` (a plain object).
// `ledger[threadId] = { level, at }` records the highest level already sent.
export function contextWarning(ledger, key, ratio, levels = CONTEXT_LEVELS) {
  const percent = Math.round(Number(ratio || 0) * 100);
  const sorted = [...levels].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const store = ledger && typeof ledger === 'object' ? ledger : {};
  if (percent < sorted[0]) {
    // Conversation was compacted or restarted: re-arm the whole ladder.
    if (store[key]) delete store[key];
    return 0;
  }
  const reached = [...sorted].reverse().find(level => percent >= level) || 0;
  if (!reached) return 0;
  const previous = Number(store[key]?.level || 0);
  if (reached <= previous) return 0;
  store[key] = { level: reached, at: Date.now() };
  return reached;
}

export function trimContextLedger(ledger, limit = 100) {
  const entries = Object.entries(ledger && typeof ledger === 'object' ? ledger : {});
  if (entries.length <= limit) return Object.fromEntries(entries);
  entries.sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));
  return Object.fromEntries(entries.slice(0, limit));
}
