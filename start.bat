@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed or is not in PATH.
    exit /b 1
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>24||major===24&&minor>=15?0:1)"
if errorlevel 1 (
    echo Node.js 24.15 or newer is required.
    exit /b 1
)

if not exist "node_modules\yauzl\package.json" goto install_dependencies
if not exist "node_modules\iconv-lite\package.json" goto install_dependencies
goto dependencies_ready

:install_dependencies
where npm >nul 2>&1
if errorlevel 1 (
    echo npm is required to install ZIP import dependencies.
    exit /b 1
)
echo Installing Kikoeta-LLS dependencies...
set "npm_config_cache=%~dp0.npm-cache"
call npm ci --omit=dev --no-audit --no-fund
if errorlevel 1 exit /b %errorlevel%

:dependencies_ready
echo Starting Kikoeta-LLS. Press Ctrl+C to stop it.
echo Admin UI: http://localhost:2376/admin
echo Kikoeta remote library URL: http://localhost:2377
echo First login: admin / kikoeta-lrc. You must set a new password.
node src\server.js
exit /b %errorlevel%
