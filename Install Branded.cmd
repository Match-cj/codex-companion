@echo off
setlocal
set "CODEX_COMPANION_INSTALL_SILENT=1"
set "CODEX_COMPANION_INSTALL_LOG=%TEMP%\CodexCompanion-install.log"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install Portable.ps1" > "%CODEX_COMPANION_INSTALL_LOG%" 2>&1
set "CODEX_COMPANION_INSTALL_EXIT=%ERRORLEVEL%"
if "%CODEX_COMPANION_INSTALL_EXIT%"=="0" del /q "%CODEX_COMPANION_INSTALL_LOG%" >nul 2>&1
exit /b %CODEX_COMPANION_INSTALL_EXIT%
