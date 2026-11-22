@echo off
setlocal
title Claude Agent Runner
pushd "%~dp0"

if not exist "%~dp0src\server.js" goto notextracted
if not exist "%~dp0scripts\start.ps1" goto notextracted

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
set "code=%errorlevel%"
popd
exit /b %code%

:notextracted
echo.
echo   The app files were not found next to start.bat.
echo.
echo   If you opened the ZIP file directly: close this window, right-click the
echo   ZIP file, choose "Extract All...", then open the extracted folder and
echo   double-click start.bat there.
echo.
pause
popd
exit /b 1
