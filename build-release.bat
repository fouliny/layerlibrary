@echo off
title MuMuHelper - Build Release Package
cd /d "%~dp0"

echo ============================================================
echo   MuMuHelper - Build Release Package
echo ============================================================
echo.

if not exist releases mkdir releases

REM ---- Read script version from hostscript.jsx ----
for /f %%v in ('powershell -NoProfile -Command "(Select-String -Path 'JSX\hostscript.jsx' -Pattern 'PSL_SCRIPT_VERSION\s*=\s*(\d+)' | Select-Object -First 1).Matches[0].Groups[1].Value"') do set VER=%%v
if "%VER%"=="" set VER=0
echo Version detected: %VER%
echo.

REM ---- Zip the plugin (all runtime files + deploy bat, exclude this script) ----
powershell -NoProfile -Command "Compress-Archive -Path 'CSXS','JSX','images','index.html','main.js','styles.css','README.md',(Get-ChildItem -File *.bat | Where-Object { $_.Name -notlike 'build-release*' }) -DestinationPath ('releases\MuMuHelper-v' + $env:VER + '.zip') -Force"
if errorlevel 1 (
    echo     FAILED to build package!
    pause
    exit /b 1
)

echo ============================================================
echo   DONE! Package: releases\MuMuHelper-v%VER%.zip
echo ============================================================
echo.
timeout /t 6 /nobreak >nul
