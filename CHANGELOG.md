# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.2.24] - 25-05-2026

> The 0.2.23 release was tagged but its Linux Ubuntu job got cancelled mid-
> run; the GitHub release ended up with Windows + macOS binaries only.
> 0.2.24 reships the same content (plus three new feature batches) with a
> fresh build of all four platforms.

### Added

- **Theme presets with editable user list.** Built-in presets stay; a new `userThemePresets` preference holds user-created variants. "Save as preset" inline input next to the Reset button captures the current `customTheme` (minus its wallpaper) under a name of the user's choosing; the entry appears alongside built-ins in the preset grid with an "your preset" sub-label and a hover-× delete affordance. Name collisions auto-suffix `(2)` / `(3)` so a saved preset never silently shadows a built-in.
- **First-class OpenRouter and 9Router via OpenAI Compatible presets.** The "OpenAI Compatible" connector in Settings → Models gains a Quick-start chip row — **OpenAI / OpenRouter / 9Router (local)** — that pre-fills the base URL so users don't have to remember whether OpenRouter's path is `/v1` or `/api/v1` (it's the latter; everyone trips on this), or which port the local 9Router server uses (20128). The chips are hidden once a key is configured to keep the configured row compact.
- **Source Control right-panel variant.** New session-scoped `useScmRightPanelStore` parallel to the AI sidebar / extension right panels — all three live in the same right slot and a three-way mutual-exclusion effect block in `App.tsx` reconciles them. Preference `sourceControlInRightPanel` (default off) gates the mode; toggle is in General settings. Includes a new `GitGraphView` tab for the commit graph.

### Changed

- **Settings → Models layout overhaul.** "+ Add provider" dropdown moves to the top of the providers section (with built-in search box + max-height capped to ~5 rows + scroll); the configured-provider cards list below it. Default chat model and editor autocomplete settings are merged into a single bordered "Defaults" card with inline label-control rows. The chat dropdown / autocomplete picker / default model dropdown all filter out unconfigured providers so the chip cluster stays focused on what actually works.
- **Settings → Theme layout overhaul.** Outer `gap-6` → `gap-4`; preset card padding and swatch size shrink one tier; wallpaper Blur / Opacity / Darken sliders re-housed in a single `CompactSliderRow` panel instead of three separate `SettingRow`s. Two `SettingRow`s ("Use background image" + "From URL") merged into a single bordered row: one URL input + Browse + Use URL + Clear + enable switch — only one source can be active at a time because they share the same backing field. A faint "Source: …" line under the row tells the user whether the current wallpaper came from a local file or a URL.
- **Settings → Models chat-dropdown filtered to configured providers.** The previous behaviour listed every provider in the registry regardless of whether the user had pasted a key for it; with 10 entries the "+ key please" affordances drowned the few rows that actually worked.

### Fixed

- **"AI detected but model isn't" — OpenAI Compatible URL commit race.** Typing a new base URL and immediately pressing **Save** on the API key (without first clicking out of the URL field) used to fire the auto-detect against the *old* URL because `commitURL` only ran on blur. `OpenAICompatibleBlock.saveKey` now commits the URL first and passes the freshly-committed URL through to the parent's auto-refresh, so the value React hasn't re-rendered yet can't leak into the request. Matches the user-reported "input AI terdetect tapi model tidak" symptom.

### Repo metadata

- `Cargo.toml`, `tedi-cli/Cargo.toml`, `tauri.conf.json`, `package.json` all gain `description` / `authors` / `license` / `repository` / `homepage` / `bugs` fields so the crate / installer / npm-style metadata reflects the IlhamriSKY/TEDI fork. NSIS `installerIcon` set to `icons/icon.ico`; upstream Crynta copyright + `licenseFile` reference added.

## [0.2.23] - 25-05-2026

> 0.2.22 was tagged but type-check failed because in-flight SCM-right-panel
> code from a separate branch sneaked into the App.tsx I edited; 0.2.23
> is the clean shipping cut of the same OpenRouter feature.

### Added

- **First-class OpenRouter provider.** OpenRouter ([openrouter.ai](https://openrouter.ai)) joins OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, and SumoPod as a top-row provider with its own API-key card, dedicated icon, dropdown group, and runtime model catalogue. Picks up keys with `sk-or-` prefix; pings `https://openrouter.ai/api/v1/models` with the user's key plus the standard `HTTP-Referer` + `X-Title` headers OpenRouter uses for dashboard attribution. Eight curated defaults (Claude Opus 4 / Sonnet 4, GPT-5 / 5-mini, Gemini 2.5 Pro, DeepSeek Chat V3, Grok 4, Llama 3.3 70B) populate the dropdown before the live catalogue resolves so the picker is never empty. Detected models carry the real maker as `ownedBy` (parsed from the `<maker>/<model>` slug or OpenRouter's `top_provider.name`) so the chat chip credits *Anthropic* / *OpenAI* / *Google* — not the gateway. Wired through `agent.ts` via `@ai-sdk/openai-compatible` so model selection, transport, and chat history all behave identically to native providers. New module: [`src/modules/ai/lib/openrouter.ts`](src/modules/ai/lib/openrouter.ts).

### Fixed

- **"AI detected but model isn't" — OpenAI Compatible URL commit race.** Typing a new base URL and immediately pressing **Save** on the API key (without first clicking out of the URL field) used to fire the auto-detect against the *old* URL, because `commitURL` only runs on blur. The most painful version: paste an OpenRouter URL + key, hit Save → /models fetched against `api.openai.com/v1` with the OpenRouter key → 401 → "Detection failed". `OpenAICompatibleBlock.saveKey` now commits the URL first and passes the freshly-committed URL all the way through to the parent's auto-refresh, so the value React hasn't re-rendered yet can't leak into the request. Symptom matched the user report "input AI terdetect tapi model tidak".

## [0.2.21] - 24-05-2026

### Fixed

- **Extension manifests with forward-compat fields no longer break install on older TEDI.** `PanelSchema` and `ContributesSchema` in [`src/modules/extensions/manifest.ts`](src/modules/extensions/manifest.ts) now use Zod `.passthrough()` instead of `.strict()`. Previously, declaring any panel field the host did not yet recognise — e.g. an extension targeting TEDI 0.2.21 setting `contributes.panels[].compact: true` against an installed TEDI 0.2.19 build — failed parse with `Invalid manifest: contributes.panels.0: Invalid input` and rendered the install dialog unusable. With `.passthrough()`, unknown keys flow through the parsed manifest, the host iterates only what it knows about, and the `engines.tedi` constraint still gates hard if the extension actually requires the new behaviour to work. This matches the VS Code convention where unknown manifest fields are silently tolerated. The change is host-side only; no extension reauthoring needed.

## [0.2.20] - 23-05-2026

### Fixed

- **`tedi --help` / `--version` / `--update` / `ext` no longer leave PowerShell with a garbled prompt on Windows.** Root cause: `TEDIApp.exe` (formerly `TEDI.exe`) is built with `windows_subsystem = "windows"` so PowerShell — the Windows 11 default — does NOT synchronously wait for it. The shell redraws the next prompt the moment it spawns the child, and the binary's `AttachConsole`'d output then lands on top of (or below, depending on timing) that already-drawn prompt. The cursor ends up mid-line; the user has to press Enter to recover and the display reads scrambled. The previous v0.2.18 attempt (`delegate_cli_to_console_binary` re-execing `tedi-cli.exe` from inside the GUI binary) did not fix this — PowerShell had still moved on before the GUI even started executing.
- **New approach: console-subsystem launcher `tedi.exe` (built from [src-tauri/src/bin/tedi-cli.rs](src-tauri/src/bin/tedi-cli.rs)).** It is what PATHEXT resolves the user's `tedi` to — the GUI binary is renamed to `TEDIApp.exe` via Tauri's `mainBinaryName` config specifically to keep it off PATHEXT's `tedi.exe` lookup. The stub:
  - Handles `--help` / `--version` inline (no Tauri runtime boot, no process spawn).
  - Spawns `TEDIApp.exe` synchronously with `Stdio::inherit` for `--update`, `ext`, `--extension` — output streams to the shell in real time, exit code propagates.
  - Spawns `TEDIApp.exe` detached for GUI launches (`tedi`, `tedi .`, `tedi <path>`) so the shell prompt returns immediately.
  - PowerShell waits on the console-subsystem stub like any normal CLI; the GUI binary's stdio is inherited from a real console handle so `dialoguer` keystroke reads work without `AttachConsole` contortions.

### Changed

- **Main GUI binary renamed `TEDI.exe` → `TEDIApp.exe`** via `tauri.conf.json: "mainBinaryName": "TEDIApp"`. `productName` stays `"TEDI"` so Start Menu, Add/Remove Programs, registry entries, and the installer filename are unchanged. The rename is purely a PATHEXT-collision avoidance so the new `tedi.exe` stub is what the shell finds when the user types `tedi`.
- **Cargo workspace split for the launcher.** The GUI package (`src-tauri/Cargo.toml`) declares only the `TEDIApp` bin; the `tedi.exe` console launcher lives in a separate workspace member (`src-tauri/tedi-cli/`) so Tauri 2's deb / dmg / nsis bundlers do not enumerate it when bundling the GUI install layout. Earlier attempts to gate the bin via `required-features` failed because the bundlers ignored the gate and then errored on the missing `target/release/tedi`. With the workspace split the Windows release step (`cargo build --release -p tedi-cli`) is the only invocation that touches the launcher; POSIX builds never see it.
- **`tedi.cmd` NSIS shim removed.** v0.2.0..v0.2.19 wrote a batch shim that PATHEXT bypassed (because `.EXE` resolves before `.CMD`) and that handled `--help` / `--version` natively as a belt-and-suspenders. The new `tedi.exe` supersedes it entirely. `NSIS_HOOK_PREUNINSTALL` deletes both `tedi.exe` and any legacy `tedi.cmd` from older installs.

### Added

- **Extension manifest flag `contributes.panels[].compact: true`.** Tells the host's [`RightPanelToggleButtons`](src/modules/extensions/components/RightPanelToggleButtons.tsx) to render the auto-rendered status-bar toggle as a 24×24 icon-only square (no `title` text, no `<Kbd>` chip). `aria-label` still carries the panel title for accessibility and the tooltip still shows on hover; the icon comes from `panels[].icon` so the extension is responsible for shipping a recognisable badge. Used by [`tedi.terminal-screenshot 0.2.1`](https://github.com/IlhamriSKY/TEDI.terminal-screenshot) to keep the camera icon compact next to the AI sidebar toggle. Older TEDI builds reject the flag with a Zod strict-input error; this is fixed in 0.2.21.

### Other

- TypeScript: `tsconfig.json` `target` / `lib` bumped from ES2020 → ES2022 so `Error.cause` (used by the AI transport's correlation-id error path) type-checks. Vite + Tauri's WebView2 / WKWebView already runs modern Chromium / WebKit so emitting ES2022 is safe.

## [0.2.19] - 22-05-2026

### Changed

- **`tedi ext` ratatui TUI removed; interactive picker is back to `dialoguer`.** The v0.2.17 fullscreen dashboard could not reliably read keystrokes on Windows even with the v0.2.18 `tedi-cli.exe` console-companion workaround — alt-screen contention with the parent shell varied by terminal host. Reverted to inline output + arrow-key `dialoguer::Select` pickers, the same approach v0.2.13 shipped, extended so every subcommand whose target arg is omitted opens an interactive picker on a TTY:
  - `tedi ext` (no subcommand) → action menu
  - `tedi ext install` (no ref) → registry picker (or typed input as last item)
  - `tedi ext uninstall` / `enable` / `disable` (no id) → installed-list picker
  - All other subcommands behave exactly like v0.2.13
  - Non-TTY (CI, pipes) still prints the legacy plain table + a hint instead of stalling on the picker
- **Install pipeline keeps its granular progress reporting from v0.2.17.** `InstallProgress` trait and `install_from_bytes_with_progress` remain; the CLI now drives them with a single-line overwrite (`\r\x1b[2K`) so download MiB and extract file-counts update in place instead of scrolling. GUI install path still uses `NoopProgress` — unchanged.
- **`tedi-cli.exe` console-subsystem companion removed.** No longer needed once the alt-screen TUI is gone. `installer.nsh` reverted to the v0.2.16 shape, release workflow drops the dedicated `cargo build --bin tedi-cli` step. `windows_subsystem = "windows"` on the main binary is harmless for the dialoguer-based picker because it never enters raw mode — `AttachConsole` is enough for inline `println!` + arrow keys.

### Removed

- `src/modules/cli_ext_tui/` (and its seven sub-files), `src/bin/tedi-cli.rs`, the `delegate_cli_to_console_binary` plumbing in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs), and the `ratatui` / `crossterm` / `futures-util` Cargo dependencies. The TUI plus its console-companion added 1 800 lines and a second binary without delivering a working Windows experience.

## [0.2.18] - 22-05-2026

### Fixed

- **`tedi ext` TUI now actually responds to keyboard input on Windows.** v0.2.17 shipped the dashboard but `TEDI.exe` is built with `windows_subsystem = "windows"` (so a `tedi .` from Explorer doesn't pop a console window). PowerShell waits for the GUI binary to exit, but the binary has no console attached for stdin — `AttachConsole(ATTACH_PARENT_PROCESS)` re-establishes stdout (good enough for the v0.2.13 `println!`-only CLI) but does NOT cleanly hand crossterm's `EventStream` a stdin handle it can poll. Result: TUI rendered, keys did nothing. New `tedi-cli.exe` console-subsystem companion (built from [src-tauri/src/bin/tedi-cli.rs](src-tauri/src/bin/tedi-cli.rs)) takes over for `ext`, `--extension`, `--update`, `--version`, `--help` and owns stdin cleanly. `TEDI.exe` detects those argv shapes at the top of `lib::run` and re-execs the sibling with inherited stdio (`delegate_cli_to_console_binary` in [src-tauri/src/lib.rs](src-tauri/src/lib.rs)). The `tedi.cmd` NSIS shim has the same delegation as a belt-and-suspenders for `tedi.cmd ext` direct invocations. Bundled via `bundle.resources` in [tauri.windows.conf.json](src-tauri/tauri.windows.conf.json); the release workflow now runs `cargo build --release --bin tedi-cli` before `tauri-action` so the binary exists at bundle time.
- **Dropped `EnableMouseCapture` from the TUI setup.** Some Windows console hosts (legacy conhost, older Windows Terminal builds) interleave mouse-tracking escape sequences with arrow-key input in ways crossterm's `EventStream` parses inconsistently, swallowing navigation keypresses. Navigation is keyboard-only anyway, so the capture provided zero value and one real footgun. Restore path drops `DisableMouseCapture` to match.

### Notes

- macOS / Linux are unaffected by both fixes. The main `tedi` binary on those OSes inherits stdin natively (no subsystem split), so it runs the TUI directly without the console-companion hop. The `tedi-cli` bin still compiles cross-platform but is only bundled into the Windows installer.
- Older Windows installs (≤ v0.2.17) that auto-update to v0.2.18 will receive `tedi-cli.exe` next to `TEDI.exe` via the NSIS installer's normal file-overwrite step. No manual action required.

## [0.2.17] - 22-05-2026

### Added

- **Full TUI dashboard for `tedi ext` subcommands.** All extension management — install / list / installed / update / uninstall / enable / disable — now opens a single keyboard-driven `ratatui` dashboard on a TTY, replacing the v0.2.13 line-by-line `println!` + `dialoguer::Select` UX. Three tabs (Installed / Registry / Updates) switchable via `Tab` / `Shift-Tab` / `1` `2` `3` / `h` `l`. Vim-style nav (`j`/`k`, `g`/`G`, PageUp/Down), filter via `/` (case-insensitive substring on id + name + description), refresh current tab via `r`, help overlay via `?`. Modal stack for confirmations: install (editable text input + live progress gauge), uninstall (y/N), enable/disable (y/N), update one, update all (sequential with per-item progress + cumulative log). Each subcommand opens the dashboard with the relevant tab focused and the matching modal pre-filled — `tedi ext install owner/repo` pops the install modal with the ref already typed, `tedi ext uninstall <id>` opens the confirm modal once the installed list lands, `tedi ext update <id>` checks just that id, etc. New module [src-tauri/src/modules/cli_ext_tui/](src-tauri/src/modules/cli_ext_tui/) (mod / app / ui / events / actions / input / theme). Panic-safe terminal restore via a `Drop` guard so a crash never strands the user's shell in raw mode / alternate screen.
- **Granular install progress reporting.** New `InstallProgress` trait + `InstallPhase` enum in [src-tauri/src/modules/extensions/install.rs](src-tauri/src/modules/extensions/install.rs) lets callers observe `Downloading { bytes_done, bytes_total }` → `Verifying` → `Extracting` → `Finalizing` → `Done`, plus a per-file callback (`progress.file(index, total, path)`) for every entry the extractor writes. The TUI install modal renders a live gauge backed by these events; download phase shows MiB / total when content-length is known, extract phase shows `N / M files` with the current relative path. Existing `install_from_bytes` is kept as a thin wrapper over `install_from_bytes_with_progress` with a `NoopProgress` impl, so the GUI install path in [extensions/commands.rs:303](src-tauri/src/modules/extensions/commands.rs#L303) (`ext_install_from_zip`, `ext_install_from_github`) is byte-for-byte unchanged.
- **Streaming HTTP download with progress callback.** [`http_get_bytes_with_progress`](src-tauri/src/modules/extensions/commands.rs) (sibling to the existing `http_get_bytes`) accumulates `reqwest::Response::chunk()` reads and fires a `FnMut(bytes_done, bytes_total)` closure on every chunk, with one initial `(0, total)` tick before the first byte lands so the TUI can render a meaningful "0 / N" before transfer begins. Same caps + timeouts as the non-streaming version (50 MiB hard cap, 15 s connect, 5 min total). Old `http_get_bytes` reduced to a one-line wrapper that passes a no-op closure, so every other caller in the extension pipeline is unchanged.
- **`--plain` / `-p` flag on `tedi ext`.** Forces the legacy text output (v0.2.13 shape) even when stdout is a terminal. Useful when the user wants pipe-friendly output without redirecting (`tedi ext installed --plain | grep on`). Non-TTY auto-fallback still works the same — pipes, redirected stdout, and CI shells get the plain printer without needing the flag.

### Changed

- **`tedi ext list` interactive picker replaced by the TUI Registry tab.** The v0.2.13 `dialoguer::Select` arrow-key picker is gone (and the `dialoguer` crate dropped from `Cargo.toml`). TTY users land in the Registry tab and press `Enter` / `i` to install; non-TTY / `--plain` users get the OFFICIAL / UNOFFICIAL table dump + install hint that v0.2.13 already printed alongside the picker. No change to the install plumbing beneath either path.
- **`cli_ext.rs` refactored into data fns + plain-mode printers.** The seven legacy `cmd_*` subcommand handlers no longer interleave logic with `println!`; pure-data fns (`load_installed_rows`, `check_updates_only`, `install_reference_with_progress`, `do_uninstall`, `do_set_enabled`, `install_github`) are now `pub(crate)` and consumed by both the plain printers and the TUI. New `InitialFocus` enum maps each subcommand + argv shape to the right TUI screen on launch.
- **Top-level `tedi --help` mentions the TUI + `--plain` flag** so the dashboard is discoverable from the entry point.

### Fixed

- **`InstallOutcome` derives `Debug`** so it can travel through the TUI's channel-backed message bus (`AppMsg::InstallDone(Box<Result<InstallOutcome, String>>)`). GUI code never logged it, so this was a no-op for existing call sites. Boxed inside `AppMsg` to keep the enum's largest variant from dominating channel-slot size for every other (tiny) variant — caught by `clippy::large_enum_variant`.

## [0.2.16] - 22-05-2026

### Added

- **Sort dropdown in the file explorer header.** New radio menu (`Sorting02Icon` button next to *Collapse folders*) with five options: Default (Rust-side folders-first + A→Z, the previous behavior), Name A→Z, Name Z→A, Modified newest first, Modified oldest first. The "modified" modes mix folders and files by `mtime` (Finder-style); the "name" modes preserve folders-first. Sort is applied client-side on the already-fetched listing — switching modes does not refetch, expansion state survives, and the trigger icon turns from `text-muted-foreground` to `text-foreground` when a non-default sort is active so the user can see at a glance that the listing is reordered. Selection persists across sessions via `localStorage` under `tedi:explorer:sortMode`. The sort applies to every `FileExplorer` mount, including the secondary folder-tree extension. See [src/modules/explorer/lib/useFileTree.ts](src/modules/explorer/lib/useFileTree.ts) (`sortEntries`, `SortMode`) and [src/modules/explorer/FileExplorer.tsx](src/modules/explorer/FileExplorer.tsx) for the trigger.
- **Active-file reveal in the main file tree.** Opening a file (editor tab, AI-proposed diff, or git diff) now expands every ancestor folder, selects the row, and scrolls it into view in the left explorer — the same affordance VS Code exposes as "Reveal in Explorer". New `activeFilePath` prop on `FileExplorer`; `App.tsx` derives it from the active tab and covers all three tab kinds (`editor` leaf, `ai-diff`, `git-diff`). SSH editor leaves are excluded (their `path` is remote and wouldn't match the local explorer root). The status-bar breadcrumb now also follows diff tabs because it consumes the same memo.

### Changed

- **`mountFolderTree` reset button uses a distinct icon.** The "Back to workspace folder" affordance (visible only after the user manually picks a folder via Open Folder) was rendered with `Cancel01Icon` and destructive hover styling, making it visually indistinguishable from the adjacent "Close panel" X. Reset now uses `Home02Icon` with the neutral `hover:text-foreground` style; Close keeps `Cancel01Icon` with destructive hover. Tooltips and aria-labels updated to match. See [src/modules/extensions/components/mountFolderTree.tsx](src/modules/extensions/components/mountFolderTree.tsx).
- **Source Control panel separator renders consistently.** The thin divider below the panel header now shows regardless of whether the current workspace is a git repo, so the empty / "no repo" state has the same chrome as the populated one instead of collapsing into a denser layout.

### Fixed

- **Files at the workspace root level now reveal correctly.** The first cut of the reveal effect treated `ancestors.length === 0` as "file outside the workspace" and zeroed out the target, which silently skipped any file sitting directly under the root (e.g. `README.md` at `D:/proj/`). Restructured the guard so `isUnderRoot` is checked explicitly, then `ancestors=[]` only means "no expansion needed" and the reveal still fires.
- **Auto-reveal survives a collapsed-explorer round trip.** While the left explorer is collapsed, its body and `listRef` are unmounted, so the very first `scrollIntoView` after activating a file had nothing to scroll. The reveal effect now also depends on `collapsed`: it short-circuits while collapsed and re-runs when the user uncollapses, so the file lands in view as soon as the panel reopens.
- **Reveal selection no longer raced the stale-selection cleanup.** The existing `selectedPath` cleanup effect cleared the highlight before the lazy `fs_read_dir` fetches for ancestor folders could land — so even when the row eventually appeared in `flat`, it wasn't selected. Selection is now deferred to a second effect that runs after the row is observed in `flat`, so the highlight only sets once it can stay.

## [0.2.15] - 22-05-2026

### Added

- **Right-panel extension hook system.** New generic surface for extension-contributed panels that slide in from the right of the workspace, mutual-exclusive with the AI sidebar. Three contribution-registry consumers wired today (`panels` with `surface: "right"`, `commands`, `keybindings`) plus matching host-API additions: `ctx.registerPanelRenderer(panelId, fn)`, `ctx.panel.{open,close,toggle}(panelId)`, and `ctx.ui.mountFolderTree(container, opts)` that embeds TEDI's built-in `FileExplorer` so extensions get pixel-identical icons / indent / expand-collapse / click-to-open without reimplementing the tree. Manifest gains `panels[].toggleCommand`, `panels[].defaultOpen`, `panels[].hideHostHeader`. New components in [src/modules/extensions/components/](src/modules/extensions/components/): `RightPanelHost` mounts the active renderer, `RightPanelToggleButtons` auto-generates a status-bar pill per panel that visually matches `AiOpenButton` (height, motion drop-in, hover accent, `<Kbd>` chip showing the bound shortcut). Reference: [IlhamriSKY/TEDI.secondary-folder-tree](https://github.com/IlhamriSKY/TEDI.secondary-folder-tree). The codebase ships zero secondary-folder-tree code — every facility is generic and any extension can use it.
- **Extension keybindings + commands now dispatched.** Previously declared but unwired. New [`useExtensionShortcuts`](src/modules/shortcuts/lib/useExtensionShortcuts.ts) hook walks `keybindingsRegistry` + `commandsRegistry` on every keydown, fires the matching runtime handler bound via `ctx.registerCommandHandler`. User overrides land in `preferences.extensionShortcuts` and rebind from a new **Extensions** group in Settings → Shortcuts that auto-renders one row per contributed binding (record / clear / reset all generic). Stored shortcuts persist via the existing `tauri-plugin-store` flow.
- **Extension workspace bridge.** New [`extensionWorkspaceBridge`](src/modules/extensions/workspaceBridge.ts) populated by `App.tsx` with the live `handleOpenFile` so `ctx.ui.mountFolderTree` routes click-to-open through the same path the left-side explorer uses (editor tab). Narrow surface on purpose — adding a field widens what every extension can reach.
- **Drag a file from the explorer onto a terminal pane → shell-quoted path appears at the prompt.** Works from the built-in left sidebar AND from any extension panel that mounts `FileExplorer` via `ctx.ui.mountFolderTree`. Cross-platform via the existing `quoteForShell`: PowerShell / cmd double-quote on Windows, POSIX single-quote close-escape-open on macOS / Linux. New `ensureFsDragListener` in [useTerminalFileDrop.ts](src-tauri/../src/modules/terminal/lib/useTerminalFileDrop.ts) synthesizes drag gestures from `mousedown` / `mousemove` (5 px threshold) / `mouseup` rather than HTML5 drag-drop, because Tauri's default `dragDropEnabled: true` installs an OS-level intercept that consumes drag events before the WebView can preventDefault on them — HTML5 drag inside the WebView produced the "not allowed" cursor on every drop zone. Mouse events are not part of the intercept surface, so they fire reliably on all three desktop WebViews (WebView2, WKWebView, WebKitGTK). Visual feedback: body cursor flips to `copy`, the terminal pane under the cursor gets a `--ring`-colored outline. Cancellation via `Escape`, window blur, or releasing outside a terminal. Right-button mouseup mid-gesture no longer commits prematurely; missed mouseup off-window auto-recovers on the next mousedown.
- **`FileExplorer` becomes embeddable.** New optional props `headerExtras?: ReactNode`, `hideCreateActions?: boolean`, `hideGrep?: boolean` let consumers reuse the component with a compact toolbar — `ctx.ui.mountFolderTree` injects an Open Folder picker + reset + close icons into `headerExtras` and hides the New file / New folder buttons. The left-sidebar call site is unchanged because all three props default to off.

### Changed

- **Settings webview now seeds extension registries.** `SettingsApp` calls `useExtensionsStore.getState().init()` once at mount so the new Extensions row in *Settings → Shortcuts* sees every installed extension's `keybindings` / `commands`. Previously the Settings tab was the only window that didn't call init, which made the new shortcut group render empty for users browsing the Settings tab without ever opening the Extensions tab.
- **`mountFolderTree` mounts a fresh React root.** Uses `createRoot` into the extension's panel container with `TooltipProvider` re-wrapped at the inner root (React context doesn't cross root boundaries). `ThemeProvider` is intentionally NOT re-wrapped — next-themes manages a class on `document.documentElement` that cascades naturally; two providers would fight over the same class. Disposer is auto-tracked by the host so extensions that forget to wire cleanup don't leak a React root past deactivate.
- **Documentation rewrites across the Rust backend.** Roughly 170 files had their doc-comments tightened — same behavior, shorter prose, fewer parenthetical asides. No functional change.

### Reference

- [Secondary Folder Tree](https://github.com/IlhamriSKY/TEDI.secondary-folder-tree) — first extension to exercise every right-panel hook (panel surface, command + keybinding contributions, `ctx.panel`, `ctx.ui.mountFolderTree`, workspace bridge). The example handles a missing host backend gracefully — `activate()` probes `ctx.ui.mountFolderTree`, `ctx.panel.toggle`, `ctx.registerPanelRenderer` before using them and stays idle (with one warning toast) when run against an older TEDI build, mirroring the Discord reference's graceful-degradation pattern.

## [0.2.14] - 21-05-2026

### Fixed

- **Auto-update no longer wipes app data (history + settings).** The Windows NSIS installer now snapshots `%APPDATA%\id.ilhamrisky.tedi\` to `%TEMP%\tedi-userdata-backup` in `NSIS_HOOK_PREINSTALL`, then restores from the snapshot in `NSIS_HOOK_POSTINSTALL` when key files (`tedi-settings.json` or `tedi-sessions.json`) are missing post-install. Defensive against Tauri NSIS template variants that wipe app data on `passive`-mode upgrades — the data dir lives outside `$INSTDIR` so the current template shouldn't normally touch it, but auto-update calls whichever uninstaller is already on disk, which may belong to a buggier prior build. Belt-and-suspenders: backup runs only when the data dir already exists (no-op on fresh install) and restore only triggers when the gate files are missing (no-op on a clean overwrite). Uses `xcopy /E /I /Y /H /K /Q` for both legs.

### Added

- **Status-bar AI context indicator.** The context-usage ring moves out of the AI composer's bottom toolbar and into the status bar's right cluster, between `ZoomIndicator` and `UpdaterPill`. New [`StatusBarContextIndicator`](src/modules/ai/components/StatusBarContextIndicator.tsx) mounts `useChat` against the active session so the ring stays live; multiple `useChat` calls on the same `Chat` instance stay in sync via the SDK's internal store. Only renders when the AI panel is open and a session exists — bar stays empty for users who don't touch AI. The numeric percentage is hidden via a `[&_button>span:first-child]:hidden` selector against the upstream `ContextTrigger` (no edit to `ai-elements/`); the hovercard still surfaces the full breakdown (model, used / window tokens, session input/output/cached) on hover.
- **Download progress in the status-bar updater pill.** `UpdaterPill` previously showed only `"Update"` while downloading; the percentage was tucked into the tooltip. Pill label now inlines `Updating <pct>%` (or bytes when `contentLength` is unknown), giving live feedback at a glance while the bundle streams.

### Changed

- **Fallback AI context window bumped from 128k to 256k.** `getModelContextLimit` returned `128_000` for any model not listed in `MODEL_CONTEXT_LIMITS`, which fired the auto-compact toast prematurely on runtime-detected models that ship larger windows. Bumped the default to `256_000` and pinned the value behind a named `FALLBACK_CONTEXT_LIMIT` constant so the rationale lives next to the literal. Models with a known hard cap (e.g. `gpt-oss-120b`, `openai/gpt-oss-20b`) stay accurate via their explicit `128_000` entry — they really are capped at 128k upstream, so doubling them would just delay the compaction trigger past the API's actual ceiling.
- **AI composer toolbar de-cluttered.** With the context ring moved to the status bar, the composer's bottom toolbar drops to just `AgentSwitcher` + `AiStatusBarControls`. `AiInputBar` still accepts the `messages` prop because the shell-style ArrowUp/Down recall in `useMentionSearch`-adjacent code reads it; the only removal is the `<ContextIndicator>` mount.

## [0.2.13] - 21-05-2026

### Added

- **`tedi ext` extension CLI.** Headless companion to Settings → Extensions. Lives in [src-tauri/src/modules/cli_ext.rs](src-tauri/src/modules/cli_ext.rs) and short-circuits out of `lib::run` before Tauri boots, so install / list / update / uninstall happen against the same `<app_data_dir>/extensions/` directory and `state.json` the GUI manages, then `process::exit`s. Both forms are accepted: `tedi ext <subcmd>` and `tedi --extension <subcmd>` (alias). Subcommands:
  - `install <REF>` — three-way classifier: existing file → install via `install_from_bytes` (source `local:<path>`); `owner/repo` or GitHub URL → fetch `releases/latest`, pick the `.zip` asset (or `zipball_url` fallback), install (source `github:<o/r>`); otherwise resolve as a registry id against `https://tedi.ilhamriski.com/extensions/`. Path-shaped inputs that don't resolve short-circuit with a targeted error instead of burning a registry round-trip.
  - `list` — fetches the public registry. On a TTY, opens an arrow-key `dialoguer::Select` picker; non-TTY (CI / pipes) prints the OFFICIAL / UNOFFICIAL groups and an `install <id>` hint.
  - `list --installed` / `installed` — walks the extensions root + state, prints `[on]/[off] <name> (id) v<X>` plus an "→ vY available" hint when `latest_version` is newer than the installed `version`.
  - `update [<ID>]` — checks every `github:`-sourced install (filtered to `<ID>` when given) against `releases/latest`, persists `latest_version` + `last_checked_at_ms`, then prompts `(y/N)` before applying. EOF-safe and non-TTY-safe: closed stdin treated as "skip", CI shells get a "run on a TTY or use `tedi ext install <id>`" hint with the per-id apply commands.
  - `uninstall <ID>` — refuses with "extension not installed" when neither the directory nor the state entry exists (stricter than the GUI's silent-success path so a typo doesn't print "Uninstalled" misleadingly).
  - `enable <ID>` / `disable <ID>` — flip the `enabled` flag on the existing state entry, error out on unknown id.
- **Windows installer shim passes `ext` and `--update` through synchronously.** `tedi.cmd` previously detached every non-version/help arg through `start ""` so the GUI launch wouldn't pin the shell. The shim now special-cases `ext`, `--extension`, `--update`, and `-u` to invoke `TEDI.exe` synchronously, so when the .cmd path is reached explicitly the user's terminal actually sees CLI stdout. The .exe path (which PATHEXT resolves first in cmd/PowerShell) was already correct via `AttachConsole`.
- **Headless `tedi --update` / `-u` on all three desktop OSes.** Sibling pattern to `tedi ext`: short-circuits out of `lib::run` before Tauri boots, so the GUI never opens. New module [src-tauri/src/modules/cli_update.rs](src-tauri/src/modules/cli_update.rs). Flow: fetch `latest.json` from the configured updater endpoint, compare versions, prompt `(y/N)` on a TTY (auto-accept on non-interactive shells), download the bundle for the current platform key (`<os>-<arch>`), verify its minisign signature against the pubkey baked into `tauri.conf.json` via [`minisign-verify`](https://crates.io/crates/minisign-verify) — the same crate `tauri-plugin-updater` uses internally — then install in place. Per-platform install:
  - **Windows**: spawn the NSIS installer with `/PASSIVE /UPDATE`. NSIS holds no handles on the running EXE, so it replaces `TEDI.exe` cleanly.
  - **Linux**: AppImage in-place swap via `$APPIMAGE`. `.deb`/`.rpm` installs need root + the system package manager — surface a clear `apt`/`dnf` hint instead of pretending to update.
  - **macOS**: extract the `.app.tar.gz` via system `tar -xzf`, rename the running `.app` to `<name>.app.old`, `mv` the new bundle into place. Rollback on failure leaves the old `.app` back where it was so the user is never stranded without TEDI.

  Pubkey format: Tauri config embeds both pubkey and per-platform signature as base64-wrapped minisign file-format text — `verify_signature` unwraps the outer base64 on each side before handing the inner text to `minisign-verify::PublicKey::decode` / `Signature::decode`. The test `pubkey_constant_decodes` enforces the embedded constant round-trips so a future edit can't silently break verification on every release.
- **Compaction pulse badge in the AI mini-window.** A brief 6-second tone-coded badge appears next to the context indicator every time the auto-compactor (or manual `/compact`) runs, surfacing even Stage 1 (lossless dedup) passes so the user can literally see every compaction. The popover gains a new "last compact" line with relative age (`5s ago`, `2m ago`) and per-stage breakdown (`dropped N · elided N · dedup`). Toast surfacing is unchanged — still only fires for Stage 2 (elision) and Stage 3 (drop) with the same per-session throttle.

### Changed

- **Extension HTTP helpers gain connect + total timeouts.** `extensions::commands::http_get_text` (small JSON, 15 s connect + 30 s total) and `http_get_bytes` (asset download, 15 s connect + 300 s total) now build their `reqwest::Client` with explicit caps so an unreachable host fails in 15 s and a stalled mid-stream download can't hang the install pipeline indefinitely. Applies to both the GUI install / update flow and the new `tedi ext` CLI.
- **Promoted extension helpers to `pub(crate)`.** `normalize_owner_repo`, `pick_release_zip`, `pick_release_tag`, `compare_versions`, `strip_v_prefix`, `http_get_text`, `http_get_bytes` are now crate-visible so `cli_ext.rs` shares the install pipeline instead of forking it. `cli::attach_parent_console` is also `pub(crate)` for the same reason — the CLI prints through the same console-attach path the version/help short-circuit uses on Windows.

### Fixed

- **Manual `/compact` now stamps `lastCompact` like auto-compact.** Previously the in-header pulse badge only fired on auto-compaction passes; running `/compact` via the slash menu skipped the indicator, making the user think the manual command "didn't run." Slash command now classifies the drop as Stage 3 and patches `agentMeta.lastCompact` the same way the per-turn compactor does, so the badge fires consistently across both paths.

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
