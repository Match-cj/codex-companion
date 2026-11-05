# Codex Companion - desktop retry watcher
# Watches the Codex/ChatGPT desktop window. When the client shows its own
# retry button (for example "Selected model is at capacity"), the watcher
# presses it. Nothing else is ever touched: no new message is sent to the
# conversation, no model is changed. The pointer is only used when UI
# Automation cannot invoke the button, and even then it is put back where it
# was - and never while the user is moving it.
#
# Output protocol (one JSON object per line on stdout):
#   {"type":"ready"}
#   {"type":"hit","at":"...","window":"...","proc":"..."}
#   {"type":"ignored","at":"...","window":"...","text":"..."}   (not a capacity error)
#   {"type":"error","message":"..."}
param(
  [int]$ParentPid = 0,
  [int]$CooldownSeconds = 8,
  [string]$ProcessPattern = 'codex|chatgpt|openai',
  [string]$ParentStartTime = ''
)

$ErrorActionPreference = 'SilentlyContinue'
# The JSON protocol carries Chinese error text back to the Node parent. Without
# this line PowerShell writes it in the legacy OEM codepage and the parent
# would show mojibake (English survives, Chinese turns into replacement chars).
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch { }
[void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient')
[void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes')

# "Retry" via char codes keeps this file ASCII so PowerShell 5.1 reads it the
# same way on every machine.
$retryName = [string][char]0x91CD + [char]0x8BD5

Add-Type -Namespace Companion -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
'@

function Get-CursorPos {
  $point = New-Object Companion.Mouse+POINT
  [Companion.Mouse]::GetCursorPos([ref]$point) | Out-Null
  return $point
}

# Taking the pointer away from someone who is using it is the one thing this
# watcher must never do. Two samples a moment apart tell us whether the mouse
# is parked: if it moved, the user is working and we simply try again next poll.
function Test-MouseParked {
  $first = Get-CursorPos
  Start-Sleep -Milliseconds 120
  $second = Get-CursorPos
  if ($first.X -ne $second.X -or $first.Y -ne $second.Y) { return $null }
  return $first
}

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

$skipStreak = 0

# Only a retry that belongs to a capacity error ("model is busy") is worth
# pressing. A Retry shown for any other failure (for example a conversation
# stuck on a retired model) cannot succeed, so the watcher reads the error
# text near the button and leaves those alone, reporting them once instead.
$capacityPattern = 'at capacity|temporarily unavailable|high demand|overloaded|capacity|暂时不可用|稍后再试|请稍后|繁忙|满载|过载|高负载|正忙|排队|容量|限流|429|rate limit'
$reportedIgnored = @{}
$seenButtonIds = New-Object 'System.Collections.Generic.HashSet[string]'

$textCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Text)

# Walk up from the button and collect the first meaningful text (the message
# and the button usually share a nearby container). Parts that are just the
# button label itself do not count.
function Get-ButtonContext {
  param($button)
  $parts = New-Object 'System.Collections.Generic.List[string]'
  $node = $button
  for ($i = 0; $i -lt 8; $i++) {
    try { $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node) } catch { break }
    if (-not $node) { break }
    try {
      $own = [string]$node.Current.Name
      if ($own -and $own -ne $script:retryName -and $own -ne 'Retry' -and $own.Length -ge 2) { $parts.Add($own) }
      $texts = $node.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCondition)
      foreach ($text in $texts) {
        $value = [string]$text.Current.Name
        if ($value -and $value -ne $script:retryName -and $value -ne 'Retry' -and $value.Length -ge 2) { $parts.Add($value) }
      }
    } catch { }
    if ($parts.Count -ge 1) { break }
  }
  return ($parts -join ' ')
}

