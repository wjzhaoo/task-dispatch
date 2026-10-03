@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then reopen this file.
  pause
  exit /b 1
)
node "%~dp0runtime\desktop-client.cjs" %*
set "TASK_EXIT=%errorlevel%"
if "%~1"=="" pause
exit /b %TASK_EXIT%
