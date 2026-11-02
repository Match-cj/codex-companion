// Portable backup envelope: password-derived AES-256-GCM, so an exported file can
// move between machines. Decryption never trusts the envelope shape, and every
// failure is reported as "password wrong or file damaged" unless it is a
// structure error the user can act on.
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scryptCallback);

export const PORTABLE_BACKUP_TYPE = 'codex-companion-portable-backup';
const PORTABLE_BACKUP_AAD = Buffer.from('CodexCompanion/portable-backup/v1', 'utf8');
const PORTABLE_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1 });

export function validatePortablePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw Error('迁移备份密码至少需要 8 个字符。');
  if (Buffer.byteLength(value, 'utf8') > 256) throw Error('迁移备份密码过长。');
  return value;
}

async function derivePortableBackupKey(password, salt) {
  return await scryptAsync(validatePortablePassword(password), salt, 32, { ...PORTABLE_SCRYPT, maxmem: 64 * 1024 * 1024 });
}

export async function encryptPortablePayload(accounts, password) {
  const plaintext = Buffer.from(JSON.stringify({ version: 1, created_at: new Date().toISOString(), accounts }), 'utf8');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await derivePortableBackupKey(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(PORTABLE_BACKUP_AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      type: PORTABLE_BACKUP_TYPE,
      version: 1,
      encryption: { cipher: 'AES-256-GCM', kdf: 'scrypt', N: PORTABLE_SCRYPT.N, r: PORTABLE_SCRYPT.r, p: PORTABLE_SCRYPT.p, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      ciphertext: ciphertext.toString('base64'),
    };
  } finally { key.fill(0); plaintext.fill(0); }
}

function decodePortableField(value, expectedLength, label) {
  let decoded;
  try { decoded = Buffer.from(String(value || ''), 'base64'); } catch { throw Error(`迁移备份的${label}无效。`); }
  if (decoded.length !== expectedLength) throw Error(`迁移备份的${label}无效。`);
  return decoded;
}

export async function decryptPortableAccountBackup(envelope, password) {
  if (!envelope || envelope.type !== PORTABLE_BACKUP_TYPE || envelope.version !== 1) throw Error('这不是受支持的 Codex Companion 迁移备份。');
  if (envelope.encryption?.cipher !== 'AES-256-GCM' || envelope.encryption?.kdf !== 'scrypt') throw Error('迁移备份使用了不支持的加密方式。');
  if (String(envelope.ciphertext || '').length > 8 * 1024 * 1024) throw Error('迁移备份文件过大。');
  const salt = decodePortableField(envelope.encryption.salt, 16, '盐值');
  const iv = decodePortableField(envelope.encryption.iv, 12, '随机数');
  const tag = decodePortableField(envelope.encryption.tag, 16, '校验值');
  const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  const key = await derivePortableBackupKey(password, salt);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(PORTABLE_BACKUP_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (payload?.version !== 1 || !Array.isArray(payload.accounts) || !payload.accounts.length || payload.accounts.length > 100) throw Error('迁移备份内没有有效账号。');
    for (const account of payload.accounts) {
      if (!account?.auth?.tokens?.id_token || !account.auth.tokens.access_token || !account.auth.tokens.refresh_token) throw Error('迁移备份内有不完整的账号凭据。');
    }
    return payload;
  } catch (error) {
    if (/迁移备份/.test(String(error?.message || ''))) throw error;
    throw Error('密码不正确，或迁移备份已经损坏。');
  } finally { key.fill(0); if (plaintext) plaintext.fill(0); }
}
