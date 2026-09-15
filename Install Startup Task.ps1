param([switch]$StartNow)

$ErrorActionPreference = 'Stop'
$taskName = 'Codex Companion'
$worker = Join-Path $PSScriptRoot 'Codex Companion Worker.vbs'
if (-not (Test-Path -LiteralPath $worker)) { throw "找不到独立启动器：$worker" }

$legacyShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Companion.lnk'
$launchMethod = 'scheduled-task'
try {
    if ($env:CODEX_COMPANION_FORCE_STARTUP_FALLBACK -eq '1') { throw '启动项回退测试。' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('"' + $worker + '"') -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '独立、隐藏地启动 Codex Companion 后台和额度浮窗。' -Force | Out-Null
    if (Test-Path -LiteralPath $legacyShortcut) { [IO.File]::Delete($legacyShortcut) }
}
catch {
    # Some managed company computers disable per-user scheduled task creation.
    # A Startup shortcut targeting wscript.exe remains hidden and needs no elevation.
    $launchMethod = 'startup-shortcut'
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    $startupDirectory = Split-Path -Parent $legacyShortcut
    New-Item -ItemType Directory -Force -Path $startupDirectory | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($legacyShortcut)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + $worker + '"'
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}

if ($StartNow) { & (Join-Path $env:WINDIR 'System32\wscript.exe') $worker }
Write-Output "Startup method installed: $launchMethod"
