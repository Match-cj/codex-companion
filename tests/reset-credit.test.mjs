import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseResetCommand, selectResetCredit, summarizeResetState, verifyResetRedemption,
  isPendingResetValid, buildResetConfirmText, buildResetQueryText, buildResetResultText,
  RESET_CONFIRM_TTL_MS,
} from '../reset-credit.mjs';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const native = fs.readFileSync(new URL('../native-usage.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('飞书口令只认完整短句，普通任务句子不会被吃掉', () => {
  assert.deepEqual(parseResetCommand('用重置'), { action: 'redeem', targetName: null });
  assert.deepEqual(parseResetCommand('使用重置 设计二组'), { action: 'redeem', targetName: '设计二组' });
  assert.deepEqual(parseResetCommand('兑换重置 品牌组'), { action: 'redeem', targetName: '品牌组' });
  assert.equal(parseResetCommand('重置次数')?.action, 'query');
  assert.equal(parseResetCommand('确认')?.action, 'confirm');
  assert.equal(parseResetCommand('确定')?.action, 'confirm');
  assert.equal(parseResetCommand('取消')?.action, 'cancel');
  assert.equal(parseResetCommand('把这个按钮重置一下颜色'), null);
  assert.equal(parseResetCommand('帮我用重置功能写个说明文档'), null);
  assert.equal(parseResetCommand('切换 设计二组'), null);
});

test('有多张卡时先花最快过期的，已用过和过期的都不选', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const credit = selectResetCredit([
    { id: 'late', status: 'available', expiresAt: '2026-12-12T00:00:00Z' },
    { id: 'used', status: 'redeemed', expiresAt: '2026-11-22T00:00:00Z' },
    { id: 'soon', status: 'available', expiresAt: '2026-12-01T00:00:00Z' },
    { id: 'expired', status: 'available', expiresAt: '2026-11-01T00:00:00Z' },
  ], { now });
  assert.equal(credit.id, 'soon');
  assert.equal(selectResetCredit(null, { now }), null);
  assert.equal(selectResetCredit([{ status: 'redeemed' }], { now }), null);
});

test('官方读数只提取必要字段，不把整包结果带出去', () => {
  const state = summarizeResetState({
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 38, resetsAt: 100 }, secondary: { usedPercent: 94, resetsAt: 900 } } },
    rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'a', status: 'available' }] },
  });
  assert.equal(state.availableCount, 2);
  assert.equal(state.primaryUsed, 38);
  assert.equal(state.secondaryUsed, 94);
  assert.equal(state.secondaryResetsAt, 900);
  assert.equal(state.credits.length, 1);
  assert.equal(summarizeResetState({}).availableCount, null);
});

test('兑换成功必须有看得见的变化；请求发出去不算成功', () => {
  const before = { availableCount: 2, secondaryUsed: 94, secondaryResetsAt: 900 };
  assert.equal(verifyResetRedemption(before, { availableCount: 1, secondaryUsed: 0, secondaryResetsAt: 1800 }).ok, true);
  assert.equal(verifyResetRedemption(before, { availableCount: 2, secondaryUsed: 0, secondaryResetsAt: 900 }).weeklyRecovered, true);
  assert.equal(verifyResetRedemption(before, { availableCount: 2, secondaryUsed: 94, secondaryResetsAt: 1800 }).weeklyDeadlineMoved, true);
  const failed = verifyResetRedemption(before, { ...before });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /别重复点/);
});

test('确认记录 10 分钟过期，且取出即删不留第二次扣减机会', () => {
  const now = 1_800_000_000_000;
  assert.equal(isPendingResetValid({ id: 'a', at: now }, { now: now + 1000 }), true);
  assert.equal(isPendingResetValid({ id: 'a', at: now }, { now: now + RESET_CONFIRM_TTL_MS + 1 }), false);
  assert.equal(isPendingResetValid(null, { now }), false);
  assert.match(server, /pendingResetRedemptions\.delete\(operator\);[\s\S]{0,160}正在为/);
  assert.match(server, /10 分钟/);
});

test('确认卡写清不可逆代价，但不替用户判断划不划算', () => {
  const text = buildResetConfirmText({
    name: '设计二组',
    account: {
      reset_count: 2,
      reset_credits_expires_at: '2026-12-01T00:00:00Z',
      usage: { primary_used_percent: 38, secondary_used_percent: 94, secondary_resets_at: 1764000000 },
    },
    credit: null,
    now: Date.parse('2026-11-21T12:00:00Z'),
  });
  assert.match(text, /设计二组/);
  assert.match(text, /2 次/);
  assert.match(text, /不能撤销/);
  assert.match(text, /确认/);
  assert.match(text, /7 天/);
  assert.doesNotMatch(text, /划算|浪费|建议|应该|最好/);
});

test('查询与结果文案只讲事实，不确定时明确要求先核对', () => {
  const query = buildResetQueryText([
    { display_name: '设计二组', is_active: true, reset_count: 2, reset_credits_expires_at: '2026-12-01T00:00:00Z' },
    { display_name: '品牌组', reset_count: 1, reset_credits_expires_at: '2026-12-12T00:00:00Z' },
  ], { now: Date.parse('2026-11-21T12:00:00Z') });
  assert.match(query, /● 设计二组：2 次/);
  assert.match(query, /○ 品牌组：1 次/);
  assert.match(query, /会先让你确认/);
  assert.match(buildResetResultText({ name: '设计二组', uncertain: true }), /别重复点/);
  assert.match(buildResetResultText({ name: '设计二组', verdict: verifyResetRedemption({ availableCount: 2 }, { availableCount: 1 }), before: {}, after: { secondaryUsed: 0 } }), /重置已用掉/);
});

test('走官方兑换方法，固定幂等键，超时不重试，结果靠重读额度核对', () => {
  assert.match(native, /account\/rateLimitResetCredit\/consume/);
  assert.match(native, /idempotencyKey, creditId/);
  assert.match(native, /summary|summarizeResetState/);
  assert.match(native, /verifyResetRedemption\(before, after\)/);
  assert.match(native, /uncertain = true; channel = 'app-server-uncertain'/);
  assert.doesNotMatch(native, /redeem_request_id.{0,80}retry/i);
});

test('没有自动兑换：只有人发口令才会触发，菜单与额度通知只加提示', () => {
  assert.match(server, /if \(await handleResetCreditCommand\(text, message, senderId\)\) return true/);
  assert.match(server, /handleFeishuControlCommand\(text, message, senderId\)/);
  assert.match(server, /用重置（用掉一次，会先让你确认）/);
  assert.match(server, /回复「用重置」：用掉一次免费重置（会先让你确认）/);
  assert.match(server, /data\.confirm!==true/);
  assert.doesNotMatch(server, /额度用尽.{0,60}redeemNativeReset/);
});

test('版本号四处一致', () => {
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  assert.equal(pkg.version, '1.0.62');
  assert.match(server, /const APP_VERSION = '1\.0\.62'/);
  assert.match(widget, /\$script:AppVersion='1\.0\.62'/);
});
