@echo off
setlocal
pushd "%~dp0"
set "NODE_EXE=%~dp0development\.local-run\node-v24.22.0-win-x64\node.exe"
"%NODE_EXE%" scripts\prepare-enterprise-app.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
start "" /b "%~dp0node_modules\electron\dist\electron.exe" "%~dp0.build\enterprise-app"
popd
