; Tauri NSIS hooks for the `tedi` CLI launcher + user-data safety net.
;
; Binary layout in $INSTDIR after install:
;   TEDIApp.exe   GUI subsystem — the actual app. Named so PATHEXT does NOT
;                 resolve `tedi` to it; the user-facing entry point is the
;                 console stub below.
;   tedi.exe      console subsystem — built from src/bin/tedi-cli.rs. This is
;                 what PowerShell / cmd invoke when the user types `tedi`.
;                 Dispatches `--help` / `--version` inline, runs `--update`
;                 and `ext` synchronously with inherited stdio, detaches
;                 GUI launches. Fixes the long-standing PowerShell-doesn't-
;                 wait-for-GUI ordering bug where `tedi --help` printed
;                 below the next prompt and left the cursor garbled.
;
; On install:
;   * Snapshot the user's app-data dir (history, settings, sessions,
;     extensions, ...) to %TEMP% before the rest of the installer (or the
;     previous uninstaller, which auto-update invokes in passive mode) gets
;     a chance to touch it. PREINSTALL runs before any file deletion.
;   * Drop `tedi.exe` (console stub) next to `TEDIApp.exe` via NSIS File
;     directive. Path is relative to the generated installer.nsi at
;     `<src-tauri>/target/release/bundle/nsis/<lang>/`.
;   * Sweep any legacy `tedi.cmd` shim from older installs (<=0.2.19); the
;     console stub replaces it entirely.
;   * Append the install dir to the user's PATH (HKCU\Environment) if not
;     already present, then broadcast WM_SETTINGCHANGE so freshly-spawned
;     shells pick it up without a logout.
;   * Restore the user-data snapshot when key files vanished during the
;     install. Belt-and-suspenders against Tauri NSIS template variants
;     that wipe app data on upgrade.
;
; On uninstall we delete both binaries-as-data we wrote (`tedi.exe`,
; `tedi.cmd` for legacy installs) but deliberately leave the PATH entry
; alone. Stripping it cleanly from a `;`-delimited string in NSIS needs a
; full string-replace helper and is easy to get wrong - a stale entry to a
; non-existent dir is harmless (Windows skips it during PATH lookup), while
; a buggy uninstaller can corrupt the user's PATH.

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"
; ${StrStr} needs an explicit declaration before first use - this line is
; the declaration, not a call. Used in NSIS_HOOK_POSTINSTALL to test whether
; $INSTDIR is already on the user's PATH so reinstalls don't pile up dupes.
${StrStr}

!define TEDI_PATH_REG_ROOT HKCU
!define TEDI_PATH_REG_KEY  "Environment"

