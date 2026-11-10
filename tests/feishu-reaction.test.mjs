import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const networkHealth = fs.readFileSync(new URL('../network-health.mjs', import.meta.url), 'utf8');
const nativeUsage = fs.readFileSync(new URL('../native-usage.mjs', import.meta.url), 'utf8');

const start = server.indexOf('const feishuReactionEvents = new Map();');
const end = server.indexOf('function observeSessionActivity(', start);
assert(start > 0 && end > start, 'reaction dedupe helpers must be a standalone slice');
const slice = server.slice(start, end);
const context = {};
vm.runInNewContext(`${slice}\nglobalThis.seen = alreadySeenReaction;\nglobalThis.maps = { feishuReactionEvents, feishuReactionMessages, feishuBotReactions };`, context);

test('the same delivered event is handled once, then forgotten after 10 minutes', () => {
  const events = context.maps.feishuReactionEvents;
  assert.equal(context.seen(events, 'evt-1', 1000), false);
  assert.equal(context.seen(events, 'evt-1', 2000), true);
  assert.equal(context.seen(events, 'evt-2', 3000), false);
  assert.equal(context.seen(events, 'evt-1', 1000 + 11 * 60 * 1000), false);
});

test('one OK per message: reconnects and bot-added reactions cannot double-notify', () => {
  assert.match(server, /feishuBotReactions\.set\(String\(message\.message_id\), Date\.now\(\)\)/);
  assert.match(server, /alreadySeenReaction\(feishuReactionEvents, eventId, now\)/);
  assert.match(server, /alreadySeenReaction\(feishuReactionMessages, `\$\{messageId\}:\$\{emoji\}`, now\)/);
  assert.match(server, /if \(botReactedAt && now - botReactedAt < 60000 && !\(humanOperator && isOperator\)\) return;/);
  assert.match(server, /if \(now - previous < 45000\) return;/);
  assert.doesNotMatch(server, /这个对话刚刚已经收到“继续”请求/);
  assert.match(server, /sendFeishuAppText\('已收到表情，继续推进这个 Codex 对话\。'/);
});

test('network diagnosis is wired to quota reads, the status API, both UIs and a notice', () => {
  assert.match(server, /updateNetworkHealth\(\);/);
  assert.match(server, /^\s+networkHealth,$/m);
  assert.match(server, /sweepStaleHomes\(root, \{ limit: 3000 \}\)/);
  assert.match(server, /notificationType: 'network_down'/);
  assert.match(widget, /networkHealth\.label/);
  assert.match(widget, /Get-FriendlyUsageError \$a\.usage\.error \$netLabel/);
  assert.match(dashboard, /status\.networkHealth/);
  assert.match(networkHealth, /export async function probeNetwork/);
});

test('every isolated Codex home is cleaned with credential scrubbing, not a silent rm', () => {
  assert.equal((nativeUsage.match(/wipeAndRemoveHome\(home, root\)/g) || []).length, 2);
  assert.doesNotMatch(nativeUsage, /fs\.rm\(resolvedHome/);
});
