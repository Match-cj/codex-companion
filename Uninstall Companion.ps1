$ErrorActionPreference = 'Stop'
$programsRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$installRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $programsRoot 'CodexCompanion'))
$testMode = $env:CODEX_COMPANION_UNINSTALL_TEST -eq '1'
if (-not $installRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    if ($testMode) {
        [pscustomobject]@{ Protected = $true; InstallRoot = $installRoot; ExpectedRoot = $expectedRoot } | ConvertTo-Json -Compress
        exit 0
    }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('只能从正式安装目录运行卸载。开发目录不会被删除。', 'Codex Companion', 'OK', 'Warning') | Out-Null
    exit 1
}
if ($testMode) {
    [pscustomobject]@{ Protected = $false; InstallRoot = $installRoot; ExpectedRoot = $expectedRoot } | ConvertTo-Json -Compress
    exit 0
}
Add-Type -AssemblyName System.Windows.Forms

$choice = [System.Windows.Forms.MessageBox]::Show("是否保留账号、备注、飞书设置和通知历史？`n`n选择 是：只卸载程序，保留数据。`n选择 否：程序和全部 Companion 数据一起删除。`n选择 取消：不做任何操作。", '卸载 Codex Companion', 'YesNoCancel', 'Question')
if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) { exit 0 }
$removeData = $choice -eq [System.Windows.Forms.DialogResult]::No
if ($removeData) {
    $confirm = [System.Windows.Forms.MessageBox]::Show('这会永久删除 Companion 保存的所有账号凭据、备注、备份、飞书配置和通知历史。确定继续吗？', '确认彻底删除', 'YesNo', 'Warning')
    if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
}

$stop = Join-Path $installRoot 'Stop Codex Companion.ps1'
if (Test-Path -LiteralPath $stop) { & $stop }
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex 助手.lnk'
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Companion.lnk'
foreach ($shortcut in @($desktopShortcut, $startupShortcut)) { if (Test-Path -LiteralPath $shortcut) { [IO.File]::Delete($shortcut) } }
Unregister-ScheduledTask -TaskName 'Codex Companion' -Confirm:$false -ErrorAction SilentlyContinue
$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCompanion'
if (Test-Path -LiteralPath $uninstallRegistryPath) { Remove-Item -LiteralPath $uninstallRegistryPath -Recurse -Force }

$dataRoot = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'CodexCompanion'))
$appDataRoot = [IO.Path]::GetFullPath($env:APPDATA)
if (-not $dataRoot.StartsWith($appDataRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '账号数据目录校验失败。' }

$helperPath = Join-Path ([IO.Path]::GetTempPath()) ("CodexCompanion-Uninstall-" + [guid]::NewGuid().ToString('N') + '.ps1')
$safeInstallRoot = $installRoot.Replace("'", "''")
$safeDataRoot = $dataRoot.Replace("'", "''")
$helper = @"
Start-Sleep -Seconds 2
if ([IO.Directory]::Exists('$safeInstallRoot')) { [IO.Directory]::Delete('$safeInstallRoot', `$true) }
if (`$args[0] -eq 'remove-data' -and [IO.Directory]::Exists('$safeDataRoot')) { [IO.Directory]::Delete('$safeDataRoot', `$true) }
[IO.File]::Delete(`$PSCommandPath)
"@
[IO.File]::WriteAllText($helperPath, $helper, [Text.UTF8Encoding]::new($true))
$argument = if ($removeData) { 'remove-data' } else { 'keep-data' }
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$helperPath,$argument) -WindowStyle Hidden
[System.Windows.Forms.MessageBox]::Show($(if ($removeData) { '程序和 Companion 数据正在删除。' } else { '程序正在卸载，账号和设置已经保留；以后重新安装可继续使用。' }), 'Codex Companion', 'OK', 'Information') | Out-Null
