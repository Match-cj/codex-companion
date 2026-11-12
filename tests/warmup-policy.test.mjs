import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { warmupDecision, describeWarmupWindow, windowStart } from '../warmup-policy.mjs';

const HOUR = 3600;
const nowSec = 1_794_360_000;
const now = nowSec * 1000;
const runningWindow = {
  primary_used_percent: 27,
  primary_window_minutes: 300,
  primary_resets_at: nowSec + 4 * HOUR,
  secondary_used_percent: 53,
  observed_at: nowSec - 60,
};

test('a running 5-hour window is never warmed up again', () => {
  const decision = warmupDecision(runningWindow, { now, accountName: '设计二组' });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'window_running');
  assert.equal(decision.resetAt, runningWindow.primary_resets_at);
  assert.equal(decision.startedAt, runningWindow.primary_resets_at - 300 * 60);
  assert.match(decision.message, /不能提前重置/);
  assert.match(decision.message, /没消耗额度/);
  assert.match(decision.message, /设计二组/);
});

test('a full quota with a stale future reset is not skipped -- clicking 预热 must do something', () => {
  const full = { ...runningWindow, primary_used_percent: 0 };
  const decision = warmupDecision(full, { now, accountName: '品牌组' });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'window_running_idle');
  assert.match(decision.message, /额度是满的/);
  assert.match(decision.message, /核对/);
  assert.match(decision.message, /品牌组/);
  const unknown = { ...runningWindow, primary_used_percent: undefined };
  assert.equal(warmupDecision(unknown, { now }).action, 'allow');
});

test('exhausted 5-hour quota, exhausted weekly quota and unreadable usage are skipped too', () => {
  assert.equal(warmupDecision({ ...runningWindow, primary_used_percent: 100 }, { now }).reason, 'five_hour_exhausted');
  assert.equal(warmupDecision({ ...runningWindow, secondary_used_percent: 100 }, { now }).reason, 'weekly_exhausted');
  assert.equal(warmupDecision({ ...runningWindow, error: 'fetch failed' }, { now }).reason, 'usage_error');
  for (const usage of [
    { ...runningWindow, primary_used_percent: 100 },
    { ...runningWindow, secondary_used_percent: 100 },
    { ...runningWindow, error: 'fetch failed' },
  ]) {
    const decision = warmupDecision(usage, { now });
    assert.equal(decision.action, 'skip');
    assert.match(decision.message, /跳过/);
  }
});

test('an expired window or a missing reset timestamp still allows a warm-up', () => {
  const expired = warmupDecision({ ...runningWindow, primary_resets_at: nowSec - 60 }, { now });
  assert.equal(expired.action, 'allow');
  assert.equal(expired.reason, 'window_expired');
  const missing = warmupDecision({ primary_used_percent: 0 }, { now });
  assert.equal(missing.action, 'allow');
  assert.equal(missing.reason, 'no_window');
  assert.equal(missing.resetAt, 0);
});

test('window start and feedback use the real reset timestamp', () => {
  assert.equal(windowStart(runningWindow), runningWindow.primary_resets_at - 300 * 60);
  const message = describeWarmupWindow(runningWindow, { now, name: '设计二组' });
  assert.match(message, /设计二组/);
  assert.match(message, /5 小时窗口 .* 开始 · .* 重置/);
  assert.match(message, /不会因预热提前/);
  assert.match(describeWarmupWindow({}, { now }), /窗口时间还没读回来/);
});

test('both server warm-up endpoints log the decision and verify the window afterwards', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /import \{ warmupDecision \} from '\.\/warmup-policy\.mjs'/);
  assert.match(server, /import \{ verifyWarmupWindow, isTransientWarmupError \} from '\.\/warmup-verify\.mjs'/);
  assert.match(server, /const warmupLogPath = path\.join\(appDir, 'warmup\.log'\)/);
  assert.match(server, /const before=\{\.\.\.\(account\.usage\|\|\{\}\)\}/);
  assert.match(server, /verifyWarmupWindow\(before,after/);
  assert.match(server, /appendWarmupLog\(`收到预热请求/);
  assert.match(server, /ok:verdict\.started/);
  assert.match(server, /warmupLogPath,/);
  assert.doesNotMatch(server, /5 小时窗口已开始计时/);
});

test('widget lets a full-quota account warm up even with a stale reset timestamp', () => {
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  assert.match(widget, /function Get-WarmupAdvice/);
  assert.match(widget, /function Get-WindowTooltip/);
  assert.match(widget, /\$warmItem\.IsEnabled=\$false;\$warmItem\.Header=\$advice\.Menu/);
  assert.match(widget, /\$fiveBox\.ToolTip=Get-WindowTooltip \$a 'primary'/);
  assert.match(widget, /if\(\$advice\.Skip\)\{\[Windows\.MessageBox\]::Show\(\$advice\.Text/);
  assert.match(widget, /if\(\$used-le 0\)/);
  assert.match(widget, /额度满格 · 点预热核对窗口/);
  assert.match(widget, /-TimeoutSec 210/);
  assert.match(widget, /\$result\.ok-eq\$false/);
  assert.match(widget, /预热没有成功/);
  assert.doesNotMatch(widget, /让 5 小时额度窗口从现在开始计时/);
});

test('dashboard states the verified result and the log path', () => {
  const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  assert.doesNotMatch(dashboard, /从现在开始计时/);
  assert.match(dashboard, /额度满格但还显示旧窗口时间时也能点/);
  assert.match(dashboard, /CodexCompanion\\warmup\.log/);
  assert.match(dashboard, /result\.ok===false/);
});

test('widget, server and package versions stay aligned', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '1.0.58');
  assert.match(server, /const APP_VERSION = '1\.0\.58'/);
  assert.match(widget, /\$script:AppVersion='1\.0\.58'/);
});
