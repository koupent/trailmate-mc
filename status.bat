@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo === docker compose ps ===
docker compose ps -a
echo.
echo === Trailmate MC logs (last 40) ===
docker compose logs --tail=40 trailmate
echo.
echo === viaproxy logs (last 20) ===
docker compose logs --tail=20 viaproxy
pause
exit /b 0