function Get-WindowText {
  param($window)
  $parts = New-Object 'System.Collections.Generic.List[string]'
  try {
    $texts = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCondition)
    foreach ($text in $texts) {
      $value = [string]$text.Current.Name
      if ($value -and $value.Length -ge 2) { $parts.Add($value) }
    }
  } catch { }
  return ($parts -join ' ')
}

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
        # Identify the exact button instance so a stuck one (a popup Retry that
        # never resolves) can be told apart from a fresh retry elsewhere.
        $buttonId = $name
        try { $buttonId = ($button.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.' } catch { }
        [void]$seenButtonIds.Add($buttonId)
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        # Decide by the error text, never by the button label alone.
        $context = Get-ButtonContext -button $button
        $isCapacity = $context -match $capacityPattern
        if (-not $isCapacity -and -not $context) {
          # The local structure exposed nothing readable; fall back to the
          # window, which still keeps a stale popup from being clicked while
          # the conversation itself shows a capacity error.
          $windowText = Get-WindowText -window $window
          if ($windowText -match $capacityPattern) { $isCapacity = $true } else { $context = $windowText }
        }
        if (-not $isCapacity) {
          if (-not $reportedIgnored.ContainsKey($buttonId)) {
            $reportedIgnored[$buttonId] = $true
            $excerpt = ''
            if ($context) { $excerpt = $context.Substring(0, [Math]::Min(160, $context.Length)) }
            Emit @{ type = 'ignored'; at = (Get-Date).ToUniversalTime().ToString('o'); window = $window.Current.Name; text = $excerpt }
          }
          continue
        }
        # Even if two watchers ever end up running (an orphaned instance from a
        # previous Companion process), only one click may happen per window.
        $stamp = Join-Path $env:TEMP 'CodexCompanionDesktopRetry.json'
        $last = 0
        if (Test-Path $stamp) {
          try { $last = [int64](Get-Content $stamp -Raw -Encoding UTF8 | ConvertFrom-Json).at } catch { $last = 0 }
        }
        if ($last -and ($now - $last) -lt 5000) { continue }
        '{ "at": ' + $now + ' }' | Set-Content -Path $stamp -Encoding ASCII

        $invoked = $false
        $method = ''
        try {
          $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          $invoked = $true
          $method = 'invoke'
        } catch { }
        if (-not $invoked) {
          # Electron only exposes part of its controls through the modern
          # pattern; the legacy MSAA action still works on many of them and
          # never touches the pointer.
          try {
            $legacy = $button.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
            $legacy.DoDefaultAction()
            $invoked = $true
            $method = 'legacy'
          } catch { }
        }
        if (-not $invoked) {
          $parked = Test-MouseParked
          # Never yank the pointer out of the user's hand. If they keep moving
          # it for a long stretch, give up waiting and click anyway - but we
          # always put the pointer back exactly where we found it.
          if (-not $parked -and $skipStreak -lt 10) {
            $skipStreak++
            Emit @{ type = 'skipped'; at = (Get-Date).ToUniversalTime().ToString('o'); window = $window.Current.Name; reason = 'mouse-in-use' }
            continue
          }
          $skipStreak = 0
          try {
            if (-not $parked) { $parked = Get-CursorPos }
            $point = $button.GetClickablePoint()
            [Companion.Mouse]::SetCursorPos([int]$point.X, [int]$point.Y) | Out-Null
            Start-Sleep -Milliseconds 60
            [Companion.Mouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
            [Companion.Mouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 60
            [Companion.Mouse]::SetCursorPos($parked.X, $parked.Y) | Out-Null
            $method = 'mouse'
          } catch {
            Emit @{ type = 'error'; message = "click failed: $($_.Exception.Message)" }
            continue
          }
        }
        $skipStreak = 0
        # Report whether the client was on screen at all. If hits keep arriving
        # while it says Minimized, we know the click works without the user
        # having to keep the window open.
        $windowState = ''
        try { $windowState = [string]$window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState } catch { }
        Emit @{ type = 'hit'; at = (Get-Date).ToUniversalTime().ToString('o'); window = $window.Current.Name; proc = $procName; method = $method; windowState = $windowState }
        Start-Sleep -Seconds $CooldownSeconds
      }
    }
  } catch {
    Emit @{ type = 'error'; message = $_.Exception.Message }
  }
  # Buttons that vanished (popup closed, error gone) get a clean slate: next
  # time they appear the user is told again if they still cannot be retried.
  # Only trust this cleanup on polls where at least one retry button was seen,
  # so a transient empty desktop does not wipe the record.
  if ($seenButtonIds.Count -gt 0) {
    foreach ($knownId in @($reportedIgnored.Keys)) {
      if (-not $seenButtonIds.Contains($knownId)) { $reportedIgnored.Remove($knownId) }
    }
  }
  $seenButtonIds.Clear()
  Start-Sleep -Seconds 3
}
