@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the Channel Room stop helper.
  pause
  exit /b 1
)
node "%~dp0launch.cjs" stop
if errorlevel 1 (
  pause
  exit /b 1
)
