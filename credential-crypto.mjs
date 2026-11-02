// Credential protection: everything that touches Windows DPAPI goes through here.
//
// The vault stores AES-less payloads: each account's auth JSON is protected with
// DPAPI under the current Windows user, so the file is useless when copied to
// another machine or user. PowerShell does the DPAPI call; the value travels on
// stdin so a token never appears in a process command line.
import { spawn } from 'node:child_process';

export function runWithInput(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `凭据加密进程退出（${code}）`)));
    child.stdin.end(String(input || ''), 'utf8');
  });
}

export async function dpapiTransform(value, protect) {
  if (process.platform !== 'win32') throw Error('原生账号库目前需要 Windows。');
  const script = protect
    ? "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$e=[Text.Encoding]::UTF8.GetBytes('CodexCompanion/auth/v1');[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$e=[Text.Encoding]::UTF8.GetBytes('CodexCompanion/auth/v1');[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  return runWithInput('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], value);
}

export const protectCredential = value => dpapiTransform(String(value), true);
export const unprotectCredential = value => dpapiTransform(String(value), false);
