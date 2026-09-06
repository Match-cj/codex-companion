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
$hadExisting = Test-Path -LiteralPath $destination
if (-not $rollback.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '回滚目录校验失败。' }

try {
    if ($hadExisting) {
        $oldStop = Join-Path $destination 'Stop Codex Companion.ps1'
        if (Test-Path -LiteralPath $oldStop) { & $oldStop }
        if (Test-Path -LiteralPath $rollback) { Remove-Item -LiteralPath $rollback -Recurse -Force }
        Move-Item -LiteralPath $destination -Destination $rollback
    }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Expand-Archive -LiteralPath $payload -DestinationPath $destination -Force
    Get-ChildItem -LiteralPath $destination -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    if ($env:CODEX_COMPANION_FAIL_STAGE -eq 'after-extract') { throw '安装失败注入：解包后。' }

    $manifestPath = Join-Path $destination 'PAYLOAD-MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw '安装包缺少完整性清单。' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([int]$manifest.format -ne 1 -or [string]$manifest.algorithm -ne 'SHA256') { throw '安装包完整性清单格式不受支持。' }
    $destinationPrefix = $destination.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $expectedRelativePaths = @{}
    foreach ($entry in @($manifest.files)) {
        $relativePath = [string]$entry.path
        $segments = @($relativePath -split '[\\/]')
        if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or $segments -contains '..') { throw '完整性清单包含不安全路径。' }
        $normalizedRelativePath = $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $filePath = [IO.Path]::GetFullPath((Join-Path $destination $normalizedRelativePath))
        if (-not $filePath.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '完整性清单文件超出安装目录。' }
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "安装包缺少文件：$relativePath" }
        $fileInfo = Get-Item -LiteralPath $filePath
        if ([long]$fileInfo.Length -ne [long]$entry.bytes) { throw "安装包文件大小不符：$relativePath" }
        $actualHash = Get-CompanionFileSha256 $filePath
        if (-not $actualHash.Equals([string]$entry.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw "安装包文件校验失败：$relativePath" }
        $expectedRelativePaths[$relativePath.ToLowerInvariant()] = $true
    }
    $actualPayloadFiles = @(Get-ChildItem -LiteralPath $destination -Recurse -File | Where-Object { -not $_.FullName.Equals($manifestPath, [StringComparison]::OrdinalIgnoreCase) })
    foreach ($actualFile in $actualPayloadFiles) {
        $actualRelativePath = $actualFile.FullName.Substring($destination.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace('\', '/').ToLowerInvariant()
        if (-not $expectedRelativePaths.ContainsKey($actualRelativePath)) { throw "安装包包含未登记文件：$actualRelativePath" }
    }
    if ($actualPayloadFiles.Count -ne $expectedRelativePaths.Count) { throw '安装包文件数量与完整性清单不符。' }

    $node = Join-Path $destination 'runtime\node.exe'
    $codex = Join-Path $destination 'runtime\codex\bin\codex.exe'
    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $codex)) { throw '内置运行时不完整。' }
    $nodeVersion = (& $node --version | Select-Object -First 1)
    $codexVersion = (& $codex --version | Select-Object -First 1)
    & $node --check (Join-Path $destination 'server.mjs')
    if ($LASTEXITCODE -ne 0) { throw '后台程序语法检查失败。' }

    if ($testMode) {
        $result = [pscustomobject]@{ Ok = $true; Destination = $destination; Node = $nodeVersion; Codex = $codexVersion; Files = @(Get-ChildItem -LiteralPath $destination -Recurse -File).Count }
        [IO.File]::WriteAllText((Join-Path $destination 'install-test.json'), ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($true))
        $result | ConvertTo-Json -Compress
        exit 0
    }

    $env:CODEX_COMPANION_QUIET = '1'
    & (Join-Path $destination 'Install Companion.ps1')
    & (Join-Path $destination 'Start Codex Companion.ps1') -NoBrowser
    $status = $null
    for ($attempt = 0; $attempt -lt 15 -and -not $status; $attempt++) {
        try { $status = Invoke-RestMethod 'http://127.0.0.1:17841/api/status' -TimeoutSec 2 } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $status -or [string]$status.version -ne '0.7.8') { throw '安装后后台没有正常启动。' }

    if ($env:CODEX_COMPANION_INSTALL_SILENT -ne '1') {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("Codex Companion 已安装完成并启动。`n`n以后双击桌面的 Codex 助手即可使用，不需要另外安装 Node.js 或 Codex CLI。", 'Codex Companion', 'OK', 'Information') | Out-Null
    }
}
catch {
    $failure = $_
    if ($testMode -and -not [string]::IsNullOrWhiteSpace([string]$env:CODEX_COMPANION_INSTALL_TEST_LOG)) {
        $testLogPath = [IO.Path]::GetFullPath([string]$env:CODEX_COMPANION_INSTALL_TEST_LOG)
        if ($testLogPath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            [IO.File]::WriteAllText($testLogPath, $failure.ToString(), [Text.UTF8Encoding]::new($true))
        }
    }
    if ($hadExisting -and (Test-Path -LiteralPath $rollback)) {
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        Move-Item -LiteralPath $rollback -Destination $destination
        if (-not $testMode) {
            $oldStart = Join-Path $destination 'Start Codex Companion.ps1'
            if (Test-Path -LiteralPath $oldStart) { & $oldStart -NoBrowser }
        }
    }
    elseif (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    throw $failure
}
