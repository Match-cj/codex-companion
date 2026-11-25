import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTEXT_LEVELS, contextWarning, contextRatio, contextStatsFromTokenInfo, formatTokenCount, trimContextLedger } from '../context-budget.mjs';
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
  // 累计字段再也不能当水位：它会被当成 0，绝不误报爆表。
  assert.equal(contextRatio({ totalTokens: 50, contextWindow: 100 }), 0);
});

// 可证伪验收：直接用 2026-11-25 真实会话抓到的 token_count 事件。
// 累计 2,156,549（401%）是当前水位 130,918（27.6%）的 16 倍——
// 旧代码读 total_token_usage 于是刚开一轮对话就喊"已贴上限"。
test('cumulative token usage never masquerades as current context water level', () => {
  const realEvent = {
    total_token_usage: {
      input_tokens: 2156549, cached_input_tokens: 2051712,
      output_tokens: 5942, total_tokens: 2162491,
    },
    last_token_usage: {
      input_tokens: 130918, cached_input_tokens: 119808,
      output_tokens: 189, total_tokens: 131107,
    },
    last_usage_includes_reasoning: true,
    model_context_window: 475000,
  };
  const stats = contextStatsFromTokenInfo(realEvent);
  assert.equal(stats.inputTokens, 130918);
  assert.equal(stats.contextWindow, 475000);
  const ratio = contextRatio(stats);
  // 旧代码这里会得到 2156549/475000 = 4.54（454%），触发 95% 档误报。
  assert.ok(ratio < 0.3, `当前水位应约 27.6%，实际 ${(ratio * 100).toFixed(1)}%`);
  assert.ok(Math.abs(ratio - 130918 / 475000) < 1e-9);
  // 新对话不该被任何档位命中。
  const ledger = {};
  assert.equal(contextWarning(ledger, 'fresh-thread', ratio), 0);
  assert.equal(formatTokenCount(stats.inputTokens), '131k');
});

test('missing current reading means unknown, never falls back to cumulative', () => {
  const cumulativeOnly = {
    total_token_usage: { input_tokens: 9999999, total_tokens: 10000000 },
    model_context_window: 475000,
  };
  const stats = contextStatsFromTokenInfo(cumulativeOnly);
  assert.equal(stats.inputTokens, 0);
  assert.equal(contextRatio(stats), 0);
  assert.equal(contextStatsFromTokenInfo(null).inputTokens, 0);
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

test('the handoff wording exists once and is reachable from both page and Feishu', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  assert.match(server, /export const HANDOFF_PROMPT = '/);
  assert.match(server, /HANDOFF_PROMPT_TEXT/);
  assert.match(server, /交接提示词/);
  assert.match(dashboard, /copyHandoffPrompt/);
  assert.match(dashboard, /HANDOFF_PROMPT_TEXT/);
  // The page must never be able to break on an unfilled placeholder.
  assert.match(dashboard, /typeof HANDOFF_PROMPT_TEXT==='string'/);
});

test('server wires the streak to the session monitor and defaults are safe', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /contextPressureLedger: \{\}/);
  assert.match(server, /async function maybeWarnContextPressure\(threadId\)/);
  assert.ok((server.match(/maybeWarnContextPressure\(threadId\)\.catch/g) || []).length >= 2);
  assert.match(server, /notificationType: 'context_pressure'/);
});
