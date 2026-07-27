@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul

echo ========================================
echo  Trailmate MC START
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
  echo [INFO] Creating services\viaproxy\viaproxy.yml from example
  copy /Y services\viaproxy\viaproxy.yml.example services\viaproxy\viaproxy.yml >nul
  echo.
  echo [ACTION REQUIRED] Edit target-address in:
  echo   services\viaproxy\viaproxy.yml
  echo   Example: your-server.example.com:25565
  echo Then run start.bat again.
  echo.
  pause
  exit /b 1
)

findstr /C:"your-minecraft-host" "services\viaproxy\viaproxy.yml" >nul 2>&1
if not errorlevel 1 (
  echo [ACTION REQUIRED] services\viaproxy\viaproxy.yml still has the example target-address.
  echo   Open the file and set target-address to your Minecraft server.
  echo   Then run start.bat again.
  echo.
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
  echo        If this is the first ViaProxy boot, it may have written a default
  echo        config and exited. Check services\viaproxy\viaproxy.yml and retry.
  pause
  exit /b 1
)

echo [2/2] Starting Trailmate MC...
docker compose up -d --build trailmate
if errorlevel 1 (
  echo [ERROR] Failed to start trailmate.
  pause
  exit /b 1
)

REM Give the bot a moment to connect; surface common online-mode auth failures.
timeout /t 4 /nobreak >nul
docker compose ps --status exited --services 2>nul | findstr /X /C:"trailmate" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [WARN] Trailmate exited right after start.
  echo        Online-mode servers need a Microsoft account in ViaProxy:
  echo          docker attach trailmate-mc-viaproxy-1
  echo          account add microsoft
  echo        Then detach with CTRL-P CTRL-Q and run restart.bat
  echo        Details: README.md / services\viaproxy\README.md
  echo        Recent logs:
  docker compose logs --tail=20 trailmate
  echo.
)

echo.
echo Done.
echo   ViaProxy:  localhost:25568
echo   Status:    status.bat
echo   Commands:  wait / follow / collect-all / home
echo   (In-game JP: 待機 / 追従 / 全回収 / 拠点)
echo.
pause
exit /b 0
