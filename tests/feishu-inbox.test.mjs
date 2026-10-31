import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFeishuInbox, inboxEntryFromEvent, renderInboxMarkdown } from '../feishu-inbox.mjs';

// Messages land on disk so an AI on this PC can read them without waiting for
// a Feishu admin to approve anything. The file is the contract, so test it.
async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cc-inbox-'));
}
const event = (text, extra = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou-1' } },
  message: { message_id: 'om-1', chat_id: 'oc-1', message_type: 'text', content: JSON.stringify({ text }), ...extra },
});

test('bot traffic and empty payloads never enter the inbox', () => {
  assert.equal(inboxEntryFromEvent({ sender: { sender_type: 'app' }, message: { message_id: 'om-1' } }), null);
  assert.equal(inboxEntryFromEvent(event('')), null);
  assert.equal(inboxEntryFromEvent({}), null);
});

test('human messages keep the text, sender and type', () => {
  const entry = inboxEntryFromEvent(event('  你好 @_user_1 继续  '), 1700000000000);
  assert.equal(entry.text, '你好 继续');
  assert.equal(entry.senderId, 'ou-1');
  assert.equal(entry.type, 'text');
  assert.equal(entry.at, 1700000000000);
  const image = inboxEntryFromEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou-1' } }, message: { message_id: 'om-2', message_type: 'image', content: JSON.stringify({ image_key: 'img' }) } });
  assert.equal(image.type, 'image');
  assert.match(image.text, /图片/);
});

test('the inbox keeps newest messages, caps its size and writes a readable md', async () => {
  const dir = await tempDir();
  const inbox = createFeishuInbox({ dir, limit: 5 });
  for (let i = 1; i <= 8; i += 1) await inbox.append({ at: 1700000000000 + i, text: `第${i}条`, type: 'text', chatId: 'oc', senderId: 'ou', messageId: `om-${i}` });
  const items = await inbox.recent(10);
  assert.equal(items.length, 5, 'oldest entries must roll off');
  assert.equal(items[0].text, '第4条');
  assert.equal(items[4].text, '第8条');
  const md = await fs.readFile(inbox.paths.mdPath, 'utf8');
  assert.match(md, /第8条/);
  assert.doesNotMatch(md, /第1条/);
  assert.match(md, /最新在最后/);
});

test('clearing empties both files but never throws', async () => {
  const dir = await tempDir();
  const inbox = createFeishuInbox({ dir });
  await inbox.append({ at: Date.now(), text: 'x', type: 'text' });
  await inbox.clear();
  assert.deepEqual(await inbox.recent(10), []);
  assert.equal((await fs.readFile(inbox.paths.jsonPath, 'utf8')).trim(), '');
  const missing = createFeishuInbox({ dir: path.join(dir, 'nope') });
  assert.deepEqual(await missing.recent(5), []);
});

test('markdown export is paste-ready for an AI', async () => {
  const dir = await tempDir();
  const inbox = createFeishuInbox({ dir });
  await inbox.append({ at: Date.now(), text: '帮我看一下这条', type: 'text' });
  const exported = await inbox.exportMarkdown();
  assert.equal(exported.count, 1);
  assert.match(exported.text, /飞书消息收件箱/);
  assert.match(exported.text, /帮我看一下这条/);
  assert.equal(renderInboxMarkdown([], {}).includes('还没有收到消息'), true);
});
