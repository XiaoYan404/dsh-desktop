@echo off
setlocal
set "CONTROL_ROOT=%APPDATA%\enterprise-office-agent-development\runtime-control"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0development\deepseek-harness\scripts\gui-hot-development.ps1" -Stop -NoOpen -RuntimeRoot "%CONTROL_ROOT%" -NodeDirectory "%~dp0development\.local-run\node-v24.22.0-win-x64"
if errorlevel 1 pause
