@echo off
setlocal
set "POWERSHELL=powershell.exe"
where pwsh.exe >nul 2>nul && set "POWERSHELL=pwsh.exe"
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-aio-package.ps1" %*
exit /b %ERRORLEVEL%