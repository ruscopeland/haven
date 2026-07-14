@echo off
cd /d "%~dp0"
cd crypto-data-collector
python -m tools.backup_database
pause
