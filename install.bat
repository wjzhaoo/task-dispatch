@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js and retry.
  pause
  exit /b 1
)
node "%~dp0scripts\install.js" %*
set "TASK_EXIT=%errorlevel%"
if "%~1"=="" pause
exit /b %TASK_EXIT%
