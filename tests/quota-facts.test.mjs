import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  roundRemaining, resetText, countdownText, resetGapText, zeroNote, buildQuotaFacts,
} from '../quota-facts.mjs';
import { quotaLeft, pickQuotaSwitchTarget } from '../quota-switch.mjs';

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0).getTime();
const sec = ms => Math.floor(ms / 1000);
const NOW = at(2026, 11, 12, 14, 0);

test('remaining percentages round like the client instead of truncating to zero', () => {
  // 用户实测：周额度客户端显示 1%，浮窗显示 0%，就是截断和四舍五入的区别。
  assert.equal(roundRemaining(99.4), 1);
  assert.equal(roundRemaining(99.6), 0);
  assert.equal(roundRemaining(100), 0);
  assert.equal(roundRemaining(7), 93);
  assert.equal(roundRemaining(0), 100);
  assert.equal(roundRemaining(-3), 100);
  assert.equal(roundRemaining(120), 0);
  assert.equal(roundRemaining(null), null);
  assert.equal(roundRemaining(undefined), null);
  assert.equal(roundRemaining(''), null);
  assert.equal(roundRemaining('abc'), null);
});

test('reset labels carry a date so two reset points can actually be compared', () => {
  assert.equal(resetText(sec(at(2026, 11, 12, 14, 19)), NOW), '今天 14:19');
  assert.equal(resetText(sec(at(2026, 11, 13, 6, 53)), NOW), '明天 06:53');
  assert.equal(resetText(sec(at(2026, 11, 11, 23, 10)), NOW), '昨天 23:10');
  assert.equal(resetText(sec(at(2026, 12, 1, 6, 53)), NOW), '12/1 06:53');
  assert.equal(resetText(0, NOW), '');
  assert.equal(resetText('oops', NOW), '');
});

test('countdown stays human readable and never claims a negative wait', () => {
  assert.equal(countdownText(sec(NOW + 3 * 3600000 + 20 * 60000), NOW), '3小时20分');
  assert.equal(countdownText(sec(NOW + 26 * 3600000), NOW), '1天2小时');
  assert.equal(countdownText(sec(NOW - 1000), NOW), '已重置');
});

test('gap text states the distance between resets without predicting waste', () => {
  const primary = sec(at(2026, 11, 12, 14, 19));
  const weekly = sec(at(2026, 11, 13, 15, 19));
  const text = resetGapText(primary, weekly);
  assert.match(text, /两次重置相差约 1 天 1 小时/);
  assert.match(text, /周额度整体重置时 5 小时额度一起清零/);
  assert.doesNotMatch(text, /浪费|赶紧|建议|提醒/);
  assert.match(resetGapText(primary, primary + 60), /几乎同时/);
  assert.equal(resetGapText(null, weekly), '');
  assert.equal(resetGapText(primary, 0), '');
});

test('zero percent gets a plain fact, not an alarm', () => {
  assert.equal(zeroNote(0, '周额度'), '周额度已见底，下一次请求可能失败');
  assert.equal(zeroNote(1, '周额度'), '');
  assert.equal(zeroNote(null, '周额度'), '');
});

test('fact bundle carries dates, countdowns, window rules and a zero-percent note', () => {
  const usage = {
    primary_used_percent: 17,
    primary_resets_at: sec(at(2026, 11, 12, 19, 19)),
    primary_window_minutes: 300,
    secondary_used_percent: 100,
    secondary_resets_at: sec(at(2026, 11, 13, 15, 19)),
    secondary_window_minutes: 10080,
  };
  const facts = buildQuotaFacts(usage, NOW);
  assert.equal(facts.primary.remaining, 83);
  assert.equal(facts.secondary.remaining, 0);
  assert.equal(facts.primary.resetText, '今天 19:19');
  assert.equal(facts.secondary.resetText, '明天 15:19');
  assert.match(facts.primary.windowText, /5 小时窗口 今天 14:19 开始/);
  assert.match(facts.secondary.windowText, /周额度整体重置时，5 小时额度会一起清零/);
  assert.match(facts.secondary.windowText, /周额度已见底，下一次请求可能失败/);
  assert.doesNotMatch(facts.secondary.windowText, /窗口空闲时不倒计时/);
  assert.match(facts.gapText, /两次重置相差/);
  assert.equal(buildQuotaFacts({}, NOW).gapText, '');
});

test('auto switch never lands on an account whose weekly quota is already empty', () => {
  const exhaustedWeekly = { id: 'A', display_name: '周额度已空', usage: { primary_used_percent: 0, secondary_used_percent: 100 } };
  const healthy = { id: 'B', display_name: '可用', usage: { primary_used_percent: 60, secondary_used_percent: 90 } };
  assert.equal(pickQuotaSwitchTarget([exhaustedWeekly, healthy], 'X').id, 'B');
  // 只有周额度已空的候选时，宁可不切，也不要切过去立刻再失败一次。
  assert.equal(pickQuotaSwitchTarget([exhaustedWeekly], 'X'), null);
  // 周额度读不到仍保留历史策略：只影响排序，不直接淘汰。
  const unknownWeekly = { id: 'C', display_name: '周额度未知', usage: { primary_used_percent: 20 } };
  assert.equal(pickQuotaSwitchTarget([unknownWeekly], 'X').id, 'C');
  assert.deepEqual(quotaLeft({ usage: { primary_used_percent: 99.4, secondary_used_percent: 99.4 } }), { primary: 1, weekly: 1 });
});

test('backend computes the facts once and both frontends only render them', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  assert.match(server, /import \{ buildQuotaFacts \} from '\.\/quota-facts\.mjs'/);
  assert.match(server, /quotaFacts:buildQuotaFacts\(account\.usage,Date\.now\(\)\)/);
  assert.match(widget, /\$a\.quotaFacts\.\$prefix/);
  assert.match(widget, /function Get-QuotaCaption/);
  assert.match(widget, /\$a\.quotaFacts\.gapText/);
  assert.match(dashboard, /function quotaHtml\(label,facts\)/);
  assert.match(dashboard, /facts\.gapText/);
  // 纯事实层：不新增颜色规则、不新增提醒、不新增设置项。
  assert.doesNotMatch(widget, /quotaFacts.* notification/i);
});

test('widget, server and package versions stay aligned', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '1.0.58');
  assert.match(server, /const APP_VERSION = '1\.0\.58'/);
  assert.match(widget, /\$script:AppVersion='1\.0\.58'/);
});
