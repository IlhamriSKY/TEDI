; Tauri NSIS hooks for the `tedi` CLI launcher + user-data safety net.
;
; Binary layout in $INSTDIR after install:
;   TEDIApp.exe   GUI subsystem — the actual app. Named so PATHEXT does NOT
;                 resolve `tedi` to it; the user-facing entry point is the
;                 console stub below.
;   tedi.exe      console subsystem — built from tedi-cli/src/main.rs. This is
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
;     shells pick it up without a logout. Through PowerShell, not NSIS
;     registry instructions - NSIS cannot hold a PATH longer than 1024
;     characters and mangles it on the way through.
;   * Restore the user-data snapshot when key files vanished during the
;     install. Belt-and-suspenders against Tauri NSIS template variants
;     that wipe app data on upgrade.
;
; On uninstall we delete both binaries-as-data we wrote (`tedi.exe`,
; `tedi.cmd` for legacy installs) but deliberately leave the PATH entry
; alone: a stale entry to a non-existent dir is harmless (Windows skips it
; during PATH lookup), while every write to that value is a chance to corrupt
; the user's PATH, and auto-update runs the old uninstaller mid-flight.

!include "LogicLib.nsh"
!include "WinMessages.nsh"

; PowerShell-provider form of the user environment key. The PATH append runs
; through PowerShell rather than NSIS registry instructions - see the block in
; NSIS_HOOK_POSTINSTALL for why.
!define TEDI_ENV_REG_PS "HKCU:\Environment"

; --- "Open with TEDI" shell verbs -----------------------------------------
; Explorer builds a context menu from static verbs under
; <root>\shell\<verb>, so registering under HKCU\Software\Classes gives the
; whole thing without an elevated installer (installMode is currentUser).
; Four roots, because Explorer treats them as unrelated:
;   Directory             right-click ON a folder
;   Directory\Background  right-click on empty space INSIDE a folder
;   Drive                 right-click on a drive root (C:\, D:\, ...)
;   *                     right-click on any file
;
; `%V` is the folder the menu was raised on and is the only field code the
; Background root understands; `*` has no `%V`, so files use `%1`.
;
; The command points at TEDIApp.exe, NOT the tedi.exe console stub: the stub
; is console-subsystem and would flash a console window on every click.
; TEDIApp.exe already resolves a positional path via `cli::capture_startup`
; and forwards it to a running instance through single-instance, so one click
; either boots TEDI at that path or opens a tab in the window already up.
;
; Windows 11 note: these are classic verbs, so they appear under
; "Show more options" (Shift+F10) rather than the trimmed default menu.
; Top-level placement needs an IExplorerCommand COM handler shipped from a
; packaged (MSIX/sparse) app - the same limitation VS Code's "Open with Code"
; lives with.
!define TEDI_VERB "TEDI"
!define TEDI_VERB_LABEL "Open with TEDI"

; Write one shell verb. `_root` is the class root, `_arg` the field code.
!macro TediWriteVerb _root _arg
  WriteRegStr HKCU "Software\Classes\${_root}\shell\${TEDI_VERB}" "" "${TEDI_VERB_LABEL}"
  WriteRegStr HKCU "Software\Classes\${_root}\shell\${TEDI_VERB}" "Icon" '"$INSTDIR\TEDIApp.exe",0'
  WriteRegStr HKCU "Software\Classes\${_root}\shell\${TEDI_VERB}\command" "" '"$INSTDIR\TEDIApp.exe" "${_arg}"'
!macroend

!macro TediDeleteVerb _root
  DeleteRegKey HKCU "Software\Classes\${_root}\shell\${TEDI_VERB}"
!macroend

