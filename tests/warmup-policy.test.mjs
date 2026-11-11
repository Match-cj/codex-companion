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

test('both server warm-up endpoints consult the policy and never claim to reset a running window', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /import \{ warmupDecision, describeWarmupWindow \} from '\.\/warmup-policy\.mjs'/);
  assert.match(server, /warmupDecision\(account\.usage/);
  assert.match(server, /if\(decision\.action==='skip'\)return send\(res,200,\{ok:true,skipped:true/);
  assert.match(server, /const decision=warmupDecision\(account\.usage,\{accountName:name\}\)/);
  assert.doesNotMatch(server, /5 小时窗口已开始计时/);
});

test('widget disables pointless warm-ups and explains the fixed window on hover', () => {
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  assert.match(widget, /function Get-WarmupAdvice/);
  assert.match(widget, /function Get-WindowTooltip/);
  assert.match(widget, /\$warmItem\.IsEnabled=\$false;\$warmItem\.Header=\$advice\.Menu/);
  assert.match(widget, /\$fiveBox\.ToolTip=Get-WindowTooltip \$a 'primary'/);
  assert.match(widget, /if\(\$advice\.Skip\)\{\[Windows\.MessageBox\]::Show\(\$advice\.Text/);
  assert.doesNotMatch(widget, /让 5 小时额度窗口从现在开始计时/);
  assert.match(widget, /固定窗口：期间的请求不会改变重置时间/);
});

test('dashboard no longer promises to restart a running window', () => {
  const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  assert.doesNotMatch(dashboard, /从现在开始计时/);
  assert.match(dashboard, /窗口计时中或额度耗尽的账号自动跳过/);
  assert.match(dashboard, /只在窗口空闲时有效；计时中会自动跳过，不耗额度/);
});

test('widget, server and package versions stay aligned', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '1.0.55');
  assert.match(server, /const APP_VERSION = '1\.0\.55'/);
  assert.match(widget, /\$script:AppVersion='1\.0\.55'/);
});
