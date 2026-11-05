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

test('successful switch is nonmodal; confirmation and failure remain actionable', () => {
  const action=widget.slice(widget.indexOf('function Switch-WidgetAccount('),widget.indexOf('function Warmup-WidgetAccount('));
  assert.match(action,/Show-WidgetNotice \(\[string\]\$result.message\)/);
  assert.doesNotMatch(action,/MessageBox\]::Show\(\[string\]\$result.message/);
  assert.match(action,/MessageBoxButton\]::OKCancel/);
  assert.match(action,/账号切换失败/);
});

test('notice stays out of taskbar, does not activate, replaces old notice and expires', {skip:process.platform!=='win32'},()=>{
  const helper=widget.slice(widget.indexOf('function Close-WidgetNotice{'),widget.indexOf('function Switch-WidgetAccount('));
  const script=`$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$SelfTest=$true
$Transparent=[Windows.Media.Brushes]::Transparent;$Disc=[Windows.Media.Brushes]::Black;$Green=[Windows.Media.Brushes]::Green;$White=[Windows.Media.Brushes]::White
function Get-WidgetMonitorWorkArea {return [pscustomobject]@{Left=0;Top=0;Right=1000;Bottom=800}}
${helper}
Show-WidgetNotice 'first' 0.1
$first=$script:NoticeWindow
if($first.ShowInTaskbar-or$first.ShowActivated){throw 'Taskbar/focus regression'}
Show-WidgetNotice 'second' 0.1
if($first.IsVisible){throw 'Old notice still visible'}
if($script:NoticeWindow.Left-ne 624){throw 'Not at bottom-right'}
$frame=New-Object Windows.Threading.DispatcherFrame
$timeout=New-Object Windows.Threading.DispatcherTimer
$timeout.Interval=[TimeSpan]::FromMilliseconds(400)
$timeout.Add_Tick({$frame.Continue=$false;$timeout.Stop()});$timeout.Start()
[Windows.Threading.Dispatcher]::PushFrame($frame)
if($null-ne$script:NoticeWindow-or$null-ne$script:NoticeTimer){throw 'Notice did not expire'}
'PASS'`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Sta','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/PASS/);
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

test('an update badge on the ring is one click away from a restart', () => {
  assert.match(widget, /\$script:UpdateBadge\.Visibility='Collapsed'/);
  assert.match(widget, /\$updateBadgeHandler=\{param\(\$sender,\$eventArgs\)\$eventArgs\.Handled=\$true;Update-Companion\}/);
  assert.match(widget, /function Update-Companion\(\[switch\]\$Confirmed\)/);
  assert.match(widget, /api\/update\/apply/);
  assert.match(widget, /function Update-UpdateBadge\(\$status\)/);
  // The badge must follow /api/status, not its own poller, and disappear while updating.
  assert.match(widget, /Update-Widget\{\$script:Status=Get-Status;Update-UpdateBadge \$script:Status/);
  assert.match(widget, /\(-not\$script:Updating\)-and/);
});

test('webpage lets the user pick auto update or notify only', () => {
  assert.match(dashboard, /<select id="updateMode"/);
  assert.match(dashboard, /<option value="auto">/);
  assert.match(dashboard, /<option value="notify">/);
  assert.match(dashboard, /async function saveUpdateMode\(mode\)\{[\s\S]{0,300}updateMode:mode/);
  assert.match(dashboard, /if\(\$\('updateMode'\)\)\$\('updateMode'\)\.value=status\.config\.updateMode/);
});
