@echo off
title Haven Engine
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install from https://nodejs.org, then run setup.bat.
  pause
  exit /b 1
)
if not exist .env (
  echo No configuration found. Running setup first...
  node setup.js
)
if not exist node_modules (
  echo Installing components ^(first run only^)...
  call npm install --no-audit --no-fund
)
echo Starting Haven Engine. Leave this window open while trading. Close it to stop.
node index.js
pause
