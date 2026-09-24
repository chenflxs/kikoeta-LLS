@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed or is not in PATH.
    exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
    echo Node.js 22 or newer is required.
    exit /b 1
)

echo Starting Kikoeta-LLS. Press Ctrl+C to stop it.
echo Admin UI: http://localhost:2376/admin
echo Kikoeta remote library URL: http://localhost:2377
echo First login: admin / kikoeta-lrc. You must set a new password.
node src\server.js
exit /b %errorlevel%
