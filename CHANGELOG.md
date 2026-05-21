# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.2.12] - 21-05-2026

### Added

- **Drag-and-drop reorder inside split groups.** Each pane leaf in a split tab now carries its own drag handle and can be shuffled among its siblings without disturbing the rest of the strip. Backed by a nested dnd-kit `SortableContext` with `leaf:<id>` items inside each split's wrapper; a new `reorderLeafInTree` tree-op moves the leaf among its **direct** split siblings (cross-level warps stay no-ops by design — sequential `Ctrl+D` splits are flat, so the typical case is fully covered). The leaf id, FIFO `terminalOrdinal`, cwd, SSH binding, editor dirty/preview state, and the underlying PTY / xterm / CodeMirror session all travel with the leaf — drag is purely a positional reshuffle, no respawn.
- **Whole-split-group drag via dedicated grip.** A small vertical-dots grip appears on the left edge of every bordered split cluster (tooltip "Drag group"). It carries the outer-context sortable's listeners so the whole split moves through the strip in one piece, while the leaves inside keep their own per-leaf drag handles for in-group reorder. Non-split tabs are unchanged — the sole entry doubles as the tab and its drag handle.
- **`/schedule` slash command.** Schedules a terminal command to run at a parsed natural-time ("in 5 minutes", "at 3pm", "tomorrow at 9am") through the existing `schedule_command` tool. Picker entry uses the calendar-add glyph and surfaces an `[time] [command]` arg hint.
- **Auto-compact stages + toast surfacing.** `compactModelMessagesDetailed` now reports per-stage counts (`lossless` dedup of superseded reads, `elided` tool-result masking, `dropped` hard-trim of oldest messages) instead of one opaque counter. Stage 1 stays silent because it runs every turn and is reversible; Stage 2/3 raise a toast — warning when messages are dropped (information loss) and info when only elision happened. Per-session 12 s throttle prevents a chain of high-context turns from spamming notifications.
- **Zoom indicator in the status bar.** Status-bar pill renders only when content zoom differs from `100%`; clicking resets to the default. Source of truth is `preferences.contentZoom`, same field the Cmd/Ctrl+= / Cmd/Ctrl+- shortcuts already drive.

### Changed

- **Tab drag collision detection switched to scoped `closestCenter`.** Default `rectIntersection` flickered between "last tab" and `null` when dragging past the strip's end, which made the snap-back-to-original gesture wobble. The new strategy filters droppables by drag-kind first (tab drags only consider `tab:*`, leaf drags only `leaf:*`) so a tab drag can't accidentally snap onto a leaf in another group's inner sortable context. Snap-back is now deterministic — return the dragged tab to its original spot and release.
- **`/compact` is force-mode.** Manual `/compact` no longer silently no-ops below the 70%-context auto threshold. Below threshold it drops the oldest ~quarter of messages (capped to preserve `keepTail`), above threshold it falls back to the original drop-until-50% loop. Zero-drop now only happens when the whole chat fits inside `keepTail`, and the toast says so plainly instead of "under threshold".
- **Slash-command toasts honour `variant`.** `composer` previously called `console.info` for slash-command results; it now routes through the real `toast()` so success / info / warning / error variants render with the matching colour.
- **Workspaces panel header redesign.** New header bar matches the other sidebar sections — leading glyph (`DashboardSquare02Icon`) + uppercase-cased title + vertical separator + the existing "New workspace" action — height bumped from 28 px to 32 px so the row aligns with the local-files / SCM / SSH headers above it.
- **Sortable group structure refactored.** Outer SortableContext IDs prefixed (`tab:<n>`) so the new inner per-leaf context (`leaf:<m>`) can coexist in the same DndContext; per-entry rendering extracted to a shared `renderEntryBody` helper so the leaf-sortable and tab-sortable paths share JSX. No user-facing change beyond the new gestures above.

## [0.2.11] - 21-05-2026

