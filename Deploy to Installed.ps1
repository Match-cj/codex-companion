param(
    [string]$InstallDir = '',
    [switch]$NoRestart
)

# 把工程目录（源码）同步到安装目录（运行现场），然后重启。
# 这是唯一允许改动安装目录的方式，不要再手工复制文件。

$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot

function Write-Step($msg) {
    Write-Host ("  " + $msg)
}

Write-Host ""
Write-Host "Codex Companion - Deploy source to installed copy"
Write-Host ("  source: " + $sourceDir)

# --- 定位安装目录（优先读注册表，回退默认路径） ---
if (-not $InstallDir) {
    $regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCompanion'
    if (Test-Path $regPath) {
        $InstallDir = (Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue).InstallLocation
    }
}
if (-not $InstallDir -or -not (Test-Path -LiteralPath $InstallDir)) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\CodexCompanion'
}
if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Host ("  ERROR: install dir not found: " + $InstallDir) -ForegroundColor Red
    exit 1
}
Write-Host ("  target: " + $InstallDir)

# --- 只同步运行时需要的文件；运行时/依赖/打包产物/日志一律不碰 ---
$excludeDirs = @('.git', '.github', 'tests', 'docs', 'node_modules', '.test-data', 'runtime')
$excludeFiles = @(
    'PAYLOAD-MANIFEST.json',
    'CODEX-LICENSE.txt',
    'NODE-LICENSE.txt',
    '.gitignore',
    'Build Branded Installer.ps1',
    'Build Update Patch.cmd',
    'Install Portable.ps1',
    'update-state.json'
)
$excludePatterns = @('*.log')

$copied = New-Object System.Collections.Generic.List[string]
$unchanged = 0

Get-ChildItem -LiteralPath $sourceDir -File | ForEach-Object {
    $name = $_.Name
    if ($excludeFiles -contains $name) { return }
    foreach ($pat in $excludePatterns) {
        if ($name -like $pat) { return }
    }
    $dest = Join-Path $InstallDir $name
    $needCopy = $true
    if (Test-Path -LiteralPath $dest) {
        try {
            $a = (Get-FileHash -LiteralPath $_.FullName -Algorithm MD5).Hash
            $b = (Get-FileHash -LiteralPath $dest -Algorithm MD5).Hash
            if ($a -eq $b) { $needCopy = $false }
        } catch {
            $needCopy = $true
        }
    }
    if ($needCopy) {
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
        $copied.Add($name)
    } else {
        $script:unchanged++
    }
}

# --- 同步必要的子目录（若有） ---
foreach ($sub in @('assets')) {
    $subSrc = Join-Path $sourceDir $sub
    if (Test-Path -LiteralPath $subSrc) {
        $subDst = Join-Path $InstallDir $sub
        if (-not (Test-Path -LiteralPath $subDst)) { New-Item -ItemType Directory -Path $subDst -Force | Out-Null }
        Get-ChildItem -LiteralPath $subSrc -File | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $subDst $_.Name) -Force
        }
        Write-Step ("synced dir: " + $sub)
    }
}

if ($copied.Count -eq 0) {
    Write-Step ("no file changes (" + $unchanged + " files already identical)")
} else {
    Write-Step ("updated " + $copied.Count + " file(s):")
    foreach ($f in $copied) { Write-Host ("    + " + $f) -ForegroundColor Yellow }
    Write-Step ($unchanged.ToString() + " file(s) already identical")
}

# --- 让“应用和功能”里的版本号跟实际一致 ---
$pkgPath = Join-Path $InstallDir 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $ver = [string]$pkg.version
        $regPath2 = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCompanion'
        if (Test-Path $regPath2) {
            Set-ItemProperty -Path $regPath2 -Name DisplayVersion -Value $ver -ErrorAction SilentlyContinue
            Set-ItemProperty -Path $regPath2 -Name InstallLocation -Value $InstallDir -ErrorAction SilentlyContinue
        }
        Write-Step ("version in package.json: " + $ver)
    } catch {
        Write-Step ("could not read package.json: " + $_.Exception.Message)
    }
}

if ($NoRestart) {
    Write-Host ""
    Write-Host "  -NoRestart given; files synced but services were not restarted." -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

# --- 停掉旧进程（否则新文件不会生效） ---
Write-Host ""
Write-Step "stopping running server and widget ..."
$stopped = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*CodexCompanion*server.mjs*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped++
    }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*CodexCompanion*Quota Widget*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped++
    }
Write-Step ("stopped " + $stopped + " process(es)")
Start-Sleep -Milliseconds 1800

# --- 用安装目录自己的启动脚本重启 ---
$launcher = Join-Path $InstallDir 'Start Codex Companion.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Host ("  ERROR: launcher missing: " + $launcher) -ForegroundColor Red
    exit 1
}
Write-Step "starting installed copy ..."
$psExe = Join-Path $PSHOME 'powershell.exe'
Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -NoBrowser') -WindowStyle Hidden

# --- 等待健康检查 ---
$ready = $false
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
    try {
        $req = [System.Net.WebRequest]::Create('http://127.0.0.1:17841/api/health')
        $req.Proxy = $null
        $req.Timeout = 1500
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Dispose()
        if ($code -ge 200 -and $code -lt 300) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}

Write-Host ""
if ($ready) {
    $running = ''
    try {
        $req2 = [System.Net.WebRequest]::Create('http://127.0.0.1:17841/api/status')
        $req2.Proxy = $null
        $req2.Timeout = 2000
        $resp2 = $req2.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp2.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Close()
        $resp2.Dispose()
        $obj = $body | ConvertFrom-Json
        $running = [string]$obj.version
    } catch {}
    Write-Host ("  OK - backend healthy, running version " + $running) -ForegroundColor Green
    Write-Host "  Widget should be visible again."
    Write-Host ""
    exit 0
} else {
    Write-Host "  FAILED - backend did not become ready within 40s." -ForegroundColor Red
    $errLog = Join-Path $InstallDir 'server.stderr.log'
    if (Test-Path -LiteralPath $errLog) {
        Write-Host "  last lines of server.stderr.log:"
        Get-Content -LiteralPath $errLog -Tail 15 | ForEach-Object { Write-Host ("    " + $_) }
    }
    Write-Host ""
    exit 1
}
