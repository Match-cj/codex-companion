$ErrorActionPreference = 'Stop'

function Get-CompanionFileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($stream)
        return -join @($hashBytes | ForEach-Object { $_.ToString('X2') })
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$payload = Join-Path $PSScriptRoot 'CodexCompanion.payload.zip'
$testMode = $env:CODEX_COMPANION_INSTALL_TEST -eq '1'
if ($testMode) {
    $allowedRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $destination = [IO.Path]::GetFullPath([string]$env:CODEX_COMPANION_INSTALL_ROOT)
} else {
    $allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
    $destination = [IO.Path]::GetFullPath((Join-Path $allowedRoot 'CodexCompanion'))
}
$allowedPrefix = $allowedRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $destination.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '安装目录校验失败。' }
if (-not (Test-Path -LiteralPath $payload)) { throw '安装包缺少程序数据。' }

$rollback = [IO.Path]::GetFullPath($destination + '.previous')
$staging = [IO.Path]::GetFullPath($destination + '.staging-' + [guid]::NewGuid().ToString('N'))
$hadExisting = Test-Path -LiteralPath $destination
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex 助手.lnk'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Companion.lnk'
$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCompanion'
if (-not $rollback.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '回滚目录校验失败。' }
if (-not $staging.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '暂存目录校验失败。' }

