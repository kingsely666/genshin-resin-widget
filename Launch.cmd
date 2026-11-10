@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if exist "node_modules\electron\dist\electron.exe" goto LAUNCH

echo [setup] First run: installing dependencies, please wait...
where npm >nul 2>nul
if errorlevel 1 goto NO_NPM
call npm install
if exist "node_modules\electron\dist\electron.exe" goto LAUNCH
if exist "node_modules\electron\install.js" call node node_modules\electron\install.js
if exist "node_modules\electron\dist\electron.exe" goto LAUNCH
goto NO_ELECTRON

:NO_NPM
echo [ERROR] Node.js / npm was not found in PATH.
echo         Install Node.js 18 or newer from https://nodejs.org , then run this again.
pause
exit /b 1

:NO_ELECTRON
echo [ERROR] Electron binary is missing after npm install.
echo         Open a terminal in this folder and run: npm install
pause
exit /b 1

:LAUNCH
echo [ok] Starting Genshin Resin Widget. This window closes automatically.
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
