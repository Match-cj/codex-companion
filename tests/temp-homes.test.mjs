import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sweepStaleHomes, wipeAndRemoveHome } from '../temp-homes.mjs';

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-temp-homes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

test('startup sweep deletes old UUID homes and scrubs credentials in every one', async t => {
  const root = await makeRoot(t);
  const oldHome = path.join(root, '0012be09-da47-43f7-bf77-b3d180eced32');
  const freshHome = path.join(root, '9dae0840-8bab-4d5a-b885-52c0cafe0001');
  const unrelated = path.join(root, 'keep-me');
  for (const dir of [oldHome, freshHome, unrelated]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(oldHome, 'auth.json'), '{"tokens":{"access_token":"secret"}}');
  await fs.writeFile(path.join(freshHome, 'auth.json'), '{"tokens":{"access_token":"secret"}}');
  await fs.writeFile(path.join(unrelated, 'auth.json'), '{"tokens":{"access_token":"secret"}}');
  await fs.writeFile(path.join(root, 'notes.txt'), 'not a folder');
  const twoDaysAgo = Date.now() - 2 * 86400 * 1000;
  await fs.utimes(oldHome, new Date(twoDaysAgo), new Date(twoDaysAgo));

  const result = await sweepStaleHomes(root, { maxAgeMs: 3600000, now: Date.now(), limit: 50 });
  assert.equal(result.scanned, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.kept, 1);
  assert.equal(result.wiped, 2);
  assert.equal(await fs.readFile(path.join(freshHome, 'auth.json'), 'utf8'), '{}');
  assert.equal(await fs.readFile(path.join(unrelated, 'auth.json'), 'utf8'), '{"tokens":{"access_token":"secret"}}');
  assert.equal(await fs.stat(path.join(root, 'notes.txt')).then(() => true, () => false), true);
  assert.equal(await fs.stat(oldHome).then(() => true, () => false), false);
});

test('a fresh run wipes its token before removing the folder', async t => {
  const root = await makeRoot(t);
  const home = path.join(root, '685300a2-45dc-4b38-ae86-4dd000000001');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'auth.json'), '{"tokens":{"access_token":"secret"}}');
  assert.equal(await wipeAndRemoveHome(home, root), true);
  assert.equal(await fs.stat(home).then(() => true, () => false), false);
});

test('cleanup refuses any path outside the folder Companion owns', async t => {
  const root = await makeRoot(t);
  const outside = path.join(root, '..', `outside-${path.basename(root)}`);
  await fs.mkdir(outside, { recursive: true });
  t.after(() => fs.rm(outside, { recursive: true, force: true }).catch(() => {}));
  assert.equal(await wipeAndRemoveHome(outside, root), false);
  assert.equal(await fs.stat(outside).then(() => true, () => false), true);
  const result = await sweepStaleHomes(path.join(root, 'does-not-exist'));
  assert.deepEqual(result, { scanned: 0, removed: 0, wiped: 0, kept: 0 });
});
