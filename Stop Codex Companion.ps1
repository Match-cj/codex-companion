$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*CodexCompanion*server.mjs*' }

foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force
}

Write-Host 'Codex Companion stopped.'
