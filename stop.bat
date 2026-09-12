@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Stopping Trailmate MC Docker stack...
echo (This does not require despawn first; containers will stop.)
docker compose down --remove-orphans
echo Done.
if /I not "%~1"=="/nopause" pause
exit /b 0
