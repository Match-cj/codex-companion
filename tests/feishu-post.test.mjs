import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFeishuPost, postInboxText, isRichTextMessage } from '../feishu-post.mjs';
import { inboxEntryFromEvent } from '../feishu-inbox.mjs';

// A real message that reached Companion but was dropped: one @-mention,
// one screenshot and three paragraphs of instructions in a single post.
const REAL_POST = {
  title: '',
  content: [
    [{ tag: 'at', user_id: '@_user_1', user_name: '陈炬的助手', style: [] }, { tag: 'text', text: ' ', style: [] }],
    [{ tag: 'img', image_key: 'img_v3_0217a_f50bd440-5063-42e3-92d8-10eb078a015g', width: 1185, height: 825 }],
    [{ tag: 'text', text: '字体这里下面空的太多了，两个字体之间之前在没有展开之前不是直接紧靠的吗？', style: [] }],
    [{ tag: 'text', text: '然后这提示词库 是否直接在设置中就显示了？', style: [] }],
    [{ tag: 'text', text: '继续往下推进吧，优先弄 ChatGPT 自动接力路径和失败原因展示。', style: [] }],
  ],
};

test('rich text is flattened into readable instructions plus image keys', () => {
  const parsed = parseFeishuPost(REAL_POST);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.imageKeys.length, 1);
  assert.equal(parsed.imageKeys[0], 'img_v3_0217a_f50bd440-5063-42e3-92d8-10eb078a015g');
  assert.match(parsed.text, /字体这里下面空的太多了/);
  assert.match(parsed.text, /提示词库/);
  assert.match(parsed.text, /继续往下推进吧/);
  assert.doesNotMatch(parsed.text, /@_user_1|陈炬的助手/);
  assert.equal(parsed.text.split('\n').length, 3);
  assert.equal(parseFeishuPost(JSON.stringify(REAL_POST)).text, parsed.text);
});

test('title, links, emoji-only blocks and repeated images are handled', () => {
  const parsed = parseFeishuPost({
    title: '这版要改的地方',
    content: [
      [{ tag: 'a', text: '参考链接', href: 'https://example.com' }],
      [{ tag: 'emotion', emoji_type: 'OK' }],
      [{ tag: 'img', image_key: 'same' }, { tag: 'img', image_key: 'same' }, { tag: 'img', image_key: 'other' }],
      [{ tag: 'media', file_key: 'clip.mp4' }],
    ],
  });
  assert.match(parsed.text, /^这版要改的地方/);
  assert.match(parsed.text, /参考链接/);
  assert.deepEqual(parsed.imageKeys, ['same', 'other']);
  assert.equal(parsed.attachments, 1);
});

test('image-only posts still produce a usable inbox label and input', () => {
  const parsed = parseFeishuPost({ content: [[{ tag: 'img', image_key: 'a' }], [{ tag: 'img', image_key: 'b' }]] });
  assert.equal(parsed.text, '');
  assert.equal(parsed.ok, true);
  assert.match(postInboxText(parsed), /2 张图片/);
  assert.equal(postInboxText(parseFeishuPost('{}')), '（富文本消息）');
});

test('malformed or empty payloads never throw', () => {
  for (const raw of ['', 'not json', 'null', '[]', '{}', null, undefined, 42]) {
    const parsed = parseFeishuPost(raw);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.imageKeys, []);
  }
  const fromV2 = parseFeishuPost({ content_v2: [[{ tag: 'text', text: '只有 content_v2' }]] });
  assert.equal(fromV2.text, '只有 content_v2');
});

test('six images at most, unknown tags with text are still readable', () => {
  const parsed = parseFeishuPost({
    content: Array.from({ length: 9 }, (_, i) => [{ tag: 'img', image_key: `k${i}` }])
      .concat([[{ tag: 'code', text: 'npm test' }]]),
  });
  assert.equal(parsed.imageKeys.length, 6);
  assert.match(parsed.text, /npm test/);
});

test('the inbox records rich text instead of silently losing it', () => {
  const data = {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
    message: { message_id: 'om_post_1', chat_id: 'oc_1', message_type: 'post', content: JSON.stringify(REAL_POST) },
  };
  const entry = inboxEntryFromEvent(data, 1234);
  assert.ok(entry, 'post messages must land in the local inbox');
  assert.equal(entry.type, 'post');
  assert.match(entry.text, /字体这里下面空的太多了/);
  assert.equal(isRichTextMessage('post'), true);
  assert.equal(isRichTextMessage('text'), false);
});

test('server forwards rich text, replies to unknown types, and replays dropped messages', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(server, /const APP_VERSION = '1\.0\.52'/);
  assert.equal(pkg.version, '1.0.52');
  assert.match(server, /import \{ parseFeishuPost, isRichTextMessage \} from '\.\/feishu-post\.mjs'/);
  assert.match(server, /const isTextLike = msgType === 'text' \|\| isRichTextMessage\(msgType\)/);
  assert.match(server, /\} else if \(isRichTextMessage\(msgType\)\) \{/);
  assert.match(server, /type: 'localImage', path: await downloadFeishuImage\(messageId, imageKey\)/);
  assert.match(server, /'文字和图片已发送'/);
  assert.doesNotMatch(server, /\} else return;\n    const chatId/);
  assert.match(server, /这条消息的格式暂时读不了/);
  assert.match(server, /async function recoverUnansweredFeishuMessages\(\)/);
  assert.match(server, /receiveFeishuMessage\(data, \{ recovered: true \}\)/);
  assert.match(server, /recoverUnansweredFeishuMessages\(\)\.catch/);
  assert.match(server, /return handleFeishuMessage\(data, opts\)/);
  assert.match(server, /if \(!recovered && messageId && received\.includes\(messageId\)\) return;/);
});
