@echo off
rem Startar x-time med riktig data (mappen data). Dubbelklicka på filen. Stäng fönstret eller tryck Ctrl+C för att stoppa.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js saknas. Installera den senaste LTS-versionen från https://nodejs.org och försök igen.
  pause
  exit /b 1
)
echo Startar x-time. Första gången skrivs administratörens lösenord ut här nedanför.
start "" /b cmd /c "ping -n 5 127.0.0.1 >nul & start http://localhost:3000"
node src\start.js
pause
