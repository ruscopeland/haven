Unicode True
RequestExecutionLevel user
Name "Haven Engine"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Haven\Engine"
ShowInstDetails show
ShowUninstDetails show
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Function .onInit
  ClearErrors
  SearchPath $0 "node.exe"
  IfErrors 0 node_found
  MessageBox MB_OK|MB_ICONEXCLAMATION "Haven Engine needs Node.js 22. Install Node.js 22 before launching Haven Engine from the Start Menu."
node_found:
FunctionEnd

Section "Haven Engine" SecMain
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\marker-engine"
  File /r "${STAGE}\strategy-sdk"
  CreateDirectory "$SMPROGRAMS\Haven Engine"
  CreateShortCut "$SMPROGRAMS\Haven Engine\Haven Engine.lnk" "$INSTDIR\marker-engine\run.bat"
  CreateShortCut "$DESKTOP\Haven Engine.lnk" "$INSTDIR\marker-engine\run.bat"
  WriteUninstaller "$INSTDIR\Uninstall Haven Engine.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Haven Engine.lnk"
  Delete "$SMPROGRAMS\Haven Engine\Haven Engine.lnk"
  RMDir "$SMPROGRAMS\Haven Engine"
  RMDir /r "$INSTDIR"
SectionEnd
