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
echo.
echo === dashboard logs (last 20) ===
docker compose logs --tail=20 dashboard
echo.
echo Dashboard: http://127.0.0.1:8787
pause
exit /b 0
