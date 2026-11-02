import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * 账号库（accounts.vault.json）的结构校验。
 * 只要有一条记录缺 id 或 protected_auth 不够长，就整库判为无效——
 * 宁可拒绝写入，也不要写坏用户唯一的登录凭据。
 */
export function validNativeVault(vault) {
  return vault && vault.version === 1 && Array.isArray(vault.accounts)
    && vault.accounts.every(entry => entry && entry.id && typeof entry.protected_auth === 'string' && entry.protected_auth.length > 20);
}

/**
 * 账号库读写底座。
 *
 * 依赖全部由调用方注入，模块本身不 import 业务代码，方便单独测试：
 * - accountsPath / backupPath：主库与备份库路径
 * - readJson(path)：读到对象或 null，并把读取错误记进 jsonReadErrors
 * - jsonReadErrors：Map，用来解释"为什么读不到"
 * - atomicJsonWrite(path, value)：原子写（先写临时文件再替换）
 * - queueWrite(fn)：串行队列，避免备份/恢复/写入互相踩
 * - afterRestore()：恢复成功后让调用方清掉内存缓存
 */
export function createNativeVaultStore({
  accountsPath,
  backupPath,
  readJson,
  jsonReadErrors,
  atomicJsonWrite,
  queueWrite,
  afterRestore,
  pathApi = path,
  fileExists = existsSync,
} = {}) {
  if (!accountsPath || !backupPath) throw Error('账号库存储缺少路径。');
  if (typeof readJson !== 'function' || typeof atomicJsonWrite !== 'function' || typeof queueWrite !== 'function') {
    throw Error('账号库存储缺少必要的读写依赖。');
  }
  const errors = jsonReadErrors instanceof Map ? jsonReadErrors : new Map();

  async function readEffective() {
    const primary = await readJson(accountsPath);
    if (validNativeVault(primary)) return { vault: primary, source: 'primary', error: '' };
    const primaryError = errors.get(accountsPath) || '主账号库格式无效';
    const backup = await readJson(backupPath);
    if (validNativeVault(backup)) return { vault: backup, source: 'backup', error: primaryError };
    const backupError = errors.get(backupPath) || '备份账号库格式无效';
    return { vault: {}, source: 'none', error: `主库：${primaryError}；备份：${backupError}` };
  }

  async function write(vault, { preserveCurrent = true } = {}) {
    if (!validNativeVault(vault)) throw Error('原生账号库校验失败，已阻止写入。');
    if (preserveCurrent && fileExists(accountsPath)) {
      const current = await readJson(accountsPath);
      if (validNativeVault(current)) await atomicJsonWrite(backupPath, current);
    }
    await atomicJsonWrite(accountsPath, vault);
    const written = await readJson(accountsPath);
    if (!validNativeVault(written) || written.accounts.length !== vault.accounts.length) {
      throw Error('原生账号库写入后的完整性校验失败。');
    }
  }

  function backup() {
    return queueWrite(async () => {
      const vault = await readJson(accountsPath);
      if (!validNativeVault(vault)) throw Error('当前原生账号库不可用，不能创建备份。');
      await atomicJsonWrite(backupPath, vault);
      return { ok: true, count: vault.accounts.length, backupUpdatedAt: new Date().toISOString() };
    });
  }

  function restore() {
    return queueWrite(async () => {
      const backupVault = await readJson(backupPath);
      if (!validNativeVault(backupVault)) throw Error('没有找到可恢复的有效账号备份。');
      const current = await readJson(accountsPath);
      if (validNativeVault(current)) await atomicJsonWrite(pathApi.join(pathApi.dirname(accountsPath), 'accounts.vault.before-restore.json'), current);
      await write(backupVault, { preserveCurrent: false });
      if (typeof afterRestore === 'function') await afterRestore();
      return { ok: true, count: backupVault.accounts.length };
    });
  }

  return { readEffective, write, backup, restore };
}
