// Local inbox for everything Companion receives from Feishu.
//
// Why this exists: a company Feishu admin can sit on an app review forever, and
// an AI tool on this PC still needs to read those messages. Instead of waiting
// for permission, Companion writes every incoming message to a plain file on
// this machine - the AI can then read the file, no cloud hop, no approval.
//
// Two files are kept in sync: the .jsonl source of truth and a .md file that is
// pleasant to read and safe to paste into a chat.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 200;

function shortText(value, limit = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function entryLine(entry, index) {
  const when = new Date(Number(entry.at) || Date.now());
  const stamp = Number.isFinite(when.getTime()) ? when.toISOString().replace('T', ' ').slice(0, 16) : '';
  const label = entry.type === 'text' ? '' : `［${entry.type}］`;
  return `${index + 1}. \`${stamp}\` ${label}${shortText(entry.text) || '（无文字内容）'}`;
}
export function renderInboxMarkdown(entries, { pathHint = '' } = {}) {
  const head = [
    '# 飞书消息收件箱',
    '',
    '由 Codex Companion 自动写入：**最新在最后**，只存在这台电脑上，不会上传到任何地方。',
    '',
    `- 共 ${entries.length} 条${pathHint ? ` · 文件位置：\`${pathHint}\`` : ''}`,
    '',
  ];
  if (!entries.length) return `${head.join('\n')}（还没有收到消息）\n`;
  return `${head.join('\n')}${entries.map(entryLine).join('\n')}\n`;
}

// Writes are serialised: Feishu can deliver bursts, and two concurrent
// read-modify-write cycles would drop messages.
export function createFeishuInbox({ dir = '', limit = MAX_ENTRIES } = {}) {
  const jsonPath = path.join(dir, 'feishu-inbox.jsonl');
  const mdPath = path.join(dir, 'feishu-inbox.md');
  let chain = Promise.resolve();
  const queue = task => { chain = chain.then(task, task); return chain; };

  async function readAll() {
    try {
      const text = await fs.readFile(jsonPath, 'utf8');
      return text.split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }
  async function writeAll(entries) {
    const body = entries.length ? `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n` : '';
    await fs.writeFile(jsonPath, body, 'utf8');
    await fs.writeFile(mdPath, renderInboxMarkdown(entries, { pathHint: mdPath }), 'utf8');
  }
  async function append(entry) {
    return queue(async () => {
      const all = await readAll();
      all.push(entry);
      await writeAll(all.slice(-limit));
      return entry;
    });
  }
  async function recent(count = 20) {
    const size = Math.max(1, Math.min(Number(count) || 20, MAX_ENTRIES));
    const all = await readAll();
    return all.slice(-size);
  }
  async function clear() {
    return queue(() => writeAll([]));
  }
  async function exportMarkdown(count = MAX_ENTRIES) {
    const entries = await recent(count);
    return { text: renderInboxMarkdown(entries, { pathHint: mdPath }), count: entries.length };
  }
  return { paths: { jsonPath, mdPath }, append, recent, clear, exportMarkdown };
}

// Turns a raw Feishu event into a flat inbox row. Returns null for anything
// that carries no human content (bots, empty payloads).
export function inboxEntryFromEvent(data = {}, now = Date.now()) {
  if (data?.sender?.sender_type === 'app') return null;
  const message = data?.message || {};
  let text = '';
  const type = String(message.message_type || 'unknown');
  try {
    const content = JSON.parse(message.content || '{}');
    if (type === 'text') text = String(content.text || '').replace(/@_user_\d+/g, '').trim();
    else if (type === 'image') text = '（图片）';
    else text = String(content.text || content.title || '').trim();
  } catch {}
  const messageId = String(message.message_id || '');
  // Nothing to read later: a bot echo, or a message with no human content.
  if (!messageId || !text) return null;
  return {
    at: now,
    messageId,
    chatId: String(message.chat_id || ''),
    senderId: String(data?.sender?.sender_id?.open_id || ''),
    senderType: String(data?.sender?.sender_type || ''),
    type,
    text: shortText(text, 2000),
  };
}
