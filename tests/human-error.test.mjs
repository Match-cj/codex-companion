import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanError } from '../human-error.mjs';

test('JSON error blobs are unwrapped to the inner human-readable message', () => {
  const raw = '{"detail":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.","error":{"type":"invalid_request_error","code":"model_not_found","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}';
  const result = humanError(raw);
  assert.equal(result, '这个对话用的模型「gpt-6.1-sol」不支持用 ChatGPT 账号跑，最常见的原因是会员刚好到期或降级了。在 Codex 底部换一个可用的模型，或换到合适的账号再继续。');
  // 包着「操作没有完成：{json}」前缀的也要能拆开。
  const prefixed = humanError(`操作没有完成：${raw}`);
  assert.match(prefixed, /模型「gpt-6.1-sol」不支持/);
  assert.doesNotMatch(prefixed, /detail/);
});

test('model_not_found and unsupported model errors translate into actionable Chinese', () => {
  assert.match(humanError('{"error":{"code":"model_not_found","message":"model_not_found"}}'), /换一个可用模型/);
  assert.match(humanError('The model is not supported when using Codex with a ChatGPT account.'), /不支持用 ChatGPT 账号跑/);
});

test('existing translations keep working', () => {
  assert.equal(humanError('invalid refresh token'), '这个账号的登录已经失效，请在 Companion 网页中重新登录后再刷新。');
  assert.equal(humanError('连接超时'.replace('连接超时','超时')), 'Codex 两分钟没有回应。任务可能卡住了，请稍后重试或重启 Companion。');
  assert.match(humanError('something else went wrong'), /操作没有完成：something else went wrong/);
});
