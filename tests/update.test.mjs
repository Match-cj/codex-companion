import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  normalizeVersion,
  isSafeRelativePath,
  pickPatchAsset,
  readPatchSha,
  depsFingerprint,
  firstLines,
  summarizeRelease,
  PATCH_ASSET_PATTERN,
} from '../update.mjs';

test('version comparison follows numeric order, not string order', () => {
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('v1.0.37', '1.0.37'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.1', '1.0.99'), 1);
});

test('normalizeVersion strips a leading v and whitespace', () => {
  assert.equal(normalizeVersion('  v1.0.37 '), '1.0.37');
  assert.equal(normalizeVersion(null), '');
});

test('patch asset names carry the version', () => {
  const match = 'CodexCompanion-Patch-v1.0.38.zip'.match(PATCH_ASSET_PATTERN);
  assert.ok(match);
  assert.equal(match[1], '1.0.38');
  assert.equal('codexcompanion-patch-v2.0.0.zip'.match(PATCH_ASSET_PATTERN)[1], '2.0.0');
  assert.equal('CodexCompanion-Setup-v1.0.38.exe'.match(PATCH_ASSET_PATTERN), null);
});

test('unsafe manifest paths are rejected', () => {
  assert.equal(isSafeRelativePath('server.mjs'), true);
  assert.equal(isSafeRelativePath('lib/thing.mjs'), true);
  for (const bad of ['', '../escape.mjs', 'a/../../b', 'C:\\Windows\\x', '/etc/passwd', 'a//b', './x', 'a\\..\\b']) {
    assert.equal(isSafeRelativePath(bad), false, bad);
  }
});

test('pickPatchAsset ignores installers and assets without a url', () => {
  const release = {
    tag_name: 'v1.0.38',
    assets: [
      { name: 'CodexCompanion-Setup-v1.0.38.exe', browser_download_url: 'https://x/setup', size: 1 },
      { name: 'CodexCompanion-Patch-v1.0.38.zip', browser_download_url: 'https://x/patch', size: 2048 },
      { name: 'CodexCompanion-Patch-v1.0.37.zip', size: 2048 },
    ],
  };
  const patch = pickPatchAsset(release);
  assert.equal(patch.name, 'CodexCompanion-Patch-v1.0.38.zip');
  assert.equal(patch.url, 'https://x/patch');
  assert.equal(patch.version, '1.0.38');
  assert.equal(pickPatchAsset({ assets: [] }), null);
});

test('patch sha is read from the release body', () => {
  const sha = 'a'.repeat(64);
  assert.equal(readPatchSha(`some notes\n\nPATCH-SHA256: ${sha}\n`), sha);
  assert.equal(readPatchSha(`PATCH-SHA256: \`${sha}\``), sha);
  assert.equal(readPatchSha('no hash here'), null);
});

test('dependency fingerprint changes only when versions change', () => {
  const base = { dependencies: { a: '1.0.0', b: '2.0.0' } };
  assert.equal(depsFingerprint(base), depsFingerprint({ dependencies: { b: '2.0.0', a: '1.0.0' } }));
  assert.notEqual(depsFingerprint(base), depsFingerprint({ dependencies: { a: '1.0.1', b: '2.0.0' } }));
  assert.notEqual(depsFingerprint(base), depsFingerprint({ dependencies: { a: '1.0.0' } }));
  assert.equal(depsFingerprint(null), depsFingerprint({}));
});

test('release notes keep readable lines only', () => {
  const body = '# 更新日志\n\n- 修复 A\n- 修复 B\n\nSHA256: `abc`\n---\n- 第三行\n';
  assert.equal(firstLines(body, 3), '- 修复 A\n- 修复 B\n- 第三行');
});

test('summarizeRelease reports availability and falls back without a patch', () => {
  const sha = 'b'.repeat(64);
  const full = summarizeRelease({
    tag_name: 'v1.0.38',
    body: `- 新功能\nPATCH-SHA256: ${sha}`,
    html_url: 'https://github.com/x/y/releases/tag/v1.0.38',
    assets: [{ name: 'CodexCompanion-Patch-v1.0.38.zip', browser_download_url: 'https://x/p', size: 4096 }],
  }, '1.0.37');
  assert.equal(full.available, true);
  assert.equal(full.patch.sha256, sha);
  assert.equal(full.requiresFullInstaller, false);

  const noPatch = summarizeRelease({ tag_name: 'v1.0.38', assets: [] }, '1.0.37');
  assert.equal(noPatch.patch, null);
  assert.equal(noPatch.requiresFullInstaller, true);

  const current = summarizeRelease({ tag_name: 'v1.0.37', assets: [] }, '1.0.37');
  assert.equal(current.available, false);
  assert.equal(current.requiresFullInstaller, false);

  const behind = summarizeRelease({ tag_name: 'v1.0.30', assets: [] }, '1.0.37');
  assert.equal(behind.available, false);
});
