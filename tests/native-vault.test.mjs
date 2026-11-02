import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { validNativeVault, createNativeVaultStore } from '../native-vault.mjs';

function vaultOf(...ids) {
  return { version: 1, accounts: ids.map(id => ({ id, name: id, protected_auth: 'x'.repeat(40) })) };
}

async function makeStore(initial = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-vault-'));
  const accountsPath = path.join(dir, 'accounts.vault.json');
  const backupPath = path.join(dir, 'accounts.vault.backup.json');
  const files = new Map();
  const errors = new Map();
  for (const [key, value] of Object.entries(initial)) {
    files.set(key === 'primary' ? accountsPath : key === 'backup' ? backupPath : key, JSON.stringify(value));
  }
  const store = createNativeVaultStore({
    accountsPath,
    backupPath,
    jsonReadErrors: errors,
    readJson: async file => {
      if (!files.has(file)) { if (!errors.has(file)) errors.set(file, '文件不存在'); return null; }
      return JSON.parse(files.get(file));
    },
    fileExists: file => files.has(file),
    atomicJsonWrite: async (file, value) => { files.set(file, JSON.stringify(value)); },
    queueWrite: action => action(),
    afterRestore: async () => { await fs.writeFile(path.join(dir, 'restored.flag'), '1'); },
  });
  return { store, files, errors, dir, accountsPath, backupPath };
}

test('validNativeVault rejects malformed vaults', () => {
  assert.equal(validNativeVault(vaultOf('a')), true);
  assert.equal(validNativeVault({ version: 2, accounts: [] }), false);
  assert.equal(validNativeVault({ version: 1, accounts: [{ id: 'a' }] }), false);
  assert.equal(validNativeVault({ version: 1, accounts: [{ id: 'a', protected_auth: 'short' }] }), false);
  assert.ok(!validNativeVault(null));
});

test('readEffective prefers the primary vault', async () => {
  const { store } = await makeStore({ primary: vaultOf('a', 'b') });
  const result = await store.readEffective();
  assert.equal(result.source, 'primary');
  assert.equal(result.error, '');
  assert.equal(result.vault.accounts.length, 2);
});

test('readEffective falls back to the backup and reports why the primary failed', async () => {
  const { store, errors, accountsPath } = await makeStore({ backup: vaultOf('a') });
  errors.set(accountsPath, 'JSON 解析失败');
  const result = await store.readEffective();
  assert.equal(result.source, 'backup');
  assert.equal(result.error, 'JSON 解析失败');
  assert.equal(result.vault.accounts.length, 1);
});

test('readEffective reports both sides when nothing is usable', async () => {
  const { store } = await makeStore({});
  const result = await store.readEffective();
  assert.equal(result.source, 'none');
  assert.match(result.error, /主库：.*；备份：/);
});

test('write refuses malformed vaults instead of corrupting credentials', async () => {
  const { store, files } = await makeStore({});
  await assert.rejects(() => store.write({ version: 1, accounts: [{ id: 'a' }] }), /已阻止写入/);
  assert.equal(files.size, 0);
});

test('write verifies what it wrote and keeps the previous vault as backup', async () => {
  const { store, files, accountsPath, backupPath } = await makeStore({});
  await store.write(vaultOf('a'));
  assert.equal(JSON.parse(files.get(accountsPath)).accounts.length, 1);
  await store.write(vaultOf('a', 'b'), { preserveCurrent: true });
  assert.equal(JSON.parse(files.get(accountsPath)).accounts.length, 2);
  assert.equal(JSON.parse(files.get(backupPath)).accounts.length, 1);
});

test('backup refuses an unusable current vault', async () => {
  const { store } = await makeStore({});
  await assert.rejects(() => store.backup(), /不可用/);
});

test('backup copies the current vault to the backup path', async () => {
  const { store, files, backupPath } = await makeStore({ primary: vaultOf('a', 'b') });
  const result = await store.backup();
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(JSON.parse(files.get(backupPath)).accounts.length, 2);
});

test('restore swaps in the backup, snapshots the current vault and clears caches', async () => {
  const { store, files, dir, accountsPath, backupPath } = await makeStore({
    primary: vaultOf('current'),
    backup: vaultOf('old'),
  });
  const result = await store.restore();
  assert.deepEqual(result, { ok: true, count: 1 });
  assert.equal(JSON.parse(files.get(accountsPath)).accounts[0].id, 'old');
  assert.equal(JSON.parse(files.get(path.join(dir, 'accounts.vault.before-restore.json'))).accounts[0].id, 'current');
  assert.equal(JSON.parse(files.get(backupPath)).accounts[0].id, 'old');
  await fs.access(path.join(dir, 'restored.flag'));
});

test('restore refuses when there is no valid backup', async () => {
  const { store } = await makeStore({});
  await assert.rejects(() => store.restore(), /没有找到可恢复/);
});
