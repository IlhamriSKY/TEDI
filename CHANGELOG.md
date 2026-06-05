# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.3.25] - 05-06-2026

### Fixed

- **OpenAI-compatible endpoints reached over a tunnel or self-hosted gateway (e.g. 9Router via a Tailscale / API tunnel) no longer fail with "Detection failed · Failed to fetch", and their models now work in chat.** Detection and the chat client used the WebView's native `fetch`, which enforces CORS: a cross-origin gateway that does not return an `Access-Control-Allow-Origin` header was blocked before any response could be read - while the **Test** button worked because it goes through Rust/reqwest, which is not subject to browser CORS. A native-first `corsFallbackFetch` now tries the WebView fetch first (so CORS-friendly cloud gateways keep the fast path with zero change) and only on a `Failed to fetch` routes the request through a new Rust streaming HTTP proxy (`http_stream` / `http_abort`, reqwest), which streams the SSE response back over an IPC channel so chat keeps its token-by-token rendering. No new dependencies ([`net.rs`](src-tauri/src/modules/net.rs), [`lib.rs`](src-tauri/src/lib.rs), [`httpProxy.ts`](src/modules/ai/lib/httpProxy.ts), [`openaiCompatible.ts`](src/modules/ai/lib/openaiCompatible.ts), [`agent.ts`](src/modules/ai/lib/agent.ts)).
- **Dragging a tab or pane no longer shows the browser's native favicon thumbnail.** Icons rendered as `<img>` (site favicons, file-type glyphs) are draggable by default in the webview, so grabbing a tab/pane over one hijacked the pointer drag and showed an ugly native image ghost instead of the app's own drag preview. Native image-drag is now disabled app-wide ([`globals.css`](src/styles/globals.css), [`LeafIcon.tsx`](src/components/LeafIcon.tsx), [`PreviewFavicon.tsx`](src/modules/preview/PreviewFavicon.tsx)).

### Changed

- **The tab strip, pane header, and drag preview now show the exact same icon for a leaf.** A shared `LeafIcon` renders the editor file-type icon, browser favicon, local-terminal / SSH-cloud glyph, and the private lock identically across all three surfaces, instead of the pane header and drag ghost falling back to a generic pencil for editor leaves ([`LeafIcon.tsx`](src/components/LeafIcon.tsx), [`EntryIcon.tsx`](src/modules/tabs/components/EntryIcon.tsx), [`PaneTreeView.tsx`](src/modules/panes/PaneTreeView.tsx)).
- **The drag preview chip was tidied and unified.** Tab and pane drag ghosts share one crisp, solid, squared chip; the pane drag ghost is a fixed 1:1 (28x28) box with the leaf icon centered ([`DragChip.tsx`](src/components/DragChip.tsx), [`PaneTreeView.tsx`](src/modules/panes/PaneTreeView.tsx)).

## [0.3.24] - 05-06-2026

### Fixed

