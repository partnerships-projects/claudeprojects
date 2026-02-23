@echo off
title SalesHandy — Uncontacted Prospects Dashboard
color 0B
echo.
echo   ========================================================
echo     SalesHandy — Uncontacted Prospects Dashboard
echo   ========================================================
echo.
echo   Starting server... (keep this window open!)
echo.
powershell -ExecutionPolicy Bypass -NoExit -File "%~dp0start-dashboard.ps1"
pause
