import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function quotaLabel(');
const end = source.indexOf('function dashboardLink(', start);
const context = { humanError: () => '登录已失效，请重新登录。' };
vm.runInNewContext(`${source.slice(start, end)};this.exports={isQuotaCommand,formatQuotaStatus};`, context);

test('额度 command accepts Chinese aliases and quota', () => {
  assert.equal(context.exports.isQuotaCommand('额度'), true);
  assert.equal(context.exports.isQuotaCommand(' 查询 额度 '), true);
  assert.equal(context.exports.isQuotaCommand('quota'), true);
  assert.equal(context.exports.isQuotaCommand('继续任务'), false);
});

test('quota status reports remaining primary and secondary windows', () => {
  const result = context.exports.formatQuotaStatus({
    display_name: '测试账号',
    usage: {
      primary_used_percent: 25,
      primary_window_minutes: 300,
      primary_resets_at: 2000000000,
      secondary_used_percent: 72,
      secondary_window_minutes: 10080,
      secondary_resets_at: 2000003600,
    },
  });
  assert.match(result, /当前账号：测试账号/);
  assert.match(result, /5 小时额度：剩余 75%/);
  assert.match(result, /周额度：剩余 28%/);
  assert.match(result, /重置 \d+天\d+小时|重置 \d+小时\d+分|重置 \d+分/);
});

test('quota status surfaces a safe login-expired state', () => {
  const result = context.exports.formatQuotaStatus({ display_name: '测试账号', usage: { error: 'invalid refresh token: secret' } });
  assert.equal(result, '当前账号：测试账号\n状态：登录已失效，请重新登录。');
  assert.doesNotMatch(result, /secret/);
});
