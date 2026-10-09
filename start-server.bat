@echo off
REM DongQinSha online server launcher.
REM This file is intentionally pure ASCII: cmd.exe reads .bat in the system
REM ANSI codepage, so Chinese literals here would come out garbled.
REM All user-facing Chinese text lives in server.py (a UTF-8 Python file).

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

python server.py %*

echo.
echo   Server stopped.
pause
