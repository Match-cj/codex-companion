// Temporary CODEX_HOME folders used for isolated quota reads / warm-ups.
//
// Codex keeps sqlite -shm/-wal files open briefly after its process exits, so
// a single fs.rm() can fail and leave a UUID folder behind. Those leftovers
// used to pile up for months (and some still held a plain-text auth.json).
// This module owns both the per-run cleanup and the one-off startup sweep.
import fs from 'node:fs/promises';
import path from 'node:path';

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never let a caller delete anything outside the two folders Companion owns.
function insideRoot(root, home) {
  return path.resolve(home).startsWith(path.resolve(root) + path.sep);
}

// Deleting the folder can fail while Codex still holds a sqlite handle, so the
// credential file is wiped first. A leftover folder is harmless; a leftover
// access token is not.
export async function wipeAndRemoveHome(home, root) {
  if (!insideRoot(root, home)) return false;
  const auth = path.join(home, 'auth.json');
  await fs.writeFile(auth, '{}', 'utf8').catch(() => {});
  try {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

export async function sweepStaleHomes(root, {
  maxAgeMs = 60 * 60 * 1000,
  limit = 2000,
  now = Date.now(),
  concurrency = 6,
} = {}) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return { scanned: 0, removed: 0, wiped: 0, kept: 0 }; }
  const candidates = entries.filter(entry => entry.isDirectory() && UUID_NAME.test(entry.name));
  const result = { scanned: candidates.length, removed: 0, wiped: 0, kept: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length && result.removed + result.kept < limit) {
      const entry = candidates[cursor++];
      const home = path.join(root, entry.name);
      let stat;
      try { stat = await fs.stat(home); } catch { continue; }
      const auth = path.join(home, 'auth.json');
      // Scrub credentials even when the folder is too new to delete.
      try { await fs.writeFile(auth, '{}', 'utf8'); result.wiped++; } catch {}
      if (now - stat.mtimeMs < maxAgeMs) { result.kept++; continue; }
      try {
        await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        result.removed++;
      } catch { result.kept++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, worker));
  return result;
}
