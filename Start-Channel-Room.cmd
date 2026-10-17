@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Channel Room requires Node.js 22 or newer. Install Node.js, then try again.
  pause
  exit /b 1
)
node "%~dp0launch.cjs" start
if errorlevel 1 (
  pause
  exit /b 1
)
