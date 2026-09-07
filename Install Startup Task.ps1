param([switch]$StartNow)

$ErrorActionPreference = 'Stop'
$taskName = 'Codex Companion'
$worker = Join-Path $PSScriptRoot 'Codex Companion Worker.vbs'
if (-not (Test-Path -LiteralPath $worker)) { throw "找不到独立启动器：$worker" }

$legacyShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Companion.lnk'
if (Test-Path -LiteralPath $legacyShortcut) { [IO.File]::Delete($legacyShortcut) }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('"' + $worker + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '独立、隐藏地启动 Codex Companion 后台和额度浮窗。' -Force | Out-Null

if ($StartNow) { Start-ScheduledTask -TaskName $taskName }
Write-Output "Scheduled task installed: $taskName"
