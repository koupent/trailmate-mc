@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Stopping Trailmate stack...
docker compose down
echo Done.
pause
