// Feishu "post" (rich text) messages pack @-mentions, images and several text
// paragraphs into ONE nested array, with no plain `text` field at the top level.
// A screenshot plus instructions sent from the Feishu composer arrives exactly
// like this. Companion used to ignore the whole message silently, which looked
// like "I sent it and nothing happened".
//
// Everything here is pure: no network, no config. It is shared by the inbox
// writer and the command handler so both see the same text and images.

const MAX_IMAGES = 6;

function emptyResult(ok = false) {
  return { text: '', imageKeys: [], attachments: 0, ok };
}

export function parseFeishuPost(raw, { maxImages = MAX_IMAGES } = {}) {
  let payload = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); } catch { return emptyResult(); }
  }
  if (!payload || typeof payload !== 'object') return emptyResult();

  const lines = [];
  const imageKeys = [];
  let attachments = 0;
  const title = String(payload.title ?? '').trim();
  if (title) lines.push(title);

  const blocks = Array.isArray(payload.content) ? payload.content
    : Array.isArray(payload.content_v2) ? payload.content_v2 : [];
  for (const block of blocks) {
    const tags = Array.isArray(block) ? block : [block];
    const parts = [];
    for (const tag of tags) {
      if (!tag || typeof tag !== 'object') continue;
      const kind = String(tag.tag || '').toLowerCase();
      // @机器人 and emoji reactions are decorations, not instructions.
      if (kind === 'at' || kind === 'emotion' || kind === 'emoji') continue;
      if (kind === 'img' || kind === 'image') {
        const key = String(tag.image_key || tag.imageKey || tag.file_key || '').trim();
        if (key && !imageKeys.includes(key) && imageKeys.length < maxImages) imageKeys.push(key);
        continue;
      }
      if (kind === 'media' || kind === 'file' || kind === 'audio' || kind === 'video') {
        attachments += 1;
        continue;
      }
      // text / a / code / strong ... anything carrying readable words.
      const value = String(tag.text ?? tag.title ?? tag.href ?? '').trim();
      if (value) parts.push(value);
    }
    const line = parts.join(' ').replace(/@_user_\d+/g, '').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }

  const text = lines.join('\n').trim();
  return { text, imageKeys, attachments, ok: Boolean(text || imageKeys.length) };
}

// Short label used by the local inbox when a post carries only screenshots.
export function postInboxText(parsed) {
  if (!parsed) return '（富文本消息）';
  if (parsed.text) return parsed.text;
  if (parsed.imageKeys.length) return `（富文本：${parsed.imageKeys.length} 张图片）`;
  return '（富文本消息）';
}

// Real Feishu events use `message_type`, the REST read-back uses `msg_type`.
export function isRichTextMessage(type) {
  return String(type || '').toLowerCase() === 'post';
}
