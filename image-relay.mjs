import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const IMAGE_LIMIT = 10 * 1024 * 1024;
export function finalImagePaths(text, extraPaths = []) {
  const paths = [];
  // Only explicit Markdown images, never plain links, tool input or remote URLs.
  for (const match of String(text || '').matchAll(/!\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^\s)]+)\s*\)/g)) {
    let target = match[1].replace(/^<|>$/g, '').replace(/^sandbox:/, '');
    try { target = decodeURIComponent(target); } catch { continue; }
    if (process.platform === 'win32' && /^\/[a-z]:\//i.test(target)) target = target.slice(1);
    if (!path.isAbsolute(target) || /^[/\\]{2}/.test(target) || !/\.(png|jpe?g|webp|gif)$/i.test(target)) continue;
    if (!paths.includes(target)) paths.push(target);
  }
  for (const candidate of extraPaths || []) {
    const target = String(candidate || '').trim();
    if (target && !paths.includes(target)) paths.push(target);
  }
  return paths.slice(0, 6);
}

export function imageSignatureMatches(bytes, extension) {
  const ext = extension.toLowerCase();
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (['.jpg','.jpeg'].includes(ext)) return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (ext === '.gif') return ['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString());
  if (ext === '.webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}

export async function validateImageRoot(root) {
  if (!path.isAbsolute(root) || /^[/\\]{2}/.test(root)) throw Error('请选择本机的具体图片目录，不能使用网络目录。');
  const real = await fs.realpath(root);
  if (real === path.parse(real).root || !(await fs.stat(real)).isDirectory()) throw Error('不能授权整个磁盘，请选择具体图片目录。');
  return real;
}

export async function readRelayImage(file, root, { trusted = false } = {}) {
  const realRoot = trusted ? null : await validateImageRoot(root);
  const realFile = await fs.realpath(file);
  if (!trusted) {
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('图片不在授权目录内。');
  }
  const handle = await fs.open(realFile, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > IMAGE_LIMIT) throw Error('图片为空、不是普通文件或超过 10MB。');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('图片读取不完整。');
      offset += bytesRead;
    }
    if (!imageSignatureMatches(bytes, path.extname(file))) throw Error('图片格式与扩展名不匹配。');
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

export async function relayFinalImages({ text, paths = [], trustedPaths = [], root, enabled, send, report }) {
  if (!enabled) return { sent: 0, failed: 0 };
  const hashes = new Set();
  let sent = 0, failed = 0;
  const trusted = new Set((trustedPaths || []).map(String));
  for (const file of finalImagePaths(text, paths)) {
    try {
      const image = await readRelayImage(file, root, { trusted: trusted.has(file) });
      if (hashes.has(image.digest)) continue;
      hashes.add(image.digest);
      await send(image.bytes);
      sent++;
    } catch { failed++; }
  }
  if (failed) await report('部分图片未回传：检查授权目录、文件格式/大小、机器人连接及图片上传权限。文字通知不受影响。');
  return { sent, failed };
}
