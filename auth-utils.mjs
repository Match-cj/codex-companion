// Small helpers around OpenAI credentials and the local OAuth callback port.
//
// Nothing here touches Companion state: JWTs are just base64, and the port
// check only reads the OS. That is why these could leave server.mjs as-is.
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

// The id_token carries the account e-mail, plan and account id. Decoding is
// best-effort: a malformed token simply yields no claims, never a throw.
export function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}
export function jwtExpiry(token) {
  const value = Number(decodeJwtPayload(token).exp);
  return Number.isFinite(value) ? value : 0;
}

// Browser login needs 127.0.0.1:1455 free for its redirect. Windows sometimes
// reserves a port range without showing a listener, so an idle port is still
// probe-bound before being reported usable.
export async function oauthPortStatus() {
  if (process.platform !== 'win32') return { requiredPort: 1455, free: true, owner: null, switcherPids: [], switcherPorts: [] };
  const script = `
$listener = Get-NetTCPConnection -State Listen -LocalPort 1455 -ErrorAction SilentlyContinue | Select-Object -First 1
$owner = if ($listener) { Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue } else { $null }
$switchers = @(Get-Process -Name 'codex-switcher' -ErrorAction SilentlyContinue)
$switcherIds = @($switchers | ForEach-Object { $_.Id })
$switcherPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $switcherIds -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)
[pscustomobject]@{
  requiredPort = 1455
  free = ($null -eq $listener)
  owner = if ($owner) { [pscustomobject]@{ name = $owner.ProcessName; pid = $owner.Id } } else { $null }
  switcherPids = $switcherIds
  switcherPorts = $switcherPorts
} | ConvertTo-Json -Compress -Depth 4
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  const result = JSON.parse(stdout.trim());
  result.switcherPids = Array.isArray(result.switcherPids) ? result.switcherPids : result.switcherPids ? [result.switcherPids] : [];
  result.switcherPorts = Array.isArray(result.switcherPorts) ? result.switcherPorts : result.switcherPorts ? [result.switcherPorts] : [];
  if (result.free) {
    result.bindable = await new Promise(resolve => {
      const tester = net.createServer();
      tester.unref();
      tester.once('error', error => resolve({ ok: false, code: error.code || '', message: error.message }));
      tester.listen(1455, '127.0.0.1', () => tester.close(() => resolve({ ok: true })));
    });
    if (!result.bindable.ok) {
      result.free = false;
      result.reserved = true;
      result.reason = result.bindable.code === 'EACCES'
        ? 'Windows 把 1455 放进了系统保留端口范围。它看起来没人占用，但程序无法使用。'
        : `1455 无法使用：${result.bindable.message}`;
    }
  } else result.bindable = { ok: false, code: 'IN_USE' };
  return result;
}
