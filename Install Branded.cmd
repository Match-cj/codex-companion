@echo off
setlocal
set "CODEX_COMPANION_INSTALL_SILENT=1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install Portable.ps1"
exit /b %ERRORLEVEL%
