# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.1.5] - 2026-05-14

### Added
- **OpenAI-Compatible provider** for any third-party endpoint that speaks the OpenAI API (custom base URL + API key, `/models` auto-detect, "Test endpoint" ping in Settings -> Models). The new provider shows up in the chat dropdown and autocomplete alongside the built-ins.
- **Built-in agent overrides:** the four built-in agents are now editable. Edits are saved as overrides (badged "Edited") and a Reset button restores the default - no fork required.
- **Pinned models** in the chat dropdown: pin any model to a top "Pinned" section across providers; persisted as `pinnedModelIds`.
- **Collapsible provider groups** in the model dropdown with model counts; collapsed sections auto-expand while a search query is active.
- **Open-file suggestion chips** above the AI input bar: every editor leaf shows up as a one-click "attach" chip (dashed border) and disappears once attached.
- **Shell-style history navigation** in the AI input: ArrowUp/ArrowDown cycle through previously sent user messages with full chip recall (files, selections, snippet handles); Esc restores the draft.
- **"Move to group" tab action:** per-leaf dropdown grafts a tab into another tab as a split, preserving the live PTY/editor session. Toasts when the target is full or already has an editor.
- **"Toggle Split Orientation" tab action:** rotates only the split that directly contains the clicked leaf (row <-> col), leaving sibling splits alone; a `normalizePaneTree` helper canonicalises the tree so successive toggles round-trip cleanly.
- **User-message attachment chips in chat history:** sent files, terminal/editor selections (with line counts), and snippet handles re-render as chips with proper file icons.
- **Linux manual updater flow:** the Updater Pill and About section list the latest GitHub release with copy-ready install commands for Arch (`yay -S terax-bin`), Debian/Ubuntu (`apt install ./TEDI_*.deb`), and Fedora/RHEL (`dnf install ./TEDI-*.rpm`), plus a "Download package" button.
- **Subfolder breadcrumb dropdowns:** clicking the chevron next to any breadcrumb segment lists its immediate subdirectories via the Tauri `list_subdirs` invoke; picking one cds in-place.
- **OS badge** in the status bar (Windows / macOS / Linux) anchoring the breadcrumb row.
- **Toast system** (`Toaster` + `toast()`) with default / warning / error variants, anchored top-right above panes and dialogs.
- **Shift-Enter in terminal** now sends the meta `ESC + \r` sequence so shells that support multi-line entry (Claude Code, Codex, fish) get a real newline instead of a submit.
- **Git status auto-refresh:** Source Control polls every 2.5s while the window is visible/focused, pausing on blur, with in-flight de-duping.
- **TEDI.md project memory:** the transport reads `TEDI.md` at the workspace root (capped at 32 KB, 30s cache) and appends it verbatim to the system prompt.

### Changed
- **Chat code-block renderer rewritten** from Shiki (~600-line `code-block.tsx`) to a Lezer + CodeMirror-stream-modes pipeline (`chat-code.tsx` + `chat-code-lezer.ts` + `code-highlight.css`). Lezer parsers cover JS/TS/JSX/TSX/Rust/Go/Python/JSON/HTML/CSS/Markdown/PHP; legacy stream modes handle C/C++/Java/C#/Kotlin/Scala/ObjC/Dart/YAML/TOML/Ruby/Swift/Lua/Haskell/Perl/R/Dockerfile/nginx/diff. Each grammar is lazy-imported; tokens are themed via `tok-*` CSS variables with full light/dark splits.
- **Shell code blocks** now render as a "command card" with a `$`/`PS>`/`>` prompt prefix and a "Run in active terminal" button that injects the command into the active PTY via `injectIntoActivePty`.
- **Streaming code blocks** show a "Generating ${lang}..." shimmer placeholder instead of partial syntax - quiet UI while the model is mid-fence.
- **AI agent pipeline rewritten** around `streamText` + `convertToModelMessages`, replacing the `Experimental_Agent` + `DirectChatTransport` wrapper. The system prompt is now byte-stable across turns (no dynamic context inside it), unlocking prompt caching on every provider; Anthropic gets an explicit `cacheControl: ephemeral` breakpoint on the system message.
- **Two-stage context compaction** (`compactModelMessagesDetailed`): at 55% of the model context limit, superseded `read_file` results are elided; at 70%, older `tool-result` blocks are elided oldest-first (keeping the last 24 messages intact) until usage drops back below 60%.
- **Auto-injected terminal scrollback is gone.** The per-turn context block shrunk from `<terminal-context>` (workspace + cwd + 300 lines of scrollback) to a compact `<env>` block (workspace + cwd + active file). Legacy `<terminal-context>` is still stripped from rendered history.
- **System prompt rewritten** in a "do, don't narrate" tone with explicit sections for tool budget, editing, path resolution, shell, dev-server reuse, approval, and style; ~40 lines shorter and noticeably more directive.
- **CodeMirror themes lazy-loaded** per `editor-theme-*` package (~100 KB shaved from the eager editor bundle) with a memo cache shared across `EditorPane`, `AiDiffPane`, and `GitDiffPane`.
- **Vite chunking:** CodeMirror language grammars, legacy stream modes, and `@uiw/codemirror-theme-*` packages are auto-split for lazy loading instead of being lumped into the eager `codemirror` chunk.
- **Status-bar breadcrumb click** changes the workspace root (persisted in `localStorage` as `tedi.workspaceRoot`), optimistically updates the leaf cwd, and only cds the active terminal as a secondary effect - explorer, AI context, and new tabs all follow.
- **Tab strip restyled:** inactive tabs sit on a dimmer `--muted/30` surface, active tabs are semibold with a 2.5px primary top accent, and trailing icons (move-to-group, rotate-split, close) cluster with tooltips.
- **Header window-drag:** explicit `startDragging()` mousedown fallback works around WebView2 flakiness with the auto-detection in regions nested inside Radix + dnd-kit. Double-click toggles maximise.
- **AI input file chips** swap the file-extension pill for `fileIconUrl` icons (matches the explorer/message history); editor selections show line counts.
- **Agents grid + provider grid** in Settings are always 2 columns now (no breakpoint), reflowing more predictably in the settings window.
- **`openai-compatible`** keyring slot and `openaiCompatibleBaseURL` preference key added; default base URL is `https://api.openai.com/v1`.
- **Inline `code` block deduped:** the markdown-component override delegates fenced blocks to `ChatCodeBlock` and keeps inline code as the existing pill.

