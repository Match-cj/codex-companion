import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  stageLabel,
  updateFailureRecord,
  updateRetryDecision,
  describeUpdateFailure,
  updateLogLine,
  trimUpdateLog,
  UPDATE_RETRY_GAP_MS,
} from '../update-diagnostics.mjs';

const now = Date.UTC(2026, 10, 11, 2, 0, 0);

test('a failure keeps the stage, versions and a readable reason', () => {
  const record = updateFailureRecord(Error('下载更新包失败（已试过 直连、内置下载）'), {
    at: now, from: '1.0.53', to: '1.0.55', stage: 'download', attempts: 1,
  });
  assert.equal(record.stage, 'download');
  assert.equal(record.from, '1.0.53');
  assert.equal(record.to, '1.0.55');
  assert.equal(record.attempts, 1);
  assert.match(record.message, /下载更新包失败/);
  assert.equal(stageLabel('download'), '下载更新包');
  assert.equal(stageLabel('nonsense'), '安装更新');
  assert.equal(updateFailureRecord(Error('x'), { stage: 'nonsense' }).stage, 'apply');
});

test('a quiet retry waits, stops after three tries and never fights an active update', () => {
  const record = updateFailureRecord(Error('offline'), { at: now, stage: 'download', attempts: 0 });
  assert.equal(updateRetryDecision({ lastError: record, now, canApply: true }).reason, 'too-soon');
  assert.equal(updateRetryDecision({ lastError: record, now: now + UPDATE_RETRY_GAP_MS - 1, canApply: true }).reason, 'too-soon');
  assert.equal(updateRetryDecision({ lastError: record, now: now + UPDATE_RETRY_GAP_MS, canApply: true }).retry, true);
  assert.equal(updateRetryDecision({ lastError: record, now: now + UPDATE_RETRY_GAP_MS, canApply: true, applying: true }).reason, 'already-running');
  assert.equal(updateRetryDecision({ lastError: record, now: now + UPDATE_RETRY_GAP_MS, canApply: false }).reason, 'needs-installer');
  assert.equal(updateRetryDecision({ lastError: { ...record, attempts: 3 }, now: now + UPDATE_RETRY_GAP_MS, canApply: true }).reason, 'too-many-tries');
  assert.equal(updateRetryDecision({ now, canApply: true }).reason, 'no-failure');
});

test('the failure is shown in plain Chinese with a retry hint', () => {
  const record = updateFailureRecord(Error('网络不通'), { at: now, to: '1.0.56', stage: 'download' });
  const text = describeUpdateFailure(record);
  assert.match(text, /v1\.0\.56/);
  assert.match(text, /下载更新包/);
  assert.match(text, /网络不通/);
  assert.match(text, /自动重试/);
  assert.equal(describeUpdateFailure(null), '');
});

test('log lines are append-only and the log keeps its newest entries', () => {
  const line = updateLogLine(now, 'error', '下载失败\n第二行  空格');
  assert.match(line, /2026-11-11T02:00:00\.000Z \[ERROR\] 下载失败 第二行 空格\n/);
  const many = Array.from({ length: 400 }, (_, i) => updateLogLine(now + i * 1000, 'info', `line ${i} ${'x'.repeat(200)}`)).join('');
  const trimmed = trimUpdateLog(many, 4096);
  assert.ok(Buffer.byteLength(trimmed, 'utf8') <= 4096);
  assert.match(trimmed, /line 399/);
  assert.doesNotMatch(trimmed, /line 0 /);
  assert.equal(trimUpdateLog('short', 4096), 'short');
});

test('the server persists update failures instead of losing them on restart', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /update\.log/);
  assert.match(server, /update-last-error\.json/);
  assert.match(server, /lastError: updateLastError/);
  assert.match(server, /appendUpdateLog/);
  assert.match(server, /updateRetryDecision/);
});

test('the widget keeps the update dot visible after a failed attempt', () => {
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  assert.match(widget, /Restore-UpdateBadge/);
  assert.match(widget, /lastError/);
});

test('versions stay aligned across server, widget and package', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '1.0.58');
  assert.match(server, /const APP_VERSION = '1\.0\.58'/);
  assert.match(widget, /\$script:AppVersion='1\.0\.58'/);
});