- **Unicode / IME input in the terminal (Vietnamese, and other scripts whose input methods emit decomposed text) no longer renders incorrectly.** Composed input that arrives as a base letter plus a separate combining mark (NFD form) was handed to xterm's WebGL renderer as a multi-codepoint cell, which takes a fragile combined-glyph path (`canvas.fillText` + bounding-box scan, with no DOM fallback) that can drop or mis-stack the mark - so e.g. Vietnamese tone marks displayed wrong. The terminal now NFC-normalizes the single `onData` chunk that immediately follows an IME `compositionend`, collapsing the text onto xterm's robust single-glyph path. Pasted text and ordinary keystrokes - including macOS NFD filenames - reach the shell byte-for-byte unchanged. This is not a Unicode-version issue: the combining marks are already zero-width in xterm's default tables, so `addon-unicode11` is intentionally not added ([`useTerminalSession.ts`](src/modules/terminal/lib/useTerminalSession.ts), [`sessionState.ts`](src/modules/terminal/lib/sessionState.ts)). Resolves [#3](https://github.com/IlhamriSKY/TEDI/issues/3).
- **The `tedi .` CLI tab no longer gets clobbered by workspace restore at launch.** Opening TEDI from the CLI in a folder drained its target tab through a fast in-memory IPC that landed before the disk-backed workspace restore, so the restore then replaced the CLI tab with the previously-saved folder. The CLI-startup drain now waits for workspace hydration, so the restore runs first and the CLI tab is appended on top and keeps focus. Hydration was hardened too: a corrupt or unreadable workspace store now still flips `hydrated` true (seeding a default) instead of stranding every consumer that gates on it ([`useWorkspaceRoot.ts`](src/app/hooks/useWorkspaceRoot.ts), [`store.ts`](src/modules/workspaces/store.ts)).
- **Background update checks no longer flash a red "Update check failed" pill when GitHub is unreachable.** The unattended first-run and 6-hourly sweeps now run silently: they skip the "checking" panel and, on failure, leave the current state untouched, so only an explicit check (`tedi --update`, the trigger event, or the dialog's Retry) surfaces an error. The updater dialog also stays mounted across state changes instead of unmounting with the pill, fixing a Radix scroll-lock race that could leave `pointer-events: none` stuck on the body and make the modal unclickable ([`useUpdater.ts`](src/modules/updater/lib/useUpdater.ts), [`UpdaterPill.tsx`](src/modules/updater/components/UpdaterPill.tsx)).

## [0.3.23] - 04-06-2026

### Fixed

- **The browser / preview pane no longer renders blank on Windows.** The embedded browser webview passed its own WebView2 `additionalBrowserArgs`, different from the main window's; on Windows an additional webview whose browser args differ from the main webview's renders permanently blank ([tauri-apps/tauri#13092](https://github.com/tauri-apps/tauri/issues/13092)) - the pane chrome (address bar) showed but the page never appeared. The flags that keep a preview processing while TEDI is minimized are now applied process-wide through the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable, so the main window and every embedded preview share identical args and the page renders ([`embed.rs`](src-tauri/src/modules/preview/embed.rs), [`lib.rs`](src-tauri/src/lib.rs)).

## [0.3.22] - 04-06-2026

Hardening pass: fixed potential bugs, crashes, and memory/resource leaks surfaced by a full-codebase audit (frontend + Rust backend). No intended behavior changes on the happy path; all static checks pass (`tsc`, `cargo check --all-targets`, `clippy`, import lint).

### Fixed

- **Browser / preview pane no longer goes permanently blank after switching workspaces and back.** Whether to destroy a preview's native webview was decided from the active workspace's tabs alone, so switching away from a workspace that had a preview pane tore down its webview, and a process-global "closed" gate then blocked it from ever being recreated. Teardown now reconciles against every live workspace (matching how terminal sessions survive a switch), so a backgrounded preview is only closed when its leaf is truly gone ([`useSessionDisposal.ts`](src/app/hooks/useSessionDisposal.ts), [`PaneStack.tsx`](src/modules/panes/PaneStack.tsx), [`embed.rs`](src-tauri/src/modules/preview/embed.rs)).
- **Two crashes that could abort the whole app are fixed.** The fuzzy file finder panicked on filenames containing characters whose lowercase form expands (e.g. `İ`), and `git diff` / the AI commit-message generator panicked when a large diff was truncated in the middle of a multi-byte UTF-8 character. Both now stay on character boundaries ([`search.rs`](src-tauri/src/modules/fs/search.rs), [`commands.rs`](src-tauri/src/modules/git/commands.rs)).
- **The PTY daemon no longer leaks a thread + socket (and stops idling down) when its handshake is rejected during an upgrade.** A version-mismatched daemon left the GUI's reader thread blocked forever; the handshake now completes before the reader thread is spawned and is bounded by a timeout, so a stale or unresponsive daemon can't pin a thread, a socket, or the client slot. Daemon liveness was also hardened (idle-shutdown, client-count accounting, session caps) ([`client.rs`](src-tauri/src/modules/pty_daemon/client.rs), [`server.rs`](src-tauri/src/modules/pty_daemon/server.rs)).
- **Closing a terminal while its shell is still streaming no longer writes into a disposed terminal.** The PTY data/exit handlers now bail if the session was disposed or superseded, so a late event can't paint a dead session's output into a live pane ([`pty-lifecycle.ts`](src/modules/terminal/lib/pty-lifecycle.ts)).
- **A completed AI turn that finished in a background session is no longer lost on restart.** Only the active session was mirrored to disk; a turn that completed after switching away (or that was evicted from memory) is now persisted durably ([`chatStore.ts`](src/modules/ai/store/chatStore.ts)).
- **The file explorer's auto-refresh no longer polls every directory ever opened.** Background refresh is bounded to the currently-visible tree instead of growing with every folder expanded this session, and a workspace switch no longer pollutes the new tree with the previous root's directories ([`useFileTree.ts`](src/modules/explorer/lib/useFileTree.ts)).
- **Project-wide find/replace writes each file atomically.** The Search panel's replace used a plain truncate-then-write; it now uses the same crash-safe atomic write as the rest of the app, so a crash mid-replace can't leave a half-written source file ([`grep.rs`](src-tauri/src/modules/fs/grep.rs)).
- **Editor performance + correctness.** A colorless file no longer rescans up to 5,000 lines on every cursor move, the find bar no longer recomputes its match count on every scroll frame, and format-on-save no longer silently discards keystrokes typed during a slow formatter ([`colorDecorations.ts`](src/modules/editor/lib/colorDecorations.ts), [`EditorPane.tsx`](src/modules/editor/EditorPane.tsx)).
- **On Unix, a timed-out or killed shell whose backgrounded grandchild keeps the pipe open no longer leaks reader/drain threads.** The one-shot, background, and external-formatter shell paths now place children in their own process group and stop draining once the child is reaped ([`shell/mod.rs`](src-tauri/src/modules/shell/mod.rs), [`shell/background.rs`](src-tauri/src/modules/shell/background.rs), [`format.rs`](src-tauri/src/modules/format.rs)).
- **Memory/leak hygiene.** Pruned several never-cleared caches and dedupe sets (preview bounds map, applied-diff and live-tab-count records), stopped a settings change-callback from firing twice in the writing window, removed render churn in the terminal theme effect and the AI composer/voice context, and fixed the AI tool-schema cache that never hit ([`embed.rs`](src-tauri/src/modules/preview/embed.rs), [`useTabSideEffects.ts`](src/app/hooks/useTabSideEffects.ts), [`store.ts`](src/modules/settings/store.ts), [`TerminalPane.tsx`](src/modules/terminal/TerminalPane.tsx), [`useWhisperRecording.ts`](src/modules/ai/hooks/useWhisperRecording.ts), [`agent.ts`](src/modules/ai/lib/agent.ts)).

## [0.3.21] - 04-06-2026

### Changed

- **Embedded-browser clicks use a trusted "virtual mouse" that keeps working while TEDI is minimized or backgrounded.** `browser_click_at` (and the native path behind `browser_click`) now injects the click through the WebView2 DevTools Protocol (`Input.dispatchMouseEvent`) instead of an OS-level `SendInput`: the event is `isTrusted` (accepted by Gmail's `jsaction`, React controlled inputs, and other frameworks that ignore synthetic clicks), it no longer moves the user's real cursor, and it no longer needs TEDI focused or in the foreground. Embedded browser panes also disable Chromium occlusion / background throttling so a minimized pane keeps processing input and rendering ([`embed.rs`](src-tauri/src/modules/preview/embed.rs)).
- **The agent reads an already-open browser pane before reaching for `curl`.** When an `<env>` browser already shows what the user is asking about (a search result, converter, dashboard, doc), the prompt now steers `read_browser` of that pane first instead of fetching the same data from another source ([`config.ts`](src/modules/ai/config.ts)).
- **The update-status pill moved to the right cluster of the status bar,** next to the extension status icons (e.g. Discord), so the "Update available" / "Update check failed" button sits with the other status glyphs ([`StatusBar.tsx`](src/modules/statusbar/StatusBar.tsx)).

### Fixed

- **OpenAI-compatible local routers (9Router, LM Studio, llama.cpp, Ollama) no longer fail detection on Windows.** A user-entered base URL is normalized before fetch: trailing slashes are stripped and a bare `localhost` host is rewritten to the IPv4 literal `127.0.0.1`, sidestepping Windows resolving `localhost` to IPv6 `::1` first (which IPv4-only local servers refuse with a bare "Failed to fetch"). A user who truly needs IPv6 can still type `[::1]` ([`normalizeOpenAICompatibleBaseURL`](src/modules/ai/config.ts), [`OpenAICompatibleBlock.tsx`](src/settings/sections/components/OpenAICompatibleBlock.tsx)).
- **Detected OpenAI-compatible models show their provider's configured label, not the gateway's internal tag.** The model-dropdown subtitle now reads `via <your provider label>` (e.g. "via Xiomi", "via 9Router") instead of `via <owned_by>`, which gateways often set to a meaningless value like "cx" ([`openaiCompatible.ts`](src/modules/ai/lib/openaiCompatible.ts)).
- **Browser-preview tooltip-hover suppression hardened.** The overlay-suppression that ignores non-interactive Radix tooltips now also matches radix's own `role="tooltip"` node, not just the app's `[data-slot="tooltip-content"]` marker, so any tooltip variant is recognised and never flickers the preview pane away ([`overlaySuppress.ts`](src/modules/preview/lib/overlaySuppress.ts)).

## [0.3.20] - 03-06-2026

### Fixed

- **`read_browser` waits for the page to finish rendering before extracting.** A read fired right after `open_preview` / navigate could hit a blank or half-loaded DOM, return almost nothing, and the agent would re-read several times (and wander into unrelated tools) while it waited for content. `preview_embed_read` now polls a tiny readiness probe (document `complete` plus body text that has stopped growing) for up to ~3s, so the first read returns the loaded page in one call ([`preview_embed_read`](src-tauri/src/modules/preview/embed.rs)).
- **The file-explorer sidebar keeps its width across a window minimize then restore.** The 0.3.19 fix re-opened a spuriously collapsed sidebar, but a minimize against the 0px container Windows reports could still leave it shrunk to an arbitrary smaller width. App now snapshots the user's last sidebar width while the window is live and re-applies it on the minimize->restore transition, without overriding a collapse the user or an extension made ([`App.tsx`](src/app/App.tsx), [`AppSidebar.tsx`](src/app/components/AppSidebar.tsx)).
- **Browser preview no longer flickers away on a plain tooltip hover.** The overlay-suppression that hides the native preview webview behind TEDI's own menus and dialogs now ignores non-interactive Radix tooltips (matched by their `[data-slot="tooltip-content"]` marker), so hovering a status-bar icon whose tooltip opens over the pane no longer makes the page vanish and reappear. Real overlays (menus, dialogs, popovers, selects) still suppress the webview so they stay clickable on top of it ([`overlaySuppress.ts`](src/modules/preview/lib/overlaySuppress.ts)).

## [0.3.19] - 03-06-2026

### Fixed

- **Maximized window no longer covers the Windows taskbar, and the taskbar button can minimize it.** With `decorations: false` the borderless main window lost two native behaviours: Windows only auto-clamps a maximized window to the monitor _work area_ for framed windows, so TEDI filled the whole monitor and ran off the bottom over the taskbar (an OS-level window screenshot then captured a window that genuinely extended to the bottom); and without `WS_MINIMIZEBOX` the taskbar button could not toggle minimize like every other app. A Windows-only window-proc subclass now clamps `WM_GETMINMAXINFO` to the work area (chaining the original proc first so TAO's `min_inner_size` survives) and re-adds `WS_MINIMIZEBOX | WS_MAXIMIZEBOX` without painting any chrome ([`apply_windows_frame_fixes`](src-tauri/src/lib.rs)).
- **The file-explorer sidebar no longer collapses after minimize then restore/maximize.** Minimizing reports a 0px container to `react-resizable-panels`, which collapses the collapsible sidebar and left it collapsed once the window came back. The minimize-then-restore transition now re-opens the sidebar, but only undoes that spurious collapse - a sidebar the user collapsed via the toggle, or one an extension hid, stays collapsed ([`App.tsx`](src/app/App.tsx)).

### Changed

- **`read_browser` surfaces form-field values.** The browser reader now appends a `Values:` list of form-control values (converter / calculator results, input and select values) that the visible page text omits, so the agent reads a shown number straight from the live DOM instead of falling back to a screenshot ([`preview_embed_read`](src-tauri/src/modules/preview/embed.rs), prompt + tool description in [`config.ts`](src/modules/ai/config.ts) / [`terminal.ts`](src/modules/ai/tools/terminal.ts)).

## [0.3.17] - 02-06-2026

### Added

- **Workspaces can be reordered by drag-and-drop.** The sidebar workspace list now uses the same `@dnd-kit/sortable` pattern as the tab strip: grab any row and drop it into a new position (vertical list, 5px activation distance so a plain click still switches and a double-click still renames). A floating drag overlay previews the row, the new order persists to `tedi-workspaces.json`, and editing a name suspends drag for that row so the input stays interactive ([`WorkspacesPanel.tsx`](src/modules/workspaces/WorkspacesPanel.tsx), new `reorderWorkspaces` action in [`store.ts`](src/modules/workspaces/store.ts)).

### Fixed

- **Workspace tab counter now reflects every open tab.** The sidebar badge only counted `pane` and `preview` tabs, so opening a Source Control, git-diff, AI-diff, or extension tab left the count too low, and switching away from a workspace dropped its count because session-only tabs are never persisted. The active workspace now reports its real open-tab total and each workspace visited this session keeps that live count while inactive, with the persisted `tabs.length` as a fallback for not-yet-opened ones ([`App.tsx`](src/app/App.tsx), [`WorkspacesPanel.tsx`](src/modules/workspaces/WorkspacesPanel.tsx)).
- **Pane header tooltips match the rest of the app.** The split-pane drag handle and close button used the native browser `title` attribute, so they rendered the OS default tooltip (different style, delay, and position) instead of the styled popover every other control uses. Both now route through the shared [`IconTooltip`](src/components/ui/icon-tooltip.tsx) ([`PaneTreeView.tsx`](src/modules/panes/PaneTreeView.tsx)); the scheduler pill's "Cancel" button had the same native-`title` slip and was converted too ([`SchedulerStatusPill.tsx`](src/modules/scheduler/components/SchedulerStatusPill.tsx)).

## [0.3.16] - 02-06-2026

> Internal architecture cleanup. This release is behaviour-preserving: no features were added or removed and no public behaviour changed. The goal is a codebase a new open-source contributor can navigate, with the large "god files" decomposed into focused units.

### Added

- **`ARCHITECTURE.md` and a zero-dependency module import guard.** A new top-level [`ARCHITECTURE.md`](ARCHITECTURE.md) maps the two-process Tauri model (React webview <-> Rust backend), the `src/modules/*` feature layout, and the IPC boundary so a new contributor can orient without reading every file first. [`scripts/check-imports.mjs`](scripts/check-imports.mjs) (wired into [`ci.yml`](.github/workflows/ci.yml)) fails the build when a module reaches across a forbidden boundary, so the layering is enforced rather than aspirational. The onboarding docs ([`README.md`](README.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`TEDI.md`](TEDI.md)) were corrected where they had drifted from the code, and a [`.nvmrc`](.nvmrc) pins the supported Node line (Vite 8 requires Node >= 20.19).

### Changed

- **`App.tsx` decomposed into domain hooks plus a dialogs host.** The ~3,000-line [`App.tsx`](src/app/App.tsx) coordinator drops to ~1,650 lines by extracting its logic verbatim into focused hooks under [`src/app/hooks/`](src/app/hooks) (`useWorkspaceSwitching`, `usePaneHandles`, `useTabActions`, `useFileActions`, `useHeaderActions`, `useExtensionSidebarBridges`, `useAppContextBridge`, `useApplyZoom`, `useSshLeafState`, `useRightPanelExclusion`, `tabsApi`) and pure helpers under [`src/app/lib/`](src/app/lib) (`terminalSnapshot`, `shortcutHandlers`, `buildLiveContext`), with every dialog tree lifted into [`AppDialogs.tsx`](src/app/components/AppDialogs.tsx). Hook call order and dependency arrays are preserved exactly, so runtime behaviour is unchanged.
- **The remaining large UI views split into subcomponents.** Each oversized single-file view is broken into reusable pieces without changing its rendered output: [`TabBar.tsx`](src/modules/tabs/TabBar.tsx), [`ModelsSection.tsx`](src/settings/sections/ModelsSection.tsx), [`ExtensionsSection.tsx`](src/settings/sections/ExtensionsSection.tsx), [`FileExplorer.tsx`](src/modules/explorer/FileExplorer.tsx), [`ExplorerGrep.tsx`](src/modules/explorer/ExplorerGrep.tsx), [`SourceControlPanel.tsx`](src/modules/scm/SourceControlPanel.tsx), [`AiStatusBarControls.tsx`](src/modules/ai/components/AiStatusBarControls.tsx), and [`AiInputBar.tsx`](src/modules/ai/components/AiInputBar.tsx) now delegate to new `components/` siblings (tab entries, model dropdowns, extension cards, grep rows, SCM change rows, AI chips / model section, and more) plus shared `lib/` helpers.
- **Backend modules centralized.** Cross-cutting Rust helpers that had been copy-pasted are extracted into single sources of truth: id generation ([`ids.rs`](src-tauri/src/modules/ids.rs)), atomic write-tmp-fsync-rename ([`fs/atomic.rs`](src-tauri/src/modules/fs/atomic.rs)), CLI ANSI painting ([`cli_paint.rs`](src-tauri/src/modules/cli_paint.rs)), cross-window events ([`events.rs`](src-tauri/src/modules/events.rs)), poison-recovering lock access ([`lockext.rs`](src-tauri/src/modules/lockext.rs)), and the extension GitHub / version-compare logic ([`extensions/github.rs`](src-tauri/src/modules/extensions/github.rs), [`extensions/version.rs`](src-tauri/src/modules/extensions/version.rs)), which shrinks [`extensions/commands.rs`](src-tauri/src/modules/extensions/commands.rs) from ~400 lines of mixed concerns.
- **Frontend IPC and path helpers unified.** A new [`ipc.ts`](src/lib/ipc.ts) gives the filesystem read path a single discriminated-union result type (text / image / binary / too-large) mirroring the Rust enum, and hosts the shared cross-window event names; a new [`path.ts`](src/lib/path.ts) consolidates the duplicated `basename` / `dirname` / segment helpers. An AI module import cycle was broken and the preferences change-map hardened so newly added live-propagating prefs cannot be silently dropped.

### Fixed

- **React diagnostics surfaced during the refactor.** Resolved the `react-doctor` findings introduced by the extraction (an unstable `key` from a mutated counter in [`HighlightLine.tsx`](src/modules/explorer/components/HighlightLine.tsx), and several `only-export-components` warnings) by moving non-component exports into dedicated `lib/` modules.

## [0.3.15] - 31-05-2026

> Security and reliability hardening across the BYOK AI agent, extension, and PTY-daemon surfaces (audit of 31 adversarially-verified findings). Gates: `tsc`, `cargo check`, and `cargo clippy --all-targets` all clean.

### Security

- **AI tools no longer accept embedded newlines in `suggest_command` / `send_to_terminal`,** closing an approval-free command-injection path via raw PTY writes ([`tools/terminal.ts`](src/modules/ai/tools/terminal.ts)).
- **The secret deny-list is applied per grep / glob hit, and symlinks are canonicalized before the deny-list check on file reads,** so a symlinked or match-by-match path cannot leak secret files ([`tools/search.ts`](src/modules/ai/tools/search.ts), [`tools/fs.ts`](src/modules/ai/tools/fs.ts)).
- **Markdown surfaces block remote images and restrict link schemes,** closing a zero-click beacon / exfiltration vector on every Streamdown render ([`markdownSafety.ts`](src/lib/markdownSafety.ts), [`message.tsx`](src/components/ai-elements/message.tsx), [`reasoning.tsx`](src/components/ai-elements/reasoning.tsx)).
- **The PTY daemon enforces a mandatory Hello handshake, session and connection caps, and a tighter inbound frame cap,** with exited-session reuse rejected ([`pty_daemon/server.rs`](src-tauri/src/modules/pty_daemon/server.rs), [`pty_daemon/spawn.rs`](src-tauri/src/modules/pty_daemon/spawn.rs)).
- **Updater release notes and the installer filename are sanitized, manifest fetches are capped, and the daemon log rotates** ([`cli_update.rs`](src-tauri/src/modules/cli_update.rs), [`extensions/commands.rs`](src-tauri/src/modules/extensions/commands.rs)).

### Fixed

- **Background processes are reaped with bounded memory** (Windows Job Object plus a grace-bounded drain join on owner exit), and `shell_bg_remove` no longer leaks ([`shell/mod.rs`](src-tauri/src/modules/shell/mod.rs)).
- **React error boundaries** were added at the root, per-pane, and per-message-part levels so a single render failure can no longer blank the app ([`ErrorBoundary.tsx`](src/components/ErrorBoundary.tsx), [`main.tsx`](src/main.tsx), [`AiChat.tsx`](src/modules/ai/components/AiChat.tsx)).

## [0.3.14] - 31-05-2026

### Added

- **User-editable system prompts for every built-in AI agent.** A new _Settings -> Agents -> System prompts_ card (behind a "Show all" toggle) lets you override the core agent prompt (full + compact variants), the plan-mode appendix, the four read-only sub-agents (explore / code-review / security / general), the editor's inline-completion prompt, and the commit-message prompt. Each override is optional and persisted in its own store ([`tedi-prompts.json`](src/modules/ai/lib/prompts.ts)); sub-agents can additionally run on their own model, and the core agent / sub-agents / inline-completion expose an opt-in temperature. Overrides resolve at runtime via [`prompts.ts`](src/modules/ai/lib/prompts.ts) + [`promptsStore.ts`](src/modules/ai/store/promptsStore.ts) and are consumed in [`agent.ts`](src/modules/ai/lib/agent.ts), [`runSubagent.ts`](src/modules/ai/agents/runSubagent.ts), [`autocomplete/provider.ts`](src/modules/editor/lib/autocomplete/provider.ts), and [`commitAi.ts`](src/modules/scm/commitAi.ts). When nothing is overridden the byte-for-byte built-in defaults are used, so existing prompt-caching behaviour is unchanged.

### Fixed

- **Prompt overrides now apply at runtime, not just in Settings.** The Settings window is a separate webview with its own store instance; [`App.tsx`](src/app/App.tsx) now hydrates the prompts store at boot (alongside agents / snippets / sessions) and the store listens for a cross-window change event, so a saved prompt override takes effect for the agent, sub-agents, autocomplete, and commit messages without needing to open the Settings panel first.

### Changed

- **AI-native dead-code and duplicate cleanup.** Removed the orphaned `getSystemPrompt()` wrapper from [`config.ts`](src/modules/ai/config.ts) (replaced by `pickSystemPromptVariant()`), the unused `stripContextBlock()` / `CONTEXT_BLOCK_RE` chain from [`transport.ts`](src/modules/ai/lib/transport.ts), and an unused store method; the two identical `findLastIndex` / `lastIndex` array helpers in [`cache.ts`](src/modules/ai/lib/cache.ts) and [`transport.ts`](src/modules/ai/lib/transport.ts) are merged into a single `findLastIndex` in [`utils.ts`](src/lib/utils.ts).

## [0.3.13] - 30-05-2026

### Changed

- **Status-bar "Open preview" action is now an icon-only button pinned to the far left.** [`StatusBar.tsx`](src/modules/statusbar/StatusBar.tsx) drops the wide labelled "Open preview · host" pill in favour of a single globe icon (URL carried in the tooltip + `aria-label`) placed at the leftmost slot, so it reads consistently with the other status-bar icon buttons (SCM / AI / panel toggles).

### Fixed

- **WCAG AA text contrast across all 7 theme presets.** Audited every preset (Default, Tokyo Night, Nord, Catppuccin, Solarized, Monokai, Matrix) in both light and dark and lifted every failing text pair to >= 4.5:1 in [`themePresets.ts`](src/modules/settings/themePresets.ts): muted text (Default/light, Solarized/light, Nord/dark, Matrix/light), button labels (Tokyo Night/light, Nord/light, Solarized light + dark; Monokai/light's lime button now uses a dark label), and Nord/dark selection + accent text. Small non-text accent glyphs (status icons, diff stripes) keep their brand values; they sit below the 3:1 UI guideline by design to preserve each palette's identity.

## [0.3.12] - 30-05-2026

### Security

- **Extension keychain isolation hardened.** [`permissions.ts`](src/modules/extensions/permissions.ts) extends `HARD_DENY_INVOKE` to refuse `secrets_get` / `secrets_set` / `secrets_delete` over the gated `ctx.invoke()` path, not just `secrets_get_all`. An extension granted `invoke:secrets_*` could otherwise read the main app keychain (service `tedi`, where provider API keys live) one account at a time, sidestepping its own `tedi-ext:<id>` namespace; the documented `ctx.secrets.*` facade is unaffected. The comment now states plainly that the runtime gate is install-time-review defence in depth, not a sandbox - raw `@tauri-apps/api` invoke still bypasses it, and full isolation would need an iframe / worker (tracked separately).
- **Extension installer rejects duplicate zip entries.** [`install.rs`](src-tauri/src/modules/extensions/install.rs) refuses an archive that carries the same file path twice. `extract_into` writes entries in order with `File::create`, so a later duplicate silently overwrote an earlier one on disk while the install-review dialog (`peek_bytes`) reads the first `manifest.json` - a crafted zip could show a benign manifest yet install a different, malicious one. Rejecting duplicate paths closes that spoofing / code-execution vector.

### Fixed

- **Blank terminal on workspace restore that never opened a shell.** The PTY daemon keeps a session alive after its shell exits so a detached GUI can still read the final scrollback; on restore, `pty_attach` discarded the daemon's `alive` flag, so reattaching a dead session replayed frozen scrollback into a pane that could not take input. [`pty/mod.rs`](src-tauri/src/modules/pty/mod.rs) threads `alive` through `PtyOpenResult`, [`pty-bridge.ts`](src/modules/terminal/lib/pty-bridge.ts) surfaces it on `PtySession`, and [`useTerminalSession.ts`](src/modules/terminal/lib/useTerminalSession.ts) now closes a dead reattached session (reaping it daemon-side), resets the terminal, and respawns a fresh shell at the saved cwd - clearing `firstByteEpoch` so the no-data watchdog still guards the respawn.
- **Closing a non-active workspace leaked its terminal sessions.** [`App.tsx`](src/app/App.tsx) `closeWorkspace` disposes the closed workspace's terminal sessions before dropping its live-tab cache. Those leaves lived only in the cache, so the `[tabs]`-keyed reconcile never ran for them and each xterm + 5k-line scrollback (~6 MB) lingered in the module session map until the app exited.
- **Terminal session listeners released deterministically.** [`useTerminalSession.ts`](src/modules/terminal/lib/useTerminalSession.ts) captures and disposes the `term.onData` handler in `disposeSession`, and makes the module-level `tedi:canvas-opacity` window listener idempotent so a dev HMR re-eval cannot stack duplicate listeners holding the session map.

### Performance

- **Daemon scrollback trim amortized.** [`server.rs`](src-tauri/src/modules/pty_daemon/server.rs) trims the per-session scrollback ring only once it overruns the 1 MiB cap by a 256 KiB slack, then back down to the cap - amortizing the O(n) `VecDeque::drain` that previously shifted ~1 MiB on every output chunk while sitting at the cap (build / install log floods). Memory stays bounded at cap + slack.

### Changed

- **Extension activation failures are now surfaced.** [`loader.ts`](src/modules/extensions/loader.ts) + [`store.ts`](src/modules/extensions/store.ts) toast when an extension's `activate()` throws (at boot and on enable) instead of only logging to the console, so a developer iterating on an extension gets immediate feedback; manifest contributions stay applied so the settings card still renders.
- **Multiple OpenAI-compatible provider instances.** The single `openaiCompatibleBaseURL` preference is replaced by `openaiCompatibleInstances[]`, each with its own base URL and keychain-stored key, with model detection run per instance ([`openaiCompatible.ts`](src/modules/ai/lib/openaiCompatible.ts), [`config.ts`](src/modules/ai/config.ts), [`keyring.ts`](src/modules/ai/lib/keyring.ts), [`ModelsSection.tsx`](src/settings/sections/ModelsSection.tsx), [`agent.ts`](src/modules/ai/lib/agent.ts), plus the AI status-bar and agent-switcher surfaces).
- **Consistent toolbar button theming.** New [`toolbarButton.ts`](src/lib/toolbarButton.ts) exports a shared `TOOLBAR_HOVER` token applied across the top toolbar / header surfaces ([`Header.tsx`](src/modules/header/Header.tsx), [`SearchInline.tsx`](src/modules/header/SearchInline.tsx), [`SshMenu.tsx`](src/modules/ssh/SshMenu.tsx), [`ExtensionHeaderItems.tsx`](src/modules/extensions/components/ExtensionHeaderItems.tsx), [`TabBar.tsx`](src/modules/tabs/TabBar.tsx), [`WorkspacesPanel.tsx`](src/modules/workspaces/WorkspacesPanel.tsx), [`PreviewAddressBar.tsx`](src/modules/preview/PreviewAddressBar.tsx)) so ghost buttons keep the correct hover in dark mode.

## [0.3.11] - 28-05-2026

### Added

- **Drag-and-drop pane repositioning, with a header on every pane.** [`PaneTreeView.tsx`](src/modules/panes/PaneTreeView.tsx) gives each split pane a top bar (drag handle, type icon, label, close button) and uses `@dnd-kit` pointer sensors to drop one pane onto another pane's edge (top / right / bottom / left) and re-split there. [`panes.ts`](src/modules/terminal/lib/panes.ts) adds `movePaneLeafToEdge` / `insertLeafBeside`, which move a leaf while preserving its id so the underlying PTY / editor / preview survives the move instead of being torn down and recreated. [`useTabs.ts`](src/modules/tabs/lib/useTabs.ts) exposes the mutation and [`PaneStack.tsx`](src/modules/panes/PaneStack.tsx) threads SSH-host / AI-CLI / private state into each header. HTML5 drag is avoided on purpose (unreliable under the Tauri WebView), so the whole interaction runs on pointer sensors.
- **App-wide glassmorphic transparency driven by a single Theme setting.** [`ThemeSection.tsx`](src/settings/sections/ThemeSection.tsx) merges wallpaper and transparency into one "Background & transparency" block: a single opacity slider (fully transparent through solid), a background picker, and Blur / Darken. [`appOpacity.ts`](src/modules/settings/appOpacity.ts) plus the glass rules in [`globals.css`](src/styles/globals.css) fade every surface uniformly toward whatever sits behind the window - shell, sidebar, header, tabs, status bar, panels, popovers / menus, the editor and terminal canvases, and first-party extensions such as SQL Explorer - while text, borders, buttons, accents, and selections stay opaque so the UI is still legible at any opacity. The wallpaper supports a static image, a looping video, and an in-app YouTube embed ([`customTheme.ts`](src/modules/settings/customTheme.ts)); the slider previews live during the drag and persists on commit, and the change propagates across windows via the prefs event. The top header bar is intentionally kept more opaque than the rest so it stays a clear, grabbable drag handle, and no `backdrop-filter` is used (it renders as a dark fill over a transparent window on Windows) - the frosted look comes from the wallpaper's own Blur slider.

### Changed

- **Tab and pane indicators now match for the same leaf state.** A private leaf reads red, an SSH leaf shows the cloud icon with an `ssh:<host>` label, and the AI-CLI working status (idle / working / blocking) is mirrored identically in both the tab strip ([`TabBar.tsx`](src/modules/tabs/TabBar.tsx)) and the per-pane header ([`PaneTreeView.tsx`](src/modules/panes/PaneTreeView.tsx)), so a leaf looks the same whether you read it from the tab or the pane.
- **The update pill moved to the far-left of the status bar.** [`StatusBar.tsx`](src/modules/statusbar/StatusBar.tsx) pins `UpdaterPill` as the first item in the left cluster (before the OS badge and the path breadcrumb) so an available update is the first thing on the bar.

### Fixed

- **Sticky header bars no longer bleed under glass.** SQL Explorer's table header, result toolbar, and schema-tree head, plus the AI chat "jump to message" pin, painted with the now-translucent surface token and let the rows / messages scrolling beneath them show through. [`globals.css`](src/styles/globals.css) pins those sticky bars to a solid canvas backing (SQL Explorer) or the boosted header tint (chat pin) under glass, and drops the chat pin's `backdrop-filter` so it no longer renders as a dark fill on Windows.

## [0.3.10] - 28-05-2026

### Added

- **`manifest.engines.tedi` is enforced at install and at activate.** The Rust install pipeline ([`commands.rs`](src-tauri/src/modules/extensions/commands.rs), [`install.rs`](src-tauri/src/modules/extensions/install.rs)) now checks `satisfies()` right after parsing the manifest and refuses the extension with a `requires TEDI X.Y.Z` error - the staging directory is removed before returning so a half-installed extension can't linger. The frontend loader ([`loader.ts`](src/modules/extensions/loader.ts)) mirrors the same check at `activate()`, so a stale extension installed on an older build that's since been downgraded surfaces a toast and skips activation instead of silently breaking against a missing host API. A small shared semver helper ([`semver.ts`](src/modules/extensions/semver.ts) + `commands::satisfies`) accepts the constraint shapes every shipped extension actually uses (empty / `*`, `">=X.Y.Z"`, `">X.Y.Z"`, `"<=X.Y.Z"`, `"<X.Y.Z"`, and `"=X.Y.Z"` / plain `"X.Y.Z"` for exact). No npm semver dep pulled in.

### Changed

- **`mountFolderTree` split: `FolderTreeShell` lives in its own component file.** [`FolderTreeShell.tsx`](src/modules/extensions/components/FolderTreeShell.tsx) now owns the React tree, picker persistence, and workspace-switch reset that an extension mounts via `ctx.ui.mountFolderTree`. [`mountFolderTree.tsx`](src/modules/extensions/components/mountFolderTree.tsx) is reduced to a one-screen factory that creates the React root and forwards options. No behaviour change for extension authors.
- **`react-doctor` dead-code sweep across UI primitives and modules.** Drops unused exports from the UI primitive barrels (`badgeVariants`, `buttonVariants`, `tabsListVariants`, `buttonGroupVariants`, `toggleVariants`), removes the `messagesToMarkdown` helper from `conversation.tsx`, deletes the unused `formatRelative` export from `SshStatusPill`, and tightens [`NewEditorDialog.tsx`](src/modules/editor/NewEditorDialog.tsx)'s focus-timeout to return a cleanup so a quick close/open cycle can't fire a stale focus. Tailwind class order normalised in `SshStatusPill` while passing through. `react-doctor` is pinned via `pnpm devDependency` with a `pnpm doctor` script so the next sweep is one command away. `pnpm-workspace.yaml` marks `msgpackr-extract` as a non-build dep to silence corepack's install nag.

## [0.3.9] - 28-05-2026

### Fixed

- **Left sidebar file tree always renders folders-first (VSCode-style), even when the Secondary Folder Tree extension has saved a non-default sort.** [`FileExplorer.tsx`](src/modules/explorer/FileExplorer.tsx) honoured `localStorage["tedi:explorer:sortMode"]` even when its Sort dropdown was hidden, so a `Modified (newest first)` pick made in the right-side extension panel (which shares the same key) bled into the primary sidebar and mixed files between folders. The primary tree now forces `sortMode` to `"default"` whenever `hideSort` is set, so a foreign mode persisted by another surface can't strand the sidebar on an order the user can't see or change. The right-side Secondary Folder Tree keeps its dropdown and full mode selection.

### Added

- **`ctx.tabs.setExtensionTabState({ panelId, reuseKey?, state })` extension API.** [`useTabs.ts`](src/modules/tabs/lib/useTabs.ts) introduces an `ExtensionTabState` union (`idle | connecting | reconnecting | connected | disconnected | error`) and a matching mutator on the tabs hook; [`tabsBridge.ts`](src/modules/extensions/tabsBridge.ts) re-exports the type and wires a setter so the bridge can reach into `useTabs` without coupling to React; [`host.ts`](src/modules/extensions/host.ts) exposes the call on `ExtensionContext.tabs` behind the existing `tabs:open` permission; [`App.tsx`](src/app/App.tsx) registers the live `setExtensionTabState` from `useTabs` into the bridge once on mount. [`TabBar.tsx`](src/modules/tabs/TabBar.tsx) renders the lifecycle tone on the tab title text using the SSH palette so workbench-style extensions read consistently next to terminal tabs: `connecting`/`reconnecting` pulses yellow, `connected` is green, `disconnected`/`error` is red, `idle`/undefined inherits the default tab colour. SQL Explorer is the first consumer (mirrors its DB connection state into the tab strip).

### Changed

- **`tedi --update` defers to the in-app updater when a TEDI window is already running on Windows.** [`cli_update.rs`](src-tauri/src/modules/cli_update.rs) now scans the live process list via `CreateToolhelp32Snapshot` (plus a new `Win32_System_Diagnostics_ToolHelp` feature on the `windows-sys` Cargo dep) before booting the headless updater. If another `TEDIApp.exe` is alive it prints a one-line notice and returns from the CLI handler instead of `process::exit`ing, so the rest of `lib::run` continues, `tauri-plugin-single-instance` forwards `--update` to the existing window via `tedi:trigger-update`, and `useUpdater` drives the download / close / install / relaunch through `tauri-plugin-updater`. This is the only path that works on Windows because NSIS cannot overwrite a mapped `TEDIApp.exe`, so the headless install would silently no-op. macOS / Linux keep the previous direct path (POSIX rename swaps the bundle while the running process holds the old inode).

## [0.3.8] - 28-05-2026

### Changed

- **Extension tab icon and label no longer carry the info tint.** [`TabBar.tsx`](src/modules/tabs/TabBar.tsx) drops the `text-info` class from both `EntryIcon`'s extension branch and the label `<span>`. Extension tabs now inherit the surrounding tab foreground so they read as part of the default tab cluster, matching the user's preference for visual consistency over per-kind colour cues. The accent stripe under the active tab still uses `--tedi-tab-ssh` so the tab kind stays identifiable in the strip.

## [0.3.7] - 27-05-2026

### Fixed

- **Extension tab activates on open even when the extension also hides the sidebars first.** [`useTabs.openExtensionTab`](src/modules/tabs/lib/useTabs.ts) previously read the reuse-target id from inside the `setTabs` updater and then called `setActiveId(resolvedId)`. That pattern only worked when React performed eager state computation. Extensions like SQL Explorer that call `setSidebarVisible(false)` + `setRightSidebarVisible(false)` before opening their tab schedule unrelated state updates first, which forces React to defer the updater. `resolvedId` stayed `null`, `setActiveId` was effectively skipped, and the new tab appeared in the bar but never took focus. The function now reads `tabsRef.current` synchronously for reuse detection, allocates the new id outside `setTabs`, and calls `setActiveId(id)` with a concrete value.

### Added

- **`ctx.ui.mountFolderTree` accepts `initialPickedPath` + `onPickedPathChange`.** [`mountFolderTree.tsx`](src/modules/extensions/components/mountFolderTree.tsx) gains two new options. `initialPickedPath` is honored on the first render of each React root, so an extension that re-mounts the tree (e.g. after closing and reopening its panel) can restore the prior "Open Folder" pick instead of snapping back to `rootPath`. `onPickedPathChange` fires whenever the shell's picked-path state mutates (pick, clear, workspace switch), giving the extension a stable hook to persist the selection. tedi.secondary-folder-tree 0.1.9 is the first consumer.
- **Extension tab title text now uses the SSH info tint.** [`TabBar.tsx`](src/modules/tabs/TabBar.tsx) adds `text-info` to the ext-tab label so the title reads in the same sky/info colour as its icon, mirroring how an SSH tab's icon + label share a colour at rest. Visual consistency for workbench-style extensions sitting next to terminal tabs.

### Changed

- **Source Control is no longer auto-restored after an extension tab closes.** [`App.tsx`](src/app/App.tsx) drops the `{ kind: "scm" }` arm from the `RightAuxSnapshot` union. If SCM is open when an extension hides the right sidebar, it still closes (alongside the AI chat / extension right panel), but it is never recorded for replay. The user re-opens SCM manually via the status-bar GitBranch icon. Rationale: SCM is intentionally a deliberate, user-driven surface; silently resurrecting it after extension teardown felt magical and made users wonder why the panel kept reappearing.

## [0.3.6] - 27-05-2026

### Added

- **`ctx.app.setRightSidebarVisible(visible)` extension API.** [`tabsBridge.ts`](src/modules/extensions/tabsBridge.ts) gains a `setRightSidebarSetter` bridge and `setRightSidebarVisible` public function; [`host.ts`](src/modules/extensions/host.ts) exposes it on `ExtensionContext.app` alongside the existing `setSidebarVisible`. Closes whichever of the three mutually-exclusive right surfaces (`useChatStore`, `useRightPanelStore`, `useScmRightPanelStore`) is currently open, snapshots which one it was, and replays the snapshot when the user leaves the extension's tab — same lifecycle latch the left sidebar already had. Calls with `visible: true` are a deliberate no-op (we can't infer which surface to reopen from a bare call); the existing exclusivity effects handle the user reopening one manually. SQL Explorer 0.2.20 is the first consumer (collapses both sidebars on `Ctrl+Alt+D` open so the workbench gets the full workspace width).

## [0.3.5] - 26-05-2026

### Added

- **`tedi theme` CLI subcommand recognised by the Windows console stub.** [`tedi-cli/src/main.rs`](src-tauri/tedi-cli/src/main.rs)'s `is_cli_invocation` now matches `theme` in addition to `ext`, so `tedi theme …` from a terminal routes to the GUI binary's CLI handler ([`cli_theme.rs`](src-tauri/src/modules/cli_theme.rs)) and prints to the user's shell instead of detaching into a new window. Without this, the stub forwarded the args to a detached GUI process and the user never saw the output.

### Changed

- **SSH menu rows drop the "last connected" relative timestamp.** [`SshMenu.tsx`](src/modules/ssh/SshMenu.tsx) used to append ` · last 5m ago` to each connection's `user@host:port` meta line via `formatRelative(c.lastConnectedAt)`. The string churned every render (relative-time recompute) and the data was already visible inside the connection editor; the menu row now stays static showing only `user@host:port`. The `formatRelative` import + the `lastConnectedAt` branch are gone.
- **Formatter language picker uses `CommandShortcut` for the preset command badge.** [`FormattersTable.tsx`](src/settings/sections/components/FormattersTable.tsx)'s "Add language…" popover listed each picker row as `<label> <muted span with cmd>`. The trailing span used a hand-rolled `text-muted-foreground font-mono text-[10px]` chip that drifted from the rest of the command-palette family. Swapped it for `<CommandShortcut>` (same component the search shortcut uses), and bumped the item gap to `gap-3` so the label and shortcut don't collide on long preset commands.

## [0.3.4] - 26-05-2026

### Changed

- **SSH menu row actions: tooltip + icon visibility cleanup.** [`SshMenu.tsx`](src/modules/ssh/SshMenu.tsx)'s per-row action buttons (`RowIconButton`) used the browser-native `title` attribute, which paints in the OS chrome colour and looks foreign next to every other header tooltip (`IconTooltip` everywhere else). Replaced with `IconTooltip` so the popup matches the rest of the header family. The buttons also stop fading: previously `opacity-0` until row hover, now visible at rest so the affordance is discoverable without hunting per-row. The danger / default tone palette tightens to a single `muted-foreground` resting colour with `accent` / `destructive/15` hover backgrounds, matching the rest of the icon button family.
- **SSH menu row actions: drop private + duplicate shortcuts.** The lock (private connect) and copy (duplicate) buttons were rarely used and crowded the row. Private mode is still reachable via the connection editor; duplicating a connection can be done by editing + saving under a new name. Edit + delete remain as the two row actions; the icons now stay visible without hover so the action is one click instead of two.

## [0.3.3] - 26-05-2026

### Added

- **`ctx.ui.codeEditor` autocomplete hook.** [`codeEditor.ts`](src/modules/extensions/codeEditor.ts) gains a `completions` option on `CodeEditorOptions`: a synchronous callback `(prefix: string) => CodeEditorCompletion[]` that the host wires into CodeMirror's `@codemirror/autocomplete` as a custom completion source. Each suggestion exposes `label`, `detail`, `info`, `type`, optional `apply` (replacement text) and `boost` (sort hint). When the callback is omitted the host skips the autocomplete extension entirely, so older extensions stay zero-overhead. SQL Explorer 0.2.13 is the first consumer (table + column completions sourced from its schema cache).
- **Themed autocomplete popup.** New `cm-tooltip-autocomplete` rules in `codeEditor.ts`'s base theme paint the popup in the same `--popover` / `--accent` palette as host menus: rounded card, mono font, matched-text highlighted in `--primary`, muted-foreground `detail` column. The popup no longer looks like raw CodeMirror chrome.

## [0.3.2] - 26-05-2026

### Fixed

- **Extension install/update no longer breaks on GitHub rate limits.** [`extensions/commands.rs`](src-tauri/src/modules/extensions/commands.rs) used to hit `api.github.com/repos/.../releases/latest` for every install, update check, and CLI `tedi ext` call. The endpoint is capped at 60 requests/hour per IP for unauthenticated traffic, so a user installing or checking several extensions in one session (or sharing an IP behind NAT) would start seeing `GET ...: HTTP 403` toasts with no actionable hint. The path now falls back to two unauthenticated public surfaces when the API returns rate-limited: the `https://github.com/<owner>/<repo>/releases/latest` 302 redirect (gives the tag) and the `releases/expanded_assets/<tag>` HTML fragment (gives the asset list). Both succeed without rate-limit accounting, so install / update keeps working even after the API quota is exhausted.

### Added

- **`TEDI_GITHUB_TOKEN` environment variable for higher GitHub API limits.** Setting a personal access token (no scopes required for public repo reads) bumps the cap from 60 to 5000 requests/hour. Useful for power users who maintain many extensions or test installs in tight loops. Read on every request, so a fresh token takes effect without restarting TEDI.
- **Actionable rate-limit error.** When the API does return HTTP 403 with a rate-limit body and the unauthenticated fallback also fails, the toast now spells out the cause, the `TEDI_GITHUB_TOKEN` workaround, and the typical reset window instead of surfacing the bare HTTP code.

## [0.3.1] - 26-05-2026

### Added

- **Settings: dedicated `Code Editor` tab.** [`src/settings/sections/CodeEditorSection.tsx`](src/settings/sections/CodeEditorSection.tsx) is the new home for editor theme, `Show minimap`, `Vim mode`, `Format on save`, and the `FormattersTable`. Splits them out of the General tab so the General page reads as "app behaviour" while editor concerns live next to the editor itself. Registered as a top-level tab in [`SettingsApp.tsx`](src/settings/SettingsApp.tsx) with the `CodeIcon` glyph and a `code-editor` `openSection` deep link.
- **`pnpm-workspace.yaml` with `allowBuilds`.** pnpm v10 blocks postinstall scripts by default; the new workspace file opts in `esbuild` and `msw` (both legitimate native / service-worker setup steps) so a fresh `pnpm install` no longer prints the "ignored build scripts" warning.

### Changed

- **`FormattersTable` language picker is now a searchable Popover + Command.** [`FormattersTable.tsx`](src/settings/sections/components/FormattersTable.tsx) swaps the previous `DropdownMenu` for `Popover` + `cmdk` so the language list (170+ entries once everything is loaded) becomes filterable by typing. Each item still shows the preset external command (e.g. `rustfmt`, `gofmt`) when one exists. Functional behaviour on selection is unchanged.
- **Editor pane flush against top + right edges.** [`editor/lib/extensions.ts`](src/modules/editor/lib/extensions.ts) drops the 8 px top padding (kept only on the left, where the gutter still needs breathing room). The first line, scrollbar, and minimap now sit flush, matching the chrome of the surrounding panes.
- **`NoFormatterError` message points to the new tab.** Toast now says `Settings → Code Editor → Formatters` instead of `Settings → General → Formatters` after the section move.

### Bundled extensions

- **`tedi.discord-rich-presence` 1.5.8.** Presence card simplified to `<workspace folder>` on the top line and `<N workspaces, M terminals>` on the bottom (removes the duplicated terminal count). Release pipeline now also builds the `windows-aarch64` and `linux-aarch64` sidecar binaries, so users on Windows ARM / Linux ARM no longer see the "no sidecar binary for this platform" toast.

## [0.3.0] - 26-05-2026

### Added

- **Format-on-save + format document pipeline.** New editor formatter system at [`src/modules/editor/lib/formatters/`](src/modules/editor/lib/formatters/) routes a save through Prettier (built-in) or an external CLI (`rustfmt`, `gofmt`, `black`, `clang-format`, `phpcbf`, etc.) based on the file's resolved language. Rust side [`src-tauri/src/modules/format.rs`](src-tauri/src/modules/format.rs) spawns the external binary with stdin/stdout piping and a 30 s timeout. UI in Settings → General gains a `FormattersTable` for binding a language to a formatter + setting `formatOnSave`. Built-in language detection in `formatters/lang.ts`; ready-made external presets in `formatters/presets.ts`. Falls back to a `NoFormatterError` toast when no formatter is configured.
- **`ctx.editor` host API.** Extensions can now read the active editor's `{ path, content, dirty }` and replace its content via `ctx.editor.getActive()` / `ctx.editor.setActiveContent(text)`. Wired through [`editorBridge.ts`](src/modules/extensions/editorBridge.ts) which App.tsx feeds on every render with the live `activeEditorHandle`, so the host stays React-free. Lets formatter / lint / refactor extensions act on the current buffer without re-implementing tab tracking.
- **Workspace + total terminal counts on `AppContextSnapshot`.** Two new fields: `workspaceCount` (length of the workspace store) and `terminalCountAll` (live tabs for the active workspace + last-saved tabs for inactive ones, walked via the new `countSavedTerminalLeaves` helper in [`workspaces/serialize.ts`](src/modules/workspaces/serialize.ts)). Discord Rich Presence v1.5.5 surfaces both in the presence card so the viewer sees the multi-workspace footprint at a glance.
- **Auto-restore for ext-tab sidebar collapses.** When an extension calls `ctx.app.setSidebarVisible(false)` while opening its tab (SQL Explorer is the first consumer), the host snapshots the user's prior sidebar state. Switching to another tab restores it; coming back to the ext's tab re-collapses. Manual sidebar toggles clear the latch so the user's intent always wins. Implemented via a new `ownerExtensionId` channel on `setSidebarVisible` + a tabs-watching effect in `App.tsx`.
- **Lazy HugeIcons barrel.** [`src/lib/hugeIconsBarrel.ts`](src/lib/hugeIconsBarrel.ts) splits the dynamic-name HugeIcons lookups (extension tab icons, `ctx.ui.icon`, contributed header items) into their own Rollup chunk loaded in parallel with the main bundle. Named imports in JSX keep their tree-shaken path.

### Changed

- **Status-bar buttons unified to icon-only.** `AiOpenButton`, `ScmRightOpenButton`, and every extension `RightPanelToggleButtons` variant render as borderless `size-6` icon buttons (Discord-style). Title + shortcut chip live in the tooltip now, so the status-bar right cluster reads as one consistent row of glyphs. The `RightPanelTextToggles` export name is preserved but its chrome matches `RightPanelCompactToggles`; the `compact` flag now only governs ordering. Tooltip `Kbd` chip forces `bg-foreground/15 text-foreground` so it stays readable against TEDI's popover (which shares `--background`'s colour token).
- **Tooltip collision padding.** `TooltipContent` defaults `collisionPadding={8}` so tooltips near the viewport edge (the rightmost status-bar button being the canonical case) auto-shift instead of clipping.
- **Extension secrets API: parameter mismatch fixed.** `host.ts`'s `ctx.secrets.{get,set}` were sending `{ name, value }` to the native `secrets_set` / `secrets_get` commands which expect `{ service, account, password }`. The call deserialised as missing fields and silently no-op'd, so any extension storing a credential (SQL Explorer being the user-visible case) actually saved nothing. Now namespaced as `service: "tedi-ext:<id>"` + `account: <name>`, matching the SSH manager's pattern. Existing keychain entries from before this fix don't exist (they never landed); a one-time re-enter is needed on first save after upgrade.
- **CLI `tedi ext` UX refresh.** [`cli_ext.rs`](src-tauri/src/modules/cli_ext.rs) gains discoverable subcommands, friendlier error messages, and more telemetry surfaced when installs / updates fail.
- **PTY daemon: scrollback + session restore reliability.** [`pty/session.rs`](src-tauri/src/modules/pty/session.rs) and [`pty_daemon/server.rs`](src-tauri/src/modules/pty_daemon/server.rs) tighten the AttachOk replay path and clean up edge cases around daemon-restart while a window is mid-close.
- **SSH session lifecycle.** [`ssh/session.rs`](src-tauri/src/modules/ssh/session.rs) + [`ssh/mod.rs`](src-tauri/src/modules/ssh/mod.rs) refine disconnect ordering so the status pill no longer briefly flickers "Connected" during teardown.
- **Em-dash sweep, round 2.** Same scope as 0.2.25 (`—` → `-`) applied to files added since.

### Extension surface

- **`AppContextSnapshot` (additive, non-breaking).** New fields `workspaceCount: number` and `terminalCountAll: number` on every snapshot delivered by `ctx.app.onContextChange`. Old extensions ignore them.
- **`ctx.editor` (additive).** Read `getActive()` for `{ path, content, dirty }`; mutate with `setActiveContent(text)`. Returns `null` / `false` when no editor leaf is focused. No new permission.
- **`ctx.app.setSidebarVisible(false)` now snapshots prior state.** The visible behaviour for extensions doesn't change (the call still hides the sidebar). The host additionally restores the snapshot when the user switches away from the calling extension's ext tab. Drop the call to opt out.

### Bundled extensions

- **`tedi.sql-explorer` 0.2.8.** Identifier whitelist replaced with proper backtick / double-quote escape so MySQL / PostgreSQL names with hyphens, leading digits, or non-ASCII characters load instead of failing with `bad request: invalid identifier`. NUL / CR / LF still rejected for safety. Connection editor switches to a docked, draggable side panel with explicit X close + Esc, matching the host AlertDialog visual family. Schema tree filters to the connection's pinned `database` when one is set, and grows an inline search box. Brand SVGs dropped from the rail + engine dropdown for a denser, chrome-coherent look. Delete connection asks for confirmation in the same custom modal (no native `confirm()`).
- **`tedi.discord-rich-presence` 1.5.5.** Presence `details` line now reports the workspace folder *plus* `N workspaces` and `M terminals` (across all workspaces). Older TEDIs that don't ship the new context fields gracefully render the legacy format.

## [0.2.26] - 26-05-2026

### Added

- **PTY daemon for session persistence.** New sidecar process ([`src-tauri/src/modules/pty_daemon/`](src-tauri/src/modules/pty_daemon/)) owns every interactive PTY across window-close so long-running shells (`cargo watch`, `npm run dev`) keep streaming and reattach when the GUI re-opens. IPC over Unix domain socket / Windows named pipe via [`interprocess`](https://crates.io/crates/interprocess); per-session ids minted by `uuid`. Scrollback ring (1 MiB) replayed as one `AttachOk` event on reattach so xterm reconstructs screen state from the ANSI on the wire. Daemon self-shuts after 24 h idle, falls back to in-process PTY when the sidecar can't spawn. See the "PTY daemon" section of [`TEDI.md`](TEDI.md) for the full protocol + fallback semantics.
- **Workspace tab + header surfaces for extensions.** `panels[].surface` enum grows a new `"tab"` value: extensions that declare it can open their UI as a full workspace tab via the new `ctx.tabs.openExtensionTab({ panelId, title, reuseKey })` host API instead of (or alongside) the right-panel slot. The first consumer is `tedi.sql-explorer`'s HeidiSQL-style query workbench. Pair with `ctx.headerBar.{setItem,removeItem}` for a header button next to SSH / Extensions / Settings (gated on `headerbar:write`), and `ctx.app.setSidebarVisible(visible)` to collapse the host file-explorer when the workbench tab opens. Tab strip renders an extension tab with the icon the extension hinted (e.g. `hugeicon:Database01Icon`) tinted in the SSH-tab sky-blue tone so workbench extensions read as part of the remote-dev cluster.
- **`ctx.ui.codeEditor(container, opts)` host API.** Mounts a CodeMirror 6 view in any extension-owned `<div>`, with the same syntax-highlight palette tier as the host code editor and a small subset of extensions (line numbers, history, active-line gutter, `Mod+Enter` callback). Languages: `sql`, `sql:mysql`, `sql:postgres`, `sql:sqlite`, `json`, `plain`. Theme inherits TEDI's CSS vars. Auto-disposed on extension deactivate.
- **`ctx.ui.icon(name, opts)` host API.** Returns a `<span>` with a HugeIcon mounted via React. Lets vanilla-JS extensions render pixel-perfect HugeIcons matching the host header / status-bar chrome instead of bundling their own SVGs. Roots tracked per extension and unmounted on deactivate. `ExtensionHeaderItems` and `ExtensionStatusItems` recognise the same `hugeicon:<Name>` prefix on `icon` strings, so an extension that registers a header item with `icon: "hugeicon:Database01Icon"` paints exactly like a core SSH / Settings button.

### Changed

- **`tedi.sql-explorer` (new external extension).** First-party reference extension showcasing the new host APIs above. Connects to MySQL / PostgreSQL / SQLite via a self-contained Rust sidecar (`tedi-sql-helper`) speaking HTTP+JSON on `127.0.0.1` with a per-boot bearer token. CRUD via UI (insert dialog, double-click cell edit, row delete) and via the embedded CodeMirror SQL editor. Connections stored under `ext:tedi.sql-explorer:connections` in TEDI settings; passwords in the OS keychain. Lives at [`IlhamriSKY/TEDI.sql-explorer`](https://github.com/IlhamriSKY/TEDI.sql-explorer), install via *Settings → Extensions → From GitHub*.

### Extension surface

- **`panels[].surface` enum: `"tab"` accepted alongside `"right"` / `"sidebar-bottom"` / `"statusbar-right"`.** A `"tab"` panel skips the auto-rendered status-bar toggle; the extension owns the open via `ctx.tabs.openExtensionTab`.
- **New permissions: `headerbar:write` (low risk), `tabs:open` (low risk).**
- **New registries: `headerItemsRegistry`** (runtime-only, mirror of `statusItemsRegistry`; cleared by `clearExtensionContributions`).

## [0.2.25] - 25-05-2026

### Added

- **Regex find + replace across the folder tree.** New `fs_grep_replace` Rust command in [`src-tauri/src/modules/fs/grep.rs`](src-tauri/src/modules/fs/grep.rs) walks the same `ignore` tree as `fs_grep`, applies `regex::Regex::replace_all` to each file, and writes the result back when content changed. Skips binary / non-UTF-8 silently, respects `.gitignore`, caps at 5 MiB per file and 1 000 files in the IPC edit-log payload. Frontend [`ExplorerGrep.tsx`](src/modules/explorer/ExplorerGrep.tsx) gains `.*` regex toggle (with client-side `RegExp` validation that displays "bad regex" inline), `Aa` case-sensitivity toggle, a collapsible Replace row with `$1` / `$2` capture group support, and a "Replace all" button gated by a `window.confirm()` since it modifies files on disk.
- **`Ctrl+G` keybinding for "Go to file".** Added as the second default binding on `explorer.search` (alongside the existing `Ctrl+Shift+P`). Label changed from "Search files" to "Go to file" to match VS Code terminology.
- **Native AI-visibility hint on private tabs.** Hovering a tab marked as private now surfaces a tooltip "Not visible to the native AI agent" in red. Combines with the existing SSH / AI-CLI tooltips when those also apply, appending the private note as an extra line in the same `TooltipContent`.

### Changed

- **Status-bar layout reorg.** Extension borderless icons (Discord status item + Screenshot compact panel toggle) now cluster at the leftmost slot of the status-bar right group so the icon row reads as one unified cluster instead of being separated by `ZoomIndicator` / `SchedulerStatusPill` / `UpdaterPill`. `RightPanelToggleButtons` split into `RightPanelCompactToggles` (next to `ExtensionStatusItems`) and `RightPanelTextToggles` (next to `AiOpenButton` / `ScmRightOpenButton`).
- **Status-bar icon overhaul.** `AiOpenButton` gets `SparklesIcon` (matches the auto-generate-commit-message button in SourceControlPanel). First-party panel toggles render HugeIcons line-art via a `HUGE_ICON_MAP` keyed by extension id so the camera icon (Camera01Icon for `tedi.screenshot`) and folder icon (Folder02Icon for `tedi.secondary-folder-tree`) match the rest of the status bar visually instead of each extension shipping its own raster logo.
- **File-tree selection contrast (sidebar-accent tokens).** Selected file row in [`FileTreeNode.tsx`](src/modules/explorer/FileTreeNode.tsx) switches from `bg-accent text-foreground` to `bg-sidebar-accent text-sidebar-accent-foreground` — the token pair documented as "Selected workspace / selected file row" in [`customTheme.ts`](src/modules/settings/customTheme.ts). Hover state to `hover:bg-sidebar-accent/40`. `ExplorerSearch` / `ExplorerGrep` active-hit rows also switch from `text-foreground` → `text-accent-foreground` so the paired token wins on themes where `accent` and `foreground` weren't designed as a high-contrast pair.
- **Theme preset contrast bumped to WCAG AA (≥4.5:1).** Tokyo Light selection fg lifted from `#3760bf` to `#1a2238` (~10:1). Catppuccin Light fg from `#4c4f69` to `#1e1e2e` (~9:1). Solarized Light fg from cream `#fdf6e3` to base03 `#002b36` (~5:1, the gold-on-cream selection was unreadable at 2:1). Solarized Dark body text from `#839496` to `#93a1a1` (~5:1). Monokai Light accent from `#0099a8` to `#006d75` (~5.6:1) and sidebar-accent from `#75715e` to `#5e5b4a`. Dark presets (Default, Tokyo, Nord, Catppuccin, Monokai, Matrix) already passed; not touched.
- **CLI `tedi ext` ANSI colors.** [`cli_ext.rs`](src-tauri/src/modules/cli_ext.rs) switches `dialoguer::Select::new()` → `Select::with_theme(ColorfulTheme)` so the `>` selection indicator + prompt gain dialoguer's coloured default. Custom ANSI helpers paint `[official]` tags cyan, `[unofficial]` yellow, `[on]` green, `[off]` dark gray, version / id / source / description dim, and update hints yellow. Auto-disabled on non-TTY stdout and when `NO_COLOR` is set.
- **SCM "Changes" tab.** Dropped the file-count badge from the tab label so the tab strip reads simply "Changes" / "Graph". The count was visible-but-redundant — the changes list right below already shows every file.
- **Tab context-menu "Mark as Private/Public".** Removed the leading `LockedIcon` so the menu item is text-only, matching the rest of the context-menu actions ("Toggle Split Orientation", "Move to New Tab", "Join Group", "Close Tabs to the Right") which are all icon-free.
- **Em-dash sweep.** Bulk-replaced `—` (U+2014 EM DASH) with `-` (U+002D HYPHEN-MINUS) across 49 source files (215 occurrences). Scope: `*.ts/tsx/rs/js/md/json/toml` excluding `node_modules/target/dist/.git/build`.

### Extension surface

- **`tedi.terminal-screenshot` renamed → `tedi.screenshot`.** Manifest `id`, display `name`, repository (now [`IlhamriSKY/TEDI.screenshot`](https://github.com/IlhamriSKY/TEDI.screenshot)), and command IDs all drop the `terminal-` segment while keeping the `tedi.` namespace prefix. Single command `tedi.screenshot.capture` (default `Mod+Alt+S`) replaces the previous toggle / captureActive / captureAll trio. Existing installs need uninstall + reinstall once because TEDI keys extensions by manifest id.
- **Screenshot extension migrated to a sidecar-based capture pipeline (v0.5.0).** Native deps (`xcap` + `image` + Linux `libpipewire-0.3-dev`) are NOT in TEDI core - they live in the extension's own `sidecar-src/` crate, built per-platform in the extension's release CI and bundled into the release zip as `sidecar/<platform>-<arch>/tedi-screenshot-helper`. Extension spawns the helper per click via the generic `invoke:shell_bg_spawn_direct` host capability, reads base64 PNG from stdout via `shell_bg_logs`. Same pattern as `tedi.discord-rich-presence`. TEDI core stays generic; uninstalling the extension removes every screenshot-specific dep with it. See the extension's [v0.5.0 changelog](https://github.com/IlhamriSKY/TEDI.screenshot/blob/main/CHANGELOG.md) for the full architecture rationale.

## [0.2.24] - 25-05-2026

### Added

- **Theme presets with editable user list.** Built-in presets stay; a new `userThemePresets` preference holds user-created variants. "Save as preset" inline input next to the Reset button captures the current `customTheme` (minus its wallpaper) under a name of the user's choosing; the entry appears alongside built-ins in the preset grid with an "your preset" sub-label and a hover-× delete affordance. Name collisions auto-suffix `(2)` / `(3)` so a saved preset never silently shadows a built-in.
- **First-class OpenRouter and 9Router via OpenAI Compatible presets.** The "OpenAI Compatible" connector in Settings → Models gains a Quick-start chip row - **OpenAI / OpenRouter / 9Router (local)** - that pre-fills the base URL so users don't have to remember whether OpenRouter's path is `/v1` or `/api/v1` (it's the latter; everyone trips on this), or which port the local 9Router server uses (20128). The chips are hidden once a key is configured to keep the configured row compact.
- **Source Control right-panel variant.** New session-scoped `useScmRightPanelStore` parallel to the AI sidebar / extension right panels - all three live in the same right slot and a three-way mutual-exclusion effect block in `App.tsx` reconciles them. Preference `sourceControlInRightPanel` (default off) gates the mode; toggle is in General settings. Includes a new `GitGraphView` tab for the commit graph.

### Changed

- **Settings → Models layout overhaul.** "+ Add provider" dropdown moves to the top of the providers section (with built-in search box + max-height capped to ~5 rows + scroll); the configured-provider cards list below it. Default chat model and editor autocomplete settings are merged into a single bordered "Defaults" card with inline label-control rows. The chat dropdown / autocomplete picker / default model dropdown all filter out unconfigured providers so the chip cluster stays focused on what actually works.
- **Settings → Theme layout overhaul.** Outer `gap-6` → `gap-4`; preset card padding and swatch size shrink one tier; wallpaper Blur / Opacity / Darken sliders re-housed in a single `CompactSliderRow` panel instead of three separate `SettingRow`s. Two `SettingRow`s ("Use background image" + "From URL") merged into a single bordered row: one URL input + Browse + Use URL + Clear + enable switch - only one source can be active at a time because they share the same backing field. A faint "Source: …" line under the row tells the user whether the current wallpaper came from a local file or a URL.
- **Settings → Models chat-dropdown filtered to configured providers.** The previous behaviour listed every provider in the registry regardless of whether the user had pasted a key for it; with 10 entries the "+ key please" affordances drowned the few rows that actually worked.

### Fixed

- **"AI detected but model isn't" - OpenAI Compatible URL commit race.** Typing a new base URL and immediately pressing **Save** on the API key (without first clicking out of the URL field) used to fire the auto-detect against the *old* URL because `commitURL` only ran on blur. `OpenAICompatibleBlock.saveKey` now commits the URL first and passes the freshly-committed URL through to the parent's auto-refresh, so the value React hasn't re-rendered yet can't leak into the request. Matches the user-reported "input AI terdetect tapi model tidak" symptom.

### Repo metadata

- `Cargo.toml`, `tedi-cli/Cargo.toml`, `tauri.conf.json`, `package.json` all gain `description` / `authors` / `license` / `repository` / `homepage` / `bugs` fields so the crate / installer / npm-style metadata reflects the IlhamriSKY/TEDI fork. NSIS `installerIcon` set to `icons/icon.ico`; upstream Crynta copyright + `licenseFile` reference added.

## [0.2.23] - 25-05-2026

> 0.2.22 was tagged but type-check failed because in-flight SCM-right-panel
> code from a separate branch sneaked into the App.tsx I edited; 0.2.23
> is the clean shipping cut of the same OpenRouter feature.

### Added

- **First-class OpenRouter provider.** OpenRouter ([openrouter.ai](https://openrouter.ai)) joins OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, and SumoPod as a top-row provider with its own API-key card, dedicated icon, dropdown group, and runtime model catalogue. Picks up keys with `sk-or-` prefix; pings `https://openrouter.ai/api/v1/models` with the user's key plus the standard `HTTP-Referer` + `X-Title` headers OpenRouter uses for dashboard attribution. Eight curated defaults (Claude Opus 4 / Sonnet 4, GPT-5 / 5-mini, Gemini 2.5 Pro, DeepSeek Chat V3, Grok 4, Llama 3.3 70B) populate the dropdown before the live catalogue resolves so the picker is never empty. Detected models carry the real maker as `ownedBy` (parsed from the `<maker>/<model>` slug or OpenRouter's `top_provider.name`) so the chat chip credits *Anthropic* / *OpenAI* / *Google* - not the gateway. Wired through `agent.ts` via `@ai-sdk/openai-compatible` so model selection, transport, and chat history all behave identically to native providers. New module: [`src/modules/ai/lib/openrouter.ts`](src/modules/ai/lib/openrouter.ts).

### Fixed

- **"AI detected but model isn't" - OpenAI Compatible URL commit race.** Typing a new base URL and immediately pressing **Save** on the API key (without first clicking out of the URL field) used to fire the auto-detect against the *old* URL, because `commitURL` only runs on blur. The most painful version: paste an OpenRouter URL + key, hit Save → /models fetched against `api.openai.com/v1` with the OpenRouter key → 401 → "Detection failed". `OpenAICompatibleBlock.saveKey` now commits the URL first and passes the freshly-committed URL all the way through to the parent's auto-refresh, so the value React hasn't re-rendered yet can't leak into the request. Symptom matched the user report "input AI terdetect tapi model tidak".

## [0.2.21] - 24-05-2026

### Fixed

- **Extension manifests with forward-compat fields no longer break install on older TEDI.** `PanelSchema` and `ContributesSchema` in [`src/modules/extensions/manifest.ts`](src/modules/extensions/manifest.ts) now use Zod `.passthrough()` instead of `.strict()`. Previously, declaring any panel field the host did not yet recognise - e.g. an extension targeting TEDI 0.2.21 setting `contributes.panels[].compact: true` against an installed TEDI 0.2.19 build - failed parse with `Invalid manifest: contributes.panels.0: Invalid input` and rendered the install dialog unusable. With `.passthrough()`, unknown keys flow through the parsed manifest, the host iterates only what it knows about, and the `engines.tedi` constraint still gates hard if the extension actually requires the new behaviour to work. This matches the VS Code convention where unknown manifest fields are silently tolerated. The change is host-side only; no extension reauthoring needed.

## [0.2.20] - 23-05-2026

### Fixed

- **`tedi --help` / `--version` / `--update` / `ext` no longer leave PowerShell with a garbled prompt on Windows.** Root cause: `TEDIApp.exe` (formerly `TEDI.exe`) is built with `windows_subsystem = "windows"` so PowerShell - the Windows 11 default - does NOT synchronously wait for it. The shell redraws the next prompt the moment it spawns the child, and the binary's `AttachConsole`'d output then lands on top of (or below, depending on timing) that already-drawn prompt. The cursor ends up mid-line; the user has to press Enter to recover and the display reads scrambled. The previous v0.2.18 attempt (`delegate_cli_to_console_binary` re-execing `tedi-cli.exe` from inside the GUI binary) did not fix this - PowerShell had still moved on before the GUI even started executing.
- **New approach: console-subsystem launcher `tedi.exe` (built from [src-tauri/src/bin/tedi-cli.rs](src-tauri/src/bin/tedi-cli.rs)).** It is what PATHEXT resolves the user's `tedi` to - the GUI binary is renamed to `TEDIApp.exe` via Tauri's `mainBinaryName` config specifically to keep it off PATHEXT's `tedi.exe` lookup. The stub:
  - Handles `--help` / `--version` inline (no Tauri runtime boot, no process spawn).
  - Spawns `TEDIApp.exe` synchronously with `Stdio::inherit` for `--update`, `ext`, `--extension` - output streams to the shell in real time, exit code propagates.
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

- **`tedi ext` ratatui TUI removed; interactive picker is back to `dialoguer`.** The v0.2.17 fullscreen dashboard could not reliably read keystrokes on Windows even with the v0.2.18 `tedi-cli.exe` console-companion workaround - alt-screen contention with the parent shell varied by terminal host. Reverted to inline output + arrow-key `dialoguer::Select` pickers, the same approach v0.2.13 shipped, extended so every subcommand whose target arg is omitted opens an interactive picker on a TTY:
  - `tedi ext` (no subcommand) → action menu
  - `tedi ext install` (no ref) → registry picker (or typed input as last item)
  - `tedi ext uninstall` / `enable` / `disable` (no id) → installed-list picker
  - All other subcommands behave exactly like v0.2.13
  - Non-TTY (CI, pipes) still prints the legacy plain table + a hint instead of stalling on the picker
- **Install pipeline keeps its granular progress reporting from v0.2.17.** `InstallProgress` trait and `install_from_bytes_with_progress` remain; the CLI now drives them with a single-line overwrite (`\r\x1b[2K`) so download MiB and extract file-counts update in place instead of scrolling. GUI install path still uses `NoopProgress` - unchanged.
- **`tedi-cli.exe` console-subsystem companion removed.** No longer needed once the alt-screen TUI is gone. `installer.nsh` reverted to the v0.2.16 shape, release workflow drops the dedicated `cargo build --bin tedi-cli` step. `windows_subsystem = "windows"` on the main binary is harmless for the dialoguer-based picker because it never enters raw mode - `AttachConsole` is enough for inline `println!` + arrow keys.

### Removed

- `src/modules/cli_ext_tui/` (and its seven sub-files), `src/bin/tedi-cli.rs`, the `delegate_cli_to_console_binary` plumbing in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs), and the `ratatui` / `crossterm` / `futures-util` Cargo dependencies. The TUI plus its console-companion added 1 800 lines and a second binary without delivering a working Windows experience.

## [0.2.18] - 22-05-2026

### Fixed

- **`tedi ext` TUI now actually responds to keyboard input on Windows.** v0.2.17 shipped the dashboard but `TEDI.exe` is built with `windows_subsystem = "windows"` (so a `tedi .` from Explorer doesn't pop a console window). PowerShell waits for the GUI binary to exit, but the binary has no console attached for stdin - `AttachConsole(ATTACH_PARENT_PROCESS)` re-establishes stdout (good enough for the v0.2.13 `println!`-only CLI) but does NOT cleanly hand crossterm's `EventStream` a stdin handle it can poll. Result: TUI rendered, keys did nothing. New `tedi-cli.exe` console-subsystem companion (built from [src-tauri/src/bin/tedi-cli.rs](src-tauri/src/bin/tedi-cli.rs)) takes over for `ext`, `--extension`, `--update`, `--version`, `--help` and owns stdin cleanly. `TEDI.exe` detects those argv shapes at the top of `lib::run` and re-execs the sibling with inherited stdio (`delegate_cli_to_console_binary` in [src-tauri/src/lib.rs](src-tauri/src/lib.rs)). The `tedi.cmd` NSIS shim has the same delegation as a belt-and-suspenders for `tedi.cmd ext` direct invocations. Bundled via `bundle.resources` in [tauri.windows.conf.json](src-tauri/tauri.windows.conf.json); the release workflow now runs `cargo build --release --bin tedi-cli` before `tauri-action` so the binary exists at bundle time.
- **Dropped `EnableMouseCapture` from the TUI setup.** Some Windows console hosts (legacy conhost, older Windows Terminal builds) interleave mouse-tracking escape sequences with arrow-key input in ways crossterm's `EventStream` parses inconsistently, swallowing navigation keypresses. Navigation is keyboard-only anyway, so the capture provided zero value and one real footgun. Restore path drops `DisableMouseCapture` to match.

### Notes

- macOS / Linux are unaffected by both fixes. The main `tedi` binary on those OSes inherits stdin natively (no subsystem split), so it runs the TUI directly without the console-companion hop. The `tedi-cli` bin still compiles cross-platform but is only bundled into the Windows installer.
- Older Windows installs (≤ v0.2.17) that auto-update to v0.2.18 will receive `tedi-cli.exe` next to `TEDI.exe` via the NSIS installer's normal file-overwrite step. No manual action required.

## [0.2.17] - 22-05-2026

### Added

- **Full TUI dashboard for `tedi ext` subcommands.** All extension management - install / list / installed / update / uninstall / enable / disable - now opens a single keyboard-driven `ratatui` dashboard on a TTY, replacing the v0.2.13 line-by-line `println!` + `dialoguer::Select` UX. Three tabs (Installed / Registry / Updates) switchable via `Tab` / `Shift-Tab` / `1` `2` `3` / `h` `l`. Vim-style nav (`j`/`k`, `g`/`G`, PageUp/Down), filter via `/` (case-insensitive substring on id + name + description), refresh current tab via `r`, help overlay via `?`. Modal stack for confirmations: install (editable text input + live progress gauge), uninstall (y/N), enable/disable (y/N), update one, update all (sequential with per-item progress + cumulative log). Each subcommand opens the dashboard with the relevant tab focused and the matching modal pre-filled - `tedi ext install owner/repo` pops the install modal with the ref already typed, `tedi ext uninstall <id>` opens the confirm modal once the installed list lands, `tedi ext update <id>` checks just that id, etc. New module [src-tauri/src/modules/cli_ext_tui/](src-tauri/src/modules/cli_ext_tui/) (mod / app / ui / events / actions / input / theme). Panic-safe terminal restore via a `Drop` guard so a crash never strands the user's shell in raw mode / alternate screen.
- **Granular install progress reporting.** New `InstallProgress` trait + `InstallPhase` enum in [src-tauri/src/modules/extensions/install.rs](src-tauri/src/modules/extensions/install.rs) lets callers observe `Downloading { bytes_done, bytes_total }` → `Verifying` → `Extracting` → `Finalizing` → `Done`, plus a per-file callback (`progress.file(index, total, path)`) for every entry the extractor writes. The TUI install modal renders a live gauge backed by these events; download phase shows MiB / total when content-length is known, extract phase shows `N / M files` with the current relative path. Existing `install_from_bytes` is kept as a thin wrapper over `install_from_bytes_with_progress` with a `NoopProgress` impl, so the GUI install path in [extensions/commands.rs:303](src-tauri/src/modules/extensions/commands.rs#L303) (`ext_install_from_zip`, `ext_install_from_github`) is byte-for-byte unchanged.
- **Streaming HTTP download with progress callback.** [`http_get_bytes_with_progress`](src-tauri/src/modules/extensions/commands.rs) (sibling to the existing `http_get_bytes`) accumulates `reqwest::Response::chunk()` reads and fires a `FnMut(bytes_done, bytes_total)` closure on every chunk, with one initial `(0, total)` tick before the first byte lands so the TUI can render a meaningful "0 / N" before transfer begins. Same caps + timeouts as the non-streaming version (50 MiB hard cap, 15 s connect, 5 min total). Old `http_get_bytes` reduced to a one-line wrapper that passes a no-op closure, so every other caller in the extension pipeline is unchanged.
- **`--plain` / `-p` flag on `tedi ext`.** Forces the legacy text output (v0.2.13 shape) even when stdout is a terminal. Useful when the user wants pipe-friendly output without redirecting (`tedi ext installed --plain | grep on`). Non-TTY auto-fallback still works the same - pipes, redirected stdout, and CI shells get the plain printer without needing the flag.

### Changed

- **`tedi ext list` interactive picker replaced by the TUI Registry tab.** The v0.2.13 `dialoguer::Select` arrow-key picker is gone (and the `dialoguer` crate dropped from `Cargo.toml`). TTY users land in the Registry tab and press `Enter` / `i` to install; non-TTY / `--plain` users get the OFFICIAL / UNOFFICIAL table dump + install hint that v0.2.13 already printed alongside the picker. No change to the install plumbing beneath either path.
- **`cli_ext.rs` refactored into data fns + plain-mode printers.** The seven legacy `cmd_*` subcommand handlers no longer interleave logic with `println!`; pure-data fns (`load_installed_rows`, `check_updates_only`, `install_reference_with_progress`, `do_uninstall`, `do_set_enabled`, `install_github`) are now `pub(crate)` and consumed by both the plain printers and the TUI. New `InitialFocus` enum maps each subcommand + argv shape to the right TUI screen on launch.
- **Top-level `tedi --help` mentions the TUI + `--plain` flag** so the dashboard is discoverable from the entry point.

### Fixed

- **`InstallOutcome` derives `Debug`** so it can travel through the TUI's channel-backed message bus (`AppMsg::InstallDone(Box<Result<InstallOutcome, String>>)`). GUI code never logged it, so this was a no-op for existing call sites. Boxed inside `AppMsg` to keep the enum's largest variant from dominating channel-slot size for every other (tiny) variant - caught by `clippy::large_enum_variant`.

## [0.2.16] - 22-05-2026

### Added

- **Sort dropdown in the file explorer header.** New radio menu (`Sorting02Icon` button next to *Collapse folders*) with five options: Default (Rust-side folders-first + A→Z, the previous behavior), Name A→Z, Name Z→A, Modified newest first, Modified oldest first. The "modified" modes mix folders and files by `mtime` (Finder-style); the "name" modes preserve folders-first. Sort is applied client-side on the already-fetched listing - switching modes does not refetch, expansion state survives, and the trigger icon turns from `text-muted-foreground` to `text-foreground` when a non-default sort is active so the user can see at a glance that the listing is reordered. Selection persists across sessions via `localStorage` under `tedi:explorer:sortMode`. The sort applies to every `FileExplorer` mount, including the secondary folder-tree extension. See [src/modules/explorer/lib/useFileTree.ts](src/modules/explorer/lib/useFileTree.ts) (`sortEntries`, `SortMode`) and [src/modules/explorer/FileExplorer.tsx](src/modules/explorer/FileExplorer.tsx) for the trigger.
- **Active-file reveal in the main file tree.** Opening a file (editor tab, AI-proposed diff, or git diff) now expands every ancestor folder, selects the row, and scrolls it into view in the left explorer - the same affordance VS Code exposes as "Reveal in Explorer". New `activeFilePath` prop on `FileExplorer`; `App.tsx` derives it from the active tab and covers all three tab kinds (`editor` leaf, `ai-diff`, `git-diff`). SSH editor leaves are excluded (their `path` is remote and wouldn't match the local explorer root). The status-bar breadcrumb now also follows diff tabs because it consumes the same memo.

### Changed

- **`mountFolderTree` reset button uses a distinct icon.** The "Back to workspace folder" affordance (visible only after the user manually picks a folder via Open Folder) was rendered with `Cancel01Icon` and destructive hover styling, making it visually indistinguishable from the adjacent "Close panel" X. Reset now uses `Home02Icon` with the neutral `hover:text-foreground` style; Close keeps `Cancel01Icon` with destructive hover. Tooltips and aria-labels updated to match. See [src/modules/extensions/components/mountFolderTree.tsx](src/modules/extensions/components/mountFolderTree.tsx).
- **Source Control panel separator renders consistently.** The thin divider below the panel header now shows regardless of whether the current workspace is a git repo, so the empty / "no repo" state has the same chrome as the populated one instead of collapsing into a denser layout.

### Fixed

- **Files at the workspace root level now reveal correctly.** The first cut of the reveal effect treated `ancestors.length === 0` as "file outside the workspace" and zeroed out the target, which silently skipped any file sitting directly under the root (e.g. `README.md` at `D:/proj/`). Restructured the guard so `isUnderRoot` is checked explicitly, then `ancestors=[]` only means "no expansion needed" and the reveal still fires.
- **Auto-reveal survives a collapsed-explorer round trip.** While the left explorer is collapsed, its body and `listRef` are unmounted, so the very first `scrollIntoView` after activating a file had nothing to scroll. The reveal effect now also depends on `collapsed`: it short-circuits while collapsed and re-runs when the user uncollapses, so the file lands in view as soon as the panel reopens.
- **Reveal selection no longer raced the stale-selection cleanup.** The existing `selectedPath` cleanup effect cleared the highlight before the lazy `fs_read_dir` fetches for ancestor folders could land - so even when the row eventually appeared in `flat`, it wasn't selected. Selection is now deferred to a second effect that runs after the row is observed in `flat`, so the highlight only sets once it can stay.

## [0.2.15] - 22-05-2026

### Added

- **Right-panel extension hook system.** New generic surface for extension-contributed panels that slide in from the right of the workspace, mutual-exclusive with the AI sidebar. Three contribution-registry consumers wired today (`panels` with `surface: "right"`, `commands`, `keybindings`) plus matching host-API additions: `ctx.registerPanelRenderer(panelId, fn)`, `ctx.panel.{open,close,toggle}(panelId)`, and `ctx.ui.mountFolderTree(container, opts)` that embeds TEDI's built-in `FileExplorer` so extensions get pixel-identical icons / indent / expand-collapse / click-to-open without reimplementing the tree. Manifest gains `panels[].toggleCommand`, `panels[].defaultOpen`, `panels[].hideHostHeader`. New components in [src/modules/extensions/components/](src/modules/extensions/components/): `RightPanelHost` mounts the active renderer, `RightPanelToggleButtons` auto-generates a status-bar pill per panel that visually matches `AiOpenButton` (height, motion drop-in, hover accent, `<Kbd>` chip showing the bound shortcut). Reference: [IlhamriSKY/TEDI.secondary-folder-tree](https://github.com/IlhamriSKY/TEDI.secondary-folder-tree). The codebase ships zero secondary-folder-tree code - every facility is generic and any extension can use it.
- **Extension keybindings + commands now dispatched.** Previously declared but unwired. New [`useExtensionShortcuts`](src/modules/shortcuts/lib/useExtensionShortcuts.ts) hook walks `keybindingsRegistry` + `commandsRegistry` on every keydown, fires the matching runtime handler bound via `ctx.registerCommandHandler`. User overrides land in `preferences.extensionShortcuts` and rebind from a new **Extensions** group in Settings → Shortcuts that auto-renders one row per contributed binding (record / clear / reset all generic). Stored shortcuts persist via the existing `tauri-plugin-store` flow.
- **Extension workspace bridge.** New [`extensionWorkspaceBridge`](src/modules/extensions/workspaceBridge.ts) populated by `App.tsx` with the live `handleOpenFile` so `ctx.ui.mountFolderTree` routes click-to-open through the same path the left-side explorer uses (editor tab). Narrow surface on purpose - adding a field widens what every extension can reach.
- **Drag a file from the explorer onto a terminal pane → shell-quoted path appears at the prompt.** Works from the built-in left sidebar AND from any extension panel that mounts `FileExplorer` via `ctx.ui.mountFolderTree`. Cross-platform via the existing `quoteForShell`: PowerShell / cmd double-quote on Windows, POSIX single-quote close-escape-open on macOS / Linux. New `ensureFsDragListener` in [useTerminalFileDrop.ts](src-tauri/../src/modules/terminal/lib/useTerminalFileDrop.ts) synthesizes drag gestures from `mousedown` / `mousemove` (5 px threshold) / `mouseup` rather than HTML5 drag-drop, because Tauri's default `dragDropEnabled: true` installs an OS-level intercept that consumes drag events before the WebView can preventDefault on them - HTML5 drag inside the WebView produced the "not allowed" cursor on every drop zone. Mouse events are not part of the intercept surface, so they fire reliably on all three desktop WebViews (WebView2, WKWebView, WebKitGTK). Visual feedback: body cursor flips to `copy`, the terminal pane under the cursor gets a `--ring`-colored outline. Cancellation via `Escape`, window blur, or releasing outside a terminal. Right-button mouseup mid-gesture no longer commits prematurely; missed mouseup off-window auto-recovers on the next mousedown.
- **`FileExplorer` becomes embeddable.** New optional props `headerExtras?: ReactNode`, `hideCreateActions?: boolean`, `hideGrep?: boolean` let consumers reuse the component with a compact toolbar - `ctx.ui.mountFolderTree` injects an Open Folder picker + reset + close icons into `headerExtras` and hides the New file / New folder buttons. The left-sidebar call site is unchanged because all three props default to off.

### Changed

- **Settings webview now seeds extension registries.** `SettingsApp` calls `useExtensionsStore.getState().init()` once at mount so the new Extensions row in *Settings → Shortcuts* sees every installed extension's `keybindings` / `commands`. Previously the Settings tab was the only window that didn't call init, which made the new shortcut group render empty for users browsing the Settings tab without ever opening the Extensions tab.
- **`mountFolderTree` mounts a fresh React root.** Uses `createRoot` into the extension's panel container with `TooltipProvider` re-wrapped at the inner root (React context doesn't cross root boundaries). `ThemeProvider` is intentionally NOT re-wrapped - next-themes manages a class on `document.documentElement` that cascades naturally; two providers would fight over the same class. Disposer is auto-tracked by the host so extensions that forget to wire cleanup don't leak a React root past deactivate.
- **Documentation rewrites across the Rust backend.** Roughly 170 files had their doc-comments tightened - same behavior, shorter prose, fewer parenthetical asides. No functional change.

### Reference

- [Secondary Folder Tree](https://github.com/IlhamriSKY/TEDI.secondary-folder-tree) - first extension to exercise every right-panel hook (panel surface, command + keybinding contributions, `ctx.panel`, `ctx.ui.mountFolderTree`, workspace bridge). The example handles a missing host backend gracefully - `activate()` probes `ctx.ui.mountFolderTree`, `ctx.panel.toggle`, `ctx.registerPanelRenderer` before using them and stays idle (with one warning toast) when run against an older TEDI build, mirroring the Discord reference's graceful-degradation pattern.

## [0.2.14] - 21-05-2026

### Fixed

- **Auto-update no longer wipes app data (history + settings).** The Windows NSIS installer now snapshots `%APPDATA%\id.ilhamrisky.tedi\` to `%TEMP%\tedi-userdata-backup` in `NSIS_HOOK_PREINSTALL`, then restores from the snapshot in `NSIS_HOOK_POSTINSTALL` when key files (`tedi-settings.json` or `tedi-sessions.json`) are missing post-install. Defensive against Tauri NSIS template variants that wipe app data on `passive`-mode upgrades - the data dir lives outside `$INSTDIR` so the current template shouldn't normally touch it, but auto-update calls whichever uninstaller is already on disk, which may belong to a buggier prior build. Belt-and-suspenders: backup runs only when the data dir already exists (no-op on fresh install) and restore only triggers when the gate files are missing (no-op on a clean overwrite). Uses `xcopy /E /I /Y /H /K /Q` for both legs.

### Added

- **Status-bar AI context indicator.** The context-usage ring moves out of the AI composer's bottom toolbar and into the status bar's right cluster, between `ZoomIndicator` and `UpdaterPill`. New [`StatusBarContextIndicator`](src/modules/ai/components/StatusBarContextIndicator.tsx) mounts `useChat` against the active session so the ring stays live; multiple `useChat` calls on the same `Chat` instance stay in sync via the SDK's internal store. Only renders when the AI panel is open and a session exists - bar stays empty for users who don't touch AI. The numeric percentage is hidden via a `[&_button>span:first-child]:hidden` selector against the upstream `ContextTrigger` (no edit to `ai-elements/`); the hovercard still surfaces the full breakdown (model, used / window tokens, session input/output/cached) on hover.
- **Download progress in the status-bar updater pill.** `UpdaterPill` previously showed only `"Update"` while downloading; the percentage was tucked into the tooltip. Pill label now inlines `Updating <pct>%` (or bytes when `contentLength` is unknown), giving live feedback at a glance while the bundle streams.

### Changed

- **Fallback AI context window bumped from 128k to 256k.** `getModelContextLimit` returned `128_000` for any model not listed in `MODEL_CONTEXT_LIMITS`, which fired the auto-compact toast prematurely on runtime-detected models that ship larger windows. Bumped the default to `256_000` and pinned the value behind a named `FALLBACK_CONTEXT_LIMIT` constant so the rationale lives next to the literal. Models with a known hard cap (e.g. `gpt-oss-120b`, `openai/gpt-oss-20b`) stay accurate via their explicit `128_000` entry - they really are capped at 128k upstream, so doubling them would just delay the compaction trigger past the API's actual ceiling.
- **AI composer toolbar de-cluttered.** With the context ring moved to the status bar, the composer's bottom toolbar drops to just `AgentSwitcher` + `AiStatusBarControls`. `AiInputBar` still accepts the `messages` prop because the shell-style ArrowUp/Down recall in `useMentionSearch`-adjacent code reads it; the only removal is the `<ContextIndicator>` mount.

## [0.2.13] - 21-05-2026

### Added

- **`tedi ext` extension CLI.** Headless companion to Settings → Extensions. Lives in [src-tauri/src/modules/cli_ext.rs](src-tauri/src/modules/cli_ext.rs) and short-circuits out of `lib::run` before Tauri boots, so install / list / update / uninstall happen against the same `<app_data_dir>/extensions/` directory and `state.json` the GUI manages, then `process::exit`s. Both forms are accepted: `tedi ext <subcmd>` and `tedi --extension <subcmd>` (alias). Subcommands:
  - `install <REF>` - three-way classifier: existing file → install via `install_from_bytes` (source `local:<path>`); `owner/repo` or GitHub URL → fetch `releases/latest`, pick the `.zip` asset (or `zipball_url` fallback), install (source `github:<o/r>`); otherwise resolve as a registry id against `https://tedi.ilhamriski.com/extensions/`. Path-shaped inputs that don't resolve short-circuit with a targeted error instead of burning a registry round-trip.
  - `list` - fetches the public registry. On a TTY, opens an arrow-key `dialoguer::Select` picker; non-TTY (CI / pipes) prints the OFFICIAL / UNOFFICIAL groups and an `install <id>` hint.
  - `list --installed` / `installed` - walks the extensions root + state, prints `[on]/[off] <name> (id) v<X>` plus an "→ vY available" hint when `latest_version` is newer than the installed `version`.
  - `update [<ID>]` - checks every `github:`-sourced install (filtered to `<ID>` when given) against `releases/latest`, persists `latest_version` + `last_checked_at_ms`, then prompts `(y/N)` before applying. EOF-safe and non-TTY-safe: closed stdin treated as "skip", CI shells get a "run on a TTY or use `tedi ext install <id>`" hint with the per-id apply commands.
  - `uninstall <ID>` - refuses with "extension not installed" when neither the directory nor the state entry exists (stricter than the GUI's silent-success path so a typo doesn't print "Uninstalled" misleadingly).
  - `enable <ID>` / `disable <ID>` - flip the `enabled` flag on the existing state entry, error out on unknown id.
- **Windows installer shim passes `ext` and `--update` through synchronously.** `tedi.cmd` previously detached every non-version/help arg through `start ""` so the GUI launch wouldn't pin the shell. The shim now special-cases `ext`, `--extension`, `--update`, and `-u` to invoke `TEDI.exe` synchronously, so when the .cmd path is reached explicitly the user's terminal actually sees CLI stdout. The .exe path (which PATHEXT resolves first in cmd/PowerShell) was already correct via `AttachConsole`.
- **Headless `tedi --update` / `-u` on all three desktop OSes.** Sibling pattern to `tedi ext`: short-circuits out of `lib::run` before Tauri boots, so the GUI never opens. New module [src-tauri/src/modules/cli_update.rs](src-tauri/src/modules/cli_update.rs). Flow: fetch `latest.json` from the configured updater endpoint, compare versions, prompt `(y/N)` on a TTY (auto-accept on non-interactive shells), download the bundle for the current platform key (`<os>-<arch>`), verify its minisign signature against the pubkey baked into `tauri.conf.json` via [`minisign-verify`](https://crates.io/crates/minisign-verify) - the same crate `tauri-plugin-updater` uses internally - then install in place. Per-platform install:
  - **Windows**: spawn the NSIS installer with `/PASSIVE /UPDATE`. NSIS holds no handles on the running EXE, so it replaces `TEDI.exe` cleanly.
  - **Linux**: AppImage in-place swap via `$APPIMAGE`. `.deb`/`.rpm` installs need root + the system package manager - surface a clear `apt`/`dnf` hint instead of pretending to update.
  - **macOS**: extract the `.app.tar.gz` via system `tar -xzf`, rename the running `.app` to `<name>.app.old`, `mv` the new bundle into place. Rollback on failure leaves the old `.app` back where it was so the user is never stranded without TEDI.

  Pubkey format: Tauri config embeds both pubkey and per-platform signature as base64-wrapped minisign file-format text - `verify_signature` unwraps the outer base64 on each side before handing the inner text to `minisign-verify::PublicKey::decode` / `Signature::decode`. The test `pubkey_constant_decodes` enforces the embedded constant round-trips so a future edit can't silently break verification on every release.
- **Compaction pulse badge in the AI mini-window.** A brief 6-second tone-coded badge appears next to the context indicator every time the auto-compactor (or manual `/compact`) runs, surfacing even Stage 1 (lossless dedup) passes so the user can literally see every compaction. The popover gains a new "last compact" line with relative age (`5s ago`, `2m ago`) and per-stage breakdown (`dropped N · elided N · dedup`). Toast surfacing is unchanged - still only fires for Stage 2 (elision) and Stage 3 (drop) with the same per-session throttle.

### Changed

- **Extension HTTP helpers gain connect + total timeouts.** `extensions::commands::http_get_text` (small JSON, 15 s connect + 30 s total) and `http_get_bytes` (asset download, 15 s connect + 300 s total) now build their `reqwest::Client` with explicit caps so an unreachable host fails in 15 s and a stalled mid-stream download can't hang the install pipeline indefinitely. Applies to both the GUI install / update flow and the new `tedi ext` CLI.
- **Promoted extension helpers to `pub(crate)`.** `normalize_owner_repo`, `pick_release_zip`, `pick_release_tag`, `compare_versions`, `strip_v_prefix`, `http_get_text`, `http_get_bytes` are now crate-visible so `cli_ext.rs` shares the install pipeline instead of forking it. `cli::attach_parent_console` is also `pub(crate)` for the same reason - the CLI prints through the same console-attach path the version/help short-circuit uses on Windows.

### Fixed

- **Manual `/compact` now stamps `lastCompact` like auto-compact.** Previously the in-header pulse badge only fired on auto-compaction passes; running `/compact` via the slash menu skipped the indicator, making the user think the manual command "didn't run." Slash command now classifies the drop as Stage 3 and patches `agentMeta.lastCompact` the same way the per-turn compactor does, so the badge fires consistently across both paths.

## [0.2.12] - 21-05-2026

### Added

- **Drag-and-drop reorder inside split groups.** Each pane leaf in a split tab now carries its own drag handle and can be shuffled among its siblings without disturbing the rest of the strip. Backed by a nested dnd-kit `SortableContext` with `leaf:<id>` items inside each split's wrapper; a new `reorderLeafInTree` tree-op moves the leaf among its **direct** split siblings (cross-level warps stay no-ops by design - sequential `Ctrl+D` splits are flat, so the typical case is fully covered). The leaf id, FIFO `terminalOrdinal`, cwd, SSH binding, editor dirty/preview state, and the underlying PTY / xterm / CodeMirror session all travel with the leaf - drag is purely a positional reshuffle, no respawn.
- **Whole-split-group drag via dedicated grip.** A small vertical-dots grip appears on the left edge of every bordered split cluster (tooltip "Drag group"). It carries the outer-context sortable's listeners so the whole split moves through the strip in one piece, while the leaves inside keep their own per-leaf drag handles for in-group reorder. Non-split tabs are unchanged - the sole entry doubles as the tab and its drag handle.
- **`/schedule` slash command.** Schedules a terminal command to run at a parsed natural-time ("in 5 minutes", "at 3pm", "tomorrow at 9am") through the existing `schedule_command` tool. Picker entry uses the calendar-add glyph and surfaces an `[time] [command]` arg hint.
- **Auto-compact stages + toast surfacing.** `compactModelMessagesDetailed` now reports per-stage counts (`lossless` dedup of superseded reads, `elided` tool-result masking, `dropped` hard-trim of oldest messages) instead of one opaque counter. Stage 1 stays silent because it runs every turn and is reversible; Stage 2/3 raise a toast - warning when messages are dropped (information loss) and info when only elision happened. Per-session 12 s throttle prevents a chain of high-context turns from spamming notifications.
- **Zoom indicator in the status bar.** Status-bar pill renders only when content zoom differs from `100%`; clicking resets to the default. Source of truth is `preferences.contentZoom`, same field the Cmd/Ctrl+= / Cmd/Ctrl+- shortcuts already drive.

### Changed

- **Tab drag collision detection switched to scoped `closestCenter`.** Default `rectIntersection` flickered between "last tab" and `null` when dragging past the strip's end, which made the snap-back-to-original gesture wobble. The new strategy filters droppables by drag-kind first (tab drags only consider `tab:*`, leaf drags only `leaf:*`) so a tab drag can't accidentally snap onto a leaf in another group's inner sortable context. Snap-back is now deterministic - return the dragged tab to its original spot and release.
- **`/compact` is force-mode.** Manual `/compact` no longer silently no-ops below the 70%-context auto threshold. Below threshold it drops the oldest ~quarter of messages (capped to preserve `keepTail`), above threshold it falls back to the original drop-until-50% loop. Zero-drop now only happens when the whole chat fits inside `keepTail`, and the toast says so plainly instead of "under threshold".
- **Slash-command toasts honour `variant`.** `composer` previously called `console.info` for slash-command results; it now routes through the real `toast()` so success / info / warning / error variants render with the matching colour.
- **Workspaces panel header redesign.** New header bar matches the other sidebar sections - leading glyph (`DashboardSquare02Icon`) + uppercase-cased title + vertical separator + the existing "New workspace" action - height bumped from 28 px to 32 px so the row aligns with the local-files / SCM / SSH headers above it.
- **Sortable group structure refactored.** Outer SortableContext IDs prefixed (`tab:<n>`) so the new inner per-leaf context (`leaf:<m>`) can coexist in the same DndContext; per-entry rendering extracted to a shared `renderEntryBody` helper so the leaf-sortable and tab-sortable paths share JSX. No user-facing change beyond the new gestures above.

## [0.2.11] - 21-05-2026

### Added

- **Cursor-position AI CLI detection.** The xterm cursor's current line is now the canonical "where is the user RIGHT NOW" signal - independent of alt-screen toggle, OSC handlers, or shell-integration. When the cursor sits on a recognisable system shell PS1 (`]$`, `user@host:path$`, zsh `%`, `PS C:\>`, `C:\path>`), the previously-active AI CLI is treated as gone, period. Closes the gap left by the prior alt-screen / shell-prompt / TUI-marker triad, which each had edges (claude v2.1+ inline rendering, killed CLIs that never emit `\x1b[?1049l`, SSH drops leaving ghost state).
- **AI CLI status on SSH leaves.** The detector runs on the byte stream regardless of whether the PTY is local or remote, so a remote `claude` / `codex` / `opencode` session now lights up the tab icon the same way as a local one. SSH disconnect resets the detector's `activeTool` so the icon doesn't ghost forward into the next reconnect.
- **History-recall / paste-then-Enter command activation.** When `cmdBuffer` is empty on Enter - because the user recalled a command via ↑, accepted shell completion via Tab+Enter, or pasted-then-pressed-Enter - the detector now strips the PS1 prefix off the cursor's prompt line and runs that through `matchTool`. Previously these paths bypassed the keystroke accumulator and never activated the tool.
- **Stable FIFO terminal ordinals.** The number rendered on each terminal tab chip - and surfaced to the AI in the per-turn `<env>` block - is now a `terminalOrdinal` assigned once at leaf creation. The same number travels with the leaf across split moves, tab reorders, workspace serialisation, and app restarts. "terminal 3" the user pinned in their head before quitting stays "terminal 3" forever. Older saved state without the field is backfilled on hydration via `maxTerminalOrdinal(tabs) + 1`.
- **`activeTabKind` in the extension App-context snapshot.** Extensions can now distinguish `terminal` / `ssh` / `editor` / `diff` / `preview` for the focused tab via `ctx.app.getContext()` / `onContextChange`. `null` when no tab is active.

### Changed

- **TabBar icon IS the AI CLI status indicator.** The separate `idle` / `working` / `blocking` chip is gone; the terminal-leaf icon tints emerald (idle) / yellow-pulse (working) / red-pulse (blocking) directly. Less visual noise on each tab, and the icon's bounding box becomes the hit target for the tooltip rather than a tiny chip beside it.
- **SSH status now tints the tab title, not the cloud icon.** `connecting` / `reconnecting` pulse yellow, `connected` turns emerald, `disconnected` / error turns red - colour lives on the text. The cloud icon stays neutral sky so the colour cue belongs to the label, not the glyph.

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
- **SSH file tree follows the active SSH terminal's cwd.** When the focused SSH leaf reports an OSC 7 cwd, the tree roots there instead of falling back to the SFTP home directory - mirrors how the local file tree tracks whichever terminal pane is focused. The home directory remains the bootstrap fallback before the shell has emitted OSC 7.

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
