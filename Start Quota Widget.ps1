# Hidden launcher for the quota widget. Pure PowerShell: no VBS wrapper, which
# antivirus engines quarantine when it spawns hidden PowerShell.
# The widget script is UTF-8 (with BOM) and contains Chinese text; PowerShell
# 5.1 must read it via -Encoding UTF8 and run it as a scriptblock, otherwise it
# misparses the file. This wrapper is pure ASCII so it is safe to run directly.
$ErrorActionPreference = 'Stop'
$widgetScript = Join-Path $PSScriptRoot 'Quota Widget WPF.ps1'
if (-not (Test-Path -LiteralPath $widgetScript)) { throw "找不到浮窗脚本：$widgetScript" }
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath $widgetScript
& ([scriptblock]::Create($source)) @args
