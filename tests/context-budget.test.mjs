import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTEXT_LEVELS, contextWarning, contextRatio, formatTokenCount, trimContextLedger } from '../context-budget.mjs';
import { notificationEnabled, notificationType, notificationRules } from '../notification-settings.mjs';

test('token counts read like a human wrote them', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(176432), '176k');
  assert.equal(formatTokenCount(200000), '200k');
  assert.equal(formatTokenCount(1500000), '1.5M');
});

test('ratio needs both a usage figure and a window', () => {
  assert.equal(contextRatio({}), 0);
  assert.equal(contextRatio({ inputTokens: 100 }), 0);
  assert.equal(contextRatio({ inputTokens: 100, contextWindow: 400 }), 0.25);
  assert.equal(contextRatio({ totalTokens: 50, contextWindow: 100 }), 0.5);
});

test('each conversation warns once per level, and compaction re-arms it', () => {
  const ledger = {};
  assert.equal(contextWarning(ledger, 't1', 0.6), 0);
  assert.equal(contextWarning(ledger, 't1', 0.72), 70);
  assert.equal(contextWarning(ledger, 't1', 0.74), 0);
  assert.equal(contextWarning(ledger, 't1', 0.88), 85);
  assert.equal(contextWarning(ledger, 't1', 0.9), 0);
  assert.equal(contextWarning(ledger, 't1', 0.96), 95);
  assert.equal(contextWarning(ledger, 't1', 1.2), 0);
  // A different conversation has its own ladder.
  assert.equal(contextWarning(ledger, 't2', 0.72), 70);
  // Compaction drops the ratio far below the first level: warn again later.
  assert.equal(contextWarning(ledger, 't1', 0.3), 0);
  assert.equal(ledger.t1, undefined);
  assert.equal(contextWarning(ledger, 't1', 0.72), 70);
});

test('levels stay configurable and a broken ratio never warns', () => {
  const ledger = {};
  assert.equal(contextWarning(ledger, 'x', 0.55, [50, 90]), 50);
  assert.equal(contextWarning(ledger, 'x', 0.95, [50, 90]), 90);
  assert.equal(contextWarning(ledger, 'y', NaN), 0);
  assert.equal(contextWarning(ledger, 'y', -1), 0);
  assert.equal(contextWarning(ledger, 'y', 0.99, []), 0);
  assert.deepEqual(CONTEXT_LEVELS, [70, 85, 95]);
});

test('the ledger keeps only the most recent entries', () => {
  const ledger = {};
  for (let index = 0; index < 10; index += 1) ledger[`t${index}`] = { level: 70, at: index };
  const trimmed = trimContextLedger(ledger, 3);
  assert.deepEqual(Object.keys(trimmed), ['t9', 't8', 't7']);
  const untouched = trimContextLedger({ a: { level: 70, at: 1 } }, 5);
  assert.deepEqual(Object.keys(untouched), ['a']);
  assert.deepEqual(trimContextLedger(null), {});
});

test('the warning text is recognised as its own notification type', () => {
  assert.ok(notificationRules.some(rule => rule.id === 'context_pressure'));
  assert.equal(notificationType('项目｜长对话\n\n上下文已用约 176k / 200k token（88%）\n\n建议…'), 'context_pressure');
  assert.equal(notificationEnabled({}, 'context_pressure'), true);
  assert.equal(notificationEnabled({ notificationTypes: { context_pressure: false } }, 'context_pressure'), false);
});

test('server wires the streak to the session monitor and defaults are safe', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /contextPressureLedger: \{\}/);
  assert.match(server, /async function maybeWarnContextPressure\(threadId\)/);
  assert.equal((server.match(/maybeWarnContextPressure\(threadId\)\.catch/g) || []).length, 2);
  assert.match(server, /notificationType: 'context_pressure'/);
});
