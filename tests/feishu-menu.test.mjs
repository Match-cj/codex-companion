import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('Feishu phone menu can toggle desktop auto takeover and show status', () => {
  assert.match(server, /handleFeishuControlCommand/);
  assert.match(server, /自动接管已开启/);
  assert.match(server, /自动接管已关闭/);
  assert.match(server, /运行中对话：\$\{feishuRunningCount\(\)\}/);
  assert.match(server, /绑定最近对话/);
});

test('stale Feishu thread mappings are cleared with a human recovery message', () => {
  assert.match(server, /forgetFeishuThreadMapping/);
  assert.match(server, /thread\\s\+not\\s\+found/);
  assert.match(server, /绑定最近对话/);
});
