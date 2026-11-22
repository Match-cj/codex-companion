import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { feishuImageCachePath, feishuImageExtension, saveFeishuImage } from '../feishu-image-cache.mjs';

// Reproduces the real 2026-11-22 report: one Feishu post with three different
// screenshots (220514 / 238146 / 128638 bytes, all image/jpeg) arrived in Codex
// as three copies of the last dark screenshot. The old cache name used only the
// message id, so all three downloads wrote the same file.
const MESSAGE_ID = 'om_x100b7f109d7148a0b375af5432a76b6';
const KEYS = [
  'img_v3_021a_aaaaaaaa-1111-2222-3333-444444444444',
  'img_v3_021a_bbbbbbbb-1111-2222-3333-444444444444',
  'img_v3_021a_cccccccc-1111-2222-3333-444444444444',
];

test('one message with three different screenshots gets three different cache paths', () => {
  const imageDir = path.join(os.tmpdir(), 'cc-cache');
  const paths = KEYS.map(imageKey => feishuImageCachePath({ imageDir, messageId: MESSAGE_ID, imageKey, contentType: 'image/jpeg' }));
  assert.equal(new Set(paths).size, 3);
  for (const p of paths) {
    assert.ok(p.startsWith(imageDir));
    assert.ok(p.endsWith('.jpg'));
    assert.doesNotMatch(p, /img_v3_/);
  }
});

test('the same image key reuses one path, and the extension follows the content type', () => {
  const args = { imageDir: os.tmpdir(), messageId: MESSAGE_ID, imageKey: KEYS[0], contentType: 'image/jpeg' };
  assert.equal(feishuImageCachePath(args), feishuImageCachePath(args));
  assert.equal(feishuImageExtension('image/png'), '.png');
  assert.equal(feishuImageExtension('image/webp'), '.webp');
  assert.equal(feishuImageExtension('image/gif'), '.gif');
  assert.equal(feishuImageExtension('image/jpeg'), '.jpg');
  assert.equal(feishuImageExtension(''), '.jpg');
  const png = feishuImageCachePath({ ...args, contentType: 'image/png' });
  assert.ok(png.endsWith('.png'));
  assert.notEqual(png, feishuImageCachePath(args));
});

test('writing three real screenshots keeps all three intact (the actual failure)', async () => {
  const imageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-feishu-img-'));
  const payloads = [
    Buffer.from('FIRST-SCREENSHOT-220514'),
    Buffer.from('SECOND-SCREENSHOT-238146'),
    Buffer.from('THIRD-SCREENSHOT-128638'),
  ];
  try {
    const paths = [];
    for (let i = 0; i < KEYS.length; i++) {
      paths.push(await saveFeishuImage({
        imageDir, messageId: MESSAGE_ID, imageKey: KEYS[i], contentType: 'image/jpeg',
        writeFile: async target => { await fs.writeFile(target, payloads[i]); },
      }));
    }
    assert.equal(new Set(paths).size, 3, 'three screenshots must not collapse into one file');
    for (let i = 0; i < payloads.length; i++) assert.deepEqual(await fs.readFile(paths[i]), payloads[i]);
    const hashes = await Promise.all(paths.map(async p => createHash('sha256').update(await fs.readFile(p)).digest('hex')));
    assert.equal(new Set(hashes).size, 3);
  } finally {
    await fs.rm(imageDir, { recursive: true, force: true });
  }
});

test('server forwards every post image through the per-image cache path', async () => {
  const source = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ saveFeishuImage \} from '\.\/feishu-image-cache\.mjs'/);
  assert.match(source, /for \(const imageKey of parsed\.imageKeys\)/);
  assert.match(source, /messageId,\s*\n\s*imageKey,\s*\n\s*contentType: rawType/);
  assert.doesNotMatch(source, /path\.join\(imageDir, `\$\{safeId\}\$\{extension\}`\)/);
});
