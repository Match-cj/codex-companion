import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import http from 'node:http';
const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
function accessContext(config = {}) {
  const context = { config, URL, Buffer, createHash, timingSafeEqual };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const isLoopback ='), source.indexOf('let accounts =')), context);
  return context;
}
const request = (address, host = '127.0.0.1:17841', extra = {}) => ({ socket: { remoteAddress: address }, headers: { host, ...extra } });
test('local native clients work; cross-site and DNS rebinding are rejected', () => {
  const c = accessContext();
  assert.equal(c.requestAccessError(request('127.0.0.1')), '');
  assert.equal(c.requestAccessError(request('::ffff:127.0.0.1')), '');
  assert(c.requestAccessError(request('127.0.0.1', 'evil.example:17841')));
  assert(c.requestAccessError(request('127.0.0.1', undefined, { origin: 'https://evil.example' })));
});
test('remote control requires opt-in and correct token, without exposing hash', () => {
  const token = 'a-valid-random-token-for-tests';
  const config = { remoteAccessEnabled: false, remoteAccessTokenHash: createHash('sha256').update(token).digest('hex'), feishuWebhookUrl: 'secret-webhook', feishuAppSecretProtected: 'secret' };
  const c = accessContext(config);
  const req = request('192.168.1.9', '192.168.1.3:17841', { authorization: `Bearer ${token}` });
  assert(c.requestAccessError(req));
  config.remoteAccessEnabled = true;
  assert.equal(c.requestAccessError(req), '');
  assert(c.requestAccessError({ ...req, headers: { ...req.headers, authorization: 'Bearer wrong' } }));
  const publicData = JSON.stringify(c.publicConfig());
  assert(!publicData.includes('secret'));
  assert(!publicData.includes(config.remoteAccessTokenHash));
});
test('Feishu rejects unapproved senders and pairs only with local secret', async () => {
  let continued = 0, saved = 0;
  const config = { feishuAllowedUserIds: [], feishuBoundChatId: 'old-group', feishuBoundThreadId: 'thread-a' };
  const c = { config, feishuPairingCode: '123456789012345678901234', randomBytes, console, saveConfig: async () => saved++, bindLatestFeishuThread: async () => ({ id: 'thread-a', name: 'Task A' }), sendFeishuAppText: async () => {}, continueThreadFromFeishu: async () => { continued++; return { id: 'thread-a', prompt: 'Task A' }; }, humanError: String };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('async function handleFeishuMessage('), source.indexOf('function isActiveWriterError(')), c);
  const event = (sender, text, group = 'old-group') => ({ sender: { sender_type: 'user', sender_id: { open_id: sender } }, message: { message_type: 'text', chat_id: group, content: JSON.stringify({ text }) } });
  await c.handleFeishuMessage(event('stranger', '绑定'));
  assert.equal(saved, 0); assert.equal(continued, 0);
  await c.handleFeishuMessage(event('owner', '绑定 123456789012345678901234'));
  assert.equal(config.feishuAllowedUserIds[0], 'owner');
  await c.handleFeishuMessage(event('stranger', '继续', 'new-group'));
  assert.equal(config.feishuBoundChatId, 'old-group'); assert.equal(continued, 0);
  await c.handleFeishuMessage(event('owner', '绑定 123456789012345678901234'));
  assert.equal(continued, 0);
  await c.handleFeishuMessage(event('owner', '继续'));
  assert.equal(continued, 1);
});
test('real HTTP entry rejects cross-site and malformed requests; health remains independent', async () => {
  const c = accessContext({ remoteAccessEnabled: false });
  Object.assign(c, { setTimeout, clearTimeout, dashboardHtml: '<html>login</html>', APP_VERSION: 'test', console });
  vm.runInContext(source.slice(source.indexOf('async function handle(req, res)'), source.indexOf('async function startTaskEngine()')), c);
  const server = http.createServer(c.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(base + '/api/health')).json()).version, 'test');
    assert.equal((await fetch(base + '/api/config', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/config', { method: 'POST', body: '{bad json' })).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
