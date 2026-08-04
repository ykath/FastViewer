@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo   LightPage Windows x64 Build Script
echo ============================================
echo.

set "PROJECT_ROOT=%~dp0"
set "MOBILE_APP=%PROJECT_ROOT%mobile-app"
set "OUTPUT_DIR=%MOBILE_APP%\release\windows"
set "CARGO_HTTP_MULTIPLEXING=false"

echo [1/5] Checking toolchain...
where node >nul 2>&1 || (echo ERROR: node not found & exit /b 1)
where npm >nul 2>&1 || (echo ERROR: npm not found & exit /b 1)
where bun >nul 2>&1 || (echo ERROR: bun not found; install Bun to compile the URL importer & exit /b 1)
where rustc >nul 2>&1 || (echo ERROR: rustc not found & exit /b 1)
where cargo >nul 2>&1 || (echo ERROR: cargo not found & exit /b 1)
rustup target list --installed | findstr /c:"x86_64-pc-windows-msvc" >nul || (
  echo ERROR: Rust target x86_64-pc-windows-msvc is not installed
  exit /b 1
)
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo ERROR: Visual Studio Installer vswhere.exe was not found
  exit /b 1
)
for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_PATH=%%I"
if not defined VS_PATH (
  echo ERROR: Microsoft Visual C++ x64 build tools are not installed
  exit /b 1
)
echo       Node, npm, Bun, Rust and Windows x64 target are ready.
echo       MSVC = %VS_PATH%
echo.

echo [2/5] Installing locked dependencies...
cd /d "%MOBILE_APP%"
call npm ci
if %errorlevel% neq 0 (echo ERROR: npm ci failed & exit /b 1)
for /f "usebackq tokens=*" %%I in (`node -p "require('./package.json').version"`) do set "APP_VERSION=%%I"
if not defined APP_VERSION (echo ERROR: package version could not be read & exit /b 1)
echo.

echo [3/5] Running frontend and Rust tests...
call npm run desktop:test
if %errorlevel% neq 0 (echo ERROR: desktop tests failed & exit /b 1)
echo.

echo [4/5] Building Windows executable and NSIS installer...
call npm run desktop:build
if %errorlevel% neq 0 (echo ERROR: Tauri build failed & exit /b 1)
echo.

echo [5/5] Collecting build artifacts...
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
if not exist "%MOBILE_APP%\src-tauri\target\release\lightpage.exe" (echo ERROR: LightPage.exe was not found & exit /b 1)
if not exist "%MOBILE_APP%\src-tauri\target\release\lightpage-url-importer.exe" (echo ERROR: URL importer sidecar was not found & exit /b 1)
set "MAKENSIS=%LOCALAPPDATA%\tauri\NSIS\makensis.exe"
if not exist "%MAKENSIS%" set "MAKENSIS=%LOCALAPPDATA%\tauri\NSIS\Bin\makensis.exe"
if not exist "%MAKENSIS%" (echo ERROR: Tauri NSIS compiler was not found & exit /b 1)
"%MAKENSIS%" /DAPP_VERSION=%APP_VERSION% /DAPP_FILE_VERSION=%APP_VERSION%.0 "%MOBILE_APP%\src-tauri\portable.nsi"
if %errorlevel% neq 0 (echo ERROR: portable self-extracting build failed & exit /b 1)
copy /Y "%OUTPUT_DIR%\LightPage_%APP_VERSION%_windows-x64.exe" "%OUTPUT_DIR%\LightPage.exe" >nul
if %errorlevel% neq 0 (echo ERROR: portable LightPage.exe could not be created & exit /b 1)

if not exist "%MOBILE_APP%\src-tauri\target\release\bundle\nsis\*setup.exe" (
  echo ERROR: NSIS installer was not found
  exit /b 1
)
if exist "%OUTPUT_DIR%\LightPage_%APP_VERSION%_windows-x64-setup.exe" del /Q "%OUTPUT_DIR%\LightPage_%APP_VERSION%_windows-x64-setup.exe"
for %%F in ("%MOBILE_APP%\src-tauri\target\release\bundle\nsis\*setup.exe") do (
  copy /Y "%%~fF" "%OUTPUT_DIR%\LightPage_%APP_VERSION%_windows-x64-setup.exe" >nul
)
if not exist "%OUTPUT_DIR%\LightPage_%APP_VERSION%_windows-x64-setup.exe" (
  echo ERROR: NSIS installer was not found
  exit /b 1
)

echo ============================================
echo   BUILD SUCCESS - UNSIGNED WINDOWS BUILD
echo   EXE:   %OUTPUT_DIR%\LightPage_%APP_VERSION%_windows-x64.exe
echo   SETUP: %OUTPUT_DIR%\LightPage_%APP_VERSION%_windows-x64-setup.exe
echo ============================================
echo NOTE: Unsigned builds may trigger Windows SmartScreen.

endlocal
