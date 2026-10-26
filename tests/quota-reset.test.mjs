import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { observeEarlyQuotaReset } from '../quota-reset.mjs';
import { notificationEnabled, resetReminderLeads, nextResetReminder } from '../notification-settings.mjs';

const now = 1800000000;
test('early reset uses previous deadline, not rolled new deadline, and deduplicates persisted snapshots', () => {
  const state = {};
  assert.equal(observeEarlyQuotaReset(state, 'account:week', { used: 34, resetAt: now + 86400, observedAt: now }), false);
  const restarted = JSON.parse(JSON.stringify(state));
  assert.equal(observeEarlyQuotaReset(restarted, 'account:week', { used: 0, resetAt: now + 604800, observedAt: now + 300 }), true);
  assert.equal(observeEarlyQuotaReset(restarted, 'account:week', { used: 0, resetAt: now + 604800, observedAt: now + 600 }), false);
  assert.equal(observeEarlyQuotaReset(restarted, 'account:week', { used: 80, resetAt: now + 86400, observedAt: now - 1 }), false);
  assert.equal(restarted['account:week'].used, 0);
});
test('scheduled reset and near-deadline readings never produce full-reset alerts', () => {
  for (const offset of [30, 60, 61, 300]) {
    const state = {};
    observeEarlyQuotaReset(state, 'week', { used: 80, resetAt: now + offset, observedAt: now });
    assert.equal(observeEarlyQuotaReset(state, 'week', { used: 0, resetAt: now + 604800, observedAt: now + offset }), false);
  }
  const state = { week: { used: 30, resetAt: now + 30, observedAt: now - 1 } };
  assert.equal(observeEarlyQuotaReset(state, 'week', { used: 0, resetAt: now + 604800, observedAt: now }), false);
});
test('first full snapshot, legacy baseline, missing deadline and partial recovery stay silent', () => {
  assert.equal(observeEarlyQuotaReset({}, 'week', { used: 0, resetAt: now + 86400, observedAt: now }), false);
  assert.equal(observeEarlyQuotaReset({ week: 30 }, 'week', { used: 0, resetAt: now + 86400, observedAt: now }), false);
  assert.equal(observeEarlyQuotaReset({ week: { used: 20, resetAt: null, observedAt: now - 10 } }, 'week', { used: 0, observedAt: now }), false);
  assert.equal(observeEarlyQuotaReset({ week: { used: 60, resetAt: now + 86400, observedAt: now - 10 } }, 'week', { used: 5, observedAt: now }), false);
});

function notifier() {
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  let clock = now;
  class FakeDate extends Date { static now() { return clock * 1000; } }
  const c = { Date: FakeDate, accounts: [], config: { resetReminderMinutes: 15 }, quotaNotifierState: new Map(), subscriptionNotifierState: new Map(),
    observeEarlyQuotaReset, notificationEnabled, resetReminderLeads, nextResetReminder, notices: [], saveConfig: async () => {}, sentQuotaNoticeToday: () => false, dashboardLink: () => '',
    quotaLabel: minutes => minutes === 10080 ? '周额度' : '5 小时额度', notify: async text => { c.notices.push(text); return { ok: true }; } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('async function checkQuotaNotices('), source.indexOf('function activeQuotaSnapshot(')), c);
  c.tick = value => { clock = value; };
  c.account = (id, used, resetAt, extra = {}) => ({ id, name: '测试账号', usage: { primary_used_percent: used, primary_window_minutes: 10080, primary_resets_at: resetAt, observed_at: clock, ...extra } });
  return c;
}
test('notifier coalesces early resets and ignores cached/error snapshots', async () => {
  const c = notifier();
  c.accounts = [c.account('A', 40, now + 86400), c.account('B', 60, now + 86400)];
  await c.checkQuotaNotices();
  c.tick(now + 300);
  c.accounts = [c.account('A', 0, now + 604800, { cached: true }), c.account('B', 0, now + 604800, { error: 'temporary failure' })];
  await c.checkQuotaNotices();
  assert.equal(c.notices.length, 0);
  c.accounts = [c.account('A', 0, now + 604800), c.account('B', 0, now + 604800)];
  await c.checkQuotaNotices();
  assert.equal(c.notices.length, 1);
  assert.match(c.notices[0], /提前恢复至 100%/);
  assert.equal((c.notices[0].match(/剩余 100%/g) || []).length, 2);
  await c.checkQuotaNotices();
  assert.equal(c.notices.length, 1);
});
test('normal scheduled expiry preserves upcoming reminder only', async () => {
  const c = notifier();
  c.accounts = [c.account('A', 40, now + 600)];
  await c.checkQuotaNotices();
  assert.equal(c.notices.length, 1);
  assert.match(c.notices[0], /即将重置/);
  c.tick(now + 601);
  c.accounts = [c.account('A', 0, now + 604800)];
  await c.checkQuotaNotices();
  assert.equal(c.notices.length, 1);
});
