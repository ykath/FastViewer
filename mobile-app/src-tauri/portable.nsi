Unicode true
SilentInstall silent
RequestExecutionLevel user
SetCompress force
SetCompressor /SOLID lzma

!include "FileFunc.nsh"

!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef APP_FILE_VERSION
  !error "APP_FILE_VERSION is required"
!endif

Name "LightPage Portable"
OutFile "${__FILEDIR__}\..\release\windows\LightPage_${APP_VERSION}_windows-x64.exe"
Icon "${__FILEDIR__}\icons\icon.ico"

VIProductVersion "${APP_FILE_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "LightPage"
VIAddVersionKey /LANG=1033 "FileDescription" "LightPage Portable"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName" "FastViewer"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 FastViewer"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\LightPage"
  File "/oname=LightPage.exe" "${__FILEDIR__}\target\release\lightpage.exe"
  File "/oname=lightpage-url-importer.exe" "${__FILEDIR__}\target\release\lightpage-url-importer.exe"
  File "/oname=THIRD_PARTY_NOTICES.md" "${__FILEDIR__}\..\url-importer\THIRD_PARTY_NOTICES.md"
  File "/oname=LICENSE.baoyu-url-to-markdown" "${__FILEDIR__}\..\url-importer\LICENSE.baoyu-url-to-markdown"
  ${GetParameters} $R0
  ExecWait '"$PLUGINSDIR\LightPage\LightPage.exe" $R0' $0
  SetErrorLevel $0
SectionEnd
