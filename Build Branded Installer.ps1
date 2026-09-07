param(
    [string]$CodexVersion = '0.153.4',
    [string]$IsccPath = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$appVersion = [string]$package.version
$outputRoot = [IO.Path]::GetFullPath((Split-Path $root -Parent))
$output = Join-Path $outputRoot "CodexCompanion-Setup-v$appVersion.exe"
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ("CodexCompanionInnoBuild-" + [guid]::NewGuid().ToString('N'))))
$systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $temporaryRoot.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase)) { throw '临时目录校验失败。' }

if ([string]::IsNullOrWhiteSpace($IsccPath)) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
        (Join-Path ${env:ProgramFiles} 'Inno Setup 7\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe')
    )
    $IsccPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath)) {
    throw '没有找到 Inno Setup 7 命令行编译器 ISCC.exe。请先安装官方 Inno Setup 7 x64。'
}
if (Test-Path -LiteralPath $output) { throw "输出文件已存在：$output" }

$payloadRoot = Join-Path $temporaryRoot 'payload'
$runtimeRoot = Join-Path $payloadRoot 'runtime'
$depsRoot = Join-Path $temporaryRoot 'codex-deps'
$stageRoot = Join-Path $temporaryRoot 'stage'
$payloadZip = Join-Path $stageRoot 'CodexCompanion.payload.zip'
$issPath = Join-Path $temporaryRoot 'CodexCompanion.iss'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$appFiles = @(
    'Codex Companion Launcher.vbs','Codex Companion Worker.vbs','companion.ico','dashboard.html','HANDOVER.md',
    'Install Companion.cmd','Install Companion.ps1','Install Startup Task.ps1','Launch Quota Widget.vbs',
    'package.json','Quota Widget WPF.ps1','README.md','server.mjs',
    'Start Codex Companion Background.cmd','Start Codex Companion.cmd','Start Codex Companion.ps1',
    'Start Quota Widget.cmd','Stop Codex Companion.cmd','Stop Codex Companion.ps1',
    'Uninstall Companion.cmd','Uninstall Companion.ps1'
)

try {
    New-Item -ItemType Directory -Force -Path $payloadRoot,$runtimeRoot,$depsRoot,$stageRoot | Out-Null
    foreach ($file in $appFiles) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $payloadRoot }
    Copy-Item -LiteralPath $node -Destination (Join-Path $runtimeRoot 'node.exe')

    & $npm install --prefix $depsRoot "@openai/codex@$CodexVersion" --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Codex CLI $CodexVersion 下载失败。" }
    $vendorCandidates = @(
        (Join-Path $depsRoot 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'),
        (Join-Path $depsRoot 'node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc')
    )
    $vendor = $vendorCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\codex.exe') } | Select-Object -First 1
    if (-not $vendor) { throw '下载内容中没有 Windows x64 Codex CLI。' }
    Copy-Item -LiteralPath $vendor -Destination (Join-Path $runtimeRoot 'codex') -Recurse

    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/v$((& $node --version).TrimStart('v'))/LICENSE" -OutFile (Join-Path $payloadRoot 'NODE-LICENSE.txt')
    Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/openai/codex/main/LICENSE' -OutFile (Join-Path $payloadRoot 'CODEX-LICENSE.txt')

    $manifestFiles = @(Get-ChildItem -LiteralPath $payloadRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
        $relativePath = $_.FullName.Substring($payloadRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace('\', '/')
        [pscustomobject]@{ path = $relativePath; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash; bytes = $_.Length }
    })
    $payloadManifest = [ordered]@{ format = 1; version = $appVersion; algorithm = 'SHA256'; files = $manifestFiles }
    [IO.File]::WriteAllText((Join-Path $payloadRoot 'PAYLOAD-MANIFEST.json'), ($payloadManifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($true))
    Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $payloadRoot | ForEach-Object FullName) -DestinationPath $payloadZip -CompressionLevel Optimal
    Copy-Item -LiteralPath (Join-Path $root 'Install Portable.ps1') -Destination (Join-Path $stageRoot 'Install Portable.ps1')
    Copy-Item -LiteralPath (Join-Path $root 'Install Branded.cmd') -Destination (Join-Path $stageRoot 'Install Branded.cmd')

    $iconPath = (Join-Path $root 'companion.ico').Replace('"', '""')
    $payloadSource = $payloadZip.Replace('"', '""')
    $scriptSource = (Join-Path $stageRoot 'Install Portable.ps1').Replace('"', '""')
    $commandSource = (Join-Path $stageRoot 'Install Branded.cmd').Replace('"', '""')
    $escapedOutputRoot = $outputRoot.Replace('"', '""')
    $iss = @"
[Setup]
AppId={{B17D38C8-AB48-47B0-A02C-4CD6909D12B9}
AppName=Codex Companion
AppVersion=$appVersion
AppVerName=Codex Companion $appVersion
AppPublisher=Codex Companion
VersionInfoVersion=$appVersion
VersionInfoProductName=Codex Companion
VersionInfoDescription=Codex Companion 安装程序
DefaultDirName={localappdata}\Programs\CodexCompanion
CreateAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UsePreviousAppDir=no
Uninstallable=no
SetupIconFile=$iconPath
WizardStyle=modern
WizardSizePercent=110
Compression=lzma2/fast
SolidCompression=yes
OutputDir=$escapedOutputRoot
OutputBaseFilename=CodexCompanion-Setup-v$appVersion
CloseApplications=no
RestartApplications=no
SetupLogging=yes
ShowLanguageDialog=no
SetupMutex=CodexCompanionInstaller

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "$payloadSource"; DestDir: "{tmp}\CodexCompanionSetup"; DestName: "CodexCompanion.payload.zip"; Flags: deleteafterinstall
Source: "$scriptSource"; DestDir: "{tmp}\CodexCompanionSetup"; DestName: "Install Portable.ps1"; Flags: deleteafterinstall
Source: "$commandSource"; DestDir: "{tmp}\CodexCompanionSetup"; DestName: "Install Branded.cmd"; Flags: deleteafterinstall

[Run]
Filename: "{tmp}\CodexCompanionSetup\Install Branded.cmd"; Description: "安装并启动 Codex Companion"; StatusMsg: "正在校验程序文件并安全升级…"; Flags: runhidden waituntilterminated

[Messages]
WelcomeLabel1=安装 Codex Companion
WelcomeLabel2=这个向导将安装账号额度浮窗、任务管理与通知功能。%n%n升级不会删除已保存的账号、备注和通知设置。
FinishedHeadingLabel=Codex Companion 已安装完成
FinishedLabelNoIcons=程序已启动。以后双击桌面的“Codex 助手”即可使用。
"@
    [IO.File]::WriteAllText($issPath, $iss, [Text.UTF8Encoding]::new($true))
    & $IsccPath $issPath
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup 编译失败（$LASTEXITCODE）。" }
    if (-not (Test-Path -LiteralPath $output)) { throw 'Inno Setup 没有生成预期安装器。' }
    [pscustomobject]@{
        Output = $output
        Bytes = (Get-Item -LiteralPath $output).Length
        SHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash
        Installer = 'Inno Setup 7'
        ManifestFiles = $manifestFiles.Count
    } | ConvertTo-Json -Compress
}
finally {
    if ((Test-Path -LiteralPath $temporaryRoot) -and $temporaryRoot.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
