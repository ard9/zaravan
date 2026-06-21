@echo off
REM ============================================================
REM  MyTube - start script (Windows)
REM ============================================================
cd /d "%~dp0"

REM --- Find a working Python launcher (python, then py) ---
set "PYCMD="
python --version >nul 2>&1 && set "PYCMD=python"
if not defined PYCMD (
    py --version >nul 2>&1 && set "PYCMD=py"
)

if not defined PYCMD (
    echo.
    echo  [!] Python was not found.
    echo.
    echo  Install Python first:
    echo    1. Go to https://www.python.org/downloads/
    echo    2. Run the installer
    echo    3. IMPORTANT: tick "Add python.exe to PATH"
    echo    4. Open a NEW terminal and run this file again.
    echo.
    pause
    exit /b 1
)

echo Using: %PYCMD%
echo Checking Python dependencies...
%PYCMD% -m pip install -r backend\requirements.txt --quiet

echo.
echo Starting MyTube server...
echo Open http://127.0.0.1:8420 in Chrome or Edge
echo Press Ctrl+C to stop.
echo.

%PYCMD% backend\main.py
pause
