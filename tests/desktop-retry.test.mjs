import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { desktopRetryEnabled, desktopTakeoverAllowed, desktopRetryCooldownSeconds, parseDesktopRetryLine, applyDesktopRetryEvent, desktopRetryState, setDesktopRetryNotifier } from '../desktop-retry.mjs';
const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
const watcherScript = fs.readFileSync(new URL('../Desktop Retry Watcher.ps1', import.meta.url), 'utf8');

test('desktop retry stays off unless explicitly enabled on Windows', () => {
  assert.equal(desktopRetryEnabled({}), false);
  assert.equal(desktopRetryEnabled({ desktopRetryAutoClick: false }), false);
  assert.equal(desktopRetryEnabled({ desktopRetryAutoClick: 'yes' }), false);
  // On non-Windows the watcher can never run, whatever the config says.
  const expected = process.platform === 'win32';
  assert.equal(desktopRetryEnabled({ desktopRetryAutoClick: true }), expected);
});

test('auto takeover cannot run while the click-through watcher is on', () => {
  assert.equal(desktopTakeoverAllowed({}), true);
  assert.equal(desktopTakeoverAllowed({ autoTakeoverDesktopTransient: false }), false);
  if (process.platform === 'win32') {
    assert.equal(desktopTakeoverAllowed({ desktopRetryAutoClick: true }), false);
  }
});

test('cooldown is clamped to a sane range', () => {
  assert.equal(desktopRetryCooldownSeconds({}), 8);
  assert.equal(desktopRetryCooldownSeconds({ desktopRetryCooldownSeconds: 1 }), 3);
  assert.equal(desktopRetryCooldownSeconds({ desktopRetryCooldownSeconds: 999 }), 120);
  assert.equal(desktopRetryCooldownSeconds({ desktopRetryCooldownSeconds: 20 }), 20);
});

test('watcher output lines are parsed defensively', () => {
  const hit = parseDesktopRetryLine('{"type":"hit","at":"2026-10-30T03:37:34.000Z","window":"Codex","proc":"Codex"}');
  assert.equal(hit?.type, 'hit');
  assert.equal(hit?.proc, 'Codex');
  assert.equal(parseDesktopRetryLine('not json'), null);
  assert.equal(parseDesktopRetryLine(''), null);
  assert.equal(parseDesktopRetryLine('{"noType":1}'), null);
});

test('the watcher reports how it clicked, so a mouse fallback is never silent', () => {
  const before = desktopRetryState();
  applyDesktopRetryEvent({ type: 'hit', window: 'Codex', method: 'mouse' });
  assert.equal(desktopRetryState().lastMethod, 'mouse');
  applyDesktopRetryEvent({ type: 'hit', window: 'Codex', method: 'invoke' });
  assert.equal(desktopRetryState().lastMethod, 'invoke');
  assert.equal(desktopRetryState().hits, before.hits + 2);
});

test('skipped clicks (user is using the mouse) are counted, not treated as hits', () => {
  const before = desktopRetryState();
  applyDesktopRetryEvent({ type: 'skipped', reason: 'mouse-in-use' });
  const after = desktopRetryState();
  assert.equal(after.skipped, before.skipped + 1);
  assert.equal(after.hits, before.hits);
  assert.equal(after.lastError, before.lastError);
});

test('recent hit rates show the real workload, not just the cumulative count', () => {
  const before = desktopRetryState();
  for (let i = 0; i < 3; i++) applyDesktopRetryEvent({ type: 'hit', window: 'ChatGPT', method: 'invoke' });
  const after = desktopRetryState();
  assert.ok(after.hits >= before.hits + 3);
  assert.ok(after.hitsLast10Minutes >= 3, `expected at least 3 recent hits, got ${after.hitsLast10Minutes}`);
  assert.ok(after.hitsLast10Minutes <= after.hitsLast60Minutes);
  assert.ok(after.hitsLast60Minutes <= after.hits);
});

test('a stalled retry button is reported once and can notify the user', () => {
  const seen = [];
  setDesktopRetryNotifier(event => seen.push(event));
  const before = desktopRetryState();
  applyDesktopRetryEvent({ type: 'stalled', window: 'ChatGPT', count: 5 });
  const after = desktopRetryState();
  assert.equal(after.stalled, before.stalled + 1);
  assert.equal(after.lastStallWindow, 'ChatGPT');
  assert.equal(after.lastStallCount, 5);
  assert.ok(after.lastStallAt > 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].count, 5);
  assert.equal(seen[0].window, 'ChatGPT');
  setDesktopRetryNotifier(null);
  applyDesktopRetryEvent({ type: 'stalled', window: 'ChatGPT', count: 5 });
  assert.equal(seen.length, 1, 'notifier must not fire after being removed');
});

test('the watcher script has a stall guard so a popup retry cannot be clicked forever', () => {
  assert.match(watcherScript, /\$stallMaxClicks\s*=\s*5/);
  assert.match(watcherScript, /\$stallWindowMs\s*=\s*600000/);
  assert.match(watcherScript, /type = 'stalled'/);
  assert.match(watcherScript, /GetRuntimeId/);
  // The stall check must happen before the click stamp is written.
  assert.ok(watcherScript.indexOf('stallMaxClicks') < watcherScript.indexOf('CodexCompanionDesktopRetry.json'));
});

test('floating window exposes the retry switch through the same config field', () => {
  const block = widgetRetryBlock();
  assert.match(block, /desktopRetryAutoClick/);
  assert.match(block, /api\/config/);
  assert.match(block, /IsCheckable=\$true/);
  assert.match(block, /Menu\.Items\.Insert/);
  assert.match(block, /Update-RetryMenuItem/);
});

function widgetRetryBlock() {
  const start = widget.indexOf('$script:RetryItem=$null');
  assert.notEqual(start, -1, 'retry menu item missing from the widget');
  const insertAt = widget.indexOf('$Menu.Items.Insert(2,$script:RetryItem)');
  assert.notEqual(insertAt, -1, 'retry item is not inserted into the widget menu');
  const end = widget.indexOf('\n', insertAt);
  return widget.slice(start, end === -1 ? widget.length : end);
}

test('retry menu item reflects the backend state without firing a toggle', { skip: process.platform !== 'win32' }, () => {
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$script:Port=17841
$Menu=New-Object Windows.Controls.ContextMenu
function Get-Status{return [pscustomobject]@{desktopRetry=[pscustomobject]@{enabled=$true}}}
${widgetRetryBlock()}
if(-not $script:RetryItem.IsChecked){throw 'Menu item not checked while enabled'}
if($script:RetryItem.Header -notlike '*已开启*'){throw "Header wrong: $($script:RetryItem.Header)"}
function Get-Status{return [pscustomobject]@{desktopRetry=[pscustomobject]@{enabled=$false}}}
Update-RetryMenuItem
if($script:RetryItem.IsChecked){throw 'Menu item still checked while disabled'}
if($script:RetryItem.Header -notlike '*已关闭*'){throw "Header wrong: $($script:RetryItem.Header)"}
function Get-Status{throw 'backend unreachable'}
Update-RetryMenuItem
if($script:RetryItem.Header -notlike '*已关闭*'){throw 'Header lost state on backend error'}
'PASS'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /PASS/);
});