; --- "Open with" app-picker entry -----------------------------------------
; Separate mechanism from the shell verbs above, and easy to conflate: the
; verbs put a top-level "Open with TEDI" line on the menu, while Explorer
; builds the "Open with >" submenu from apps registered under
; Software\Classes\Applications\<exe>. Registering only the verbs (as we did
; through 0.3.97) means TEDI is absent from that submenu even though its own
; line is right there on the same menu.
;
; A shell\open\command is the whole registration - this is what VS Code
; ships and nothing more. No SupportedTypes (the app opens anything) and no
; FriendlyAppName: Explorer falls back to the exe's FileDescription, which
; the Tauri bundler already stamps as "TEDI".
!define TEDI_APP_KEY "Software\Classes\Applications\TEDIApp.exe"

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
    ; nsExec pushes the exit code whether or not you want it. Leaving it on
    ; the stack corrupts whatever the Tauri template pops next.
    Pop $0
  tedi_preinstall_no_backup:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; --- install tedi.exe (console-subsystem launcher) -----------------------
  ; TEDIApp.exe is `windows_subsystem = "windows"`; PowerShell does not
  ; synchronously wait for GUI-subsystem children, so `tedi --help` output
  ; lands after the next prompt and the cursor ends up mid-line. tedi.exe
  ; is a console-subsystem twin from tedi-cli/src/main.rs that PowerShell
  ; waits for properly. PATHEXT then resolves the user's `tedi` to this
  ; binary instead of the GUI (the GUI is renamed TEDIApp.exe specifically
  ; to keep it off PATHEXT's `tedi.exe` lookup).
  ;
  ; The release workflow builds the stub via an explicit
  ; `cargo build --release -p tedi-cli` step (see
  ; .github/workflows/release.yml), so by the time NSIS runs the file is at
  ; <src-tauri>/target/release/tedi.exe. The Tauri 2.11 NSIS bundler emits
  ; `installer.nsi` at `<src-tauri>/target/release/bundle/nsis/installer.nsi`
  ; (NO per-language subdirectory — earlier versions of this comment claimed
  ; otherwise and shipped `..\..\..\tedi.exe`, which resolved one level too
  ; high to `target/tedi.exe`. `/nonfatal` then swallowed the missing-file
  ; error and the installer silently shipped without the launcher, leaving
  ; the user with "'tedi' is not recognized as an internal or external
  ; command"). Two dots up = bundle/, three dots = the bundle/nsis sibling
  ; level we don't want, two dots is correct: `..\..\` lands at
  ; target/release/.
  ;
  ; Drop /nonfatal so a missing tedi.exe FAILS the installer build instead
  ; of producing a broken installer. The launcher is now load-bearing for
  ; every CLI subcommand (`tedi --help`, `tedi ext ...`, etc.) so a missing
  ; binary is not a degradation — it is a complete CLI outage.
  SetOutPath "$INSTDIR"
  File "/oname=tedi.exe" "..\..\tedi.exe"

  ; --- remove any legacy tedi.cmd shim ------------------------------------
  ; v0.2.0 .. v0.2.19 wrote a `tedi.cmd` here that handled --help / --version
  ; natively and delegated other subcommands to TEDI.exe. The new tedi.exe
  ; supersedes it — leave nothing on disk that could confuse PATHEXT (cmd
  ; runs AFTER exe so it would be a no-op, but keep things tidy).
  Delete "$INSTDIR\tedi.cmd"

  ; --- ensure install dir is on user PATH ---------------------------------
  ; NEVER read PATH with ReadRegStr. NSIS_MAX_STRLEN is 1024, and on a longer
  ; value ReadRegStr does not return a truncated string - it returns an EMPTY
  ; one plus the error flag. The old code read that as "user has no PATH yet"
  ; and wrote `Path = $INSTDIR`, destroying every entry the user had. Measured
  ; against the NSIS 3.08 the Tauri bundler ships: a 1023-char PATH reads fine,
  ; 1024 comes back empty, and a 1573-char one came back out as 32 chars of
  ; install dir. Any dev machine clears that easily. Issue #9. Just under the
  ; limit the concatenation truncated instead, appending half a directory as a
  ; junk PATH entry. Both failure modes are silent.
  ;
  ; .NET's RegistryKey has no length limit, so the whole read-modify-write
  ; runs in PowerShell. DoNotExpandEnvironmentNames keeps `%VAR%` entries
  ; literal so they are written back unexpanded, -Type ExpandString preserves
  ; REG_EXPAND_SZ, and -notcontains is a literal case-insensitive element
  ; compare so reinstalls don't pile up dupes and a `[` in a path can't be
  ; read as a wildcard. Set-ItemProperty creates the value when absent.
  ;
  ; $INSTDIR travels in an env var rather than being interpolated into the
  ; script text: the directory page lets the user pick a path containing an
  ; apostrophe, which would otherwise break the PowerShell string literal.
  ;
  ; powershell.exe is invoked by absolute path, not resolved through PATH -
  ; PATH is the one thing this block cannot assume is sane, and an absolute
  ; path also removes the "rogue powershell.exe earlier in PATH" hijack from a
  ; signed installer. $SYSDIR is WOW64-redirected to SysWOW64 for the 32-bit
  ; NSIS stub, which carries its own copy. No -ExecutionPolicy: it governs
  ; script FILES, not -Command (verified under both Restricted and AllSigned),
  ; and `-ExecutionPolicy Bypass` in an installer is a stock AV heuristic.
  ; ErrorActionPreference Stop means any failure exits non-zero having written
  ; nothing - TEDI not being on PATH beats corrupting it - and -NonInteractive
  ; keeps an unattended auto-update from ever blocking on a prompt.
  ;
  ; `exit 3` marks "PATH actually changed" so the broadcast below stays
  ; conditional; auto-update re-runs this hook on every release and
  ; HWND_BROADCAST blocks on each unresponsive top-level window.
  System::Call 'kernel32::SetEnvironmentVariable(t "TEDI_INSTDIR", t "$INSTDIR") i'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference = 'Stop'; $$k = Get-Item -LiteralPath '${TEDI_ENV_REG_PS}'; $$p = [string]$$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$d = $$env:TEDI_INSTDIR; if ($$d -and (($$p -split ';') -notcontains $$d)) { $$n = if ($$p -eq '') { $$d } else { $$p.TrimEnd(';') + ';' + $$d }; Set-ItemProperty -LiteralPath '${TEDI_ENV_REG_PS}' -Name Path -Value $$n -Type ExpandString; exit 3 }"`
  Pop $1
  ${If} $1 == 3
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}

  ; --- "Open with TEDI" context-menu entries -------------------------------
  ; See the TediWriteVerb definition above for why there are four roots and
  ; why the command targets TEDIApp.exe rather than the tedi.exe stub.
  !insertmacro TediWriteVerb "Directory" "%V"
  !insertmacro TediWriteVerb "Directory\Background" "%V"
  !insertmacro TediWriteVerb "Drive" "%V"
  !insertmacro TediWriteVerb "*" "%1"

  ; --- "Open with > TEDI" app-picker entry ---------------------------------
  WriteRegStr HKCU "${TEDI_APP_KEY}\DefaultIcon" "" '"$INSTDIR\TEDIApp.exe",0'
  WriteRegStr HKCU "${TEDI_APP_KEY}\shell\open\command" "" '"$INSTDIR\TEDIApp.exe" "%1"'

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
      Pop $0
    ${EndIf}
    RMDir /r "${TEDI_DATA_BACKUP}"
  tedi_postinstall_no_restore:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\tedi.exe"
  ; Legacy shim from <=0.2.19 installs. Delete is a no-op when absent so
  ; this is safe on fresh-install-then-uninstall flows.
  Delete "$INSTDIR\tedi.cmd"

  ; Drop the context-menu verbs. Unlike the PATH entry (deliberately left
  ; behind - see the header note), these are ours alone and point at an
  ; $INSTDIR that is about to stop existing, so leaving them would put a
  ; dead "Open with TEDI" on every folder and file.
  ;
  ; Auto-update runs the old uninstaller in passive mode before the new
  ; install, so this fires on upgrades too - NSIS_HOOK_POSTINSTALL rewrites
  ; the verbs immediately afterwards.
  !insertmacro TediDeleteVerb "Directory"
  !insertmacro TediDeleteVerb "Directory\Background"
  !insertmacro TediDeleteVerb "Drive"
  !insertmacro TediDeleteVerb "*"
  DeleteRegKey HKCU "${TEDI_APP_KEY}"
!macroend
