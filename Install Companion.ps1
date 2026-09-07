param([switch]$EnableStartup)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$appVersion = [string]$package.version
$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCompanion'
$uninstallScript = Join-Path $root 'Uninstall Companion.ps1'
$uninstallCommand = '"' + (Join-Path $PSHOME 'powershell.exe') + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $uninstallScript + '"'
if ($env:CODEX_COMPANION_INSTALL_REGISTRY_TEST -eq '1') {
    [pscustomobject]@{ RegistryPath = $uninstallRegistryPath; Version = $appVersion; InstallLocation = $root; UninstallString = $uninstallCommand } | ConvertTo-Json -Compress
    exit 0
}
$missing = @()
$bundledNode = Join-Path $root 'runtime\node.exe'
$bundledCodex = Join-Path $root 'runtime\codex\bin\codex.exe'

if (-not (Test-Path -LiteralPath $bundledNode) -and -not (Get-Command node.exe -ErrorAction SilentlyContinue)) { $missing += 'Node.js LTS' }
if (-not (Test-Path -LiteralPath $bundledCodex) -and -not (Get-Command codex.cmd -ErrorAction SilentlyContinue) -and -not (Get-Command codex.exe -ErrorAction SilentlyContinue)) { $missing += 'OpenAI Codex CLI' }

if ($missing.Count -gt 0) {
    Add-Type -AssemblyName System.Windows.Forms
    $message = "请先安装以下依赖：`n`n- " + ($missing -join "`n- ") + "`n`n安装完成后再次运行本脚本。"
    [System.Windows.Forms.MessageBox]::Show($message, 'Codex Companion 安装检查', 'OK', 'Warning') | Out-Null
    exit 1
}

$launcher = Join-Path $root 'Codex Companion Launcher.vbs'
$icon = Join-Path $root 'companion.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Codex 助手.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $root
if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = $icon + ',0' }
$shortcut.Save()

$estimatedSizeKb = [int][Math]::Ceiling(((Get-ChildItem -LiteralPath $root -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1KB)
New-Item -Path $uninstallRegistryPath -Force | Out-Null
$registryValues = @{
    DisplayName = 'Codex Companion'
    DisplayVersion = $appVersion
    Publisher = 'Codex Companion'
    InstallLocation = $root
    DisplayIcon = $icon
    UninstallString = $uninstallCommand
    NoModify = 1
    NoRepair = 1
    EstimatedSize = $estimatedSizeKb
}
foreach ($entry in $registryValues.GetEnumerator()) {
    $kind = if ($entry.Key -in @('NoModify', 'NoRepair', 'EstimatedSize')) { 'DWord' } else { 'String' }
    New-ItemProperty -Path $uninstallRegistryPath -Name $entry.Key -Value $entry.Value -PropertyType $kind -Force | Out-Null
}

# Always register the hidden scheduled task. It prevents console flashes and
# keeps Companion independent when ChatGPT/Codex is closed.
& (Join-Path $root 'Install Startup Task.ps1')

if ($env:CODEX_COMPANION_QUIET -ne '1') {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("安装完成。`n`n以后双击桌面上的 Codex 助手即可启动。", 'Codex Companion', 'OK', 'Information') | Out-Null
}
