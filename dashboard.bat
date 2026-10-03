@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then reopen this file.
  pause
  exit /b 1
)
rem [AI-added] 2026-09-19 00:30: default entry is the unified web console; the old CLI menu stays available via --cli
if /i "%~1"=="--cli" goto cli
rem Legacy default entry (superseded by the web console): node "%~dp0runtime\wizard.cjs" %*
node "%~dp0runtime\web-console.cjs" %*
set "TASK_EXIT=%errorlevel%"
if not "%TASK_EXIT%"=="0" pause
exit /b %TASK_EXIT%
:cli
shift
set "CLI_ARGS="
:cli_loop
if "%~1"=="" goto cli_run
set "CLI_ARGS=%CLI_ARGS% %~1"
shift
goto cli_loop
:cli_run
node "%~dp0runtime\wizard.cjs" %CLI_ARGS%
set "TASK_EXIT=%errorlevel%"
if not "%TASK_EXIT%"=="0" pause
exit /b %TASK_EXIT%
