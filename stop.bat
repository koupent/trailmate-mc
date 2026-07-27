@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Stopping Trailmate MC stack...
docker compose down --remove-orphans
echo Done.
if /I not "%~1"=="/nopause" pause
exit /b 0
