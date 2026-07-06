@echo off
title Haven Engine - Setup
cd /d "%~dp0"
echo.
echo   Haven Engine - one-time setup
echo   ------------------------------
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is required but was not found.
  echo   Install the LTS version from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo   Installing components ^(first run only, ~1 min^)...
  call npm install --no-audit --no-fund
)
node setup.js
echo.
pause
