; Tauri NSIS hooks for the `tedi` CLI shim + user-data safety net.
;
; On install:
;   * Snapshot the user's app-data dir (history, settings, sessions,
;     extensions, ...) to %TEMP% before the rest of the installer (or the
;     previous uninstaller, which auto-update invokes in passive mode) gets
;     a chance to touch it. PREINSTALL runs before any file deletion.
;   * Write `tedi.cmd` next to `TEDI.exe` so terminals can call `tedi .`
;     regardless of casing.
;   * Append the install dir to the user's PATH (HKCU\Environment) if not
;     already present, then broadcast WM_SETTINGCHANGE so freshly-spawned
;     shells pick it up without a logout.
;   * Restore the user-data snapshot when key files vanished during the
;     install. Belt-and-suspenders against Tauri NSIS template variants
;     that wipe app data on upgrade.
;
; On uninstall we delete the shim but deliberately leave the PATH entry
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
  ; --- install tedi-cli.exe (console-subsystem companion) -----------------
  ; TEDI.exe is `windows_subsystem = "windows"` so its stdin is detached
  ; from the parent terminal and the `tedi ext` ratatui TUI cannot read
  ; keystrokes. tedi-cli.exe is a console-subsystem twin built from
  ; src/bin/tedi-cli.rs. The release workflow builds it via an explicit
  ; `cargo build --release --bin tedi-cli` step (see
  ; .github/workflows/release.yml), so by the time NSIS runs the file is
  ; present at <src-tauri>/target/release/tedi-cli.exe. Path is relative
  ; to the generated installer.nsi at
  ; <src-tauri>/target/release/bundle/nsis/<lang>/, i.e. three dirs up
  ; gets us back to target/release.
  ;
  ; /nonfatal lets dev builds and `tauri dev` (which do not run this hook,
  ; but a future iteration of the bundler might) survive a missing file
  ; without aborting the whole install. Missing tedi-cli.exe only loses
  ; the TUI — plain CLI mode in TEDI.exe still works.
  SetOutPath "$INSTDIR"
  File /nonfatal "/oname=tedi-cli.exe" "..\..\..\tedi-cli.exe"

  ; --- write the shim ------------------------------------------------------
  ; Belt-and-suspenders for `--version` / `--help`: default Windows PATHEXT
  ; resolves `.EXE` before `.CMD`, so plain `tedi` lands on `tedi.exe`, not
  ; this shim. The EXE itself now calls AttachConsole(ATTACH_PARENT_PROCESS)
  ; and prints (see modules::cli::handle_version_help_and_exit). This .cmd
  ; still runs if the user explicitly invokes `tedi.cmd` or if some future
  ; PATHEXT override flips the priority. ${VERSION} is baked in from NSIS
  ; and refreshed every install/update so both paths stay in sync.
  FileOpen $0 "$INSTDIR\tedi.cmd" w
  ${If} $0 != ""
    FileWrite $0 "@echo off$\r$\n"
    FileWrite $0 "setlocal$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"--version$\" goto :tedi_version$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"-V$\" goto :tedi_version$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"--help$\" goto :tedi_help$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"-h$\" goto :tedi_help$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"--update$\" goto :tedi_passthrough$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"-u$\" goto :tedi_passthrough$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"ext$\" goto :tedi_passthrough$\r$\n"
    FileWrite $0 "if /i $\"%~1$\"==$\"--extension$\" goto :tedi_passthrough$\r$\n"
    FileWrite $0 "start $\"$\" $\"%~dp0TEDI.exe$\" %*$\r$\n"
    FileWrite $0 "exit /b 0$\r$\n"
    FileWrite $0 "$\r$\n"
    FileWrite $0 ":tedi_passthrough$\r$\n"
    FileWrite $0 "rem `start` detaches the child from this console so the GUI launch above$\r$\n"
    FileWrite $0 "rem doesn't pin the shell. The CLI subcommands are the opposite: they run$\r$\n"
    FileWrite $0 "rem to completion, draw a ratatui TUI on the user's terminal, and exit.$\r$\n"
    FileWrite $0 "rem TEDI.exe is GUI subsystem (windows_subsystem = $\"windows$\") so it has$\r$\n"
    FileWrite $0 "rem no console attached for stdin — the TUI cannot read keystrokes from it.$\r$\n"
    FileWrite $0 "rem tedi-cli.exe is the console-subsystem companion that inherits the$\r$\n"
    FileWrite $0 "rem caller's stdin/stdout cleanly. Invoked synchronously here.$\r$\n"
    FileWrite $0 "if exist $\"%~dp0tedi-cli.exe$\" ($\r$\n"
    FileWrite $0 "    $\"%~dp0tedi-cli.exe$\" %*$\r$\n"
    FileWrite $0 ") else ($\r$\n"
    FileWrite $0 "    $\"%~dp0TEDI.exe$\" %*$\r$\n"
    FileWrite $0 ")$\r$\n"
    FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
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
    FileWrite $0 "echo     tedi ext ^<SUBCOMMAND^> [ARGS]    (manage extensions, headless)$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo If TEDI is already running, the request is forwarded to that window$\r$\n"
    FileWrite $0 "echo (a second window is not opened).$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo FLAGS:$\r$\n"
    FileWrite $0 "echo     -h, --help           Print this help and exit$\r$\n"
    FileWrite $0 "echo     -v, -V, --version    Print version and exit$\r$\n"
    FileWrite $0 "echo     -u, --update         Check for updates and install in place (headless)$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo ARGS:$\r$\n"
    FileWrite $0 "echo     PATH             Folder to open, or file to edit. Use . for the$\r$\n"
    FileWrite $0 "echo                      current directory. Relative paths resolve against$\r$\n"
    FileWrite $0 "echo                      the shell's cwd.$\r$\n"
    FileWrite $0 "echo.$\r$\n"
    FileWrite $0 "echo EXTENSION SUBCOMMANDS (run `tedi ext help` for full reference):$\r$\n"
    FileWrite $0 "echo     tedi ext install ^<path^|owner/repo^|registry-id^>$\r$\n"
    FileWrite $0 "echo     tedi ext list                  Browse registry (interactive picker)$\r$\n"
    FileWrite $0 "echo     tedi ext list --installed      Locally installed (alias: tedi ext installed)$\r$\n"
    FileWrite $0 "echo     tedi ext update [^<ID^>]         Check upstream for updates$\r$\n"
    FileWrite $0 "echo     tedi ext uninstall ^<ID^>$\r$\n"
    FileWrite $0 "echo     tedi ext enable ^<ID^>$\r$\n"
    FileWrite $0 "echo     tedi ext disable ^<ID^>$\r$\n"
    FileWrite $0 "exit /b 0$\r$\n"
    FileClose $0
  ${EndIf}

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
  Delete "$INSTDIR\tedi.cmd"
  Delete "$INSTDIR\tedi-cli.exe"
!macroend
