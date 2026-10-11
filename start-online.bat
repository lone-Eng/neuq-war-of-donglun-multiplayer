@echo off
REM =========================================================
REM  DongQinSha - internet multiplayer launcher (plan A).
REM
REM  Starts server.py, then a cloudflared tunnel, then opens the
REM  public address so the host plays on the URL that the invite
REM  link will carry.
REM
REM  The real work lives in tools\online.ps1. That file has Chinese
REM  messages, so it is saved as UTF-8 *with* BOM (PowerShell 5.1
REM  reads BOM-less .ps1 as ANSI/GBK and would garble them).
REM
REM  This .bat is intentionally pure ASCII: cmd.exe reads .bat in
REM  the system ANSI codepage, so Chinese literals would garble.
REM =========================================================

chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python was not found. Install Python 3 from https://www.python.org/
  echo   and make sure "Add python.exe to PATH" is checked.
  echo.
  pause
  exit /b 1
)

REM -ExecutionPolicy Bypass: this is a double-click launcher, and a machine
REM with a Restricted policy would otherwise refuse to run the .ps1 at all.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\online.ps1"

echo.
echo   Online session ended.
pause
