// Observe only fresh successful readings; callers keep cached/error data out.
// A percentage alone cannot distinguish a scheduled reset from an early reset.
export function observeEarlyQuotaReset(observations, key, { used, resetAt, observedAt }) {
  if (used == null || !Number.isFinite(Number(used)) || Number(used) < 0 || Number(used) > 100) return false;
  if (!Number.isFinite(observedAt) || observedAt <= 0) return false;
  const previous = observations[key];
  if (previous && typeof previous === 'object' && Number(previous.observedAt) >= observedAt) return false;
  const next = { used: Number(used), resetAt: Number.isFinite(Number(resetAt)) && Number(resetAt) > 0 ? Number(resetAt) : null, observedAt };
  observations[key] = next;
  // Legacy numeric baselines lack the old deadline: seed silently on upgrade.
  if (!previous || typeof previous !== 'object') return false;
  // One-minute tolerance avoids near-deadline clock/rounding noise. The OLD
  // deadline matters: the new one may already have rolled to next week.
  return Number(previous.used) > 0 && next.used === 0 &&
    Number.isFinite(previous.resetAt) && previous.resetAt > observedAt + 60;
}
