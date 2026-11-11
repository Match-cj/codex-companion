import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWarmupWindow, isTransientWarmupError } from '../warmup-verify.mjs';

const nowSec = 1_794_360_000;
const now = nowSec * 1000;
const HOUR = 3600;

test('a changed reset timestamp means the window really started', () => {
  const before = { primary_resets_at: nowSec - 600, primary_window_minutes: 300 };
  const after = { primary_resets_at: nowSec + 5 * HOUR, primary_window_minutes: 300 };
  const verdict = verifyWarmupWindow(before, after, { now, name: '品牌组' });
  assert.equal(verdict.started, true);
  assert.equal(verdict.reason, 'window_started');
  assert.equal(verdict.startedAt, nowSec);
  assert.equal(verdict.beforeResetAt, before.primary_resets_at);
  assert.equal(verdict.afterResetAt, after.primary_resets_at);
  assert.match(verdict.message, /预热成功/);
  assert.match(verdict.message, /品牌组/);
});

test('full quota with an unchanged stale reset is never reported as success', () => {
  const stale = nowSec + 3 * HOUR;
  const before = { primary_used_percent: 0, primary_resets_at: stale, primary_window_minutes: 300 };
  const verdict = verifyWarmupWindow(before, { ...before }, { now, name: '品牌组' });
  assert.equal(verdict.started, false);
  assert.equal(verdict.reason, 'window_unchanged');
  assert.match(verdict.message, /没有从现在开始/);
  assert.match(verdict.message, /没有白白提前重置/);
  assert.match(verdict.message, /预热日志/);
});

test('stale or unreadable usage is reported honestly', () => {
  const before = { primary_resets_at: 0 };
  const unreadable = verifyWarmupWindow(before, { primary_resets_at: 0 }, { now });
  assert.equal(unreadable.started, false);
  assert.equal(unreadable.reason, 'usage_unreadable');
  assert.match(unreadable.message, /不会假装成功/);
  const old = { primary_resets_at: nowSec - 3600, primary_window_minutes: 300 };
  const stale = verifyWarmupWindow(before, old, { now });
  assert.equal(stale.reason, 'usage_stale');
  assert.match(stale.message, /旧额度/);
});

test('transient network errors get a friendlier hint', () => {
  assert.equal(isTransientWarmupError(Error('fetch failed')), true);
  assert.equal(isTransientWarmupError(Error('预热请求超时')), true);
  assert.equal(isTransientWarmupError(Error('ECONNRESET')), true);
  assert.equal(isTransientWarmupError(Error('账号凭据不完整，无法预热。')), false);
});
