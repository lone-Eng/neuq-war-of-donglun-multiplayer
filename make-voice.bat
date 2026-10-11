@echo off
REM =========================================================
REM  DongQinSha - voice pack generator (double-click me).
REM
REM  Synthesizes the game's spoken lines with the open-source
REM  Kokoro-82M-v1.1-zh model and drops mp3s into audio\voice\,
REM  where the game picks them up (Settings -> voice picker).
REM
REM  The real work lives in tools\make-voice.ps1. That file has
REM  Chinese messages, so it is saved as UTF-8 *with* BOM --
REM  PowerShell 5.1 reads BOM-less .ps1 as ANSI/GBK and would
REM  garble them.
REM
REM  This .bat is intentionally pure ASCII: cmd.exe reads .bat in
REM  the system ANSI codepage, so Chinese literals would garble.
REM
REM  Args are passed through, e.g.:  make-voice.bat -Audition
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

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-voice.ps1" %*

echo.
pause
