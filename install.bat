@echo off
title SalesHandy Dashboard — Installer
color 0B

echo.
echo   ========================================================
echo     SalesHandy Dashboard — One-Time Setup
echo   ========================================================
echo.
echo   This will:
echo     1. Start the dashboard server now
echo     2. Make it start automatically when your PC boots
echo.
echo   Press any key to continue (or close this window to cancel)
pause >nul

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo   ERROR: Node.js is not installed!
    echo   Download it from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

:: Get the folder where this script lives
set "SCRIPT_DIR=%~dp0"

:: Create a VBS script that launches node silently (no black window)
echo   Creating silent launcher...
(
echo Set WshShell = CreateObject("WScript.Shell"^)
echo WshShell.Run "cmd /c cd /d ""%SCRIPT_DIR%"" && node server.js", 0, False
) > "%SCRIPT_DIR%saleshandy-silent.vbs"

:: Create a visible launcher for manual use
(
echo @echo off
echo title SalesHandy Dashboard
echo color 0B
echo echo.
echo echo   SalesHandy Dashboard is running!
echo echo   Open http://localhost:8080 in your browser
echo echo   Share the URL with your team
echo echo.
echo echo   Keep this window open. Close it to stop the server.
echo echo.
echo cd /d "%SCRIPT_DIR%"
echo node server.js
echo pause
) > "%SCRIPT_DIR%start-dashboard-visible.bat"

:: Add to Windows Startup folder (runs on boot)
echo   Setting up auto-start on boot...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

:: Copy the silent VBS launcher to Startup folder
copy /y "%SCRIPT_DIR%saleshandy-silent.vbs" "%STARTUP%\saleshandy-dashboard.vbs" >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo   Auto-start configured! Dashboard will run on every boot.
) else (
    echo   Could not set auto-start. You can manually copy
    echo   saleshandy-silent.vbs to your Startup folder.
)

:: Start the server now (visible, so user can see it working)
echo.
echo   Starting dashboard now...
echo.
echo   ========================================================
echo     Dashboard is running!
echo   ========================================================
echo.
echo   Open in your browser:  http://localhost:8080
echo.
echo   Share this URL with your team (use your PC's IP):
echo.

:: Show local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        echo     http://%%b:8080
    )
)

echo.
echo   The server will auto-start when your PC boots.
echo   Keep this window open to see server logs.
echo.
echo   ========================================================
echo.

cd /d "%SCRIPT_DIR%"
node server.js
pause
