import fs from 'node:fs/promises';
import path from 'node:path';

export const HTML_LIMIT = 20 * 1024 * 1024;

export function finalHtmlPaths(text, extraPaths = []) {
  const paths = [];
  for (const match of String(text || '').matchAll(/(?:\[[^\]\r\n]*\]\()?(<[^>\r\n]+>|(?:[A-Za-z]:[\\/]|\/)[^\s)<>\r\n]+\.(?:html?|HTML?))(?:\))?/g)) {
    let target = String(match[1] || '').replace(/^<|>$/g, '').replace(/^sandbox:/, '');
    try { target = decodeURIComponent(target); } catch { continue; }
    if (process.platform === 'win32' && /^\/[a-z]:\//i.test(target)) target = target.slice(1);
    if (path.isAbsolute(target) && !/^[/\\]{2}/.test(target) && !paths.includes(target)) paths.push(target);
  }
  for (const candidate of extraPaths || []) {
    const target = String(candidate || '').trim();
    if (target && path.isAbsolute(target) && !/^[/\\]{2}/.test(target) && !paths.includes(target)) paths.push(target);
  }
  return paths.slice(0, 6);
}

export async function readRelayHtml(file, { trusted = false, root = '' } = {}) {
  const realFile = await fs.realpath(file);
  if (!trusted) {
    if (!root || !path.isAbsolute(root)) throw Error('未授权 HTML 目录');
    const realRoot = await fs.realpath(root);
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('HTML 不在授权目录内');
  }
  if (!/\.html?$/i.test(realFile)) throw Error('仅支持 HTML 文件');
  const stat = await fs.stat(realFile);
  if (!stat.isFile() || !stat.size || stat.size > HTML_LIMIT) throw Error('HTML 文件为空、不是普通文件或超过 20MB');
  return { bytes: await fs.readFile(realFile), name: path.basename(realFile) };
}

