@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Graders-Windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup did not complete. Built-in packs remain available with Start-LLM-Bench-Windows.cmd -SkipSetup.
  pause
)
endlocal
