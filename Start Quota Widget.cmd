@echo off
setlocal
cd /d "%~dp0"
start "" powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start Quota Widget.ps1"
endlocal
