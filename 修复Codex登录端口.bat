@echo off
chcp 65001 >nul
title Fix Codex login port 1455

rem 修复“登录失败: failed to start login server ... os error 10013”。
rem 原因：Windows(WinNAT) 把 1455 端口收进了动态保留范围，谁都绑不了。
rem 办法：重启 winnat 释放，然后永久保留 1455 给 Codex 登录专用。

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要管理员权限，正在弹出授权窗口，请点“是”...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo [1/3] 正在重启 Windows NAT 服务，释放被占的端口范围...
net stop winnat >nul 2>&1
echo [2/3] 正在把 1455 永久保留给 Codex 登录...
netsh int ipv4 add excludedportrange protocol=tcp startport=1455 numberofports=1 store=persistent >nul
echo [3/3] 正在恢复 Windows NAT 服务...
net start winnat >nul 2>&1

echo.
netsh int ipv4 show excludedportrange protocol=tcp | findstr /c:"1455" >nul
if %errorlevel% equ 0 (
  echo √ 修复成功：1455 已永久保留给 Codex 登录，重启电脑也不会丢。
) else (
  echo × 没有确认成功，请再运行一次本脚本；仍失败请把截图发给开发者。
)
echo.
echo 现在可以回到 Codex 客户端或 Codex Companion 网页重新点登录了。
echo.
pause
