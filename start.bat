@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul

echo ========================================
echo  Trailmate MC START (Docker only)
echo ========================================
echo.
echo  Containers start parked. The companion does NOT join
echo  the Minecraft world until you press Spawn in the dashboard.
echo.

docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker is not ready. Start Docker Desktop first.
  echo         Tip: enable "Start Docker Desktop when you sign in" for auto-start.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [INFO] Creating .env from .env.example
  copy /Y .env.example .env >nul
)

if not exist "config.json" (
  echo [INFO] Creating config.json from config.example.json
  copy /Y config.example.json config.json >nul
)

if not exist "services\viaproxy\viaproxy.yml" (
  echo [INFO] Creating services\viaproxy\viaproxy.yml from example
  copy /Y services\viaproxy\viaproxy.yml.example services\viaproxy\viaproxy.yml >nul
)

if not exist "data" mkdir data

echo [1/3] Starting ViaProxy...
docker compose up -d viaproxy
if errorlevel 1 (
  echo [ERROR] Failed to start viaproxy.
  pause
  exit /b 1
)

docker compose up -d --wait viaproxy
if errorlevel 1 (
  echo [ERROR] Timed out waiting for healthy ViaProxy.
  echo        First boot may write a default config and exit once.
  echo        Check services\viaproxy\viaproxy.yml and retry.
  pause
  exit /b 1
)

echo [2/3] Starting Trailmate (parked, not in-world)...
docker compose up -d --build trailmate
if errorlevel 1 (
  echo [ERROR] Failed to start trailmate.
  pause
  exit /b 1
)

echo [3/3] Starting dashboard...
docker compose up -d --build dashboard
if errorlevel 1 (
  echo [ERROR] Failed to start dashboard.
  pause
  exit /b 1
)

echo.
echo Done. Opening dashboard...
echo   Dashboard: http://127.0.0.1:8787
echo   ViaProxy:  localhost:25568
echo.
echo   Use the dashboard to set the server address and Spawn / Despawn.
echo   stop.bat / restart.bat only control Docker containers.
echo.

start "" "http://127.0.0.1:8787"
timeout /t 2 /nobreak >nul
pause
exit /b 0
