# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.2.6] - 19-05-2026

### Added

- **SSH file tree (SFTP).** Sibling sidebar panel that opens whenever an SSH session is connected. Browses the remote filesystem via an SFTP subsystem channel multiplexed onto the existing russh session - no extra TCP connection, no extra password prompt. The remote home directory (`canonicalize(".")`) is the natural root, and switching between SSH tabs swaps the tree to the matching host without remounting. Supports create file / create folder / rename / delete in addition to expand. Access is governed entirely by the remote user's unix permissions: the kernel enforces, TEDI never overrides. `permission denied` / `no such file` errors surface inline at the failing subtree so sibling branches stay usable. Driven by `russh-sftp 2.1`; panel + bridge module are lazy-loaded so local-only workflows pay nothing.
- **SSH host-key pinning.** Saved connections now pin the SHA256 fingerprint observed on the first successful connect; subsequent handshakes that present a different server key fail fast with a clear mismatch error instead of silently accepting it. Closes the silent-MITM window between TOFU and a real `known_hosts` UI. First connect and dialog-time test connects remain TOFU and just record the fingerprint.

## [0.2.5] - 19-05-2026

### Added

- **AI CLI status badge in the tab bar.** Per-tab `idle` / `working` / `blocking` chip next to the tab title when a known AI CLI (`claude`, `codex`, `opencode`, `copilot`, `pi`, `aider`, `gemini`, `amazon-q`, `cody`, `goose`, `cursor-agent`, `ollama run`) is running. Detection is screen-content based via xterm's live viewport - inspired by [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) - so it works the same on Windows / macOS / Linux without shell-integration hooks. Auto-clears the moment the TUI exits xterm's alternate-screen buffer. Toast + falling beep on task completion (`working → idle` ≥1.5 s) and rising beep + warning toast on approval prompts (`* → blocking`). Defensive try/catch wraps every detector boundary so a host-callback failure never disables the tab bar.
- **Brand refresh.** New TEDI logo and icon set across Windows / macOS / Linux / Android / iOS; primary, ring, and accent palette retuned to TEDI blue `#0057FE` with a light-blue `--accent` tint (`#DBE5FF` light / `#0A2870` dark) for selection surfaces.
- **Image diff in Source Control.** `git_file_head` returns a typed `ReadResult` (text / image / binary); `GitDiffPane` renders PNG / JPEG blobs side-by-side instead of dumping base64 into CodeMirror.
- **`tedi` CLI launcher.** `tedi .` / `tedi <path>` opens a folder or file. Second invocation forwards to the running window via `tauri-plugin-single-instance`; `--version` / `--help` / `--update` short-circuit before GUI init.
- **`tedi --update` / `-u`.** Triggers the in-app updater from the terminal - works whether or not an instance is running.
- **`tedi --version` / `--help` visible on Windows.** GUI binary now `AttachConsole(ATTACH_PARENT_PROCESS)` before printing so the output is visible even though `windows_subsystem = "windows"` detaches stdio.
- **Windows installer shim.** NSIS post-install hook writes `tedi.cmd` next to the EXE and appends the install dir to user `PATH`.
- **Unix `tedi` shim install.** `cli_install_path_shim` writes `~/.local/bin/tedi`; self-heals on launch via `refresh_shim_if_present` after macOS `.app` relocation or AppImage filename change.
- **Restore checkpoint.** Roll back the agent's last turn: reverts every file the agent mutated, trims chat history, clears the read-cache. Manually-edited files since the agent wrote are preserved.
- **AI-generated commit messages.** Sparkles button in Source Control pulls the diff (capped at 80 KB), runs it through the active model, writes a Conventional-Commit one-liner into the message input.
- **Commit + push from Source Control.** Message input, commit (Enter), and push (uses upstream if set, else `push -u origin <branch>`). Backend gains `git_commit`, `git_push`, `git_diff_full`.
- **Upstream tracking and ahead / behind counts** in `git_status`, surfaced as chips in the panel header and a numeric badge on the Push button.
- **Per-change line stats** in `git_status` - added / removed / binary populated from a single `git diff --numstat HEAD`.
- **Settings → About: inline download + install.** Full updater state machine inside the panel - `available` → "Download & install vX.Y.Z" with release notes, `downloading` → progress bar, `ready` → "Restart to apply". Linux falls back to opening the GitHub release page.
- **Updater dialog & pill surface errors** in destructive colour with retry; dialog renders `idle` / `checking` states standalone when invoked via `--update`.
- **Content-zoom shortcuts.** `view.zoomIn` / `view.zoomOut` / `view.zoomReset` (Cmd/Ctrl+= / +- / +0) scale editor, diff, and terminal together via a `--content-zoom` CSS variable + xterm `fontSize` multiplier.
- **`terminal.close` (Ctrl+Shift+X).** Blocked when it's the last terminal in the workspace.
- **PTY spawn / no-data watchdogs.** 15 s spawn timeout funnels hung `pty_open` into the retry banner; 5 s post-spawn silence watchdog catches wedged ConPTY / profile init.
- **PTY lifecycle debug traces** (`[tedi-pty]` in devtools). Silence with `localStorage.TEDI_DEBUG_PTY = "0"`.
- **Session token-usage display** in the context indicator: cumulative Input / Output / Cached tokens with prompt-cache hit rate.
- **`read_file` paging.** Accepts `offset` (0-based line) and `limit` (max 2000 lines). 200 KB byte cap trims to the last complete newline.
- **Provider-aware prompt-cache adapter (`lib/cache.ts`).** Marks three Anthropic breakpoints - system, last user, last tool-result - for compounding savings on long tool loops.

