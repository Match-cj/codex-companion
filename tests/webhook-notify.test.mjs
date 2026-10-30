import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { KINDS, friendlyWebhookReason, buildWebhookRequest, normalizeWebhookTarget, validateWebhooks, trimBytes, isAllowedWebhookUrl, webhookBodyRejected, sendWebhook, sendWebhooks, activeWebhookTargets } from '../webhook-notify.mjs';

test('every channel explains its limits and how to get the address', () => {
  // The whole point of the comparison table: nobody should have to sign up for
  // eight services to find out which one fits.
  for (const kind of KINDS) {
    assert.ok(kind.limit && kind.limit.length > 10, `${kind.id} has no limit description`);
    assert.ok(kind.howto && kind.howto.length > 10, `${kind.id} has no setup instructions`);
    assert.ok(kind.hint, `${kind.id} has no hint`);
  }
  const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  for (const kind of KINDS) {
    assert.ok(dashboard.includes(`id:'${kind.id}'`), `dashboard is missing channel ${kind.id}`);
  }
  assert.match(dashboard, /webhookCompare/);
});

test('every supported channel builds a request its own API accepts', () => {
  const cases = [
    ['wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc', '', payload => {
      assert.equal(payload.msgtype, 'text');
      assert.equal(payload.text.content, 'hello');
    }],
    ['dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=abc', '', payload => {
      assert.equal(payload.msgtype, 'text');
      assert.equal(payload.text.content, 'hello');
    }],
    ['pushplus', 'https://www.pushplus.plus/send', 'tok', payload => {
      assert.equal(payload.token, 'tok');
      assert.equal(payload.content, 'hello');
      assert.equal(payload.template, 'txt');
    }],
    ['serverchan', 'https://sctapi.ftqq.com/SCT123.send', '', payload => {
      assert.equal(payload.desp, 'hello');
      assert.ok(payload.title);
    }],
    ['bark', 'https://api.day.app/KEY', '', payload => {
      assert.equal(payload.body, 'hello');
      assert.equal(payload.group, 'Codex Companion');
    }],
    ['telegram', 'https://api.telegram.org/bot123/sendMessage', '42', payload => {
      assert.equal(payload.chat_id, '42');
      assert.equal(payload.text, 'hello');
    }],
    ['discord', 'https://discord.com/api/webhooks/1/abc', '', payload => {
      assert.equal(payload.content, 'hello');
    }],
    ['custom', 'https://example.com/hook', '', payload => {
      assert.equal(payload.text, 'hello');
      assert.equal(payload.app, 'Codex Companion');
    }],
  ];
  assert.deepEqual(cases.map(item => item[0]).sort(), KINDS.map(item => item.id).sort());
  for (const [kind, url, token, check] of cases) {
    const request = buildWebhookRequest({ kind, url, token }, 'hello', { title: 'T' });
    assert.equal(request.url, url, kind);
    assert.equal(request.headers['Content-Type'], 'application/json', kind);
    check(request.body);
  }
});

test('token-only channels derive their own endpoint', () => {
  assert.equal(buildWebhookRequest({ kind: 'pushplus', token: 'tok' }, 'x').url, 'https://www.pushplus.plus/send');
  assert.equal(buildWebhookRequest({ kind: 'serverchan', token: 'SCT1' }, 'x').url, 'https://sctapi.ftqq.com/SCT1.send');
  assert.equal(buildWebhookRequest({ kind: 'bark', token: 'KEY' }, 'x').url, 'https://api.day.app/KEY');
});

test('long output is cut by bytes so Chinese never becomes broken characters', () => {
  const text = '结果'.repeat(2000);
  const cut = trimBytes(text, 1800);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 1800);
  assert.ok(cut.endsWith('…'));
  assert.equal(trimBytes('short', 1800), 'short');
  assert.equal(trimBytes('', 1800), '');
});

