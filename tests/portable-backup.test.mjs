import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPortablePayload, decryptPortableAccountBackup, validatePortablePassword } from '../portable-backup.mjs';

// A two-letter token like "at" appears by chance in base64 ciphertext and in
// JSON field names, which made this assertion flaky. Use a realistic value.
const ACCESS_TOKEN = 'access-token-value-9f31';
const accounts = [{
  metadata: { id: 'acc-1', email: 'a@example.com' },
  alias: '主号',
  auth: { tokens: { access_token: ACCESS_TOKEN, refresh_token: 'rt', id_token: 'it' } },
}];

test('portable backup round-trips accounts with the same password', async () => {
  const envelope = await encryptPortablePayload(accounts, 'correct horse battery');
  assert.equal(envelope.type, 'codex-companion-portable-backup');
  assert.equal(envelope.encryption.cipher, 'AES-256-GCM');
  assert.ok(!JSON.stringify(envelope).includes(ACCESS_TOKEN), 'ciphertext must not leak tokens');
  const payload = await decryptPortableAccountBackup(envelope, 'correct horse battery');
  assert.equal(payload.accounts.length, 1);
  assert.equal(payload.accounts[0].alias, '主号');
  assert.equal(payload.accounts[0].auth.tokens.access_token, ACCESS_TOKEN);
});

test('a wrong password is reported as a wrong password, not a crash', async () => {
  const envelope = await encryptPortablePayload(accounts, 'correct horse battery');
  await assert.rejects(() => decryptPortableAccountBackup(envelope, 'wrong password!!'), /密码不正确/);
});

test('password rules stay enforced on both directions', async () => {
  await assert.rejects(() => encryptPortablePayload(accounts, 'short'), /至少需要 8 个字符/);
  assert.throws(() => validatePortablePassword(''), /至少需要 8 个字符/);
  const envelope = await encryptPortablePayload(accounts, '12345678');
  await assert.rejects(() => decryptPortableAccountBackup(envelope, 'x'), /至少需要 8 个字符/);
});

test('foreign or damaged envelopes are rejected with a readable reason', async () => {
  await assert.rejects(() => decryptPortableAccountBackup({ type: 'other', version: 1 }, '12345678'), /不是受支持的/);
  const envelope = await encryptPortablePayload(accounts, '12345678');
  const tampered = { ...envelope, ciphertext: Buffer.from('nope').toString('base64') };
  await assert.rejects(() => decryptPortableAccountBackup(tampered, '12345678'), /密码不正确|无效/);
});

test('an account without full tokens is refused at import time', async () => {
  const envelope = await encryptPortablePayload([{ metadata: {}, auth: { tokens: { access_token: 'only' } } }], '12345678');
  await assert.rejects(() => decryptPortableAccountBackup(envelope, '12345678'), /不完整的账号凭据/);
});