### Changed

- **PTY observability + epoch correctness.** `pty_open` invoke logs before `SPAWN_LOCK`; `retryPty` / `respawnSession` capture `myEpoch` after the synchronous bump and drop stale results. `STUCK_RECOVERY_MS = 8 s` forces a retry when both `lastPtyError` and `pty` stay null past the settle budget.
- **SCM panel header redesigned.** Branch + change count, ahead / behind chips, vertical separator, discard-all and refresh icons, tooltips on every action.
- **Per-tab-type accent stripe moved to the left edge.** A 3 × 16 px vertical bar centred on the trigger replaces the 2.5 px top stripe - emerald local shell, sky SSH, brand-blue editor, cyan preview, violet AI diff, amber git diff. Active tab now sits on the brand-tinted `--accent` surface so the categorical hue reads against a coloured background. Painted by a child `<span>` to win the specificity fight with the primitive `TabsTrigger` `::after`.
- **Read cache lives at module scope, keyed by `sessionId`** so `restoreToLastCheckpoint` can clear it as part of the rollback.
- **PTY size syncs on hidden → visible flip** since `ResizeObserver` only fires on dimension changes.
- **Diff view runs without minimap** - the merge view already has dual scrollbars and unchanged-region collapser.
- **Subagents flow through `generateText`** with cache breakpoints injected on system / user messages.
- **`Cmd/Ctrl+P` freed for future quick-open.** Tab-cycle moved to `Cmd/Ctrl+Alt+P`.
- **Project-wide Prettier sweep** (~170 files) + `rustfmt.toml`, `.editorconfig`, `.gitattributes`, `.prettierignore`.

### Fixed

- **`tedi --version` / `--help` produced no output on Windows.** Default PATHEXT resolves `.EXE` before `.CMD`, so the GUI binary won the lookup but its stdout was detached. EXE now attaches to the parent console before printing.
- **Updater pill silently hid errors.** Error state now lights up the pill with the message in tooltip + dialog with Retry.
- **No-data watchdog killing healthy shells.** Track `firstByteEpoch` per session and refuse to arm if bytes already arrived for that epoch.
- **Forever-blank terminal on workspace restore.** Two split panes could land in `lastPtyError === null && pty === null`; the new `STUCK_RECOVERY_MS` watchdog forces recovery after 8 s.
- **Stale retries clobbering newer spawns.** Late-arriving results from superseded spawns now drop instead of stomping the newer session's state.
- **Tab accent stripe flicker** in multi-tab / split layouts.
- **Hung `pty_open` left panes black forever.** The 15 s spawn timeout funnels it into the retry path.
- **Compact pass dropped distinct paged reads** as redundant - now keyed by `path#offset:limit`.
- **NSIS installer crash on Windows runner.** Pinned `pnpm/action-setup@v4` (v6 self-installer crashed with `STATUS_STACK_BUFFER_OVERRUN` on `windows-2025`).
- **Installer `${StrStr}` resolution.** Switched from `nsis_tauri_utils::FindInString` to `StrFunc.nsh` `${StrStr}`.

