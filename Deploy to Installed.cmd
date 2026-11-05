@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Deploy to Installed.ps1"
echo.
if errorlevel 1 (
  echo Deploy FAILED - see messages above.
) else (
  echo Deploy finished.
)
pause
endlocal
