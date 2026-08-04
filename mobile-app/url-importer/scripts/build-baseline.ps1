$ErrorActionPreference = 'Stop'

$bunVersion = '1.3.0'
$archiveName = 'bun-windows-x64-baseline.zip'
$expectedSha256 = '27b686dd83121b9331dfe340abe0f940740d1c5f713aeff9be8dbdcf98c157f8'
$importerRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $importerRoot ".cache\bun-v$bunVersion-windows-x64-baseline"
$archivePath = Join-Path $cacheRoot $archiveName
$runtimeDirectory = Join-Path $cacheRoot 'bun-windows-x64-baseline'
$bunExecutable = Join-Path $runtimeDirectory 'bun.exe'

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

if (-not (Test-Path -LiteralPath $bunExecutable)) {
    $temporaryArchive = "$archivePath.download"
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://github.com/oven-sh/bun/releases/download/bun-v$bunVersion/$archiveName" `
        -OutFile $temporaryArchive

    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryArchive).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        [System.IO.File]::Delete($temporaryArchive)
        throw "Bun baseline checksum mismatch: expected $expectedSha256, got $actualSha256"
    }

    Move-Item -LiteralPath $temporaryArchive -Destination $archivePath -Force
    if (Test-Path -LiteralPath $runtimeDirectory) {
        [System.IO.Directory]::Delete($runtimeDirectory, $true)
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $cacheRoot -Force
}

if (-not (Test-Path -LiteralPath $bunExecutable)) {
    throw 'Failed to prepare Bun Windows x64 baseline runtime'
}

& $bunExecutable run (Join-Path $PSScriptRoot 'build.ts')
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
