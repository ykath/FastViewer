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
if not defined GRADLE_LOCAL_ZIP set "GRADLE_LOCAL_ZIP=C:\Users\iamya\Downloads\Compressed\gradle-8.14.3-all.zip"
if defined GRADLE_USER_HOME (
    set "LIGHTPAGE_GRADLE_HOME=%GRADLE_USER_HOME%"
) else (
    set "LIGHTPAGE_GRADLE_HOME=%USERPROFILE%\.gradle"
)

echo [1/5] Checking toolchain...
where java >nul 2>&1 || (echo ERROR: java not found, check JAVA_HOME & exit /b 1)
java -version 2>&1 | findstr /i "version" >nul || (echo ERROR: java version check failed & exit /b 1)
echo       JAVA_HOME = %JAVA_HOME%
echo       ANDROID_HOME = %ANDROID_HOME%
echo.

echo [2/5] Building web assets (vite build)...
cd /d "%MOBILE_APP%"
call npm run build
if %errorlevel% neq 0 (echo ERROR: vite build failed & exit /b 1)
echo       dist/ ready
echo.

echo [3/5] Syncing to Android (cap sync)...
call npx cap sync android
if %errorlevel% neq 0 (echo ERROR: cap sync failed & exit /b 1)
echo       Android project synced
echo.

echo [4/5] Preparing local Gradle distribution cache...
set "LIGHTPAGE_WRAPPER_PROPERTIES=%MOBILE_APP%\android\gradle\wrapper\gradle-wrapper.properties"
set "LIGHTPAGE_GRADLE_LOCAL_ZIP=%GRADLE_LOCAL_ZIP%"
if exist "%GRADLE_LOCAL_ZIP%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference = 'Stop';" ^
      "$properties = $env:LIGHTPAGE_WRAPPER_PROPERTIES;" ^
      "$localZip = $env:LIGHTPAGE_GRADLE_LOCAL_ZIP;" ^
      "$gradleHome = $env:LIGHTPAGE_GRADLE_HOME;" ^
      "$line = Get-Content -LiteralPath $properties | Where-Object { $_ -match '^distributionUrl=' } | Select-Object -First 1;" ^
      "if (-not $line) { throw 'distributionUrl not found in gradle-wrapper.properties' };" ^
      "$url = ($line -split '=', 2)[1] -replace '\\:', ':';" ^
      "$archiveName = [IO.Path]::GetFileName($url);" ^
      "if ([IO.Path]::GetFileName($localZip) -ne $archiveName) { Write-Host ('      Local ZIP version does not match ' + $archiveName + '; Gradle will download it.'); exit 0 };" ^
      "$md5 = [Security.Cryptography.MD5]::Create();" ^
      "try { $hash = $md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($url)) } finally { $md5.Dispose() };" ^
      "[Array]::Reverse($hash);" ^
      "$positiveHash = New-Object byte[] ($hash.Length + 1);" ^
      "[Array]::Copy($hash, $positiveHash, $hash.Length);" ^
      "$number = [Numerics.BigInteger]::new($positiveHash);" ^
      "$alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'; $base36 = '';" ^
      "do { $remainder = [int]($number %% 36); $base36 = [string]$alphabet[$remainder] + $base36; $number = [Numerics.BigInteger]::Divide($number, 36) } while ($number -gt 0);" ^
      "$distributionName = $archiveName.Substring(0, $archiveName.Length - 4);" ^
      "$cacheDir = Join-Path $gradleHome ('wrapper\dists\' + $distributionName + '\' + $base36);" ^
      "$cachedZip = Join-Path $cacheDir $archiveName;" ^
      "$okMarker = $cachedZip + '.ok';" ^
      "if (Test-Path -LiteralPath $okMarker) { Write-Host ('      Gradle cache already ready: ' + $cacheDir); exit 0 };" ^
      "New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null;" ^
      "$temporaryZip = $cachedZip + '.local-copy';" ^
      "Copy-Item -LiteralPath $localZip -Destination $temporaryZip -Force;" ^
      "Move-Item -LiteralPath $temporaryZip -Destination $cachedZip -Force;" ^
      "Remove-Item -LiteralPath ($cachedZip + '.part') -Force -ErrorAction SilentlyContinue;" ^
      "Write-Host ('      Local Gradle ZIP cached: ' + $cachedZip)"
    if errorlevel 1 (
        echo WARNING: failed to seed local Gradle cache; Gradle will try the configured download URL.
    )
) else (
    echo       Local Gradle ZIP not found: %GRADLE_LOCAL_ZIP%
    echo       Gradle will use the configured download URL.
)
echo.

echo [5/5] Building debug APK (gradle assembleDebug)...
cd /d "%MOBILE_APP%\android"
call gradlew.bat assembleDebug
if %errorlevel% neq 0 (echo ERROR: gradle build failed & exit /b 1)
echo.

set "APK_PATH=%MOBILE_APP%\android\app\build\outputs\apk\debug\app-debug.apk"
set "LIGHTPAGE_APK=%MOBILE_APP%\android\app\build\outputs\apk\debug\LightPage.apk"
if exist "%APK_PATH%" (
    copy /Y "%APK_PATH%" "%LIGHTPAGE_APK%" >nul
    if %errorlevel% neq 0 (echo ERROR: failed to create LightPage.apk & exit /b 1)
    echo ============================================
    echo   BUILD SUCCESS
    echo   APK: %LIGHTPAGE_APK%
    echo   Original: %APK_PATH%
    echo ============================================
) else (
    echo ERROR: APK not found at expected path
    exit /b 1
)

endlocal
