@echo off
REM DevCode Windows installer (cmd.exe wrapper)
REM Usage:
REM   curl -fsSL https://raw.githubusercontent.com/AEmad99/devcode/main/install.cmd -o install-devcode.cmd && install-devcode.cmd
REM Or:
REM   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/AEmad99/devcode/main/install.ps1 | iex"

powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/AEmad99/devcode/main/install.ps1 | iex"
if errorlevel 1 exit /b %ERRORLEVEL%
