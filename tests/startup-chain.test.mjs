import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  taskActionIsStale,
  shortcutIsStale,
  TASK_NAME,
} from '../startup-chain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');

test('task action pointing at the deleted VBS worker is stale', () => {
  assert.equal(taskActionIsStale({
    Execute: 'C:\\Windows\\System32\\wscript.exe',
    Arguments: '"C:\\Users\\x\\AppData\\Local\\Programs\\CodexCompanion\\Codex Companion Worker.vbs"',
  }), true);
});

test('task action using any .vbs argument is stale', () => {
  assert.equal(taskActionIsStale({ Execute: 'wscript.exe', Arguments: '"C:\\some\\Launcher.vbs"' }), true);
  assert.equal(taskActionIsStale({ Execute: 'cscript.exe', Arguments: '//B "C:\\some\\x.vbs"' }), true);
});

test('direct-PowerShell task action is stale (flashes Terminal every 5 minutes)', () => {
  assert.equal(taskActionIsStale({
    Execute: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    Arguments: '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\...\\Start Codex Companion.ps1" -NoBrowser',
  }), true);
  assert.equal(taskActionIsStale({
    Execute: 'powershell.exe',
    Arguments: '-NoProfile -WindowStyle Hidden -File "C:\\...\\Start Codex Companion.ps1" -NoBrowser',
  }), true);
  // Bypass/Hidden alone must not be treated as stale.
  assert.equal(taskActionIsStale({ Execute: 'powershell.exe', Arguments: '-ExecutionPolicy Bypass -WindowStyle Hidden -File x.ps1' }), false);
});

test('headless conhost task action is healthy (no Terminal flash)', () => {
  assert.equal(taskActionIsStale({
    Execute: 'C:\\Windows\\System32\\conhost.exe',
    Arguments: '--headless "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\...\\Start Codex Companion.ps1" -NoBrowser',
  }), false);
});

test('task action unreadable or missing is treated as healthy (no churn)', () => {
  assert.equal(taskActionIsStale(null), false);
  assert.equal(taskActionIsStale({}), false);
  assert.equal(taskActionIsStale({ Execute: 'powershell.exe' }), false);
});

test('desktop shortcut to the old VBS launcher is stale', () => {
  assert.equal(shortcutIsStale({
    TargetPath: 'C:\\Windows\\System32\\wscript.exe',
    Arguments: '"C:\\...\\Codex Companion Launcher.vbs"',
  }), true);
  assert.equal(shortcutIsStale({ TargetPath: 'powershell.exe', Arguments: '-File "C:\\a.vbs"' }), true);
});

test('direct-PowerShell shortcut is stale (flashes Terminal on double-click)', () => {
  assert.equal(shortcutIsStale({
    TargetPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    Arguments: '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\...\\Start Codex Companion.ps1" -NoBrowser',
  }), true);
  assert.equal(shortcutIsStale(null), false);
});

test('headless conhost shortcut is healthy', () => {
  assert.equal(shortcutIsStale({
    TargetPath: 'C:\\Windows\\System32\\conhost.exe',
    Arguments: '--headless "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\...\\Start Codex Companion.ps1" -NoBrowser',
  }), false);
});

test('install scripts no longer register wscript/VBS, and load PowerShell directly', () => {
  const startup = read('Install Startup Task.ps1');
  const companion = read('Install Companion.ps1');
  const portable = read('Install Portable.ps1');
  for (const source of [startup, companion, portable]) {
    assert.doesNotMatch(source, /New-ScheduledTaskAction[^\n]*wscript/i);
    assert.doesNotMatch(source, /TargetPath\s*=\s*[^#\n]*wscript\.exe/i);
    assert.doesNotMatch(source, /Join-Path[^\n]*'Codex Companion Worker\.vbs'/i);
    assert.match(source, /ExecutionPolicy Bypass/);
  }
  assert.match(startup, /Start Codex Companion\.ps1/);
  assert.match(portable, /Start Codex Companion\.ps1/);
  assert.match(startup, /--headless/);
  assert.match(startup, /conhost\.exe/);
});

test('widget launchers no longer spawn the VBS file', () => {
  const starter = read('Start Codex Companion.ps1');
  const desktop = read('desktop-client.mjs');
  const appPaths = read('app-paths.mjs');
  const cmd = read('Start Quota Widget.cmd');
  for (const source of [starter, desktop, appPaths, cmd]) {
    assert.doesNotMatch(source, /Launch Quota Widget\.vbs/);
  }
  const wrapper = read('Start Quota Widget.ps1');
  assert.match(wrapper, /Get-Content -Raw -Encoding UTF8/);
  assert.match(wrapper, /\[scriptblock\]::create/i);
  assert.match(desktop, /spawn\('powershell\.exe'/);
  assert.doesNotMatch(desktop, /spawn\('wscript\.exe'/);
});

test('installer payload carries no VBS but carries the new PowerShell launchers', () => {
  const build = read('Build Branded Installer.ps1');
  assert.doesNotMatch(build, /Launcher\.vbs|Worker\.vbs|Launch Quota Widget\.vbs/);
  assert.match(build, /Start Quota Widget\.ps1/);
  // The comma bug previously concatenated the last two entries into one string.
  assert.match(build, /'Desktop Retry Watcher\.ps1',\s*\n\s*'LICENSE'/);
});

test('all VBS launchers are gone from the source tree', () => {
  for (const name of ['Codex Companion Launcher.vbs', 'Codex Companion Worker.vbs', 'Launch Quota Widget.vbs']) {
    assert.throws(() => read(name), /ENOENT/, `${name} should be removed`);
  }
});

test('server self-heals a stale chain once on startup', () => {
  const server = read('server.mjs');
  assert.match(server, /import \{ healStartupChain \}/);
  assert.match(server, /healStartupChain\(\{ sourceDir \}\)/);
  assert.equal(TASK_NAME, 'Codex Companion');
});
