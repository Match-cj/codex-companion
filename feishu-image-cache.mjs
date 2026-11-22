// One Feishu "post" can carry several DIFFERENT screenshots. The cache file
// name must include the image key: naming it only after the message id used to
// make every image in the same message overwrite the previous one, so Codex
// received N copies of the last screenshot (v1.0.61 and earlier).
//
// Pure path building lives here so the failure can be reproduced in a test:
// three different image keys must never resolve to one file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function feishuImageExtension(contentType) {
  const raw = String(contentType || '');
  if (/png/i.test(raw)) return '.png';
  if (/webp/i.test(raw)) return '.webp';
  if (/gif/i.test(raw)) return '.gif';
  return '.jpg';
}

export function feishuImageCachePath({ imageDir, messageId, imageKey, contentType }) {
  const safeId = String(messageId || '').replace(/[^a-z0-9_-]/gi, '_');
  const safeKey = createHash('sha256').update(String(imageKey || '')).digest('hex').slice(0, 12);
  return path.join(imageDir, `${safeId}-${safeKey}${feishuImageExtension(contentType)}`);
}

export async function saveFeishuImage({ imageDir, messageId, imageKey, contentType, writeFile, ttlMs = 60 * 60 * 1000 }) {
  if (typeof writeFile !== 'function') throw Error('图片消息缺少写入函数。');
  await fs.mkdir(imageDir, { recursive: true });
  const imagePath = feishuImageCachePath({ imageDir, messageId, imageKey, contentType });
  await writeFile(imagePath);
  const cleanup = setTimeout(() => fs.unlink(imagePath).catch(() => {}), ttlMs);
  cleanup.unref?.();
  return imagePath;
}
