$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'Codex Companion.lnk'
$targetPath = Join-Path $PSScriptRoot 'Start Codex Companion Background.cmd'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Save()

Write-Host "Startup shortcut installed: $shortcutPath"
