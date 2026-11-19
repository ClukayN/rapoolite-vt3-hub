@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Prefer the native host exe (no console, real tray, frameless window)
if exist "dist\RapooLite.exe" (
  start "" "dist\RapooLite.exe" %*
  goto :eof
)

rem Fallback: run the Node backend and open the UI in an Edge app window
where node >nul 2>nul
if errorlevel 1 (
  echo [RapooLite] Neither dist\RapooLite.exe nor Node.js was found.
  echo [RapooLite] Install Node.js 18+ from https://nodejs.org, or build the exe with host\build.ps1
  pause
  exit /b 1
)

if /i "%~1"=="/debug" (
  echo [RapooLite] debug mode - press Ctrl+C to stop
  node start.js
  goto :eof
)

rem Start hidden: UI opens in its own window, tray stays, no console left behind
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList 'start.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
