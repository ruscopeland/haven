; Haven Desktop NSIS Installer
; Produces haven-setup.exe — a polished single-file installer for Windows.
;
; Prerequisites:
;   - NSIS 3.x (makensis) on PATH
;   - haven-desktop.exe built and placed in bin/
;   - WebView2 Evergreen Bootstrapper in bin/MicrosoftEdgeWebview2Setup.exe (optional)

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT_NAME "Haven"
!define PRODUCT_PUBLISHER "Haven"
!define PRODUCT_VERSION "${HAVEN_VERSION}"
!define PRODUCT_EXE "haven-desktop.exe"

Name "${PRODUCT_NAME}"
OutFile "..\bin\haven-setup.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
RequestExecutionLevel admin

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"

  ; Main executable
  File "..\bin\${PRODUCT_EXE}"

  ; WebView2 bootstrapper (optional — Windows 10+ ships with WebView2)
  IfFileExists "..\bin\MicrosoftEdgeWebview2Setup.exe" 0 +3
    File "..\bin\MicrosoftEdgeWebview2Setup.exe"
    ExecWait '"$INSTDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'

  ; Start Menu shortcut
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Haven.lnk" "$INSTDIR\${PRODUCT_EXE}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  ; Desktop shortcut
  CreateShortCut "$DESKTOP\Haven.lnk" "$INSTDIR\${PRODUCT_EXE}"

  ; Uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Registry for Add/Remove Programs
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${PRODUCT_EXE}"
  Delete "$INSTDIR\MicrosoftEdgeWebview2Setup.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Haven.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  Delete "$DESKTOP\Haven.lnk"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
SectionEnd
