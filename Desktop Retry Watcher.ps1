# Codex Companion - desktop retry watcher
# Watches the Codex/ChatGPT desktop window. When the client shows its own
# retry button (for example "Selected model is at capacity"), the watcher
# presses it through UI Automation. Nothing else is ever touched: no new
# message is sent to the conversation, no model is changed, no mouse pointer
# is moved unless UI Automation refuses to invoke the button.
#
# Output protocol (one JSON object per line on stdout):
#   {"type":"ready"}
#   {"type":"hit","at":"...","window":"...","proc":"..."}
#   {"type":"error","message":"..."}
param(
  [int]$ParentPid = 0,
  [int]$CooldownSeconds = 8,
  [string]$ProcessPattern = 'codex|chatgpt|openai',
  [string]$ParentStartTime = ''
)

$ErrorActionPreference = 'SilentlyContinue'
[void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient')
[void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes')

# "Retry" via char codes keeps this file ASCII so PowerShell 5.1 reads it the
# same way on every machine.
$retryName = [string][char]0x91CD + [char]0x8BD5

Add-Type -Namespace Companion -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
'@

function Emit($object) {
  $json = $object | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# Only one watcher may ever run: a leftover instance from a previous Companion
# process would click the same button twice. A named mutex is the only reliable
# way to enforce that across process trees.
$mutex = New-Object System.Threading.Mutex($false, 'Global\CodexCompanionDesktopRetryWatcher')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  $ownId = $PID
  $others = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.ProcessId -ne $ownId -and $_.CommandLine -like '*Desktop Retry Watcher.ps1*' })
  foreach ($other in $others) { Stop-Process -Id $other.ProcessId -Force }
} catch { }

function ParentAlive {
  if ($ParentPid -le 0) { return $true }
  $proc = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  # Windows reuses process ids: without the start time a new process could keep
  # an orphaned watcher alive forever.
  if ($ParentStartTime) {
    try {
      $expected = [datetime]::Parse($ParentStartTime).ToUniversalTime()
      $actual = $proc.StartTime.ToUniversalTime()
      if ([Math]::Abs(($actual - $expected).TotalSeconds) -gt 5) { return $false }
    } catch { return $false }
  }
  return $true
}

try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  Emit @{ type = 'ready'; pid = $PID }
} catch {
  Emit @{ type = 'error'; message = "ui automation unavailable: $($_.Exception.Message)" }
  exit 1
}

while (ParentAlive) {
  try {
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
      $procName = (Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
      if (-not $procName) { continue }
      if ($procName -notmatch $ProcessPattern) { continue }
      $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
      foreach ($button in $buttons) {
        $name = $button.Current.Name
        if ($name -ne $retryName -and $name -ne 'Retry') { continue }
        # Even if two watchers ever end up running (an orphaned instance from a
        # previous Companion process), only one click may happen per window.
        $stamp = Join-Path $env:TEMP 'CodexCompanionDesktopRetry.json'
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $last = 0
        if (Test-Path $stamp) {
          try { $last = [int64](Get-Content $stamp -Raw | ConvertFrom-Json).at } catch { $last = 0 }
        }
        if ($last -and ($now - $last) -lt 5000) { continue }
        '{ "at": ' + $now + ' }' | Set-Content -Path $stamp -Encoding ASCII

        $invoked = $false
        try {
          $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          $invoked = $true
        } catch { }
        if (-not $invoked) {
          try {
            $point = $button.GetClickablePoint()
            [Companion.Mouse]::SetCursorPos([int]$point.X, [int]$point.Y) | Out-Null
            Start-Sleep -Milliseconds 80
            [Companion.Mouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
            [Companion.Mouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
          } catch {
            Emit @{ type = 'error'; message = "click failed: $($_.Exception.Message)" }
          }
        }
        Emit @{ type = 'hit'; at = (Get-Date).ToUniversalTime().ToString('o'); window = $window.Current.Name; proc = $procName }
        Start-Sleep -Seconds $CooldownSeconds
      }
    }
  } catch {
    Emit @{ type = 'error'; message = $_.Exception.Message }
  }
  Start-Sleep -Seconds 3
}