### Added

- **Cursor-position AI CLI detection.** The xterm cursor's current line is now the canonical "where is the user RIGHT NOW" signal — independent of alt-screen toggle, OSC handlers, or shell-integration. When the cursor sits on a recognisable system shell PS1 (`]$`, `user@host:path$`, zsh `%`, `PS C:\>`, `C:\path>`), the previously-active AI CLI is treated as gone, period. Closes the gap left by the prior alt-screen / shell-prompt / TUI-marker triad, which each had edges (claude v2.1+ inline rendering, killed CLIs that never emit `\x1b[?1049l`, SSH drops leaving ghost state).
- **AI CLI status on SSH leaves.** The detector runs on the byte stream regardless of whether the PTY is local or remote, so a remote `claude` / `codex` / `opencode` session now lights up the tab icon the same way as a local one. SSH disconnect resets the detector's `activeTool` so the icon doesn't ghost forward into the next reconnect.
- **History-recall / paste-then-Enter command activation.** When `cmdBuffer` is empty on Enter — because the user recalled a command via ↑, accepted shell completion via Tab+Enter, or pasted-then-pressed-Enter — the detector now strips the PS1 prefix off the cursor's prompt line and runs that through `matchTool`. Previously these paths bypassed the keystroke accumulator and never activated the tool.
- **Stable FIFO terminal ordinals.** The number rendered on each terminal tab chip — and surfaced to the AI in the per-turn `<env>` block — is now a `terminalOrdinal` assigned once at leaf creation. The same number travels with the leaf across split moves, tab reorders, workspace serialisation, and app restarts. "terminal 3" the user pinned in their head before quitting stays "terminal 3" forever. Older saved state without the field is backfilled on hydration via `maxTerminalOrdinal(tabs) + 1`.
- **`activeTabKind` in the extension App-context snapshot.** Extensions can now distinguish `terminal` / `ssh` / `editor` / `diff` / `preview` for the focused tab via `ctx.app.getContext()` / `onContextChange`. `null` when no tab is active.

### Changed

- **TabBar icon IS the AI CLI status indicator.** The separate `idle` / `working` / `blocking` chip is gone; the terminal-leaf icon tints emerald (idle) / yellow-pulse (working) / red-pulse (blocking) directly. Less visual noise on each tab, and the icon's bounding box becomes the hit target for the tooltip rather than a tiny chip beside it.
- **SSH status now tints the tab title, not the cloud icon.** `connecting` / `reconnecting` pulse yellow, `connected` turns emerald, `disconnected` / error turns red — colour lives on the text. The cloud icon stays neutral sky so the colour cue belongs to the label, not the glyph.

### Fixed

- **Right-click on SSH tabs did nothing.** The previous tab-trigger composition wrapped `TabsTrigger` in `<Tooltip>` first, then handed that block to `ContextMenuTrigger asChild`. Tooltip is a Provider, not a DOM element, so Radix' `Slot` silently dropped the `onContextMenu` handler. Both `asChild` triggers now stack around the same `TabsTrigger` so the context-menu handler reaches the actual DOM node.
- **Streaming detection on inline AI CLIs (claude v2.1+, opencode).** Rate-based "is the AI generating?" fallback would only fire while alt-screen was active; inline tools that don't toggle alt-screen during a stream never lit up the working icon. The cursor scan now establishes "not at shell prompt" first, so streaming output below correctly flags `working`.

## [0.2.8] - 20-05-2026

### Added

