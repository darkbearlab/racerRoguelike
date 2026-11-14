@echo off
rem Start the local dev server and open the game in the default browser.
rem Close this window (or press Ctrl+C) to stop the server.
title Race Roguelike - close this window to stop the server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing packages...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo  The game opens in your browser in a moment.
echo  Close this window to stop the server.
echo.
call npx vite --open
pause
