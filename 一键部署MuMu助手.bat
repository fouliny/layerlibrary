@echo off
title MuMuHelper - One-Click Deploy

set "SRC=%~dp0"
set "DST=%APPDATA%\Adobe\CEP\extensions\com.pslib.layerlibrary"

echo ============================================================
echo   MuMuHelper One-Click Deploy
echo ============================================================
echo.
echo [1/2] Copying plugin files to CEP extensions folder...
if not exist "%DST%" mkdir "%DST%"
xcopy "%SRC%*" "%DST%" /E /Y /I >nul 2>&1
if errorlevel 1 (
    echo     FAILED! Check permissions, or close Photoshop first.
    echo     Tip: right-click this script, select "Run as administrator".
    pause
    exit /b 1
)
echo     Deployed to: %DST%
echo.
echo [2/2] Enabling unsigned extensions (Photoshop 2020 - 2026)...
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.9"  /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.13" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
echo     Registry updated (PlayerDebugMode=1)
echo.
echo ============================================================
echo   DONE!
echo   Restart Photoshop, then open MuMuHelper from
echo   Window - Extensions menu.
echo ============================================================
echo.
timeout /t 6 /nobreak >nul
