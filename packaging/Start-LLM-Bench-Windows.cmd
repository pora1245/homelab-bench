@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LLM-Bench-Windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup did not complete. See the message above and docs\WINDOWS-NATIVE-PREPARATION.md.
  echo This launcher does not change saved PowerShell policy, Defender, or SmartScreen.
  pause
)
endlocal
