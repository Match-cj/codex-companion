// Self-heal for the startup chain.
//
// Older releases launched Companion through VBS wrappers (Launcher.vbs /
// Worker.vbs / Launch Quota Widget.vbs). Antivirus engines quarantine VBS that
// spawns hidden PowerShell, which left the 5-minute self-heal task pointing at
// a deleted script -> "cannot find script file" popup every 5 minutes and no
// backend after a reboot.
//
// This module detects a stale chain and re-registers it. The decision logic is
// pure so tests can pin it down without touching the real Windows scheduler.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const TASK_NAME = 'Codex Companion';

// Returns true if this Task Scheduler action still uses the removed VBS chain.
// Defaults to "healthy" on anything unreadable so we never churn on noise.
export function taskActionIsStale(action) {
  if (!action) return false;
  const execute = String(action.Execute || '').toLowerCase();
  const args = String(action.Arguments || '').toLowerCase();
  if (execute.includes('wscript.exe') || execute.includes('cscript.exe')) return true;
  return ['.vbs', 'worker.vbs', 'launcher.vbs'].some(token => args.includes(token));
}

// A shortcut is stale if its target is wscript/cscript or its args name a vbs.
export function shortcutIsStale(shortcut) {
  if (!shortcut) return false;
  const target = String(shortcut.TargetPath || '').toLowerCase();
  const args = String(shortcut.Arguments || '').toLowerCase();
  if (target.includes('wscript.exe') || target.includes('cscript.exe')) return true;
  return args.includes('.vbs');
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  return stdout.trim();
}

// Reads the live scheduled task action + desktop shortcut and returns whether
// either is stale. Any read failure is swallowed (healing is best-effort).
export async function inspectStartupChain({ desktopShortcutPath } = {}) {
  const result = { taskStale: false, shortcutStale: false, error: '' };
  try {
    const taskJson = await runPowerShell(
      `$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($t) { $t.Actions | Select-Object -First 1 -Property Execute,Arguments | ConvertTo-Json -Compress }`
    );
    if (taskJson) {
      try { result.taskStale = taskActionIsStale(JSON.parse(taskJson)); } catch {}
    }
  } catch (error) { result.error = String(error?.message || error); }
  if (desktopShortcutPath) {
    try {
      const script = `$s = New-Object -ComObject WScript.Shell; $sc = $s.CreateShortcut('${String(desktopShortcutPath).replace(/'/g, "''")}'); @{ TargetPath = $sc.TargetPath; Arguments = $sc.Arguments } | ConvertTo-Json -Compress`;
      const shortcutJson = await runPowerShell(script);
      if (shortcutJson) {
        try { result.shortcutStale = shortcutIsStale(JSON.parse(shortcutJson)); } catch {}
      }
    } catch (error) { result.error = result.error || String(error?.message || error); }
  }
  return result;
}

// Re-registers a healthy chain by re-running the installers already shipped in
// the install directory. Both scripts are idempotent. Never throws.
export async function healStartupChain({ sourceDir }) {
  const outcome = { healed: false, task: false, shortcut: false, error: '' };
  const inspect = await inspectStartupChain({
    desktopShortcutPath: await (async () => {
      try {
        return (await runPowerShell(`[Environment]::GetFolderPath('Desktop') + '\\Codex 助手.lnk'`));
      } catch { return ''; }
    })(),
  });
  if (!inspect.taskStale && !inspect.shortcutStale) return outcome;
  try {
    const ps = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (inspect.taskStale) {
      await execFileAsync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${sourceDir}\\Install Startup Task.ps1`], { windowsHide: true, timeout: 60000 });
      outcome.task = true;
    }
    if (inspect.shortcutStale) {
      const quiet = await execFileAsync('cmd.exe', ['/d', '/s', '/c', `set CODEX_COMPANION_QUIET=1&& "${ps}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${sourceDir}\\Install Companion.ps1"`], { windowsHide: true, timeout: 60000 }).catch(() => null);
      outcome.shortcut = Boolean(quiet);
    }
  } catch (error) {
    outcome.error = String(error?.message || error);
  }
  outcome.healed = outcome.task || outcome.shortcut;
  return outcome;
}