; App-data dir must match `identifier` in tauri.conf.json. Tauri 2's
; `app_data_dir` resolves to `%APPDATA%\<identifier>\` on Windows. The
; backup lives in %TEMP% so it disappears on reboot even if a restore is
; somehow skipped — never accumulates stale snapshots.
!define TEDI_DATA_DIR    "$APPDATA\id.ilhamrisky.tedi"
!define TEDI_DATA_BACKUP "$TEMP\tedi-userdata-backup"

!macro NSIS_HOOK_PREINSTALL
  ; --- snapshot user data --------------------------------------------------
  ; Only snapshot when there's something to save; a fresh install has no
  ; data dir and we don't want to seed an empty backup that the post-hook
  ; would then "restore" over a clean install.
  IfFileExists "${TEDI_DATA_DIR}\*.*" 0 tedi_preinstall_no_backup
    ; Wipe any previous backup so a re-run starts clean.
    RMDir /r "${TEDI_DATA_BACKUP}"
    ; xcopy ships with Windows; /E recursive, /I treat target as dir,
    ; /Y silent overwrite, /H copy hidden + system, /K preserve attrs,
    ; /Q quiet. nul redirection suppresses console output during /PASSIVE.
    nsExec::ExecToLog 'cmd /c xcopy "${TEDI_DATA_DIR}" "${TEDI_DATA_BACKUP}" /E /I /Y /H /K /Q >nul 2>&1'
  tedi_preinstall_no_backup:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; --- install tedi.exe (console-subsystem launcher) -----------------------
  ; TEDIApp.exe is `windows_subsystem = "windows"`; PowerShell does not
  ; synchronously wait for GUI-subsystem children, so `tedi --help` output
  ; lands after the next prompt and the cursor ends up mid-line. tedi.exe
  ; is a console-subsystem twin from src/bin/tedi-cli.rs that PowerShell
  ; waits for properly. PATHEXT then resolves the user's `tedi` to this
  ; binary instead of the GUI (the GUI is renamed TEDIApp.exe specifically
  ; to keep it off PATHEXT's `tedi.exe` lookup).
  ;
  ; The release workflow builds the stub via an explicit
  ; `cargo build --release --bin tedi` step (see
  ; .github/workflows/release.yml), so by the time NSIS runs the file is at
  ; <src-tauri>/target/release/tedi.exe. Path is relative to the generated
  ; installer.nsi at <src-tauri>/target/release/bundle/nsis/<lang>/, i.e.
  ; three dirs up gets us back to target/release.
  ;
  ; /nonfatal lets future bundler variants survive a missing file without
  ; aborting the whole install; missing tedi.exe leaves the user with only
  ; the GUI binary which they'd invoke via the Start Menu shortcut.
  SetOutPath "$INSTDIR"
  File /nonfatal "/oname=tedi.exe" "..\..\..\tedi.exe"

  ; --- remove any legacy tedi.cmd shim ------------------------------------
  ; v0.2.0 .. v0.2.19 wrote a `tedi.cmd` here that handled --help / --version
  ; natively and delegated other subcommands to TEDI.exe. The new tedi.exe
  ; supersedes it — leave nothing on disk that could confuse PATHEXT (cmd
  ; runs AFTER exe so it would be a no-op, but keep things tidy).
  Delete "$INSTDIR\tedi.cmd"

  ; --- ensure install dir is on user PATH ---------------------------------
  ReadRegStr $1 ${TEDI_PATH_REG_ROOT} "${TEDI_PATH_REG_KEY}" "Path"
  ${If} $1 == ""
    WriteRegExpandStr ${TEDI_PATH_REG_ROOT} "${TEDI_PATH_REG_KEY}" "Path" "$INSTDIR"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${Else}
    ; Substring check against `;PATH;` sentinels so a partial-match dir
    ; doesn't false-positive. ${StrStr} returns the haystack-tail starting
    ; at the needle (empty when missing).
    StrCpy $2 ";$1;"
    StrCpy $3 ";$INSTDIR;"
    ${StrStr} $4 $2 $3
    ${If} $4 == ""
      ; Re-write as REG_EXPAND_SZ so existing `%VAR%` references in the
      ; user's PATH keep expanding.
      WriteRegExpandStr ${TEDI_PATH_REG_ROOT} "${TEDI_PATH_REG_KEY}" "Path" "$1;$INSTDIR"
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}

  ; --- restore user data ---------------------------------------------------
  ; If PREINSTALL took a snapshot, copy it back. Two key files (settings +
  ; sessions) gate the restore — if either is missing post-install we
  ; assume the install flow wiped the dir and replay the snapshot. /Y
  ; forces overwrite so the pre-install state always wins; the new TEDI
  ; hasn't started yet, so nothing in the data dir is worth keeping. On a
  ; clean install the backup never existed and this is a no-op.
  IfFileExists "${TEDI_DATA_BACKUP}\*.*" 0 tedi_postinstall_no_restore
    StrCpy $5 "0"
    IfFileExists "${TEDI_DATA_DIR}\tedi-settings.json" +2 0
      StrCpy $5 "1"
    IfFileExists "${TEDI_DATA_DIR}\tedi-sessions.json" +2 0
      StrCpy $5 "1"
    ${If} $5 == "1"
      CreateDirectory "${TEDI_DATA_DIR}"
      nsExec::ExecToLog 'cmd /c xcopy "${TEDI_DATA_BACKUP}" "${TEDI_DATA_DIR}" /E /I /Y /H /K /Q >nul 2>&1'
    ${EndIf}
    RMDir /r "${TEDI_DATA_BACKUP}"
  tedi_postinstall_no_restore:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\tedi.exe"
  ; Legacy shim from <=0.2.19 installs. Delete is a no-op when absent so
  ; this is safe on fresh-install-then-uninstall flows.
  Delete "$INSTDIR\tedi.cmd"
!macroend
