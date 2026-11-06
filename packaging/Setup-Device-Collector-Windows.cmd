@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Device-Collector-Windows.ps1" -Interactive %*
if errorlevel 1 pause
endlocal
