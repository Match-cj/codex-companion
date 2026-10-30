import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopRetryEnabled, desktopTakeoverAllowed, desktopRetryCooldownSeconds, parseDesktopRetryLine } from '../desktop-retry.mjs';

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
