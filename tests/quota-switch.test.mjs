import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isQuotaExhaustedText,
  quotaLeft,
  quotaLeftText,
  pickQuotaSwitchTarget,
  findAccountByName,
  parseSwitchCommand,
} from '../quota-switch.mjs';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');

test('real Codex quota-exhausted wording is recognised, ordinary failures are not', () => {
  // 2026-11-07 用户真实报错原文
  assert.equal(isQuotaExhaustedText("You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:35 AM."), true);
  assert.equal(isQuotaExhaustedText('exceeded your current quota'), true);
  assert.equal(isQuotaExhaustedText('额度已用尽'), true);
  assert.equal(isQuotaExhaustedText('429 Too Many Requests'), false);
  assert.equal(isQuotaExhaustedText('selected model is at capacity'), false);
  assert.equal(isQuotaExhaustedText(''), false);
});

test('switch target prefers an account whose 5-hour window still has room', () => {
  const accounts = [
    { id: 'A', display_name: '设计二组', usage: { primary_used_percent: 100, secondary_used_percent: 46 } },
    { id: 'B', display_name: '品牌组', usage: { primary_used_percent: 7, secondary_used_percent: 1 } },
    { id: 'C', display_name: '备用', usage: { primary_used_percent: 60, secondary_used_percent: 90 } },
    { id: 'D', display_name: '未知额度', usage: {} },
  ];
  assert.equal(pickQuotaSwitchTarget(accounts, 'A').display_name, '品牌组');
  // 读不到额度不能当成“有额度”，永远不自动选它。
  assert.equal(pickQuotaSwitchTarget([accounts[0], accounts[3]], 'A'), null);
  // 当前账号自己不算候选。
  assert.equal(pickQuotaSwitchTarget([accounts[1]], 'B'), null);
  assert.deepEqual(quotaLeft(accounts[0]), { primary: 0, weekly: 54 });
  assert.match(quotaLeftText(accounts[0]), /5 小时剩 0%/);
});

test('account lookup is exact first then unique fuzzy, and refuses ambiguity', () => {
  const accounts = [
    { id: 'A', display_name: '设计二组', name: 'mrk44444@163.com' },
    { id: 'B', display_name: '品牌组', name: 'brand@x.com' },
    { id: 'C', display_name: '品牌组 2', name: 'brand2@x.com' },
  ];
  assert.equal(findAccountByName(accounts, '设计二组').id, 'A');
  assert.equal(findAccountByName(accounts, 'mrk44444').id, 'A');
  assert.equal(findAccountByName(accounts, '品牌组').id, 'B');
  assert.equal(findAccountByName(accounts, '不存在'), null);
  // “品牌”同时命中两个账号时必须返回 null，宁可问一句也不乱切。
  assert.equal(findAccountByName(accounts, '品牌'), null);
});

test('Feishu commands cover switch, specified switch, auto toggle and account list', () => {
  assert.deepEqual(parseSwitchCommand('切换'), { action: 'switch', targetName: '', continueAfter: true });
  assert.deepEqual(parseSwitchCommand('切换 品牌组'), { action: 'switch', targetName: '品牌组', continueAfter: true });
  assert.deepEqual(parseSwitchCommand('切到品牌组 不继续'), { action: 'switch', targetName: '品牌组', continueAfter: false });
  assert.deepEqual(parseSwitchCommand('自动切换 开启'), { action: 'auto-toggle', enabled: true });
  assert.deepEqual(parseSwitchCommand('自动切换 关闭'), { action: 'auto-toggle', enabled: false });
  assert.deepEqual(parseSwitchCommand('自动切换'), { action: 'auto-status' });
  assert.deepEqual(parseSwitchCommand('账号'), { action: 'accounts' });
  assert.deepEqual(parseSwitchCommand('切换这个按钮的颜色'), { action: 'switch', targetName: '这个按钮的颜色', continueAfter: true });
  // 这类长句不能被当成指令吃掉：服务端用“短句或命中账号名”做二次过滤。
  assert.match(server, /shortEnough/);
  assert.match(server, /mentionsKnownAccount/);
});

test('failure path asks before switching by default and can switch automatically', () => {
  assert.match(server, /autoSwitchAccountOnQuotaExhausted: false/);
  assert.match(server, /handleQuotaExhaustedFailure\(task/);
  assert.match(server, /return「切换」|回复「切换」/);
  assert.match(server, /switchCount < 3/);
  assert.match(server, /performQuotaSwitch/);
  assert.match(server, /isQuotaExhaustedText\(`\$\{turnError\}\\n\$\{finalText\}`\)/);
});

test('every spoken form of “switch and continue” means the same thing', () => {
  // 用户明确要求：切换 / 切换账号 / 切换账号并继续 都能换号并继续，不用背口令。
  for (const text of ['切换', '切换账号', '切换账号并继续', '切换 并继续', '换号', '换到账号']) {
    assert.deepEqual(parseSwitchCommand(text), { action: 'switch', targetName: '', continueAfter: true }, text);
  }
  assert.deepEqual(parseSwitchCommand('切换 品牌组 并继续'), { action: 'switch', targetName: '品牌组', continueAfter: true });
  assert.deepEqual(parseSwitchCommand('切换账号 品牌组 继续'), { action: 'switch', targetName: '品牌组', continueAfter: true });
  assert.deepEqual(parseSwitchCommand('换到 品牌组'), { action: 'switch', targetName: '品牌组', continueAfter: true });
  assert.deepEqual(parseSwitchCommand('切换账号 不继续'), { action: 'switch', targetName: '', continueAfter: false });
  // 账号名里不会出现“并继续/继续”，这些尾巴必须被吃掉。
  assert.deepEqual(parseSwitchCommand('切到品牌组 继续'), { action: 'switch', targetName: '品牌组', continueAfter: true });
});

test('continuing after a switch never depends on the in-memory task table', () => {
  // 2026-11-07 真实故障：额度用尽后软件重启过，回「切换」时内存任务表已清空，
  // 于是虽然换号成功却报“没识别到要接力的对话”。续跑只能依赖对话 id。
  assert.doesNotMatch(server, /const task = tasks\.get\(String\(taskId\)\);\s*\n\s*if \(!task\) return/);
  assert.match(server, /function continuationThreadCandidates\(preferred\)/);
  assert.match(server, /function rememberActiveThread\(threadId\)/);
  assert.match(server, /config\.lastActiveThreadId = id;/);
  assert.match(server, /rememberActiveThread\(id\);/, 'turn/completed 要记录最近对话');
  assert.match(server, /rememberActiveThread\(threadId\);/, '手动续跑要记录最近对话');
  // 猜的对话要如实告诉用户，不能装作一切正常。
  assert.match(server, /guessed: candidate !== wanted/);
});

test('saying “切换” while already on the target account still continues the thread', () => {
  // 用户 2026-11-07 的真实处境：已经换到新账号了，任务还停着，再回「切换」不能只说“没有切换”。
  assert.match(server, /async function continueOnCurrentAccount\(threadId\)/);
  assert.match(server, /当前已经在 \$\{accountDisplayName\(chosen\)\}/);
  assert.match(server, /const resumed = await continueOnCurrentAccount\(chatThreadId\);/);
});

test('webpage exposes the toggle and saves it', () => {
  assert.match(dashboard, /id="quotaAutoSwitch"/);
  assert.match(dashboard, /async function saveQuotaSwitch\(\)/);
  assert.match(dashboard, /autoSwitchAccountOnQuotaExhausted/);
});
