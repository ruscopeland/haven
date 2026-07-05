@echo off
echo Starting Crypto Data Collector Backend...

echo Starting API Server...
start "Crypto API Server" cmd /k "uvicorn api.server:app --reload"

echo Starting Scanner Engine...
start "Crypto Scanner Engine" cmd /k "python scanner\collector.py"

echo.
echo Both services have been started in new windows!
echo You can close this window.
pause
