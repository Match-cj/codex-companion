import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const refreshBlock = widget.slice(widget.indexOf('function Request-QuotaRefresh('), widget.indexOf('function Test-ScreenPointInsideWindow('));
const detailBlock = widget.slice(widget.indexOf('function New-DetailBody('), widget.indexOf('$Window.Add_Closed({Close-WidgetNotice})'));

test('a completed quota refresh never closes and reopens the detail window', () => {
  assert.match(refreshBlock, /\$d\.Content=\$body\.Outer/);
  assert.doesNotMatch(refreshBlock, /\$old\.Close\(\)/);
  assert.doesNotMatch(refreshBlock, /\$script:Detail=\$null/);
  // Reopening the window is what stole focus and reset WPF ClickCount.
  assert.doesNotMatch(refreshBlock, /Show-Detail/);
  assert.match(refreshBlock, /if\(\[Math\]::Abs\(\$newHeight-\$d\.Height\)-gt 12\)/);
  assert.match(detailBlock, /function New-DetailBody\(\$status\)/);
  assert.match(detailBlock, /return \[pscustomobject\]@\{Outer=\$outer;Height=/);
  assert.match(detailBlock, /\$body=New-DetailBody \$script:Status;\$d\.Content=\$body\.Outer/);
  // Only the initial open activates a window; refresh must not reactivate it.
  assert.match(detailBlock, /\$d\.ShowActivated=\$true/);
  assert.doesNotMatch(refreshBlock, /ShowActivated/);
});

test('clicks on the panel hold off content swaps so a double click still switches accounts', () => {
  assert.match(detailBlock, /Add_PreviewMouseLeftButtonDown\(\{\$script:DetailGuardUntil=\[DateTime\]::UtcNow\.AddSeconds\(2\)\}\)/);
  assert.match(detailBlock, /\$switchHandler=\{param\(\$sender,\$eventArgs\)[\s\S]{0,320}DetailGuardUntil=\[DateTime\]::UtcNow\.AddSeconds\(3\)/);
  assert.match(refreshBlock, /\[DateTime\]::UtcNow-lt\$script:DetailGuardUntil\)\{\$script:DetailPendingRefresh=\$true;Start-DetailRefreshRetry;return\}/);
  assert.match(refreshBlock, /function Request-DetailRefresh/);
  assert.match(refreshBlock, /function Start-DetailRefreshRetry/);
  assert.match(widget, /\$script:DetailRefreshTimer=New-Object Windows\.Threading\.DispatcherTimer/);
  assert.match(widget, /-not\$script:DetailPendingRefresh-or\$null-eq\$script:Detail\)\{\$script:DetailRefreshTimer\.Stop\(\);return\}/);
  assert.match(widget, /\$script:DetailRefreshTimer\.Stop\(\);Refresh-Detail\}\)/);
  assert.match(detailBlock, /ClickCount-lt 2\)\{return\}/);
});

test('ring clicks are throttled, poll less often, and show progress without repainting', () => {
  assert.match(refreshBlock, /function Request-QuotaRefresh\(\[switch\]\$Auto\)/);
  assert.match(refreshBlock, /if\(\$nowMs-\$script:LastAutoRefreshAt-lt 45000\)\{return\}/);
  assert.match(refreshBlock, /\$script:DetailRefreshLabel\.Text='↻ 刷新中…'/);
  assert.match(refreshBlock, /\$script:DetailRefreshLabel\.Text='↻'/);
  assert.match(detailBlock, /\$script:DetailRefreshLabel=\$refreshLabel/);
  assert.match(widget, /FromMilliseconds\(1500\);\$script:QuotaPollTimer/);
  assert.match(widget, /api\/status" -TimeoutSec 4/);
  // The self-test path must still be a no-op for network calls.
  assert.match(refreshBlock, /if\(\$SelfTest\)\{return\}/);
});

test('the webpage also stops repainting account buttons while they are being clicked', () => {
  assert.match(dashboard, /let lastAccountInteraction=0;const accountsBusy=\(\)=>Date\.now\(\)-lastAccountInteraction<3000/);
  assert.match(dashboard, /document\.addEventListener\('pointerdown',[\s\S]{0,180}closest\('#accounts'\)/);
  assert.match(dashboard, /function render\(status,force\)\{latestStatus=status;/);
  assert.match(dashboard, /if\(force\|\|!accountsBusy\(\)\)\$\('accounts'\)\.innerHTML=/);
  assert.match(dashboard, /async function load\(force\)\{[\s\S]{0,140}render\(status,force\)/);
  assert.match(dashboard, /await load\(true\);toast\('额度已同步'\)/);
  assert.doesNotMatch(dashboard, /if\(i%4===0\)await load\(\)/);
});

test('the widget self-test really exercises a completed refresh without reopening the window', () => {
  const selfTest = widget.slice(widget.indexOf('if($SelfTest){'), widget.indexOf('$TopmostTimer=New-Object'));
  assert.match(selfTest, /Refresh-Detail/);
  assert.match(selfTest, /\$refreshKeptWindow=\(\$script:Detail -eq \$detailWindowBefore\)/);
  assert.match(selfTest, /-not\$refreshKeptWindow -or -not\$refreshKeptCards/);
});

test('widget, server and package versions stay aligned', () => {
  assert.ok(server.includes(`const APP_VERSION = '${pkg.version}'`));
  assert.match(widget, new RegExp(`\\$script:AppVersion='${pkg.version.replace(/\./g, '\\.')}'`));
  assert.equal(pkg.version, '1.0.57');
});
