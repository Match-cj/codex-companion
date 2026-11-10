import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuotaFailure, parseProxyUrl, readSystemProxy, probeNetwork, networkNoticeDecision, networkStateText } from '../network-health.mjs';

test('quota failures separate a dead VPN from an expired login', () => {
  assert.equal(classifyQuotaFailure('failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)').network, true);
  assert.equal(classifyQuotaFailure('额度刷新失败：当前网络或系统代理无法连接 OpenAI 额度接口。').network, true);
  assert.equal(classifyQuotaFailure('网络连接失败：连不上目标网站（GitHub/OpenAI）').network, true);
  assert.equal(classifyQuotaFailure('这个账号的登录已经失效，请在 Companion 网页中重新登录后再刷新。').kind, 'login');
  assert.equal(classifyQuotaFailure('操作没有完成：独立额度进程已退出（-1）').kind, 'other');
  assert.equal(classifyQuotaFailure('').kind, 'ok');
});

test('proxy strings from env vars and Windows registry both parse', () => {
  assert.deepEqual(parseProxyUrl('http://127.0.0.1:7890'), { host: '127.0.0.1', port: 7890, address: '127.0.0.1:7890' });
  assert.deepEqual(parseProxyUrl('127.0.0.1:1080'), { host: '127.0.0.1', port: 1080, address: '127.0.0.1:1080' });
  assert.deepEqual(parseProxyUrl('socks5=127.0.0.1:7891'), { host: '127.0.0.1', port: 7891, address: '127.0.0.1:7891' });
  assert.equal(parseProxyUrl(''), null);
});

test('the Windows VPN port wins over an AI-session HTTP_PROXY env var', async () => {
  const disabledRegistry = async (command, args) => ({ stdout: args.includes('ProxyEnable') ? 'ProxyEnable REG_DWORD 0x0' : 'ProxyServer REG_SZ 127.0.0.1:7890' });
  const fromEnv = await readSystemProxy({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, platform: 'win32', run: disabledRegistry });
  assert.equal(fromEnv.address, '127.0.0.1:7890');
  const disabled = await readSystemProxy({ env: {}, platform: 'win32', run: disabledRegistry });
  assert.equal(disabled, null);
  const fromRegistry = await readSystemProxy({
    env: { HTTPS_PROXY: 'http://127.0.0.1:3215' }, platform: 'win32',
    run: async (command, args) => ({ stdout: args.includes('ProxyEnable') ? 'ProxyEnable REG_DWORD 0x1' : 'ProxyServer REG_SZ 127.0.0.1:17891;http=127.0.0.1:17891' }),
  });
  assert.equal(fromRegistry.address, '127.0.0.1:17891');
});

const proxy = { host: '127.0.0.1', port: 7890, address: '127.0.0.1:7890' };

test('dead proxy port is reported as a VPN/proxy dropout without any HTTP call', async () => {
  let calls = 0;
  const result = await probeNetwork({ proxy, tcpProbe: async () => false, httpGet: async () => { calls++; return true; } });
  assert.equal(result.state, 'proxy_down');
  assert.match(result.label, /VPN/);
  assert.equal(calls, 0);
});

test('internet works but OpenAI does not: blame the VPN line', async () => {
  const result = await probeNetwork({ proxy: null, tcpProbe: async () => true, httpGet: async url => url.includes('baidu.com') });
  assert.equal(result.state, 'openai_blocked');
  assert.match(result.label, /OpenAI/);
});

test('nothing answers: the PC itself is offline', async () => {
  const result = await probeNetwork({ proxy: null, tcpProbe: async () => true, httpGet: async () => false });
  assert.equal(result.state, 'offline');
});

test('OpenAI answers: the network is fine, the upstream API is not', async () => {
  const result = await probeNetwork({ proxy, tcpProbe: async () => true, httpGet: async () => true });
  assert.equal(result.state, 'upstream');
  assert.match(networkStateText('proxy_down').hint, /VPN/);
});

test('one notice going down, one coming back, never a stream while broken', () => {
  const first = networkNoticeDecision({ state: 'ok', notifiedAt: 0 }, true, 1000);
  assert.equal(first.notice, 'down');
  assert.equal(first.state, 'down');
  const repeat = networkNoticeDecision(first, true, 2000);
  assert.equal(repeat.notice, null);
  const recovered = networkNoticeDecision(repeat, false, 3000);
  assert.equal(recovered.notice, 'recovered');
  assert.equal(recovered.state, 'ok');
  const quiet = networkNoticeDecision(recovered, false, 4000);
  assert.equal(quiet.notice, null);
  // Ten minutes later a still-broken network may remind once more.
  const later = networkNoticeDecision(first, true, 1000 + 10 * 60 * 1000 + 1);
  assert.equal(later.notice, 'down');
});