- **Extensions subsystem.** Third-party extensions installable from a packaged `.zip` or directly from a GitHub release (`owner/repo` → `releases/latest` → `.zip` asset). Settings → Extensions surfaces the install pipeline, an in-app **Check updates** / **Update** flow keyed off the release `tag_name` + semver compare, per-card animated update indicator, and a trust-on-install dialog that peeks the manifest + icon before extracting. Rust install pipeline carries path-traversal + size guards, atomic `state.json` writes (temp → rename), MOTW (`Zone.Identifier`) auto-strip on Windows so SmartScreen / Defender doesn't silently refuse to launch bundled binaries, `chmod 0o755` on Unix for `sidecar/*` after extract, and a rename-to-trash dance on replace so an active sidecar's locked files don't break the update. Frontend deactivates the prior copy before invoking the install on the Rust side as belt-and-braces. Settings webview and main webview share the contribution registries via a `tedi://ext-changed` Tauri event; manifest contributions are seeded before the JS module's `activate(ctx)` runs so the UI surface (toggles, themes, slash commands, …) survives any extension-side throw.
- **Extension host API (`window.tedi`-equivalent passed to `activate(ctx)`).** Namespaced `settings.get/set/onChange(key)` (auto-scoped as `ext:<id>:<key>`), `secrets.get/set(name)` (same OS keychain TEDI core uses, scoped per extension), permission-gated `invoke(cmd, args)` (with `secrets_get_all` hard-denied even under `*`), `events.emit/on(name)` (tunneled as `ext://<id>/<name>`), `app.getContext / onContextChange` for live workspace state, `ui.toast`, per-extension `storage` (a separate tauri-plugin-store file), `contribute.{settings, commands, keybindings, slashCommands, themes, editorThemes, panels, aiTools}`, and a runtime `statusBar.setItem / removeItem` for status-bar icons.
- **Extension status-bar slot.** New bottom-right strip rendered by `ExtensionStatusItems`. Items are bare 16 px icons (no chrome) coloured via CSS `mask-image` so SVG `currentColor` glyphs pick up the host theme automatically: full `--foreground` on success, `--muted-foreground/40` on connecting / disconnected, with a tiny amber / red dot in the top-right corner only for warning / error tones (success doesn't need a redundant dot because full-opacity vs grayscale already conveys "live").
- **Discord Rich Presence as a reference extension.** Discord no longer ships in the core binary; the [reference repo](https://github.com/IlhamriSKY/TEDI.discord-rich-presence) builds a per-platform `tedi-discord-helper` sidecar that owns the Discord IPC and exposes it to the extension JS layer over loopback HTTP. Demonstrates `shell_bg_spawn_direct`, the status icon API, the cross-platform parent-PID watchdog pattern (libc::getppid on Unix, ToolHelp32 on Windows), and a GitHub-Actions release workflow that produces a `.zip` matching the install schema.

### Changed

- **Sidebar order.** SSH file tree now sits directly underneath the local file tree (above source control, above the workspaces panel). Both file explorers are adjacent so users browsing local + remote in one session don't have to context-switch over the source-control panel.
- **SSH file tree follows the active SSH terminal's cwd.** When the focused SSH leaf reports an OSC 7 cwd, the tree roots there instead of falling back to the SFTP home directory — mirrors how the local file tree tracks whichever terminal pane is focused. The home directory remains the bootstrap fallback before the shell has emitted OSC 7.

### Removed

- **Discord Rich Presence code in core.** The `discord_rpc_*` Tauri commands, the `DiscordState` manager, the `discord-rich-presence` Cargo dep, the `discordRpcEnabled` preference, the General-settings toggle, and the `useDiscordRichPresence` hook are gone. The reference extension takes their place. Users who relied on the old toggle should install `IlhamriSKY/TEDI.discord-rich-presence` from Settings → Extensions → From GitHub.

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
- **Windows installer shim.** NSIS post-install hook writes `tedi.cmd` next to the EXE and appends the install dir to user `PATH`.
- **Unix `tedi` shim install.** `cli_install_path_shim` writes `~/.local/bin/tedi`; self-heals on launch via `refresh_shim_if_present` after macOS `.app` relocation or AppImage filename change.
- **Restore checkpoint.** Roll back the agent's last turn: reverts every file the agent mutated, trims chat history, clears the read-cache. Manually-edited files since the agent wrote are preserved.
- **AI-generated commit messages.** Sparkles button in Source Control pulls the diff (capped at 80 KB), runs it through the active model, writes a Conventional-Commit one-liner into the message input.
- **Commit + push from Source Control.** Message input, commit (Enter), and push (uses upstream if set, else `push -u origin <branch>`). Backend gains `git_commit`, `git_push`, `git_diff_full`.
- **Upstream tracking and ahead / behind counts** in `git_status`, surfaced as chips in the panel header and a numeric badge on the Push button.
- **Settings → About: inline download + install.** Full updater state machine inside the panel - `available` → "Download & install vX.Y.Z" with release notes, `downloading` → progress bar, `ready` → "Restart to apply". Linux falls back to opening the GitHub release page.
- **Content-zoom shortcuts.** `view.zoomIn` / `view.zoomOut` / `view.zoomReset` (Cmd/Ctrl+= / +- / +0) scale editor, diff, and terminal together via a `--content-zoom` CSS variable + xterm `fontSize` multiplier.
- **Session token-usage display** in the context indicator: cumulative Input / Output / Cached tokens with prompt-cache hit rate.

### Changed

- **SCM panel header redesigned.** Branch + change count, ahead / behind chips, vertical separator, discard-all and refresh icons, tooltips on every action.
- **Per-tab-type accent stripe moved to the left edge.** A 3 × 16 px vertical bar centred on the trigger replaces the 2.5 px top stripe - emerald local shell, sky SSH, brand-blue editor, cyan preview, violet AI diff, amber git diff. Active tab now sits on the brand-tinted `--accent` surface so the categorical hue reads against a coloured background. Painted by a child `<span>` to win the specificity fight with the primitive `TabsTrigger` `::after`.
- **`Cmd/Ctrl+P` freed for future quick-open.** Tab-cycle moved to `Cmd/Ctrl+Alt+P`.

### Fixed

- **Updater pill silently hid errors.** Error state now lights up the pill with the message in tooltip + dialog with Retry.
- **Forever-blank terminal on workspace restore.** Two split panes could land in `lastPtyError === null && pty === null`; the new `STUCK_RECOVERY_MS` watchdog forces recovery after 8 s.
- **Hung `pty_open` left panes black forever.** The 15 s spawn timeout funnels it into the retry path.

## [0.1.9] - 16-05-2026

### Added

- **Preview proxy (`tedi-frame://`).** Custom URI scheme proxies HTTP(S) URLs and strips `X-Frame-Options`, CSP `frame-ancestors`, COOP / COEP / CORP, `Set-Cookie`, and HSTS so the preview pane can embed public sites. Address bar gains a shield toggle to flip between proxied and direct loads. 25 MB body cap, 20 s upstream timeout.
- **Bundled Nerd Font.** `JetBrainsMono Nerd Font Mono` (regular + bold woff2, ~2 MB) prepended to the terminal / editor font chain - Oh-My-Zsh / Powerlevel10k / Starship glyphs render out of the box.
- **Terminal copy / paste shortcuts.** `Ctrl+Shift+C` copies the xterm selection; `Ctrl+Shift+V` pastes through `term.paste()` for bracketed-paste so multi-line snippets aren't executed line-by-line.
- **Layout-independent shortcut matching.** `canonicalKey()` folds `KeyboardEvent.code` (`KeyT`, `Digit5`) into the canonical form before comparing - fixes macOS `Option+Z` (`key: "Ω"`) and Cyrillic / Greek / Arabic / Devanagari layouts.
- **Tab right-click context menu.** Close, Close Others, Close All, per-pane Move to group, Toggle Split Orientation.

### Changed

- **IME composition guard for `Ctrl+Backspace`.** Mid-composition keys defer entirely to the browser / IME so candidate-delete and Hangul jamo correction don't corrupt the PTY buffer.
