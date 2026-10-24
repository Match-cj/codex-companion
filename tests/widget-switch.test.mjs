import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
test('widget and webpage use the same account-switch action after confirmation', () => {
  const action = widget.slice(widget.indexOf('function Switch-WidgetAccount('), widget.indexOf('function Warmup-WidgetAccount('));
  assert.match(action, /api\/codex\/status/);
  assert.match(action, /MessageBoxResult\]::OK/);
  assert.match(action, /closeCodex=\$true/);
  assert.match(action, /api\/accounts\/switch/);
  assert.doesNotMatch(action, /validateOnly/);
  assert.match(action, /activeAccountId/);
  assert.match(dashboard, /function switchAccount\(id\).*closeCodex:true/);
});
test('inactive account cards switch only after a double click', () => {
  assert.match(widget, /Add_PreviewMouseLeftButtonDown/);
  assert.match(widget, /ClickCount-lt 2/);
  assert.doesNotMatch(widget, /DoubleClickTime|LastClick/);
  assert.match(widget, /Switch-WidgetAccount/);
  assert.doesNotMatch(widget, /\$switchButton\.Content='切换账号'/);
});
test('switch confirmation owns its window and suppresses floating-window interference', () => {
  const action = widget.slice(widget.indexOf('function Switch-WidgetAccount('), widget.indexOf('function Warmup-WidgetAccount('));
  assert.ok(action.indexOf('$script:SwitchInProgress=$true') < action.indexOf('MessageBox]::Show'));
  assert.match(action, /MessageBox\]::Show\(\$owner,/);
  assert.match(action, /MessageBoxButton\]::OKCancel/);
  assert.match(action, /value=\$\(\[int\]\$choice\)/);
  assert.match(widget, /if\(\$script:MenuOpen -or \$script:SwitchInProgress\)\{return\}/);
  assert.match(widget, /function Close-Detail\(\[switch\]\$Force\)\{if\(\$script:SwitchInProgress -and -not\$Force\)\{return\}/);
  assert.match(action, /finally\{\$script:SwitchInProgress=\$false/);
});
test('widget exposes running conversations, stop actions, and full shutdown', () => {
  assert.match(widget, /运行中对话：/);
  assert.match(widget, /api\/task\/.*\/stop/);
  assert.match(widget, /退出 Companion（后台与浮窗）/);
  assert.match(widget, /api\/shutdown/);
});

test('outside-click detection keeps scaled panel edge clicks inside', { skip: process.platform !== 'win32' }, () => {
  const helper = widget.slice(widget.indexOf('function Test-ScreenPointInsideWindow('), widget.indexOf('function Get-WidgetMonitorWorkArea{'));
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName WindowsBase
${helper}
foreach($scale in @(1.0,1.25,1.5,2.0)){
  $window=[pscustomobject]@{IsVisible=$true;ActualWidth=430.0;ActualHeight=279.0;Scale=$scale;Left=-1900.0;Top=120.0}
  $window|Add-Member -MemberType ScriptMethod -Name PointFromScreen -Value {param($point) [Windows.Point]::new(($point.X-$this.Left)/$this.Scale,($point.Y-$this.Top)/$this.Scale)}
  $inside=[Windows.Point]::new($window.Left+429*$scale,$window.Top+278*$scale)
  $outside=[Windows.Point]::new($window.Left+431*$scale,$window.Top+280*$scale)
  if(-not(Test-ScreenPointInsideWindow $window $inside)){throw "Inside click rejected at $scale"}
  if(Test-ScreenPointInsideWindow $window $outside){throw "Outside click accepted at $scale"}
}
'PASS'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /PASS/);
});
