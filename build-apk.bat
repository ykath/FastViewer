@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo   FastViewer APK Build Script
echo ============================================
echo.

set "PROJECT_ROOT=%~dp0"
set "MOBILE_APP=%PROJECT_ROOT%mobile-app"
set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot"
set "ANDROID_HOME=E:\CodexProjects\ClassUseCount\tools\android-sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"

echo [1/4] Checking toolchain...
where java >nul 2>&1 || (echo ERROR: java not found, check JAVA_HOME & exit /b 1)
java -version 2>&1 | findstr /i "version" >nul || (echo ERROR: java version check failed & exit /b 1)
echo       JAVA_HOME = %JAVA_HOME%
echo       ANDROID_HOME = %ANDROID_HOME%
echo.

echo [2/4] Building web assets (vite build)...
cd /d "%MOBILE_APP%"
call npm run build
if %errorlevel% neq 0 (echo ERROR: vite build failed & exit /b 1)
echo       dist/ ready
echo.

echo [3/4] Syncing to Android (cap sync)...
call npx cap sync android
if %errorlevel% neq 0 (echo ERROR: cap sync failed & exit /b 1)
echo       Android project synced
echo.

echo [4/4] Building debug APK (gradle assembleDebug)...
cd /d "%MOBILE_APP%\android"
call gradlew.bat assembleDebug
if %errorlevel% neq 0 (echo ERROR: gradle build failed & exit /b 1)
echo.

set "APK_PATH=%MOBILE_APP%\android\app\build\outputs\apk\debug\app-debug.apk"
if exist "%APK_PATH%" (
    echo ============================================
    echo   BUILD SUCCESS
    echo   APK: %APK_PATH%
    echo ============================================
) else (
    echo ERROR: APK not found at expected path
    exit /b 1
)

endlocal
