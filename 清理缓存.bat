@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer.
  pause
  exit /b 1
)
node "%~dp0runtime\cleanup-cache.cjs" %*
set "TASK_EXIT=%errorlevel%"
pause
exit /b %TASK_EXIT%