test('validation rejects unknown kinds, insecure hosts, duplicates and missing tokens', () => {
  assert.throws(() => normalizeWebhookTarget({ kind: 'nope' }), /类型不认识/);
  assert.throws(() => normalizeWebhookTarget({ kind: 'custom', url: 'http://example.com/hook' }), /https/);
  assert.equal(isAllowedWebhookUrl('http://127.0.0.1:9000/hook'), true);
  assert.equal(isAllowedWebhookUrl('http://localhost:9000/hook'), true);
  assert.equal(isAllowedWebhookUrl('ftp://example.com/x'), false);
  assert.equal(isAllowedWebhookUrl('not a url'), false);
  assert.throws(() => normalizeWebhookTarget({ kind: 'pushplus', url: 'https://www.pushplus.plus/send' }), /token/);
  assert.throws(() => validateWebhooks([{ kind: 'custom', url: 'https://a.com/x' }, { kind: 'custom', url: 'https://a.com/x' }]), /重复/);
  assert.throws(() => validateWebhooks(Array.from({ length: 11 }, (_, index) => ({ kind: 'custom', url: `https://a.com/${index}` }))), /10/);
  assert.equal(validateWebhooks(undefined), undefined);
  assert.equal(validateWebhooks([]).length, 0);
});

test('disabled channels never receive a message', () => {
  const config = { webhooks: [
    { id: 'a', kind: 'custom', url: 'https://a.com/x', enabled: true },
    { id: 'b', kind: 'custom', url: 'https://b.com/x', enabled: false },
    { id: 'c', kind: 'custom', url: '' },
  ] };
  assert.deepEqual(activeWebhookTargets(config).map(item => item.id), ['a']);
  assert.deepEqual(activeWebhookTargets({}).map(item => item.id), []);
});

test('a 200 response with an error code counts as failure', () => {
  assert.equal(webhookBodyRejected('wecom', { errcode: 0, errmsg: 'ok' }), '');
  assert.match(webhookBodyRejected('wecom', { errcode: 93000, errmsg: 'invalid webhook url' }), /invalid webhook url/);
  assert.match(webhookBodyRejected('dingtalk', { errcode: 310000, errmsg: 'keywords not in content' }), /keywords/);
  assert.equal(webhookBodyRejected('pushplus', { code: 200, msg: 'ok' }), '');
  assert.match(webhookBodyRejected('pushplus', { code: 900, msg: 'token 无效' }), /token 无效/);
  assert.equal(webhookBodyRejected('custom', { ok: true }), '');
});

