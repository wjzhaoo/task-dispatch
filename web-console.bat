@echo off
setlocal
chcp 65001 >nul
node "%~dp0runtime\web-console.cjs" %*
if errorlevel 1 pause
