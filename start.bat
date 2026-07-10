@echo off
chcp 65001 >nul
cd /d "%~dp0"

title Alpha Launcher
echo ==============================================
echo   STARTING EVERYTHING
echo ==============================================
echo.

REM --- 1. Collector ---
tasklist /FI "WINDOWTITLE eq Alpha Collector" 2>nul | findstr "cmd.exe" >nul
if %errorlevel% equ 0 (
    echo   [SKIP] Collector is already running.
) else (
    echo   [START] Opening Collector window...
    start "Alpha Collector" cmd /k "title Alpha Collector && cd /d %~dp0crypto-data-collector && python onchain_collector.py"
    echo          Give it a few seconds to connect to the chain RPCs...
)
echo.

REM --- 2. Marker Engine (headless executor) ---
tasklist /FI "WINDOWTITLE eq Alpha Engine" 2>nul | findstr "cmd.exe" >nul
if %errorlevel% equ 0 (
    echo   [SKIP] Marker Engine is already running.
) else (
    echo   [START] Opening Marker Engine window...
    start "Alpha Engine" cmd /k "title Alpha Engine && cd /d %~dp0marker-engine && (if not exist node_modules npm install --no-audit --no-fund) && npm start"
    echo          Executes chart markers on-chain. Key comes from
    echo          marker-engine/.env ^(PRIVATE_KEY^).
)
echo.

REM --- 3. Kill old processes on ports ---
echo   [KILL] Freeing ports 8000 + 5173...
powershell -NoProfile -Command ^
    "netstat -ano | Select-String ':8000 ' | ForEach-Object { $p = [int]($_ -split '\s+')[-1]; if ($p -gt 0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }"
powershell -NoProfile -Command ^
    "netstat -ano | Select-String ':5173 ' | ForEach-Object { $p = [int]($_ -split '\s+')[-1]; if ($p -gt 0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }"
timeout /t 2 /nobreak >nul
echo.

REM --- 4. API Server ---
echo   [START] Opening API Server window (port 8000)...
start "Alpha API" cmd /k "title Alpha API && cd /d %~dp0crypto-data-collector && python main.py"
timeout /t 3 /nobreak >nul
echo.

REM --- 5. CMC rank refresh (background, does not block startup) ---
echo   [RANK] Refreshing CMC market caps in background...
start "Haven CMC Rank" cmd /c "cd /d %~dp0crypto-data-collector && python cmc_ranking.py --limit 500 --cmc-only"
echo.

REM --- 6. Frontend (Chart) ---
echo   [START] Opening Chart UI window (port 5173)...
start "Alpha UI" cmd /k "title Alpha UI && cd /d %~dp0crypto-charting-ui && npx vite --port 5173"
timeout /t 3 /nobreak >nul
echo.

REM --- 7. Open browser ---
echo   [OPEN] http://localhost:5173
start http://localhost:5173
echo.

REM --- 8. Done ---
echo ==============================================
echo   ALL LAUNCHED
echo ==============================================
echo.
echo   Collector  : "Alpha Collector" window  (on-chain DEX swaps -^> buckets)
echo   Engine     : "Alpha Engine" window     (executes marker swaps on-chain)
echo   API        : "Alpha API" window        - http://localhost:8000
echo   Alpha Terminal : "Alpha UI" window     - http://localhost:5173 (dashboard + charts + engine controls)
echo   Rank job   : "Haven CMC Rank"          (market caps + logo ids)
echo.
echo   Close each window individually to stop that component.
echo   Run this batch file again anytime - it won't duplicate
echo   processes that are already running.
echo.
pause
