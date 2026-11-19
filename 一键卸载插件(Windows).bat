@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\uninstall.ps1" (
    echo [ERROR] Missing scripts\uninstall.ps1
    pause
    exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
if errorlevel 1 pause
