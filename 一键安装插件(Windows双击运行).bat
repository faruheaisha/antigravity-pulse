@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\install.ps1" (
    echo [ERROR] Please extract the entire ZIP archive to a folder before running!
    pause
    exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 pause
