param([switch]$NoBrowser)

$ErrorActionPreference = 'Continue'
$InformationPreference = 'Continue'

$root = $PSScriptRoot
$roamingRoot = [Environment]::GetFolderPath('ApplicationData')
$companionDataRoot = [IO.Path]::GetFullPath((Join-Path $roamingRoot 'CodexCompanion'))
$env:APPDATA = [IO.Path]::GetFullPath($roamingRoot)
$env:CODEX_COMPANION_DATA_DIR = $companionDataRoot
$bundledNode = Join-Path $root 'runtime\node.exe'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { '' }
$port = 17841
$statusUrl = "http://127.0.0.1:$port/api/status"
$logFile = Join-Path $root 'launcher.log'
$serverOut = Join-Path $root 'server.stdout.log'
$serverErr = Join-Path $root 'server.stderr.log'

function Write-Log($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    try { $line | Out-File -FilePath $logFile -Append -Encoding utf8 } catch {}
}

function Show-ErrorBox($msg) {
    try {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        [System.Windows.Forms.MessageBox]::Show($msg, 'Codex Companion', 'OK', 'Error') | Out-Null
    } catch {
        Write-Log ("MessageBox failed: " + $_.Exception.Message)
    }
}

# TCP connect never goes through an HTTP proxy => reliable localhost readiness check
function Test-PortOpen($hostName, $p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.SendTimeout = 1000
        $c.ReceiveTimeout = 1000
        $c.Connect($hostName, $p)
        $c.Close()
        return $true
    } catch {
        return $false
    }
}

Write-Log "=== Launcher starting (v0.7.13) ==="
Write-Log "Data directory: $companionDataRoot"

if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    Write-Log 'ERROR: node.exe was not found in PATH'
    Show-ErrorBox '没有找到 Node.js。请先安装 Node.js LTS，再重新启动 Codex Companion。'
    exit 1
}

# 1. Clean up any leftover server/widget from previous runs
$existingServer = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*CodexCompanion*server.mjs*' }
foreach ($p in $existingServer) {
    Write-Log "Stopping leftover server PID=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
$existingWidget = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*CodexCompanion*Quota Widget*' }
foreach ($p in $existingWidget) {
    Write-Log "Stopping leftover widget PID=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
# give the OS time to release the port before the new server binds
Start-Sleep -Milliseconds 1500

# 2. Start server with its output captured (so we can see why it fails)
$serverPath = Join-Path $root 'server.mjs'
if (-not (Test-Path $serverPath)) {
    Write-Log "ERROR: server.mjs not found at $serverPath"
    Show-ErrorBox "找不到 server.mjs：`n$serverPath"
    exit 1
}

Write-Log "Starting server (capturing output to server.stdout.log / server.stderr.log)"
try {
    $serverProc = Start-Process -FilePath $node -ArgumentList "`"$serverPath`"" `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru
    Write-Log "Server started PID=$($serverProc.Id)"
} catch {
    Write-Log ("ERROR starting server: " + $_.Exception.Message)
    Show-ErrorBox ("无法启动 server.mjs：`n" + $_.Exception.Message)
    exit 1
}

# 3. Wait for the port to come up (TCP, proxy-proof), up to 20s
$ready = $false
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    if ($serverProc.HasExited) {
        Write-Log ("Server process exited early (code=$($serverProc.ExitCode))")
        break
    }
    if (Test-PortOpen '127.0.0.1' $port) {
        $ready = $true
        Write-Log "Server port ready (TCP)"
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    $errTail = ''
    try { $errTail = (Get-Content $serverErr -Tail 15 -ErrorAction SilentlyContinue) -join "`n" } catch {}
    if (-not $errTail) {
        try { $errTail = (Get-Content $serverOut -Tail 15 -ErrorAction SilentlyContinue) -join "`n" } catch {}
    }
    Write-Log ("ERROR: server not ready. Stderr tail:`n$errTail")
    try { if (-not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } } catch {}
    $msg = "Codex Companion 启动失败。`n`n端口 $port 在 20 秒内没有就绪。"
    if (-not [string]::IsNullOrWhiteSpace($errTail)) {
        $msg += "`n`n服务器日志尾部：`n$errTail"
    }
    $msg += "`n`n可查看 launcher.log / server.stderr.log 了解详情。"
    Show-ErrorBox $msg
    exit 1
}

# 4. Start widget through the UTF-8-safe VBS launcher
$widgetPath = Join-Path $root 'Quota Widget WPF.ps1'
if ((Test-Path $widgetPath) -and (Test-Path (Join-Path $root 'Launch Quota Widget.vbs'))) {
    Write-Log "Starting widget"
    try {
        Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $root 'Launch Quota Widget.vbs') + '"') -WindowStyle Hidden
    } catch {
        Write-Log ("ERROR starting widget: " + $_.Exception.Message)
        Show-ErrorBox ("浮窗启动失败：`n" + $_.Exception.Message +
                       "`n`n服务器仍在运行，可手动打开 http://127.0.0.1:$port/ 查看控制台。")
    }
} else {
    Write-Log "WARNING: widget script not found at $widgetPath"
}

# 5. Optionally open dashboard
if (-not $NoBrowser) {
    Write-Log "Opening dashboard"
    Start-Process "http://127.0.0.1:$port/"
}

Write-Log "Launcher finished"
exit 0