### Removed
- `src/components/ai-elements/code-block.tsx` (622 lines) - replaced by `chat-code.tsx` + `chat-code-lezer.ts`.
- `shiki` and the `pnpm.overrides.shiki` pin from `package.json`; `@streamdown/math` was dropped (math rendering removed from chat output).
- `streamdownPlugins` (math plugin) registration in `MessageResponse`.
- Auto-injected `recent_terminal_output` block on every turn (the agent now asks the user to paste output when it needs it).

### Fixed
- `tool.tsx` no longer feeds tool input/output through the heavy code-block path - JSON is rendered as plain monospace, sidestepping a stale Shiki dependency and shaving a parser hop per tool call.
- `usePreferences` subscriptions for AgentsSection now react to either `builtinOverrides` or `customAgents` changing (was deriving from a single snapshot, missed cross-tab updates).
- `BlockChrome`/`CommandCard` `Run` button only fires when an active PTY is present; resets to "Run" after 1.5s instead of staying stuck on "Sent".
- Header drag region no longer eats clicks on buttons/tabs/menu items thanks to the explicit `INTERACTIVE_SELECTOR` guard.

## [0.1.4] - 2026-05-13

### Fixed
- **Ask TEDI** popup now anchors to the actual selection rectangle (top-center) instead of where the mouseup landed, so it consistently appears just above the highlighted text. Falls back to the mouse coordinate when the DOM/xterm selection rect can't be measured.
- The popup only triggers when the mouseup lands inside a terminal/editor pane (`[data-pane-leaf]`), preventing it from popping in the status bar, tab strip, or sidebar after a stale xterm selection.

### Changed
- **Ask TEDI** button restyled: pill (`rounded-full`), AI-magic icon prefix, semibold label tracking, smaller shadow and faster transition. Width 156 to 168, height locked at 34, gap above selection 10px.
- Per-platform bundle scope: Windows now only emits NSIS (`.exe`) - MSI dropped - using LZMA compression to slim the installer. Linux builds remain `deb`/`rpm`/`appimage`. `bundle.targets` in the shared `tauri.conf.json` removed in favor of per-platform overrides in `tauri.linux.conf.json` / `tauri.windows.conf.json`.
- Release profile: `strip = "symbols"` (was `true`) - explicit about what's stripped.
- SSH event pump: pattern-match `ChannelMsg::ExtendedData { ext: 1, .. }` directly instead of an `if ext == 1` guard (clippy-clean).
- `public/icon.png`: re-exported smaller (852 KB to 22 KB) for faster initial paint of the About panel.

## [0.1.3] - 2026-05-13

### Fixed
- Workspaces: switching to another workspace no longer kills running PTYs. The previous workspace's terminal leaves are now cached in-memory; the dispose effect treats cached leaves as still-live, so the same xterm sessions are re-attached when you switch back. Closing a workspace still tears its sessions down.

### Changed
- Status-bar **Update** pill: solid primary fill (was outline) for higher contrast against the status bar.
- **Ask TEDI** floating button (text selection): solid primary fill, rounded corners, shadow + ring, dedicated `Kbd` chip for the shortcut. Width bumped 110→156px so the shortcut isn't truncated.

## [0.1.2] - 2026-05-13

### Changed
- Status-bar update pill: removed `max-w-32` clamp so the "Update available" label is not truncated on wide status bars.
- OSC 8889 (`tedi_open`) spawn-tab parser now accepts a `split=row|col` field so shells can request a split-pane spawn instead of a new tab.

## [0.1.1] - 2026-05-13

First update delivered over the signed auto-update channel - used to verify the end-to-end signed-update flow on real installs.

### Changed
- Polish across AI surfaces (chat, mini window, status-bar controls, agents, transport, todos), settings (general, models, store), explorer (file tree, search, constants), tabs, editor language resolver, status bar, App.tsx, contributing notes, `.gitignore`, and `globals.css`.

## [0.1.0] - 2026-05-13

Initial release under the **TEDI** (Terminal Environment & Development Infrastructure) name. Versioning restarts from `0.1.0` because TEDI tracks its own roadmap independently of upstream Terax.

### Added
- Workspaces with persisted tab layouts and switcher in the sidebar.
- Tab grouping and drag-to-reorder.
- Terminal and editor split panes (mix and match per tab).
- Spawn a new terminal tab from inside an existing shell instead of an external window (OSC 8889, `tedi_open`).
- Inline image preview.
- Side-by-side Markdown preview.
- "Open folder" workspace picker in the header.
- Code-editor visual refresh.
- Signed auto-updater (`tauri-plugin-updater`): checks GitHub Releases every 6 hours, offers in-app install + relaunch. First install is still manual.
- Settings → About: "Check for updates" button for manual polling.

### Changed
- AI tool-routing, sub-agents, snippets, and plan-mode flow polished.
- Project memory file renamed to `TEDI.md`.
- Identity rebranded from CMDAN to TEDI (bundle id `id.ilhamrisky.tedi`, crate `tedi`, keychain service `tedi`, store files `tedi-*.json`).
