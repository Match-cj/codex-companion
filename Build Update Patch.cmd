@echo off
chcp 65001 >nul
setlocal
rem 生成应用内更新补丁：把本项目自己的程序文件打成一个几百 KB 的 zip。
rem 生成后把 zip 传到对应 GitHub Release 的附件里，并在说明里写上 PATCH-SHA256。
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0tools\make-patch.mjs" %*
if errorlevel 1 (
  echo.
  echo 生成失败，请把上面的错误信息发给我。
  pause
  exit /b 1
)
echo.
pause
