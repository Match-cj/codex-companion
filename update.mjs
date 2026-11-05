// Update check + in-place patch helpers.
//
// The full installer is ~176 MB, but almost all of it is the bundled Node
// runtime and the Codex CLI binary. Our own code is a few hundred KB, so a
// release also carries a small "patch" zip: the same files, only re-copied when
// their hash differs. Nothing here runs on its own — a check is a read-only
// HTTP GET, and applying is always an explicit user action.
import { createHash } from 'node:crypto';

export const DEFAULT_FEED = 'https://api.github.com/repos/Match-cj/codex-companion/releases/latest';
// Release asset that carries the in-app update. The version is in the name so a
// stale download can never be mistaken for the current one.
export const PATCH_ASSET_PATTERN = /^CodexCompanion-Patch-v([0-9][0-9.]*)\.zip$/i;
export const MANIFEST_NAME = 'update-manifest.json';

export function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '');
}

// Two update policies, and only two: install by itself while the machine is
// idle, or wait until the user clicks the badge. Anything more is a setting
// nobody can reason about.
export const UPDATE_MODES = ['auto', 'notify'];
export const DEFAULT_UPDATE_MODE = 'auto';
// "Idle" is 5 straight minutes without touching the mouse or keyboard, with no
// task running and nothing waiting for confirmation.
export const DEFAULT_IDLE_SECONDS = 300;

export function normalizeUpdateMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return UPDATE_MODES.includes(text) ? text : DEFAULT_UPDATE_MODE;
}

// Decides whether a new version may be installed without asking. Every "no" has
// its own reason so the badge, the log and the page can say why it is waiting
// instead of silently doing nothing.
export function idleUpdateDecision({
  mode = DEFAULT_UPDATE_MODE,
  available = false,
  canApply = false,
  applying = false,
  runningTasks = 0,
  pendingApprovals = 0,
  idleSeconds = null,
  minIdleSeconds = DEFAULT_IDLE_SECONDS,
} = {}) {
  if (normalizeUpdateMode(mode) !== 'auto') return { apply: false, reason: 'notify-only' };
  if (!available) return { apply: false, reason: 'up-to-date' };
  if (!canApply) return { apply: false, reason: 'needs-installer' };
  if (applying) return { apply: false, reason: 'already-running' };
  if (Number(runningTasks) > 0) return { apply: false, reason: 'tasks-running' };
  if (Number(pendingApprovals) > 0) return { apply: false, reason: 'waiting-confirmation' };
  // Unknown idle time means we could be interrupting something; wait rather
  // than guess. The next check retries once the idle probe answers again.
  if (idleSeconds === null || idleSeconds === undefined || !Number.isFinite(Number(idleSeconds))) {
    return { apply: false, reason: 'idle-unknown' };
  }
  if (Number(idleSeconds) < Number(minIdleSeconds)) return { apply: false, reason: 'user-active' };
  return { apply: true, reason: 'idle' };
}

function versionParts(value) {
  return normalizeVersion(value).split('.').map(part => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

// -1 when a < b, 1 when a > b, 0 when equal. Non-numeric parts count as 0 so a
// malformed tag can never make the updater think it is behind forever.
export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const one = left[index] ?? 0;
    const two = right[index] ?? 0;
    if (one !== two) return one < two ? -1 : 1;
  }
  return 0;
}

// Files come from a zip we downloaded, so every path is checked before it can
// be written anywhere: relative, no drive letter, no "..", no leading slash.
export function isSafeRelativePath(value) {
  const text = String(value ?? '');
  if (!text || text.length > 240) return false;
  if (text.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(text)) return false;
  if (text.startsWith('/') || text.startsWith('\\')) return false;
  const parts = text.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  return true;
}

export function pickPatchAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  for (const asset of assets) {
    const match = String(asset?.name || '').match(PATCH_ASSET_PATTERN);
    if (!match) continue;
    if (!asset.browser_download_url) continue;
    return {
      name: asset.name,
      url: asset.browser_download_url,
      size: Number(asset.size) || 0,
      version: normalizeVersion(match[1]),
    };
  }
  return null;
}

// The release body carries "PATCH-SHA256: <hex>" next to the installer hash so
// a truncated or swapped download is rejected before anything is replaced.
export function readPatchSha(body) {
  const match = String(body || '').match(/PATCH[-_ ]?SHA256:\s*`?([0-9a-f]{64})`?/i);
  return match ? match[1].toLowerCase() : null;
}

// Dependencies must match between the patch and the installed copy. When they
// differ the patch cannot work on its own (node_modules is not shipped in it),
// so the caller falls back to asking for the full installer.
export function depsFingerprint(packageJson) {
  const deps = packageJson?.dependencies && typeof packageJson.dependencies === 'object'
    ? Object.entries(packageJson.dependencies).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const devDeps = packageJson?.devDependencies && typeof packageJson.devDependencies === 'object'
    ? Object.entries(packageJson.devDependencies).sort(([a], [b]) => a.localeCompare(b))
    : [];
  return createHash('sha256')
    .update(JSON.stringify({ deps, devDeps }))
    .digest('hex')
    .slice(0, 32);
}

export function firstLines(text, count = 3) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    // Release notes are Markdown; the banner is plain text, so drop emphasis
    // markers instead of showing stray ** and backticks.
    .map(line => line.trim().replace(/\*\*/g, '').replace(/`/g, ''))
    .filter(line => line && !/^#{1,6}\s/.test(line) && !/^[-=]{3,}$/.test(line) && !/SHA256/i.test(line))
    .slice(0, count)
    .join('\n');
}

// Normalizes one GitHub "latest release" response into what the UI needs.
export function summarizeRelease(release, currentVersion) {
  const latest = normalizeVersion(release?.tag_name || release?.name || '');
  const patch = pickPatchAsset(release);
  const available = Boolean(latest) && compareVersions(latest, currentVersion) > 0;
  return {
    current: normalizeVersion(currentVersion),
    latest,
    available,
    notes: firstLines(release?.body, 4),
    publishedAt: release?.published_at || null,
    htmlUrl: release?.html_url || null,
    patch: patch && available && compareVersions(patch.version, currentVersion) > 0
      ? { name: patch.name, url: patch.url, size: patch.size, sha256: readPatchSha(release?.body) }
      : null,
    requiresFullInstaller: available && !(patch && compareVersions(patch.version, currentVersion) > 0),
  };
}
