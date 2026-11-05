param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$TargetVersion,
    [int]$Port = 17841,
    [string]$Launcher = '',
    [string]$TaskName = 'Codex Companion'
)

# Runs outside the app right after an in-place update. Two jobs:
#   1. start the new version through the scheduled task (the only sanctioned way),
#   2. if the new version never answers /api/health, restore _update-backup and
#      start again, so a bad patch can never leave the machine without a backend.
# This script is copied to %TEMP% before it runs, so stopping "processes whose
# command line contains the install path" never kills the watchdog itself.
$ErrorActionPreference = 'SilentlyContinue'
$install = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if (-not $Launcher) { $Launcher = Join-Path $install 'Start Codex Companion.ps1' }
$backup = Join-Path $install '_update-backup'
$stateFile = Join-Path $install 'update-state.json'
$log = Join-Path $env:TEMP 'CodexCompanion-update-watchdog.log'

function Write-Log([string]$message) {
    try { Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $message) -Encoding UTF8 } catch {}
}

function Stop-App {
    if ($TaskName) { try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {} }
    Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.Name -in @('node.exe', 'powershell.exe', 'wscript.exe', 'codex.exe') -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf($install, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Milliseconds 900
}

function Start-App {
    $started = $false
    if ($TaskName) { try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; $started = $true } catch {} }
    if (-not $started -and (Test-Path -LiteralPath $Launcher)) {
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $Launcher)
    }
}

function Wait-Healthy([string]$expectVersion, [int]$seconds = 90) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        try {
            $health = Invoke-RestMethod ("http://127.0.0.1:$Port/api/health") -TimeoutSec 3
            if (-not $expectVersion) { if ($health.ok) { return $true } }
            elseif ([string]$health.version -eq $expectVersion) { return $true }
        } catch {}
    }
    return $false
}

Write-Log "start target=$TargetVersion port=$Port"
Stop-App
Start-App
if (Wait-Healthy $TargetVersion) {
    Write-Log 'health ok, update confirmed'
    exit 0
}

Write-Log 'new version did not answer, rolling back'
Stop-App
if (Test-Path -LiteralPath $backup) {
    Get-ChildItem -LiteralPath $backup -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($backup.Length).TrimStart('\')
        $target = Join-Path $install $relative
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
}
Remove-Item -LiteralPath $stateFile -Force
Remove-Item -LiteralPath $backup -Recurse -Force
Start-App
if (Wait-Healthy '') { Write-Log 'rolled back and healthy' } else { Write-Log 'rollback start failed' }
