@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -Watch
if errorlevel 1 (
  echo.
  echo Live preview did not start. Read the message above.
  pause
)
endlocal
