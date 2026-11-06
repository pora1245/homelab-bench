@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Code-Grader-Windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Optional code grading is not ready. Non-code tests do not need Docker.
  pause
)
endlocal