try {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Expand-Archive -LiteralPath $payload -DestinationPath $staging -Force
    Get-ChildItem -LiteralPath $staging -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    if ($env:CODEX_COMPANION_FAIL_STAGE -eq 'after-extract') { throw '安装失败注入：解包后。' }

    $manifestPath = Join-Path $staging 'PAYLOAD-MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw '安装包缺少完整性清单。' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$manifest.format -ne 1 -or [string]$manifest.algorithm -ne 'SHA256') { throw '安装包完整性清单格式不受支持。' }
    $destinationPrefix = $staging.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $expectedRelativePaths = @{}
    foreach ($entry in @($manifest.files)) {
        $relativePath = [string]$entry.path
        $segments = @($relativePath -split '[\\/]')
        if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or $segments -contains '..') { throw '完整性清单包含不安全路径。' }
        $normalizedRelativePath = $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $filePath = [IO.Path]::GetFullPath((Join-Path $staging $normalizedRelativePath))
        if (-not $filePath.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '完整性清单文件超出安装目录。' }
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "安装包缺少文件：$relativePath" }
        $fileInfo = Get-Item -LiteralPath $filePath
        if ([long]$fileInfo.Length -ne [long]$entry.bytes) { throw "安装包文件大小不符：$relativePath" }
        $actualHash = Get-CompanionFileSha256 $filePath
        if (-not $actualHash.Equals([string]$entry.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw "安装包文件校验失败：$relativePath" }
        $expectedRelativePaths[$relativePath.ToLowerInvariant()] = $true
    }
    $actualPayloadFiles = @(Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object { -not $_.FullName.Equals($manifestPath, [StringComparison]::OrdinalIgnoreCase) })
    foreach ($actualFile in $actualPayloadFiles) {
        $actualRelativePath = $actualFile.FullName.Substring($staging.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace('\', '/').ToLowerInvariant()
        if (-not $expectedRelativePaths.ContainsKey($actualRelativePath)) { throw "安装包包含未登记文件：$actualRelativePath" }
    }
    if ($actualPayloadFiles.Count -ne $expectedRelativePaths.Count) { throw '安装包文件数量与完整性清单不符。' }

    $node = Join-Path $staging 'runtime\node.exe'
    $codex = Join-Path $staging 'runtime\codex\bin\codex.exe'
    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $codex)) { throw '内置运行时不完整。' }
    $nodeVersion = (& $node --version | Select-Object -First 1)
    $codexVersion = (& $codex --version | Select-Object -First 1)
    & $node --check (Join-Path $staging 'server.mjs')
    if ($LASTEXITCODE -ne 0) { throw '后台程序语法检查失败。' }

    if ($testMode) {
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        Get-ChildItem -LiteralPath $staging -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
        $result = [pscustomobject]@{ Ok = $true; Destination = $destination; Node = $nodeVersion; Codex = $codexVersion; Files = @(Get-ChildItem -LiteralPath $destination -Recurse -File).Count }
        [IO.File]::WriteAllText((Join-Path $destination 'install-test.json'), ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($true))
        $result | ConvertTo-Json -Compress
        exit 0
    }

    try { Stop-ScheduledTask -TaskName 'Codex Companion' -ErrorAction SilentlyContinue } catch {}
    if ($hadExisting) {
        $oldStop = Join-Path $destination 'Stop Codex Companion.ps1'
        if (Test-Path -LiteralPath $oldStop) { & $oldStop }
    }
    Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -in @('node.exe','codex.exe','powershell.exe','wscript.exe') -and $_.CommandLine -and
        $_.CommandLine.IndexOf($destination, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 700
    if (Test-Path -LiteralPath $rollback) { Remove-Item -LiteralPath $rollback -Recurse -Force }
    if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination $rollback }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem -LiteralPath $staging -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }

    $manifestPath = Join-Path $destination 'PAYLOAD-MANIFEST.json'
    $node = Join-Path $destination 'runtime\node.exe'

    $env:CODEX_COMPANION_QUIET = '1'
    & (Join-Path $destination 'Install Companion.ps1')
    # Start through the same hidden worker regardless of whether startup was
    # registered as a scheduled task or as the policy-compatible Startup fallback.
    & (Join-Path $env:WINDIR 'System32\wscript.exe') (Join-Path $destination 'Codex Companion Worker.vbs')
    $status = $null
    $healthError = ''
    # The launcher can make two 45-second attempts on a cold/antivirus-scanned
    # machine. Do not roll back while that supported recovery path is still active.
    for ($attempt = 0; $attempt -lt 105 -and -not $status; $attempt++) {
        # Use the bundled runtime, bypassing Windows PowerShell's system proxy.
        # A response from an older service is not proof the new install is ready.
        try {
            $probe = 'const http=require("http");const r=http.get("http://127.0.0.1:17841/api/health",s=>{let b="";s.on("data",d=>b+=d);s.on("end",()=>{try{const j=JSON.parse(b);if(s.statusCode!==200||!j.ok||!j.version)throw Error("HTTP "+s.statusCode);console.log(JSON.stringify({version:j.version}))}catch(e){console.error(e.message);process.exitCode=1}})});r.setTimeout(2000,()=>r.destroy(Error("health timeout")));r.on("error",e=>{console.error(e.message);process.exitCode=1});' | & $node 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($probe -join ' ') }
            $candidate = ($probe -join '') | ConvertFrom-Json
            if ([string]$candidate.version -ne [string]$manifest.version) { throw "Expected version $($manifest.version), received $($candidate.version)" }
            $status = $candidate
        } catch { $healthError = $_.ToString(); Start-Sleep -Seconds 1 }
    }
    if (-not $status -or [string]$status.version -ne [string]$manifest.version) {
        $launcherTail = ''
        try { $launcherTail = (Get-Content (Join-Path $destination 'launcher.log') -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } catch {}
        throw "安装后后台检查失败：$healthError$([Environment]::NewLine)$launcherTail"
    }
    if (Test-Path -LiteralPath $rollback) { Remove-Item -LiteralPath $rollback -Recurse -Force -ErrorAction SilentlyContinue }

    if ($env:CODEX_COMPANION_INSTALL_SILENT -ne '1') {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("Codex Companion 已安装完成并启动。`n`n以后双击桌面的 Codex 助手即可使用，不需要另外安装 Node.js 或 Codex CLI。", 'Codex Companion', 'OK', 'Information') | Out-Null
    }
}
catch {
    $failure = $_
    Write-Output ('INSTALL FAILURE: ' + $failure.ToString())
    if (-not $testMode) {
        # Capture diagnostics before rollback removes the failed installation.
        try {
            $diagnostic = @('INSTALL FAILURE: ' + $failure.ToString(), 'Expected version: ' + $manifest.version, 'Last health error: ' + $healthError)
            foreach ($logName in @('launcher.log','server.stdout.log','server.stderr.log')) {
                $diagnostic += "--- $logName ---"
                $logFile = Join-Path $destination $logName
                if (Test-Path -LiteralPath $logFile) { $diagnostic += Get-Content -LiteralPath $logFile -Tail 100 }
            }
            $diagnosticPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodexCompanion安装失败日志.txt'
            [IO.File]::WriteAllText($diagnosticPath, ($diagnostic -join [Environment]::NewLine), [Text.UTF8Encoding]::new($true))
            Write-Output "Diagnostic log: $diagnosticPath"
        } catch { Write-Output ('Unable to save desktop diagnostic: ' + $_.ToString()) }
    }
    if ($testMode -and -not [string]::IsNullOrWhiteSpace([string]$env:CODEX_COMPANION_INSTALL_TEST_LOG)) {
        $testLogPath = [IO.Path]::GetFullPath([string]$env:CODEX_COMPANION_INSTALL_TEST_LOG)
        if ($testLogPath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            [IO.File]::WriteAllText($testLogPath, $failure.ToString(), [Text.UTF8Encoding]::new($true))
        }
    }
    try { Stop-ScheduledTask -TaskName 'Codex Companion' -ErrorAction SilentlyContinue } catch {}
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -in @('node.exe','codex.exe','powershell.exe','wscript.exe') -and $_.CommandLine -and
        $_.CommandLine.IndexOf($destination, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    if ($hadExisting -and (Test-Path -LiteralPath $rollback)) {
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue }
        if (-not (Test-Path -LiteralPath $destination)) { Move-Item -LiteralPath $rollback -Destination $destination -ErrorAction SilentlyContinue }
        if (-not $testMode) {
            $env:CODEX_COMPANION_QUIET = '1'
            $oldInstall = Join-Path $destination 'Install Companion.ps1'
            if (Test-Path -LiteralPath $oldInstall) { try { & $oldInstall } catch {} }
            $oldStart = Join-Path $destination 'Start Codex Companion.ps1'
            if (Test-Path -LiteralPath $oldStart) { & $oldStart -NoBrowser }
        }
    }
    elseif (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not $hadExisting) {
        if (Test-Path -LiteralPath $desktopShortcut) { Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $startupShortcut) { Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $uninstallRegistryPath) { Remove-Item -LiteralPath $uninstallRegistryPath -Recurse -Force -ErrorAction SilentlyContinue }
    }
    throw $failure
}
finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
