@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  Trailmate START
echo ========================================
echo.

docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker is not ready. Start Docker Desktop first.
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
  echo [WARN] services\viaproxy\viaproxy.yml is missing.
  echo        Copy viaproxy.yml.example and set target-address.
  pause
  exit /b 1
)

echo [1/2] Starting ViaProxy...
docker compose up -d viaproxy
if errorlevel 1 (
  echo [ERROR] Failed to start viaproxy.
  pause
  exit /b 1
)

docker compose up -d --wait viaproxy
if errorlevel 1 (
  echo [ERROR] Timed out waiting for healthy ViaProxy.
  pause
  exit /b 1
)

echo [2/2] Starting Trailmate...
docker compose up -d --build trailmate
if errorlevel 1 (
  echo [ERROR] Failed to start trailmate.
  pause
  exit /b 1
)

echo.
echo Done.
echo   ViaProxy:  localhost:25568
echo   Commands:  待機 / 追従 / 全回収 / 拠点
echo.
pause
