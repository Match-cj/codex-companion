// Device-code login: Companion starts a throwaway Codex CLI instance in its own
// CODEX_HOME, asks it for a login code, shows the code to the user, and imports
// the resulting credentials once OpenAI confirms.
//
// The class owns no Companion state. Whatever it needs from the outside is
// injected: homeRoot (where the temporary profile may live) and importAccount
// (the vault write). That is what keeps it movable and testable.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { humanError } from './human-error.mjs';
import { codexLaunch } from './desktop-client.mjs';

export class DeviceLoginSession {
  constructor(name = '', { homeRoot = '', importAccount = async () => ({}) } = {}) {
    this.name = String(name || '').trim();
    this.id = randomUUID();
    this.root = path.join(homeRoot, 'device-login');
    this.home = path.join(this.root, this.id);
    this.importAccount = importAccount;
    this.pending = new Map();
    this.nextId = 0;
    this.proc = null;
    this.loginId = null;
    this.state = { status: 'starting', message: '正在生成安全登录码……' };
  }
  publicState() { return { ...this.state, loginId: this.loginId }; }
  async start() {
    await fs.mkdir(this.home, { recursive: true });
    const { command, args } = codexLaunch();
    this.proc = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: this.home } });
    this.proc.stdout.setEncoding('utf8');
    let buffer = '';
    this.proc.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) this.receive(line); });
    this.proc.stderr.on('data', data => console.error('[device login]', String(data).trim()));
    this.proc.on('exit', code => {
      if (['starting', 'waiting'].includes(this.state.status)) this.state = { status: 'failed', message: `登录服务意外结束（代码 ${code ?? '-'}），请重试。` };
    });
    await this.request('initialize', { clientInfo: { name: 'codex_companion_login', title: 'Codex Companion Login', version: '0.1.7' } });
    this.send({ method: 'initialized', params: {} });
    const result = await this.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (result?.type !== 'chatgptDeviceCode') throw Error('Codex 没有返回设备登录码，请更新 Codex CLI 后重试。');
    this.loginId = result.loginId;
    this.state = { status: 'waiting', verificationUrl: result.verificationUrl, userCode: result.userCode, message: '请打开登录页并输入这个一次性代码。' };
    return this.publicState();
  }
  send(value) { this.proc?.stdin.write(`${JSON.stringify(value)}\n`); }
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} 超时`)); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }
  receive(line) {
    if (!line.trim()) return;
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id); clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(Error(message.error.message || JSON.stringify(message.error))); else pending.resolve(message.result);
      return;
    }
    if (message.method === 'account/login/completed' && (!this.loginId || message.params?.loginId === this.loginId)) this.finish(message.params || {});
  }
  async finish(result) {
    if (!result.success) {
      this.state = { status: 'failed', message: `登录没有完成：${result.error || 'OpenAI 没有接受这次登录，请重试。'}` };
      await this.cleanup(); return;
    }
    this.state = { status: 'importing', message: '登录成功，正在安全加入 Companion 账号库……' };
    try {
      const authPath = path.join(this.home, 'auth.json');
      let contents = '';
      for (let i = 0; i < 20 && !contents; i++) { try { contents = await fs.readFile(authPath, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 250)); } }
      if (!contents) throw Error('登录已通过，但没有找到账号凭据。请重试。');
      const imported = await this.importAccount(contents, this.name);
      this.state = { status: 'completed', accountName: imported?.name || imported?.email || this.name || '新账号', message: imported?.updated ? '原有账号的登录已经更新，可以继续使用。' : '新账号已加入账号列表，可以直接使用。' };
    } catch (error) {
      this.state = { status: 'failed', message: humanError(error) };
    } finally { await this.cleanup(); }
  }
  async cancel() {
    try { if (this.loginId) await this.request('account/login/cancel', { loginId: this.loginId }); } catch {}
    this.state = { status: 'canceled', message: '已取消这次登录。' };
    await this.cleanup();
  }
  async cleanup() {
    try { this.proc?.kill(); } catch {}
    const root = path.resolve(this.root) + path.sep;
    const target = path.resolve(this.home);
    if (target.startsWith(root)) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
}
