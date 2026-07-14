@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Haven local launcher

echo Starting Haven's API, local trading engine, and web app...
echo.

start "Haven API" cmd /k "cd /d %~dp0crypto-data-collector && python main.py"
start "Haven Engine" cmd /k "cd /d %~dp0marker-engine && (if not exist node_modules npm install --no-audit --no-fund) && npm start"
start "Haven Web" cmd /k "cd /d %~dp0crypto-charting-ui && (if not exist node_modules npm install --no-audit --no-fund) && npm run dev"

timeout /t 4 /nobreak >nul
start http://localhost:5173
echo Haven is opening at http://localhost:5173
echo Close the three Haven windows to stop the local services.
pause
