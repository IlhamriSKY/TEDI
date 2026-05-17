; Tauri NSIS hooks for the `tedi` CLI shim.
;
; On install:
;   * Write `tedi.cmd` next to `TEDI.exe` so terminals can call `tedi .`
;     regardless of casing.
;   * Append the install dir to the user's PATH (HKCU\Environment) if not
;     already present, then broadcast WM_SETTINGCHANGE so freshly-spawned
;     shells pick it up without a logout.
;
; On uninstall we delete the shim but deliberately leave the PATH entry
; alone. Stripping it cleanly from a `;`-delimited string in NSIS needs a
; full string-replace helper and is easy to get wrong — a stale entry to a
; non-existent dir is harmless (Windows skips it during PATH lookup), while
; a buggy uninstaller can corrupt the user's PATH.

!include "LogicLib.nsh"
!include "WinMessages.nsh"

!define TEDI_PATH_REG_ROOT HKCU
!define TEDI_PATH_REG_KEY  "Environment"

!macro NSIS_HOOK_POSTINSTALL
  ; --- write the shim ------------------------------------------------------
  ; `--version` / `--help` are handled inside the .cmd itself because the GUI
  ; binary has `windows_subsystem = "windows"` (stdout detached). The version
  ; string is baked in from the NSIS ${VERSION} define and refreshed on every
  ; install/update, so the .cmd always matches the installed app.
  FileOpen $0 "$INSTDIR\tedi.cmd" w
  ${If} $0 != ""
    FileWrite $0 "@echo off$\r$\n"
    FileWrite $0 "setlocal$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"--version$\" goto :tedi_version$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"-V$\" goto :tedi_version$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"--help$\" goto :tedi_help$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"-h$\" goto :tedi_help$\r$\n"
    FileWrite $0 "start $\"$\" $\"%~dp0TEDI.exe$\" %*$\r$\n"
    FileWrite $0 "exit /b 0$\r$\n"
    FileWrite $0 "$\r$\n"
    FileWrite $0 ":tedi_version$\r$\n"
    FileWrite $0 "echo TEDI ${VERSION}$\r$\n"
    FileWrite $0 "exit /b 0$\r$\n"
    FileWrite $0 "$\r$\n"
    FileWrite $0 ":tedi_help$\r$\n"
    FileWrite $0 "echo TEDI ${VERSION} - Terminal Environment ^& Development Infrastructure$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo USAGE:$\r$\n"
    FileWrite $0 "echo     tedi [PATH]$\r$\n"
    FileWrite $0 "echo     tedi [FLAG]$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo If TEDI is already running, the request is forwarded to that window$\r$\n"
    FileWrite $0 "echo (a second window is not opened).$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo FLAGS:$\r$\n"
    FileWrite $0 "echo     -h, --help       Print this help and exit$\r$\n"
    FileWrite $0 "echo     -V, --version    Print version and exit$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo ARGS:$\r$\n"
    FileWrite $0 "echo     PATH             Folder to open, or file to edit. Use . for the$\r$\n"
    FileWrite $0 "echo                      current directory. Relative paths resolve against$\r$\n"
    FileWrite $0 "echo                      the shell's cwd.$\r$\n"
    FileWrite $0 "exit /b 0$\r$\n"
    FileClose $0
  ${EndIf}

  ; --- ensure install dir is on user PATH ---------------------------------
  ReadRegStr $1 ${TEDI_PATH_REG_ROOT} "${TEDI_PATH_REG_KEY}" "Path"
  ${If} $1 == ""
    WriteRegExpandStr ${TEDI_PATH_REG_ROOT} "${TEDI_PATH_REG_KEY}" "Path" "$INSTDIR"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${Else}
    ; Case-insensitive substring check against `;PATH;` sentinels so a
    ; partial-match dir doesn't false-positive.
    StrCpy $2 ";$1;"
    StrCpy $3 ";$INSTDIR;"
    nsis_tauri_utils::FindInString $2 $3
    Pop $4
    ${If} $4 == "-1"
      ; Re-write as REG_EXPAND_SZ so existing `%VAR%` references in the
      ; user's PATH keep expanding.
      WriteRegExpandStr ${TEDI_PATH_REG_ROOT} "${TEDI_PATH_REG_KEY}" "Path" "$1;$INSTDIR"
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\tedi.cmd"
!macroend