test('transport failure is reported per channel instead of throwing', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.includes('bad')) return { ok: true, status: 200, json: async () => ({ errcode: 40058, errmsg: 'invalid token' }) };
    if (url.includes('boom')) throw new Error('connect ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ errcode: 0 }) };
  };
  try {
    const targets = [
      { id: 'ok', kind: 'wecom', name: '好渠道', url: 'https://good/hook' },
      { id: 'bad', kind: 'wecom', name: '坏渠道', url: 'https://bad/hook' },
      { id: 'down', kind: 'custom', name: '断网', url: 'https://boom/hook' },
    ];
    const delivery = await sendWebhooks(targets, '任务完成', { title: 'Codex' });
    assert.equal(delivery.ok, 1);
    assert.equal(delivery.failed, 2);
    assert.equal(calls.length, 3);
    assert.equal(delivery.results.find(item => item.id === 'bad').reason, 'invalid token');
    assert.match(delivery.results.find(item => item.id === 'down').reason, /ECONNREFUSED/);
    assert.equal((await sendWebhooks([], 'x')).ok, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('missing token surfaces as a readable failure, not a crash', async () => {
  const result = await sendWebhook({ id: 'x', kind: 'telegram', name: '电报', url: '', token: '' }, 'x');
  assert.equal(result.ok, false);
  assert.match(result.reason, /缺少/);
});

test('transport errors are translated into plain Chinese', () => {
  assert.match(friendlyWebhookReason('fetch failed'), /网络连不上/);
  assert.match(friendlyWebhookReason('connect ECONNREFUSED 127.0.0.1:9'), /网络连不上/);
  assert.match(friendlyWebhookReason('The operation was aborted due to timeout'), /超时|网络连不上/);
  assert.equal(friendlyWebhookReason('invalid token'), 'invalid token');
  assert.equal(friendlyWebhookReason(''), '发送失败');
  assert.equal(friendlyWebhookReason('HTTP 404'), 'HTTP 404');
});

test('webpage and backend expose the same channel management routes', () => {
  const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  for (const route of ['/api/webhooks/add', '/api/webhooks/remove', '/api/webhooks/toggle', '/api/webhooks/test']) {
    assert.ok(dashboard.includes(route), `dashboard missing ${route}`);
    assert.ok(server.includes(`u.pathname==='${route}'`), `server missing ${route}`);
  }
  assert.match(dashboard, /toggleWebhookChannel/);
  // Adding the section must not clobber its neighbours.
  assert.match(dashboard, /桌面端自动重试/);
  assert.match(dashboard, /高级设置/);
  assert.match(server, /webhooks: \[\]/);
});

test('a Feishu outage does not block the other channels', async () => {
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const history = [];
  const calls = [];
  const c = {
    config: { webhooks: [{ id: 'w1', kind: 'wecom', name: '企微群', url: 'https://x', enabled: true }] },
    feishuClient: {}, feishuBoundChatId: 'chat',
    canonicalCodexThreadId: id => String(id || ''),
    inferNotificationTaskId: async (text, id) => id,
    notificationType: () => '', notificationEnabled: () => true,
    normalizeAppName: value => value, trim: value => value,
    pushHistory: entry => history.push(entry), saveConfig: async () => {},
    sendFeishuAppText: async () => { throw new Error('feishu down') },
    sendWebhooks: async (targets, text) => { calls.push({ targets, text }); return { ok: 1, failed: 0, results: [{ id: 'w1', ok: true }] } },
    applyWebhookDelivery: () => {},
    console,
  };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('async function notify(text,'), source.indexOf('function quotaLabel(')), c);
  const result = await c.notify('Codex 任务完成');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targets.length, 1);
  assert.equal(calls[0].text, 'Codex 任务完成');
  assert.equal(history.length, 1);
  assert.equal(history[0].sent, true);
});

test('webhook-only setup works without any Feishu configuration', async () => {
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const history = [];
  const c = {
    config: { webhooks: [{ id: 'w1', kind: 'bark', name: 'iPhone', url: 'https://api.day.app/KEY', enabled: true }] },
    feishuClient: null, feishuBoundChatId: '',
    canonicalCodexThreadId: id => String(id || ''),
    inferNotificationTaskId: async (text, id) => id,
    notificationType: () => '', notificationEnabled: () => true,
    normalizeAppName: value => value, trim: value => value,
    pushHistory: entry => history.push(entry), saveConfig: async () => {},
    sendWebhooks: async () => ({ ok: 1, failed: 0, results: [{ id: 'w1', ok: true }] }),
    applyWebhookDelivery: () => {},
    console,
  };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('async function notify(text,'), source.indexOf('function quotaLabel(')), c);
  const result = await c.notify('额度已恢复', { appName: 'Codex 额度' });
  assert.equal(result.ok, true);
  assert.equal(history[0].sent, true);
});

test('disabled channels are dropped before any network call', async () => {
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const c = {
    config: { webhooks: [{ id: 'w1', kind: 'wecom', url: 'https://x', enabled: false }] },
    feishuClient: null, feishuBoundChatId: '',
    canonicalCodexThreadId: id => String(id || ''), inferNotificationTaskId: async (text, id) => id,
    notificationType: () => '', notificationEnabled: () => true,
    normalizeAppName: value => value, trim: value => value,
    pushHistory: () => {}, saveConfig: async () => {},
    sendWebhooks: async () => { throw new Error('must not be called') },
    applyWebhookDelivery: () => {},
    console,
  };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('async function notify(text,'), source.indexOf('function quotaLabel(')), c);
  const result = await c.notify('任务完成');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'feishu-not-configured');
});