## [0.1.9] - 16-05-2026

### Added

- **Preview proxy (`tedi-frame://`).** Custom URI scheme proxies HTTP(S) URLs and strips `X-Frame-Options`, CSP `frame-ancestors`, COOP / COEP / CORP, `Set-Cookie`, and HSTS so the preview pane can embed public sites. Address bar gains a shield toggle to flip between proxied and direct loads. 25 MB body cap, 20 s upstream timeout.
- **Bundled Nerd Font.** `JetBrainsMono Nerd Font Mono` (regular + bold woff2, ~2 MB) prepended to the terminal / editor font chain - Oh-My-Zsh / Powerlevel10k / Starship glyphs render out of the box.
- **CJK font fallback chain** (Noto + YaHei / JhengHei / Meiryo / MS Gothic / Malgun Gothic + Hiragino / PingFang / Apple SD Gothic Neo).
- **Terminal copy / paste shortcuts.** `Ctrl+Shift+C` copies the xterm selection; `Ctrl+Shift+V` pastes through `term.paste()` for bracketed-paste so multi-line snippets aren't executed line-by-line.
- **Layout-independent shortcut matching.** `canonicalKey()` folds `KeyboardEvent.code` (`KeyT`, `Digit5`) into the canonical form before comparing - fixes macOS `Option+Z` (`key: "Ω"`) and Cyrillic / Greek / Arabic / Devanagari layouts.
- **PTY spawn-crash recovery.** 3 s `SPAWN_GRACE_MS` window catches shells that exit shortly after spawn; leaf held in place with a retry banner.
- **Spawn-epoch race guard for terminal respawn.** Per-session `ptySpawnEpoch` lets late `onExit` events bail out before touching state owned by a newer spawn.
- **Tab right-click context menu.** Close, Close Others, Close All, per-pane Move to group, Toggle Split Orientation.
- **SQL syntax highlighting in AI chat code blocks** for `sql` / `pgsql` / `mysql` / `sqlite` (+ `postgres` / `postgresql` / `plpgsql` / `psql` / `mariadb` / `sqlite3` aliases).

### Changed

- **PTY size floor `MIN_PTY_DIM = 2`** - `FitAddon` briefly computes 0x0 dims during drag / hidden-tab switch; floor + de-dup + bookkeeping centralised in `syncPtySize()`.
- **IME composition guard for `Ctrl+Backspace`.** Mid-composition keys defer entirely to the browser / IME so candidate-delete and Hangul jamo correction don't corrupt the PTY buffer.
- **Active-tab pane wrapper paints `bg-background`** so WebView2 stops compositing a hidden tab's xterm scrollbar over the visible one.
- **Tooltip refactor.** Raw `title="…"` replaced with Radix `Tooltip` across tab close, SCM, file-explorer, workspaces, AI input chips, status-bar pin / unpin, AiDiff / GitDiff labels, model dropdown remove-key.

### Fixed

- **Stray `- -` line in README.md.**

### Removed

- **`fs_stat` Tauri command** and `FileStat` / `StatKind` types - no remaining callers.
- **Unused shadcn UI components** (`~1.3 k LOC` across `card` / `checkbox` / `empty` / `item` / `label` / `menubar` / `radio-group` / `select` / `sheet` / `skeleton` / `slider` / `toggle-group`).
- **`src/modules/ai/lib/placeholders.ts`** - input bar resolves placeholders inline now.
