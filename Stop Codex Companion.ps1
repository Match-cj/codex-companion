$installRoot = [IO.Path]::GetFullPath($PSScriptRoot)

try { Stop-ScheduledTask -TaskName 'Codex Companion' -ErrorAction SilentlyContinue } catch {}

$processes = Get-CimInstance Win32_Process |
    Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -in @('node.exe','codex.exe','powershell.exe','wscript.exe') -and $_.CommandLine -and (
            $_.CommandLine.IndexOf($installRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $_.CommandLine -like '*CodexCompanion*server.mjs*'
        )
    }

foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500
Write-Host 'Codex Companion stopped.'
