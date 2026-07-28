# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.3.95] - 28-07-2026

### Added

- **TEDI asks before it quits on top of a running terminal.** Closing the window while a terminal is busy (a full-screen TUI, a command still running, or an AI agent mid-turn) now opens a prompt instead of taking the decision for you. "Leave them running" closes the window while the PTY daemon keeps every session alive, so they reattach on the next launch; "Close all terminals" kills them outright; Cancel keeps you where you are. Busy is the same test the tab-close confirmation already used, so the two agree. See [useQuitGuard.ts](src/app/hooks/useQuitGuard.ts), [sessionState.ts](src/modules/terminal/lib/sessionState.ts), [AppDialogs.tsx](src/app/components/AppDialogs.tsx).

### Changed

- **TEDI now reads "Terminal Director" everywhere.** The old expansion ("Terminal Environment & Development Infrastructure") is replaced across the README, the docs, the installer metadata, the `tedi --help` banner, and the About panel. See [README.md](README.md), [tauri.conf.json](src-tauri/tauri.conf.json), [cli.rs](src-tauri/src/modules/cli.rs), [AboutSection.tsx](src/settings/sections/AboutSection.tsx).

### Fixed

- **The close button works again.** Clicking X (or pressing Alt+F4) did nothing: the window handler asked the backend to destroy the window, but `core:window:allow-destroy` was never granted in the capability file and `core:default` does not include it, so the request was denied into a discarded promise and every close path was dead. See [default.json](src-tauri/capabilities/default.json), [App.tsx](src/app/App.tsx).
- **The AI's side-by-side review tab opens again on Windows.** Files saved with CRLF line endings are the norm on Windows, and the preview that builds the diff compared the model's LF-only text against them without translating, so any multi-line edit silently failed to render and you were left approving a write you could not see. It now normalizes exactly the way the edit tool itself does. See [AgentRunBridge.tsx](src/modules/ai/components/AgentRunBridge.tsx), [edit.ts](src/modules/ai/tools/edit.ts).
- **A remote file tab no longer comes back pointing at your local disk.** An editor opened over SFTP is bound to a live SSH session number, which is meaningless after a restart, so the restored tab quietly fell back to local file access: it read whatever sat at that path on your own machine, and the next save wrote over it. Remote editor panes are now left out of the saved layout rather than restored wrong, and any terminal or editor split beside them still comes back. See [serialize.ts](src/modules/workspaces/serialize.ts), [useDocument.ts](src/modules/editor/lib/useDocument.ts).
- **The AI no longer treats a remote directory as a local one.** With an SSH terminal focused, the working directory handed to the AI's file and shell tools was the remote host's path, even though every one of those tools runs locally. It now falls back to the workspace root, matching what the file explorer already did. See [buildLiveContext.ts](src/app/lib/buildLiveContext.ts).
- **The "open in browser" pill no longer appears for a remote dev server.** A `npm run dev` over SSH prints a `localhost` URL that belongs to the remote host, and the pill offered to open that port on your own machine. Detection is now limited to local terminals. See [pty-lifecycle.ts](src/modules/terminal/lib/pty-lifecycle.ts).
- **A restored workspace focuses the tab you left active.** The saved active-tab index counted tabs that were then dropped from the save, so a workspace holding an extension panel reopened with the wrong tab in front. See [serialize.ts](src/modules/workspaces/serialize.ts).
- **Quitting with "Close all terminals" no longer leaves a stray shell behind.** Killing every session made the daemon report each one as exited, which the pane handler read as a normal close and answered by tearing down panes and spawning a replacement shell, overwriting the layout on the way out. See [usePaneHandles.ts](src/app/hooks/usePaneHandles.ts), [pty/mod.rs](src-tauri/src/modules/pty/mod.rs).
- **Cancelling a quit no longer closes the Settings window.** Child windows now follow the main window's actual destruction rather than the close request the prompt can veto. See [lib.rs](src-tauri/src/lib.rs).

### Security

- **"Semi" approval mode no longer auto-runs a command that reads your keys.** The mode auto-approved a list of read-only command prefixes but never looked at the argument, so `cat ~/.ssh/id_rsa` and `cat .env` ran with no prompt and with the secret deny-list never consulted. Auto-approval now requires the whole command to clear that deny-list; anything it flags falls back to asking, so a deliberate read is still one click away. `find` was also dropped from the list, since `-delete` and `-exec` make it a mutating command that the prefix check could not see. See [AgentRunBridge.tsx](src/modules/ai/components/AgentRunBridge.tsx), [security.ts](src/modules/ai/lib/security.ts).
- **An unattended sub-agent can no longer enumerate directories outside the workspace.** `list_directory` was missing the out-of-scope refusal its three sibling read tools carry; because a sub-agent has no approval prompt, the approval gate on it was inert. See [fs.ts](src/modules/ai/tools/fs.ts).
- **An unattended sub-agent can no longer start a background process outside the workspace.** The safety check inspected the command text only, so an explicit working directory reached the spawn unchecked. See [shell.ts](src/modules/ai/tools/shell.ts).

## [0.3.94] - 23-07-2026

### Changed

- **The app opens faster.** Enabled extensions now activate in parallel instead of one at a time, so a single extension that waits on the network or a subprocess (a usage meter curling an endpoint, a relay agent) no longer holds up every other extension's status items and panels from appearing. The code editor and the AI composer are also no longer loaded on the first frame - each loads the moment you first open an editor or the AI panel - trimming roughly 1.3 MB of JavaScript (the editor stack, the markdown renderer) off the initial paint. And the accumulated AI chat history is no longer serialized across the app bridge on every launch. See [loader.ts](src/modules/extensions/loader.ts), [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx), [AiInputBarConnect.tsx](src/modules/ai/components/AiInputBarConnect.tsx), [sessions.ts](src/modules/ai/lib/sessions.ts), [vite.config.ts](vite.config.ts).
- **The status-bar zoom control only appears while you are zoomed.** The minus / percentage / plus pill now hides at 100% and returns the moment you zoom in or out, keeping the status bar clean at the default zoom. Zooming in from 100% is still available from the keyboard shortcut. See [ZoomControl.tsx](src/modules/statusbar/ZoomControl.tsx).

### Fixed

- **An inactive tab's terminal scrollbar no longer bleeds over the active pane.** WebView2 could composite a hidden xterm's native scrollbar above the visible tab; hidden terminal panes now use `display: none` (their PTY and xterm session stay alive and re-fit on return) so the compositor can't surface the stray scrollbar. See [TerminalPane.tsx](src/modules/terminal/TerminalPane.tsx), [PaneStack.tsx](src/modules/panes/PaneStack.tsx).

## [0.3.93] - 21-07-2026

### Added

- **Split-pane layouts keep their proportions across a restart.** Reopening a workspace already restored your panes, but every split snapped back to an equal size. The divider positions you set now persist and are restored exactly as you left them. See [panes.ts](src/modules/terminal/lib/panes.ts), [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx), [serialize.ts](src/modules/workspaces/serialize.ts).
- **A "done" state for the terminal AI-agent badge.** The per-terminal status (idle / working / waiting for approval) gained a fourth state: a finished turn now shows a distinct "done" glance, held until you focus or type in that terminal, so among many terminals you can tell at a glance which agent just completed. See [aiCliStatus.ts](src/modules/terminal/lib/aiCliStatus.ts), [aiCliDetector.ts](src/modules/terminal/lib/aiCliDetector.ts).

### Changed

- **A running agent is recognized again after a restart.** When a reopened workspace reattaches to a still-running agent, the badge resumes its working / waiting-for-approval state immediately instead of going blank until you type a command. Launching an agent indirectly - `npx claude`, `bunx opencode`, or an absolute path - is now detected too. See [aiCliDetector.ts](src/modules/terminal/lib/aiCliDetector.ts), [session-lifecycle.ts](src/modules/terminal/lib/session-lifecycle.ts).

### Fixed

- **Panes no longer disappear after a terminal error or an update.** A transient empty snapshot could overwrite a saved layout, and a locked or partial read during an update handoff could blank the saved workspaces. An empty snapshot never overwrites saved panes now, a failed read retries before falling back, and the layout is flushed to disk before the window closes - so a pane you closed also stays closed instead of reappearing. See [store.ts](src/modules/workspaces/store.ts), [App.tsx](src/app/App.tsx).
- **The agent badge no longer sticks on "waiting for approval" (red) while it is actually working.** A stray phrase in the agent's own output could latch a false approval state over an actively-generating turn and hold it for a full minute; an "esc to interrupt" hint now overrides it and the hold is much shorter. See [aiCliDetector.ts](src/modules/terminal/lib/aiCliDetector.ts).
- **"Finished" no longer fires mid-turn, especially for Claude.** A quiet stretch inside one turn (a silent sub-agent) could trip a premature completion; the agent's own busy signal is now trusted until it clears or the shell prompt returns. See [aiCliDetector.ts](src/modules/terminal/lib/aiCliDetector.ts).

## [0.3.92] - 20-07-2026

### Added

- **Local AI models (Ollama, llama.cpp, vLLM) now work end to end.** Bring-your-own-key already covered the hosted providers, but a local endpoint was rejected before it could ever connect: the model builder demanded an API key, so a keyless Ollama or llama.cpp server could not be used at all. A loopback base URL (`127.x` / `localhost` / `[::1]`) now counts as keyless, while a remote gateway still gets the actionable "add a key" message instead of a bare 401, and one-click presets were added for Ollama (`:11434`), llama.cpp (`:8080`) and vLLM (`:8000`). See [config.ts](src/modules/ai/config.ts), [OpenAICompatibleBlock.tsx](src/settings/sections/components/OpenAICompatibleBlock.tsx).
- **Editor autocomplete works with every provider, not just three.** Ghost-text completion was hardwired to Cerebras / Groq / LM Studio, so anyone holding only an OpenAI, Anthropic or local key got nothing. It now runs on all ten providers with a fast default model each, and the settings block gained a model-id field so a local model name can be entered directly. See [autocomplete/provider.ts](src/modules/editor/lib/autocomplete/provider.ts), [AutocompleteBlock.tsx](src/settings/sections/components/AutocompleteBlock.tsx).
- **A `read_browser_console` tool so the AI can see what a page logged.** A document-start capture script folds `console.error`/`warn`, `onerror` and unhandled rejections into a 200-entry ring buffer (so load-time errors are caught too) that the AI drains on demand, closing the browser-debug loop that nothing in the app previously closed. This brings the AI command count to 103. See [preview/embed.rs](src-tauri/src/modules/preview/embed.rs), [browser/lib/native.ts](src/modules/browser/lib/native.ts).
- **The AI can read images.** `read_file` now falls back to a binary read and returns real image files (PNG/JPEG/GIF/WebP) as image parts, capped at 4 MB; SVG stays text. See [tools/fs.ts](src/modules/ai/tools/fs.ts).
- **Extension API: `ctx.ai`, `ctx.paths.home` and clickable status items.** Extensions can now read the live AI state and, behind the new `ai:configure` / `ai:prompt` permissions, set the model, toggle sub-agents, or send a prompt (`setApprovalMode` is deliberately not exposed, since it is the one AI setting that persists across restarts). `StatusItem.onClick` renders a real button instead of a click-hijacking span, and `ctx.paths.home` was added. See [host.ts](src/modules/extensions/host.ts), [registries.ts](src/modules/extensions/registries.ts).
- **A refreshed model line-up.** Added GPT-5.x, Claude Opus 4.8 / Sonnet 5 / Fable 5, Gemini 3.5, Grok 4.5 and newer Groq models; every legacy id is kept so an existing saved selection never breaks. See [config.ts](src/modules/ai/config.ts).

### Changed

- **Forced sub-agent fan-out now keys off breadth, not message length.** A study verb paired with a breadth cue ("audit the whole codebase", "analisa arsitektur sistem ini") reliably pins the first step to a sub-agent fan-out, while narrow single-file study ("pahami fungsi ini", "analyze the whole file") still does not. The previous fixed 40-character floor rejected genuinely broad but short requests, so the breadth word - not the sentence length - now makes the call. See [orchestrationIntent.ts](src/modules/ai/lib/orchestrationIntent.ts).
- **Cheaper AI turns on gateways without prompt caching.** Per-step history compaction used to rewrite old messages on every provider, which busts the prefix cache on those that have one; it now only does so for cache-less gateways and when the payload is actually large, and Anthropic prompt-cache breakpoints are re-applied per step (capped so they never exceed the four-breakpoint ceiling). See [compact.ts](src/modules/ai/lib/compact.ts), [cache.ts](src/modules/ai/lib/cache.ts).
- **The install review shows what an extension's AI tools actually say.** Contributed AI-tool descriptions - the text injected into every AI turn, and the real prompt-injection surface - are now disclosed before you consent, not just the tool names. See [InstallReviewDialog.tsx](src/settings/sections/components/InstallReviewDialog.tsx).

### Fixed

- **Keyless local models now appear in the model pickers.** A provider-level filter dropped the entire OpenAI-Compatible provider whenever the shared key slot was empty, so a working keyless local endpoint's models were hidden from both the chat model dropdown and the default-model picker, and the per-instance readiness check downstream never ran. The provider is now gated per instance, so a loopback endpoint's models show and are selectable. See [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx), [DefaultModelDropdown.tsx](src/settings/sections/components/DefaultModelDropdown.tsx).
- **A floated terminal honors your scrollback setting.** The pop-out terminal hardcoded a 10,000-line scrollback, ignoring the preference and doubling the memory a user who lowered it had asked to save; it now reads the setting and follows later changes. See [FloatTerminal.tsx](src/float/FloatTerminal.tsx).
- **Installing an extension can no longer leave an uninstallable "ghost".** The TypeScript manifest schema was stricter than the Rust validator, so an extension Rust accepted but TypeScript rejected installed with a success toast yet never appeared in Settings and could not be removed from the UI. The schemas were relaxed to match the backend and the invariant documented. See [manifest.ts](src/modules/extensions/manifest.ts).
- **A bad extension manifest and a failed activation clean up after themselves.** A malformed manifest now surfaces a toast instead of a silent console warning, and an extension whose `activate` threw no longer leaves its settings card and commands on screen until restart. See [loader.ts](src/modules/extensions/loader.ts).

### Security

- **Extension risk tiers no longer under-warn on wildcard permissions.** The install badge derived its risk level separately from what a permission actually grants, so broad patterns (`*:*`, `invoke*`, `s*`, `shell:*`, `*fs_*`) all granted a high-risk capability while badging only medium. The tier is now derived by probing the real permission check, and `mcp_` (which can launch arbitrary binaries) and the new `ai:` permissions are rated high. See [permissions.ts](src/modules/extensions/permissions.ts).
- **One extension can no longer silently install or approve another.** The extension-management commands (`ext_install_from_zip` / `_from_github` / `ext_enable` / `ext_disable` / `ext_uninstall`) were added to the hard-deny invoke list, since reaching them would let an extension mint install-time consent for a second one. See [permissions.ts](src/modules/extensions/permissions.ts).
- **A cross-provider credential leak in autocomplete is closed.** The completion key was held in a bare ref while the provider was read fresh from the store, so switching provider and then typing shipped the previous provider's API key to the new provider's endpoint. The key reference now carries its provider provenance and is re-checked after the async key fetch. See [EditorPane.tsx](src/modules/editor/EditorPane.tsx), [autocomplete/provider.ts](src/modules/editor/lib/autocomplete/provider.ts).
- **Unattended sub-agent shells are now scope-checked.** An autonomous worker's `bash` was the one tool with no scope enforcement; its commands now run their path tokens through the same secret deny-list and out-of-scope check the file tools use, blocking obvious reads like `cat ~/.ssh/id_rsa` or absolute paths outside the workspace. It raises the bar rather than sandboxing (a shell cannot be fully scoped by inspecting a string), and only the auto-approved worker path is affected - the approval-gated main agent is unchanged. See [security.ts](src/modules/ai/lib/security.ts), [tools/shell.ts](src/modules/ai/tools/shell.ts).

## [0.3.91] - 18-07-2026

### Added

- **Remote (SSH) Source Control.** With an SSH terminal focused, the Source Control panel now reports that remote machine's repository instead of the local workspace: branch, upstream, ahead/behind, and the changed-file list. This needed a new remote command primitive, since SSH sessions previously offered only an interactive shell and SFTP, and it reuses the existing porcelain parsers unchanged. It is deliberately **read only** - commit, push, discard, diff, and history all run local git, so those controls are omitted rather than shown against the wrong repository. It also follows only the *focused* terminal, so a backgrounded SSH session never quietly hides your local source control. Per-file line counts are not shown for remote entries (counting them reads the local disk). See [ssh/mod.rs](src-tauri/src/modules/ssh/mod.rs), [ssh/session.rs](src-tauri/src/modules/ssh/session.rs), [SourceControlPanel.tsx](src/modules/scm/SourceControlPanel.tsx).
- **A zoom control in the status bar.** The zoom readout moved to the far left and became a real control: minus, the current percentage, and plus as one segmented pill, styled to match the badges beside it. Each segment runs the same command as its keyboard shortcut, and the readout resets to 100% when clicked. It is now always visible - the old readout hid itself at 100%, which is exactly the state you need a zoom-in button from. See [ZoomControl.tsx](src/modules/statusbar/ZoomControl.tsx).

### Fixed

- **The left sidebar no longer comes back shut after minimizing the window.** Reported repeatedly and mis-diagnosed three times, this was never about detecting the minimize. A minimize (and the restore after it) drives the window's client area through small but non-zero widths, and the panel library re-derives a pixel `minSize` against whatever the container currently measures - so at roughly 90px wide the sidebar's 130px minimum became 65% of the container, the panel was snapped shut, and a growing container never revisits that decision. The sidebar's minimum is now expressed as a percentage, which is invariant to container size, so the collapse is structurally impossible rather than detected and undone. The previous detect-and-undo machinery is deleted; it could never win, because the restore can re-collapse the panel after any fixed timer has already fired. See [AppSidebar.tsx](src/app/components/AppSidebar.tsx), [App.tsx](src/app/App.tsx).
- **Refresh in the Remote (SSH) file tree now re-reads every open folder, not just the root.** Expanded subfolders kept whatever listing they had when first opened, and nothing else ever re-read them - collapsing and re-expanding served the cache - so from the outside the remote tree simply could not be refreshed. Refresh now re-pulls the root and every expanded folder without flashing them back to a loading state, and the tree also refreshes when the window regains focus and on a slow interval while visible. See [useSshFileTree.ts](src/modules/ssh/useSshFileTree.ts).
- **A `cd` in an SSH terminal no longer collapses the remote folder tree you were browsing.** The remote shell reports its working directory on every prompt, and the tree followed it by resetting to the new root - throwing away the folders you had just expanded. Expanding a folder now hands the tree's root to you; the Back button returns it to following the terminal. Following still applies until you touch the tree, so opening a session still lands you where the shell is. See [SshFileExplorer.tsx](src/modules/ssh/SshFileExplorer.tsx), [useSshNav.ts](src/modules/ssh/useSshNav.ts).
- **The Remote panel stops jumping to a different host when you click a local tab.** With two or more SSH sessions open, leaving the SSH tab handed the panel to whichever session came first in tab order, resetting the tree's navigation and expansion. It now stays on the session it was already showing. See [useSshLeafState.ts](src/app/hooks/useSshLeafState.ts).
- **Remote file rows no longer offer actions that cannot work.** "Reveal in Finder" passed a remote path to the local file manager and always failed; it is hidden for remote entries, and "Attach to Agent" no longer renders where nothing is wired to it. See [FileTreeNode.tsx](src/modules/explorer/FileTreeNode.tsx).

### Changed

- **Typing in an SSH terminal no longer re-serializes the workspace on every prompt.** Because the remote shell reports its directory each time a prompt is drawn, every single Enter allocated a fresh tab array and wrote the workspace layout back to disk. The update is now skipped when the directory has not actually changed. See [useTabs.ts](src/modules/tabs/lib/useTabs.ts).

## [0.3.90] - 18-07-2026

### Added

- **Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).** A searchable overlay lists every command grouped by category, each with its keyboard shortcut shown as a key badge; picking one runs it through the normal shortcut system. Contributed by [@praneshnikhar](https://github.com/praneshnikhar) in [#7](https://github.com/IlhamriSKY/TEDI/pull/7), then reworked so the palette can run *every* command: commands owned by a component rather than the app shell (the file explorer's "Go to file", "Search in files" and "Replace in files") used to do nothing when picked, and now dispatch through a shared command registry. Non-runnable entries (documentation-only key hints, the palette itself) are hidden. See [CommandPalette.tsx](src/modules/commandPalette/CommandPalette.tsx), [commandRegistry.ts](src/modules/shortcuts/lib/commandRegistry.ts).
- **The folder search panel has a close button.** The "Find text in files" panel could only be dismissed with Escape; it now has an X in the search row that closes it. See [GrepSearchBar.tsx](src/modules/explorer/components/GrepSearchBar.tsx).
- **Remote Access mirrors the desktop's terminal title.** The browser previously re-derived each tab's window title from its own copy of the stream, so it went stale after a scrollback reset and was blank for a browser that joined a running full-screen agent late. The host's captured title now travels to the browser over the existing tab-metadata channel, so the web tab reads the same as the app. See [host.ts](src/modules/extensions/host.ts), [useAppContextBridge.ts](src/app/hooks/useAppContextBridge.ts).

### Changed

- **"Go to file" moved to `Ctrl+P` / `Cmd+P`.** `Ctrl+Shift+P` now opens the Command Palette (VS Code parity); "Go to file" keeps its `Ctrl+G` / `Cmd+G` alternative. See [shortcuts.ts](src/modules/shortcuts/shortcuts.ts).

### Fixed

- **A dropped PTY daemon now reconnects on its own instead of wedging every terminal until you restart the app.** The GUI opened a single daemon connection at startup and kept it for the whole session, so any daemon death (a crash, an idle shutdown, the pty startup race) made every new tab and every retry report "daemon connection dropped" forever. The daemon client now reconnects (respawning the daemon if needed) on the next terminal operation, and the startup race that could abort the daemon returns an error instead of taking the whole daemon down. See [pty/mod.rs](src-tauri/src/modules/pty/mod.rs), [pty_daemon/server.rs](src-tauri/src/modules/pty_daemon/server.rs).
- **The left file explorer comes back exactly as you left it after a window minimize and restore.** The restore step read the window's own resize event to tell a minimize apart from a restore, but that check raced and sometimes never ran, and the open/closed decision combined several per-path flags that could disagree once the sidebar was closed one way and reopened another. Minimize is now read synchronously from the resize payload, and a single source of truth records the sidebar's intended state across drag, toggle, and extension hide/show. See [App.tsx](src/app/App.tsx), [useExtensionSidebarBridges.ts](src/app/hooks/useExtensionSidebarBridges.ts).
- **A reconnected SSH session no longer inherits stray terminal modes from the dropped one.** When a remote program (vim, htop, tmux) dies with the connection it never sends its mode-reset teardown, so mouse tracking or the alternate screen stayed on and streamed garbage into the fresh shell. The terminal now runs that teardown itself on a drop. See [ssh-session.ts](src/modules/terminal/lib/ssh-session.ts).

## [0.3.89] - 14-07-2026

### Fixed

- **The SQL Explorer's "Read only" badge shows its lock icon again.** The connection read-only pill asked the host for the `SquareLock02Icon` glyph, but the legacy hugeicon→Lucide alias map only carried the `01` variant, so the icon resolved to nothing and the badge rendered as bare text. Added the `02` alias (mapped to Lucide `Lock`), which also covers any other extension that references it. See [iconRegistry.ts](src/lib/iconRegistry.ts).
- **The AI composer's bottom toolbar no longer overlaps, and Send stays pinned to the bottom-right.** Every control inherited the button base's `shrink-0`, so a long model name (for example `qwen-2.5-72b-instruct · via OpenAI Compatible`) pushed the action row past the panel width and clipped the Send button. The model selector is now the one control that gives up width (its label and provider hint truncate as a single line), the action group shrinks and stays flush-right, and Send is always fully visible whether the toolbar sits on one row or wraps to two. See [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx), [AiStatusBarControls.tsx](src/modules/ai/components/AiStatusBarControls.tsx).
- **The left sidebar keeps its width after you minimize and then maximize the window.** It tracked and restored its width in pixels, but the minimize animation passes the container through shrinking widths that overwrote the saved value, so the folder tree came back narrower. It now tracks and restores the sidebar as a *percentage* of the window, which react-resizable-panels holds constant while only the pixel width changes, so it returns at exactly the size you left it. See [App.tsx](src/app/App.tsx).

## [0.3.88] - 14-07-2026

### Added

- **The Remote (SSH) file explorer gains Back / Forward / Up plus a clickable breadcrumb.** The tree still follows the terminal's cwd, but you can now climb out of it: a navigation row above the tree steps Back and Forward through visited folders (browser-style, a forward branch is discarded when you go somewhere new), goes Up one level, and jumps to any ancestor from the breadcrumb. Once you navigate it pins to the chosen folder so terminal activity can't yank the tree out from under you; stepping Back past the start returns to following the shell, and a reconnect or a switch to a different remote resets the history so it never replays a stale path. See [useSshNav.ts](src/modules/ssh/useSshNav.ts), [SshFileExplorer.tsx](src/modules/ssh/SshFileExplorer.tsx).

### Fixed

- **Browsing a remote folder from the status-bar breadcrumb no longer fails with "the system cannot find the path".** Under an SSH session the breadcrumb path is remote, but its subfolder dropdown listed over the *local* `list_subdirs`, and clicking a segment repointed the *local* workspace root at that remote path (which then persisted across reloads and broke the local explorer). The breadcrumb now lists subfolders over SFTP on the active session, and a breadcrumb `cd` under SSH targets only the remote shell without touching the local root. See [CwdBreadcrumb.tsx](src/modules/statusbar/CwdBreadcrumb.tsx), [useTabActions.ts](src/app/hooks/useTabActions.ts), [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx).
- **Permission-denied and missing folders now read clearly instead of dumping a raw OS error.** A folder you can't open shows "You don't have permission to open this folder." with a lock glyph in a muted tone, and a folder that's gone shows "This folder no longer exists.", in both the local and Remote (SSH) trees and the breadcrumb dropdown; only genuinely unexpected errors keep the loud red text. The mapping covers the Windows, Unix, and SFTP phrasings so it works whether the tree is local or remote. See [fsError.ts](src/lib/fsError.ts), [FileTreeNode.tsx](src/modules/explorer/FileTreeNode.tsx).
- **Ctrl+D now splits the pane even while a terminal is focused.** The split-right shortcut was previously swallowed by the terminal (a focused terminal owns Ctrl+D); it is now exempt from the terminal-chord gate so it fires the split like Ctrl+Shift+D (split-down) already did, winning over the shell's Ctrl+D EOF. See [App.tsx](src/app/App.tsx).

## [0.3.87] - 14-07-2026

### Added

- **Dropping files onto the Remote (SSH) tree now shows a live upload progress bar.** The SFTP upload streamed a file in one write, so the explorer had no way to show more than 0% then 100%; a large drop looked frozen. The backend now writes each file in 256 KiB chunks and streams `{written, total}` byte progress over a Tauri channel, and the SSH explorer renders a strip above the tree with the file name, a `1/3`-style counter for a multi-file drop, a moving percentage, and a real progress bar. Behaviour is otherwise unchanged (folders still rejected, 256 MB per-file cap, remote kernel enforces write permission). See [sftp.rs](src-tauri/src/modules/ssh/sftp.rs), [sftp.ts](src/modules/ssh/sftp.ts), [useSshFileDrop.ts](src/modules/ssh/useSshFileDrop.ts), [SshFileExplorer.tsx](src/modules/ssh/SshFileExplorer.tsx).

### Fixed

- **An open sidebar stays open after you minimize and restore the window.** The collapse detector keyed off the sidebar's pixel width, but minimizing the window drops the container to 0px while react-resizable-panels preserves the sidebar's layout percentage, so the minimize artifact was mistaken for a user close and the sidebar came back shut. It now treats only a zero *percentage* as a genuine collapse (a real drag or toggle sets the percentage to 0), so minimize/restore leaves the sidebar as you had it. See [App.tsx](src/app/App.tsx).

## [0.3.86] - 13-07-2026

### Added

- **Extension status-bar items can show a progress bar, a percentage, and a rich detail tooltip.** A status item may now carry a short `label` (for example `62%`), a `progress` value (`0..1`) that renders a compact pixel-style bar tinted by tone (green when there is headroom, amber when close, red when spent), and a structured `detail` tooltip that draws a real progress bar per row. A new read-only `note` setting type lets an extension surface live text, such as the signed-in account, in its Settings card. Together these back the new [AI Usage Meter](https://github.com/IlhamriSKY/TEDI.ai-usage) extension, which shows Claude Code and Codex (ChatGPT) 5-hour and weekly usage in the status bar. See [registries.ts](src/modules/extensions/registries.ts), [ExtensionStatusItems.tsx](src/modules/extensions/components/ExtensionStatusItems.tsx), [manifest.ts](src/modules/extensions/manifest.ts), [ExtensionCard.tsx](src/settings/sections/components/ExtensionCard.tsx).

### Fixed

- **Moving the built-in Files or Workspaces section to the right panel now works.** The right-dock shipped in 0.3.85 was dead on arrival: the shared placement guard validated the built-in `__section__:` sentinels against the extension registry, where they never matched, so a docked built-in section closed the moment it opened. It now validates built-in sections against the movable-built-ins list, so Workspaces docks to the right and back (Files stays left-only), verified in-app. See [useExtensionPanelDefaults.ts](src/app/hooks/useExtensionPanelDefaults.ts), [App.tsx](src/app/App.tsx), [Header.tsx](src/modules/header/Header.tsx), [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx).

## [0.3.85] - 13-07-2026

### Added

- **The Files and Workspaces sidebar sections can now move to the right panel.** A "move to right panel" button in each section's header docks it into the shared right slot, the same way Source Control and the Remote (SSH) explorer already do. The right-slot instance gains "move back to left" and "close" buttons, a status-bar toggle reopens it once closed, the left sidebar drops the section while it is docked, and it joins the mutual-exclusion set with the AI sidebar and the other right panels (opening one closes the others). The placement persists, and a docked section restores its open/closed state on the next launch. See [AppSidebar.tsx](src/app/components/AppSidebar.tsx), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx), [sidebarPlacementStore.ts](src/modules/extensions/sidebarPlacementStore.ts), [BuiltinSectionRightToggles.tsx](src/modules/extensions/components/BuiltinSectionRightToggles.tsx), [useDockedSectionAutoOpen.ts](src/app/hooks/useDockedSectionAutoOpen.ts).

### Changed

- **The workspace shell now reads as a "bento" of framed, floating panels.** The left sidebar sections (Files, Remote, Source Control, Workspaces), the center panes, and the right panel are each a distinct single-pixel-bordered card, separated by consistent gaps over a deep tray, so the sections stand out clearly; under a translucent app opacity the gaps reveal the wallpaper. The styling stays pure TEDI (square corners, one-pixel border lines) and the layout arrangement is unchanged. To keep every card visible against the tray in every theme, cards paint the canvas colour, which is distinct from the sidebar tray in all built-in themes, while still dimming to a legible floor under glass. See [App.tsx](src/app/App.tsx), [AppSidebar.tsx](src/app/components/AppSidebar.tsx), [WorkspaceArea.tsx](src/app/components/WorkspaceArea.tsx), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx).
- **A pane's terminal-theme picker moved from the right-click menu to a header gear button.** The gear icon sits between the float and close buttons in a terminal pane's header and opens the same theme list (follow-global plus every preset). The pane's right-click menu no longer carries the theme submenu; it keeps the "Split with &lt;extension&gt;" actions. See [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx).
- **Right-click in the terminal now copies your selection, or pastes when there is none.** Following the Windows Terminal / VS Code "copyPaste" convention, right-clicking a terminal that has an active selection copies it and clears the highlight (so the next right-click pastes); with no selection it pastes as before. This works identically for local and SSH terminals, routing paste through the bracketed-paste path so a multi-line snippet does not auto-execute. Select-to-copy on selection release, and `Ctrl+Shift+C` / `Ctrl+Shift+V` / `Shift+Insert`, continue to work. See [TerminalPane.tsx](src/modules/terminal/TerminalPane.tsx), [useTerminalSession.ts](src/modules/terminal/lib/useTerminalSession.ts).

### Fixed

- **The status bar hides the local-OS badge while the active pane is an SSH session.** The bottom-left "Windows / macOS / Linux" badge reflects the local machine, which is misleading when you are working in a remote shell (the breadcrumb already shows the remote path). It is now hidden whenever the focused pane is a connected SSH terminal, and shown again the moment you switch back to a local pane. See [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx), [App.tsx](src/app/App.tsx).

## [0.3.84] - 13-07-2026

### Added

- **The Remote (SSH) file tree shows Unix permissions.** Each remote file and folder now displays its `rwxr-xr-x` mode summary at the end of the row (muted, monospace), so you can see an entry's access rights, and why a directory is read-only, before you try to write. The mode already came back from the SFTP listing; it is now surfaced. Local (non-remote) rows are unaffected. See [FileTreeNode.tsx](src/modules/explorer/FileTreeNode.tsx), [sftp.rs](src-tauri/src/modules/ssh/sftp.rs).
- **Drag and drop local files onto the SSH file tree to upload them.** Drop one or more files from your file manager anywhere on the Remote panel and they upload over SFTP to the remote folder under the cursor: a folder row uploads into it, a file row into its parent, and empty tree space into the current root. The target directory refreshes and reveals the new files, with a toast on success or failure. A new backend `ssh_sftp_upload` reads the local file's bytes on the Rust side, so binary files transfer intact; folders are rejected (files only) and each file is capped at 256 MB. Write permission is enforced by the remote kernel, so a denied upload surfaces `permission denied`. See [useSshFileDrop.ts](src/modules/ssh/useSshFileDrop.ts), [SshFileExplorer.tsx](src/modules/ssh/SshFileExplorer.tsx), [sftp.rs](src-tauri/src/modules/ssh/sftp.rs).

### Fixed

- **An SSH pane header shows the connection's name, matching the tab.** A split pane's header read `ssh:<host>` (the raw IP) while the tab strip already read `ssh:<name>`; the two now use the identical label, so several connections to the same host stay distinguishable in the pane header too. See [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx).
- **The status-bar breadcrumb no longer shows a local Windows path under an SSH shell.** When the active terminal is a remote SSH session, the folder breadcrumb followed the remote shell's directory (reported via OSC 7) but fell back to the local workspace root when the remote had not reported one, so it could show a misleading local path. It now follows the remote directory only, showing "no directory" until the remote reports one, and never the local root. Local terminals are unchanged. See [useChromeDerivations.ts](src/app/hooks/useChromeDerivations.ts).

## [0.3.83] - 12-07-2026

### Fixed

- **The scrollbar no longer overlaps content in the scrolling panels.** The file explorer, the folder-wide Search results, extension sidebar sections, and the Workspaces panel draw a custom overlay scrollbar that floats over the content, so right-edge items could sit under the 10px thumb: the git M / A / U status letter in the file tree, the per-row "Replace" buttons in Search, and the hover actions plus tab-count pills in the sidebar panels. Each scrolling list now reserves the thumb's width so those items always clear the scrollbar, matching the clearance the Source Control panel already used. See [FileTreeNode.tsx](src/modules/explorer/FileTreeNode.tsx), [ExplorerGrep.tsx](src/modules/explorer/ExplorerGrep.tsx), [ExtensionSidebarSection.tsx](src/modules/extensions/components/ExtensionSidebarSection.tsx), [WorkspacesPanel.tsx](src/modules/workspaces/WorkspacesPanel.tsx).
- **The commit graph stays readable on a busy history.** Once a repository shows more than a handful of concurrent branch lanes, the graph column would push the commit subject and time off-screen (there is no horizontal scrollbar). Lanes now compress toward a minimum width as they get crowded, and the commit dot shrinks with them, so a wide history keeps its text visible instead of overflowing. See [GitGraphView.tsx](src/modules/scm/GitGraphView.tsx).
- **The Remote (SSH) connection menu no longer opens a stray tab.** Clicking an inline action button in a connection row (for example, edit) could trip Radix's menu-item click synthesis and also fire the row's connect action, opening an unwanted SSH tab. The action buttons now stop both the pointer-down and the pointer-up, so only the button fires. See [SshMenu.tsx](src/modules/ssh/SshMenu.tsx).
- **SSH tabs and panes show the connection's name.** A remote terminal's label now reads `ssh:<name>` when the saved connection has a name, falling back to the host or IP, so several connections to the same host stay distinguishable. See [entries.ts](src/modules/tabs/lib/entries.ts).

### Changed

- **Dependencies refreshed to their latest compatible releases.** About twenty npm packages (the CodeMirror themes, Tailwind, Vite, Radix, Motion, Prettier, Lucide, react-resizable-panels, the Tauri CLI, and the Node type definitions) and the Rust crate graph were updated within their existing version ranges, so no public API changed and the full `tsc` / build / clippy / test suite stays green. The AI SDK (`ai` v6, `@ai-sdk/*` v3) and the TypeScript compiler are deliberately held back, since their next majors are breaking and warrant a dedicated migration.
- **Internal cleanup: dead code removed and duplicated helpers unified.** Removed several unused exports and two never-imported barrel modules, and folded hand-rolled copies of the shared path helpers (`basename` / `pathSegments`), the regex-escape helper, the format-config file walk, and the path-change event bus back onto single implementations, so display and security logic can no longer drift apart. On the backend, the SSRF link-local / cloud-metadata block is now defined once and reused by both the request guard and the redirect guard, a redundant worker-thread hop in the agent shell session was removed, and duplicate process-creation flags and ANSI-paint closures were dropped. Behavior is unchanged and the codebase is a net ~160 lines lighter. See [pathChangeBus.ts](src/modules/ai/lib/pathChangeBus.ts), [configWalk.ts](src/modules/editor/lib/formatters/configWalk.ts), [net.rs](src-tauri/src/modules/net.rs), [session.rs](src-tauri/src/modules/shell/session.rs).

## [0.3.82] - 08-07-2026

### Added

- **Search and replace reaches VS Code parity, in both a single file and across a folder.** The in-editor find bar now shows the live "{current} of {total}" match position instead of only a total count, and seeks the first match as you type, so Enter / Shift+Enter walk the results with the counter tracking along. The folder-wide Search panel gains the same "{current} of {total}" readout plus explicit up/down navigation buttons, and, most importantly, per-result replace: hovering a match row reveals a "Replace" button that rewrites just that line, and hovering a file row reveals "Replace all in file", so you can replace one occurrence at a time or a whole file without triggering the folder-wide "Replace All" (which keeps its two-step confirm). See [EditorFindReplace.tsx](src/modules/editor/EditorFindReplace.tsx), [ExplorerGrep.tsx](src/modules/explorer/ExplorerGrep.tsx), [GrepHitRow.tsx](src/modules/explorer/components/GrepHitRow.tsx), [GrepFileRow.tsx](src/modules/explorer/components/GrepFileRow.tsx).

### Changed

- **A new `fs_replace_in_file` backend command powers the targeted replaces.** It rewrites either every match in one file or only the match(es) on a single 1-indexed line, feeding the regex just the line's own text so a replacement can never swallow the line terminator (`\n` or `\r\n`), and it never writes to disk on a no-op. Guarded by unit tests in [grep.rs](src-tauri/src/modules/fs/grep.rs).

## [0.3.81] - 08-07-2026

### Added

- **The Remote (SSH) file explorer can now dock in the right panel.** It previously lived only as a left-sidebar section; a "move to right panel" button in its header (plus a status-bar toggle) now hosts it in the shared right slot, mirroring the Source Control panel. The right-slot instance gains "move back to left" and "close" buttons, the left sidebar drops its SSH pane while docked, and the panel joins the mutual-exclusion set with the AI sidebar, Source Control, and extension panels (opening one closes the others). A new `sshInRightPanel` preference (default off) persists the choice, and the panel auto-closes when the last SSH session disconnects. See [sshRightPanelStore.ts](src/modules/ssh/sshRightPanelStore.ts), [SshFileExplorer.tsx](src/modules/ssh/SshFileExplorer.tsx), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx), [useRightPanelExclusion.ts](src/app/hooks/useRightPanelExclusion.ts).
- **Select-to-copy in the terminal.** Following the PuTTY convention, releasing a left-button selection (drag, double-click word, or triple-click line) copies it to the clipboard, so copying out of the terminal is just "highlight it". Right-click still pastes and Ctrl+Shift+C still copies. See [TerminalPane.tsx](src/modules/terminal/TerminalPane.tsx).

### Fixed

- **A focused terminal now also keeps bare-Alt readline meta sequences.** After v0.3.80 freed the Ctrl control codes, a shortcut-collision audit found `Alt+Z` (toggle word wrap) still shadowed the terminal's meta-z. A focused terminal now lets every bare-Alt chord on a letter or digit fall through to xterm (readline M-b / M-f / M-d word ops, M-1..M-9 digit-argument), while app chords that add Ctrl or Shift (Ctrl+Alt+P, Shift+Alt+F) stay active. A whole-catalog audit ([keybindings-collision-verify.ts](scripts/keybindings-collision-verify.ts)) confirms no two actions share a chord and every shell control code reaches the terminal. See [shortcuts.ts](src/modules/shortcuts/shortcuts.ts), [App.tsx](src/app/App.tsx).

## [0.3.80] - 07-07-2026

### Fixed

- **A focused terminal now keeps every Ctrl control code the shell needs, instead of the app stealing them.** On Windows and Linux the primary modifier is Ctrl, so the catalog's `Mod+letter` shortcuts (split, close tab, new editor, toggle sidebar, ask AI, show shortcuts, ...) were captured app-wide even inside a focused terminal, so `Ctrl+D` (EOF and the GNU screen / tmux detach `Ctrl+A Ctrl+D`), `Ctrl+L` (clear), `Ctrl+W` (kill-word), `Ctrl+E` (end-of-line), `Ctrl+K` (kill-line), `Ctrl+B` / `Ctrl+F`, `Ctrl+I` (Tab), `Ctrl+[` (Esc) and the rest never reached the shell. A single predicate now lets any bare-Ctrl control-code chord fall through to xterm when a terminal is focused, while app shortcuts that carry Shift/Alt/Meta (Ctrl+Shift+C copy, Ctrl+Shift+V paste, Ctrl+Shift+D split-down, Ctrl+Shift+X close, ...) stay active, and Ctrl+Tab / Ctrl+digit / zoom are untouched. Every app action that yields in a terminal keeps an alternative (go to file on Ctrl+Shift+P, split on Ctrl+Shift+D, find via the header search box, the rest via toolbar buttons). macOS is unaffected (its modifier is Cmd, so no bare-Ctrl chord was ever an app shortcut). Guarded by a self-check ([keybindings-terminal-verify.ts](scripts/keybindings-terminal-verify.ts)). See [shortcuts.ts](src/modules/shortcuts/shortcuts.ts), [App.tsx](src/app/App.tsx).

### Added

- **Right-click pastes into the terminal.** Following the PuTTY and Windows Terminal convention, right-clicking a terminal pane now pastes the clipboard, so a snippet copied from anywhere on the PC drops straight into the shell, including over SSH. It reads the WebView clipboard and routes through the bracketed-paste path, so a multi-line snippet does not auto-execute line by line; `Ctrl+Shift+V` and `Shift+Insert` continue to work. See [TerminalPane.tsx](src/modules/terminal/TerminalPane.tsx).

## [0.3.79] - 06-07-2026

### Fixed

- **AI streams on SumoPod and cloud gateways no longer hang forever when the upstream stalls.** The Rust streaming proxy already aborted a wedged connection after an idle timeout, but that guard only covered the CORS-fallback path; SumoPod and other cloud OpenAI-compatible gateways use the WebView's native fetch, which had no idle timeout, so a gateway that accepted the request and then went silent mid-response left the turn spinning indefinitely. Provider fetches now run through an idle-timeout wrapper that aborts a stream after five minutes with no body bytes and surfaces a clear, retryable error instead of hanging, with the timer measuring only upstream wait so a slow-but-live stream and consumer backpressure never trip it. Guarded by a self-check ([stream-idle-timeout-verify.ts](scripts/stream-idle-timeout-verify.ts)). See [httpProxy.ts](src/modules/ai/lib/httpProxy.ts), [agent.ts](src/modules/ai/lib/agent.ts).
- **Fewer mid-turn "context exceeded" errors on runtime-detected models.** Models absent from the context-limit table (most SumoPod and OpenAI-compatible ids) assumed a 512K window, so compaction fired too late and the request could overflow the gateway's real, smaller window mid-turn. The fallback is now a conservative 256K so compaction runs before the real limit is hit, while known large models (gpt-4.1, gemini-2.5-pro) are tabled explicitly so they are not over-compacted. See [config.ts](src/modules/ai/config.ts).
- **A single-file "study" or "explain" request no longer forces a slow multi-subagent fan-out.** The trigger that pins the first agent step to a `run_subagents` fan-out fired on a study verb alone (e.g. "explain this function"), adding a full extra round of latency to plainly single-file work. It now requires an explicit sub-agent request, or a study verb paired with a breadth cue (project / codebase / architecture / ...), with the breadth keywords word-bounded so they no longer match inside unrelated words (report, projected, wholesale). The soft prompt mandate still nudges the model to delegate genuinely broad tasks. Guarded by a self-check ([orchestration-intent-verify.ts](scripts/orchestration-intent-verify.ts)). See [orchestrationIntent.ts](src/modules/ai/lib/orchestrationIntent.ts), [agent.ts](src/modules/ai/lib/agent.ts).

### Changed

- **Slightly faster first token on every AI turn.** Project-memory reads and MCP tool loading are independent but ran in two sequential batches before the request was sent; they now race together in one batch. See [transport.ts](src/modules/ai/lib/transport.ts).

## [0.3.78] - 06-07-2026

### Changed

- **The in-app update prompt now shows a clean, scrollable changelog.** The "update available" dialog in the status bar and the updater in Settings > About previously printed the release notes as raw monospaced text, so headings, bold, and links read as literal markdown. They now render the changelog as structured, scrollable content (section headings, bullet lists, bold, inline code, and external links), so the "what's new" is easy to read. The generated notes also drop the boilerplate install and auto-update footer, so they open directly on the actual changes. See [ReleaseNotes.tsx](src/modules/updater/components/ReleaseNotes.tsx), [UpdaterDialog.tsx](src/modules/updater/components/UpdaterDialog.tsx), [AboutSection.tsx](src/settings/sections/AboutSection.tsx).

## [0.3.77] - 06-07-2026

### Added

- **Editor panes can now be floated into their own always-on-top window.** Any local (non-SSH) editor gains the same pop-out button terminals already have. The hand-off is loss-safe: the main pane saves and unmounts its editor while floating so two CodeMirror views cannot race and stomp the same file, and the float saves both on dock-back and on its title-bar close, so the edits flow back when the main pane remounts. Remote/SFTP editors stay gated out because they depend on the main window's SSH session. See [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx), [FloatApp.tsx](src/float/FloatApp.tsx), [EditorPane.tsx](src/modules/editor/EditorPane.tsx).
- **Markdown tables gained a control toolbar with live search and pop-out.** Every table in the AI chat, the reasoning panel, and the editor's markdown preview now renders inside a card with a slim header bar offering three controls: search (filters rows in place by substring, with a shown/total counter and correctly recomputed zebra striping), copy-as-markdown (which honors an active search and copies only the visible rows), and Open in pane (pops the table into its own always-on-top float window, like a floated terminal). See [markdown-code.tsx](src/components/ai-elements/markdown-code.tsx).

### Changed

- **Markdown tables render as a compact, scannable grid.** Tables moved from the airy default spacing to a bordered rounded card with a sticky opaque header, dense cell padding, subtle column separators, and row hover with zebra striping, and an all-empty header row (common in AI key/value tables written as bare pipes) is now hidden instead of showing a blank sticky strip. See [markdown-code.tsx](src/components/ai-elements/markdown-code.tsx).
- **AI reasoning blocks render markdown tables and code identically to the main chat.** The reasoning panel previously used a bare renderer, so a table or code fence inside it looked different and carried the default table controls. It now uses the shared component map (Lezer-highlighted code blocks, the app's table toolbar), matching the chat message, editor preview, and float window. See [reasoning.tsx](src/components/ai-elements/reasoning.tsx).
- **File operations no longer freeze the window on large repositories.** Project-wide search, grep, glob, and find-replace, plus single-file read and write and recursive copy and delete, now run on a background thread instead of the UI thread, so a search over a big tree or opening a large file keeps the app responsive. See [grep.rs](src-tauri/src/modules/fs/grep.rs), [search.rs](src-tauri/src/modules/fs/search.rs), [file.rs](src-tauri/src/modules/fs/file.rs), [mutate.rs](src-tauri/src/modules/fs/mutate.rs).
- **Faster startup and lighter memory under heavy terminal output.** The AI sidebar panel now loads on demand, trimming roughly 72 KB from the initial bundle, and the terminal daemon reader forwards each output chunk without an extra copy, cutting allocation churn during a log flood. See [index.ts](src/modules/ai/index.ts), [client.rs](src-tauri/src/modules/pty_daemon/client.rs).

### Fixed

- **Float windows no longer risk a blank screen or a tooltip crash.** Every float kind now renders inside one shared tooltip provider and an error boundary, so the tooltips in the editor find bar and the table controls have the provider they require, and a render error shows a fallback instead of blanking the frameless window. See [FloatApp.tsx](src/float/FloatApp.tsx).
- **A floated editor matches the main window's editor settings.** The float process now hydrates the preferences store on startup, so vim mode, line wrap, minimap, and AI autocomplete follow your configuration instead of falling back to defaults. See [main.tsx](src/float/main.tsx).
- **Sticky markdown-table headers no longer bleed through when scrolling under the glass theme.** With glass enabled the header's translucent background let the scrolling rows show through; the header is now pinned to the solid canvas colour, consistent with the existing SQL-grid and connection-form glass fixes. See [globals.css](src/styles/globals.css).

### Security

- **The SSRF guard now re-checks every HTTP redirect hop.** The block on the cloud instance metadata service and the link-local address ranges previously validated only the initial URL, so a public URL could redirect (3xx) into that space and slip past the check. The redirect policy on every outbound client (the dev-server probe, the AI streaming proxy, and the preview asset proxy) now rejects a redirect that lands on a blocked address, keeping the existing ten-hop limit. See [net.rs](src-tauri/src/modules/net.rs), [proxy.rs](src-tauri/src/modules/preview/proxy.rs).

### Removed

- **Dropped the runtime `shadcn` dependency and an unused component.** The `shadcn` CLI (a build-time code generator, pinned only for one static token CSS file) is no longer a runtime dependency; its stylesheet is vendored as [shadcn-tailwind.css](src/styles/shadcn-tailwind.css), so the shipped bundle is unchanged while the install size and its supply-chain surface shrink. The orphaned `SshStatusPill` component was also removed.

## [0.3.76] - 04-07-2026

### Added

- **Float a terminal pane into its own always-on-top window.** Every terminal pane's header gains a pop-out button (next to close) that ejects the pane into a separate OS window floating above other apps (YouTube-PiP style), so you can keep watching a running agent while you work elsewhere. The window is a live mirror: it renders the shell's output and sends your keystrokes back to the real PTY over Tauri events (the same cross-window transport the Debug window uses), so the main pane is never disturbed. While a pane is floating, its main-window slot stops rendering the now-redundant terminal (kept mounted so the shell + mirror stay live) and shows a "floating" indicator with **Focus window** and **Dock back** actions; closing the float window or docking back restores the pane. Built on a new float-window entry ([float.html](float.html), [src/float/](src/float/)) + the mirror bridge ([floatHost.ts](src/modules/panes/floatHost.ts), [floatProtocol.ts](src/modules/panes/floatProtocol.ts), [floatStore.ts](src/modules/panes/floatStore.ts), [floatTap.ts](src/modules/terminal/lib/floatTap.ts)) and a Rust `open_float_window` command ([lib.rs](src-tauri/src/lib.rs)). Note: Document Picture-in-Picture is unavailable in WebView2 (`requestWindow` throws "Internal error: no window"), so this uses a native Tauri window instead. Terminal panes only for now.

### Changed

- **AI conversations compact between steps to cut token usage.** The agent loop and sub-agent loop now run an elide-only compaction pass over the message history before each model step (`compactStepMessages`, ~80k `RESEND_COMPACTION_BUDGET`) instead of only compacting when the context overflows. The pass is idempotent and never drops a message or orphans a tool-result - it elides large tool outputs in place while preserving tool-call/result pairing - so it is safe to feed into an active AI SDK tool loop every step, guarded by a self-check ([compact-step-verify.ts](scripts/compact-step-verify.ts)). See [compact.ts](src/modules/ai/lib/compact.ts), [agent.ts](src/modules/ai/lib/agent.ts), [runSubagent.ts](src/modules/ai/agents/runSubagent.ts).

### Fixed

- **Git history in the sidebar: the scrollbar no longer overlaps the row, and the columns are responsive.** The Radix `ScrollArea`'s 10px overlay thumb sat on top of the rightmost column (the commit time read as covered), and every column stayed on even in a narrow sidebar, cramming the row. The commit list is now a container-query context: the author and short-SHA columns drop as the sidebar narrows (both still live in the row tooltip + detail card), subject and time always stay, and the row's right padding clears the overlay thumb. See [GitGraphView.tsx](src/modules/scm/GitGraphView.tsx).
- **Beautify extension: the wand icon in the header shows again.** The bundled `tedi.beautify` extension registers its header button with the legacy `hugeicon:MagicWand01Icon` ref, which had no entry in the icon alias map after the Lucide migration, so it rendered a blank placeholder next to the markdown-preview toggle. Added `MagicWand01Icon` -> `WandSparkles` to `HUGEICON_ALIAS` (fixes the already-installed extension at runtime) and updated the extension source to the native `lucide:WandSparkles`. See [iconRegistry.ts](src/lib/iconRegistry.ts).

## [0.3.75] - 04-07-2026

### Changed

- **Icon system migrated from HugeIcons to `lucide-react`.** The whole UI now draws its glyphs from [lucide-react](https://lucide.dev), imported by name so each icon tree-shakes into the main chunk (no runtime barrel for the static call sites). Dynamic, name-based lookups (extension tab icons, contributed header/status items, `ctx.ui.icon()`) route through the new [iconRegistry.ts](src/lib/iconRegistry.ts) `resolveExtIcon`, which accepts `lucide:<Name>` refs and still resolves legacy `hugeicon:<Name>` refs from already-installed extensions by mapping each to its nearest Lucide equivalent (`HUGEICON_ALIAS`). Lucide ships no brand marks, so the AI-provider and GitHub logos moved to inline `currentColor` SVGs in the new [BrandIcon.tsx](src/components/BrandIcon.tsx) (same `size`/`className` API as a Lucide icon). Docs updated to match ([TEDI.md](TEDI.md), [ARCHITECTURE.md](ARCHITECTURE.md), [extensions/README.md](extensions/README.md)).
- **Codebase-wide dedup / simplification pass (net −1147 lines across 172 files).** Repeated inline logic was pulled into shared helpers and reused at every call site: byte-size formatting into [format.ts](src/lib/format.ts) (`formatBytes`), the SCM change status letter/tone maps into [statusMeta.ts](src/modules/scm/statusMeta.ts), and the editor/explorer search-option toggle into a shared [search-option-toggle.tsx](src/components/ui/search-option-toggle.tsx). A matching simplification pass over the Rust side (net −128 lines) trimmed duplicated glue with no behavior change. Verified with `tsc --noEmit`, `cargo check`, and `cargo clippy --all-targets -- -D warnings`, all green.

### Removed

- **`@hugeicons/core-free-icons`, `@hugeicons/react`, and `src/lib/hugeIconsBarrel.ts`.** Superseded by `lucide-react` + [iconRegistry.ts](src/lib/iconRegistry.ts); no source references remained.

### Fixed

- **Editor find/replace: the "Replace all" button shows its own glyph again.** After the Lucide migration both the "Replace next" and "Replace all" buttons rendered the identical `Replace` icon (the old distinct `ReplaceAllIcon` had no automatic Lucide mapping), so the two adjacent buttons were visually indistinguishable. "Replace all" now uses Lucide's dedicated `ReplaceAll` glyph, restoring the single-vs-all distinction (matching the VSCode convention). Handlers, tooltips, and shortcuts were unaffected. See [EditorFindReplace.tsx](src/modules/editor/EditorFindReplace.tsx).
- **Consistent hover tooltips on the markdown/chat block controls.** The three icon buttons that appear over rendered markdown (in both the AI chat and the editor's markdown preview) - copy-table, run-in-terminal, and copy-code - now all use the host `Tooltip` with the same `side="top"` styling. The copy-code button previously carried only a bare `aria-label`, so it showed the browser's plain title bubble (or nothing) while the sibling controls showed the styled app tooltip. See [chat-code.tsx](src/components/ai-elements/chat-code.tsx).

## [0.3.74] - 03-07-2026

### Fixed

- **Closing a terminal now kills the whole child process tree, not just the shell leader.** On Windows `killer.kill()` only terminates the ConPTY shell leader, so a `claude` / `node` (or anything the shell spawned) inside a just-closed tab was orphaned until the deferred `Session` drop closed the Job Object — or forever, if the job was never created. The close path now terminates the child tree synchronously: `PtyJob::terminate` fires `TerminateJobObject` immediately, with a `taskkill /T` fallback keyed on the shell-leader pid when no Job Object exists. Applied on both the in-process (`pty_close`) and daemon (`close_session`) backends; on Unix `killer.kill()` was already the whole story. See [session.rs](src-tauri/src/modules/pty/session.rs), [job.rs](src-tauri/src/modules/pty/job.rs), [mod.rs](src-tauri/src/modules/pty/mod.rs), [server.rs](src-tauri/src/modules/pty_daemon/server.rs).
- **Editor: escape the horizontal-scroll trap on a long single line.** With line wrap off, drag-selecting past the right edge auto-scrolls the view sideways and strands it there; on a doc that fits vertically the plain vertical wheel had nothing to scroll, so a mouse-only user couldn't get back to the left. A plain vertical wheel is now redirected to the horizontal axis when that is the only scrollable one (same pattern as the tab strip). See [EditorPane.tsx](src/modules/editor/EditorPane.tsx).
- **Four source files were invisible to code search.** `skills.ts`, `mcpClient.ts`, `useTabSideEffects.ts`, and `inlineExtension.ts` used a literal NUL (`\0`) byte as an in-memory cache-key / join separator; git and ripgrep treat any file containing a NUL as binary and skip it, so every search over them silently returned nothing (this had also masked a live caller during dead-code review). Replaced with the visible, collision-proof `\x1f` unit separator, with build/read pairs kept consistent so behavior is unchanged. See [skills.ts](src/modules/ai/lib/skills.ts), [mcpClient.ts](src/modules/ai/lib/mcpClient.ts).

### Removed

- **Dead-code sweep (~420 lines).** Removed verified-unused code with no runtime references: three orphaned UI components (`ui/alert.tsx`, `ui/toggle.tsx`, `ai-elements/snippet.tsx`); unused daemon-client internals (`PtyClient::detach` / `is_alive`, `transport::bind_daemon` / `incoming`, `PtyState::is_daemon`, `fs::atomic_write_string`); and unused frontend exports (`resetShortcuts`, `resetExtensionShortcuts`, `statusIconClass`, `isLive`, `getLanguageDef`, `sftpStat`, `parseManifest`, the `CTRL/TAB/ENTER_KEY` constants, and more). Verified with `tsc`, `cargo check`, and `clippy -D warnings`. See [transport.rs](src-tauri/src/modules/pty_daemon/transport.rs).

## [0.3.73] - 03-07-2026

### Added

- **Extensions can create a workspace and switch the active one.** New `ctx.app.createWorkspace(name)` and `ctx.app.setActiveWorkspace(id)` (gated by a new `workspaces:manage` permission) let a permitted extension make a workspace (creating one switches to it, which auto-seeds a default terminal) or switch which workspace is active. This is what lets the Remote Access browser open a new terminal / SSH tab in a chosen workspace and create workspaces from the web: only a workspace id / name ever crosses the bridge, and the actual shell spawn stays on the existing, separately-gated open path. See [workspaceMgmtBridge.ts](src/modules/extensions/workspaceMgmtBridge.ts), [host.ts](src/modules/extensions/host.ts), [App.tsx](src/app/App.tsx).

## [0.3.72] - 02-07-2026

### Added

- **Format-on-save now covers every supported language, not just the web ones.** Previously only the 14 Prettier languages were wired by default, so saving a `.rs`/`.go`/`.py`/etc. did nothing even with format-on-save on. A language with no explicit config now falls back to its shipped default (built-in Prettier for the web languages, the external preset — rustfmt, gofmt, ruff, … — for the rest), so all 44 known languages format on save out of the box. A missing external tool is silent (the save falls through to a plain write instead of nagging on every Ctrl+S); only a real formatter error toasts. Explicit **Format Document** (Shift+Alt+F) still surfaces a missing tool. See [index.ts](src/modules/editor/lib/formatters/index.ts), [external.ts](src/modules/editor/lib/formatters/external.ts).
- **Drop a file onto an editor pane to open it.** Dragging a file from the OS onto an editor leaf (not a terminal) opens it VSCode-style, for any absolute path — even one outside the current workspace root. See [useEditorFileDrop.ts](src/app/hooks/useEditorFileDrop.ts), [App.tsx](src/app/App.tsx).

### Fixed

- **Built-in JSON/JSONC formatting no longer throws every time.** The `json` parser emits an estree AST, but the standalone Prettier build only had the `babel` plugin registered for it, so every save/format of a `.json`/`.jsonc` file threw `Couldn't find plugin for AST format "estree"`. The estree printer is now loaded alongside babel. See [prettier.ts](src/modules/editor/lib/formatters/prettier.ts).
- **A project `.prettierrc.json` with a `$schema` URL is no longer silently ignored.** The relaxed-JSON reader stripped `//` line comments without skipping string literals, so the `//` inside a `"$schema": "https://…"` value broke `JSON.parse` and the whole config was dropped (this repo's own `.prettierrc.json` included). It now tries strict `JSON.parse` first and only falls back to comment/trailing-comma stripping for genuinely JSON5-flavoured files. See [projectConfig.ts](src/modules/editor/lib/formatters/projectConfig.ts).
- **An external formatter can no longer blank a file, and several presets that silently did nothing are fixed.** A formatter that exits 0 with empty output would overwrite the buffer with `""` and persist it; a non-empty buffer now refuses an empty result and keeps the original. The C/C++ (`clang-format`), XML (`xmllint`), Protocol Buffers (`buf`), F# (`fantomas`), and PowerShell presets were corrected to invocations that actually format the buffer (they were no-ops or spawn failures before). See [index.ts](src/modules/editor/lib/formatters/index.ts), [presets.ts](src/modules/editor/lib/formatters/presets.ts).
- **The Settings tab bar centers when it fits and scrolls from the first tab when narrow.** Centering with `items-center` pushed the first tab past the unreachable negative-scroll edge on a small window; it now uses `mx-auto`, which centers when the tabs fit and collapses to 0 on overflow so the row scrolls from the start. See [SettingsApp.tsx](src/settings/SettingsApp.tsx).
- **The Debug window confirms a capture download.** Exporting a capture now shows a "Downloaded …" toast (the window gained a `Toaster`). See [DebugApp.tsx](src/debug/DebugApp.tsx).

### Changed

- **Settings sections share one static card component.** A new `SettingsCard` reuses `SettingsAccordion`'s chrome (border, background, padding, header typography) so always-open cards and collapsible accordions sit together without a visual seam; the Agents, Sub-agents, Skills, MCP, System-prompts, About, and Extensions sections adopt it. See [SettingsCard.tsx](src/settings/components/SettingsCard.tsx).
- **Dialog footer buttons fill the row.** `DialogFooter` now splits its width evenly across buttons (one fills, two go 50/50) instead of hugging the right, matching `AlertDialogFooter`; a bespoke footer opts out with `sm:[&>button]:flex-none` (see the SSH dialog). See [dialog.tsx](src/components/ui/dialog.tsx), [SshConnectionDialog.tsx](src/modules/ssh/SshConnectionDialog.tsx).
- **The composer model button stays compact.** The provider icon was dropped from the composer trigger (it still lives in the dropdown's section headers). See [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx).
- **The workspace `TEDI.md` preload is bounded to a compact head.** The project-memory doc lands in the cacheable system-prompt prefix every turn, so an exhaustive `TEDI.md` (>100 KB here) would dominate the prompt even for a trivial message. It is now cut to a ~12 KB head at the last markdown section header before the budget (never mid-table/sentence), with a read-on-demand pointer; the full doc stays one `read_file` away. See [transport.ts](src/modules/ai/lib/transport.ts).

## [0.3.71] - 01-07-2026

### Added

- **Remote-access mirrors get per-workspace terminals and live AI-CLI status.** The host now publishes every LIVE workspace's terminals (the active one plus any visited this run, whose PTYs stay attached) to the app-context bridge the Remote Access extension mirrors, each carrying its workspace (`wsId`/`wsName`/`wsActive`) and AI-CLI run state (idle/working/blocking). A browser mirror can group tabs into the same per-workspace switcher the desktop shows and render the same working indicator on every tab, which it cannot derive on its own (PowerShell emits no OSC 133 C, and only the host sees commands started from the desktop). The terminals signature now includes those fields so a status flip or workspace switch/rename propagates instead of being swallowed as "unchanged". See [host.ts](src/modules/extensions/host.ts), [appBridge.ts](src/modules/extensions/appBridge.ts), [useAppContextBridge.ts](src/app/hooks/useAppContextBridge.ts).

### Fixed

- **The chat model button no longer shows a false "no key" warning for a model that works.** A model id shared by two providers (e.g. `deepseek-v4-pro` on native DeepSeek and SumoPod, `claude-sonnet-4-6` on Anthropic and SumoPod) resolved by id alone, so the trigger read the key status of the static-table provider (which the user may not have configured) instead of the one actually selected, painting the button yellow with "no key configured" even though sending worked. The trigger now resolves against the selected provider and treats keyless providers (LM Studio) as always usable; picking a keyless model no longer bounces to Settings either. See [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx).
- **A last-used gateway model is restored on boot instead of being dropped.** `hasKeyForModel` (the boot-restore fallback for older data with no saved provider) derived the provider from the id alone, so a last pick like SumoPod `claude-sonnet-4-6` was checked against Anthropic and discarded when there was no Anthropic key. It now considers every provider that serves the id and restores when any is usable. See [chatStore.ts](src/modules/ai/store/chatStore.ts).
- **Sub-agent results stay open after a fan-out finishes.** The live rows expand each sub-agent's summary the moment it lands, but the final `run_subagents` output collapsed them all again on completion, so the user had to re-open each to read what they just watched stream in. The final result rows now open by default, matching the live rows and the single `run_subagent` output. See [tool.tsx](src/components/ai-elements/tool.tsx).
- **The Settings and Debug windows scroll horizontally when narrow.** Resizing either window small clipped content with no way to reach it: Settings only scrolled vertically (the tab bar and wide section content were cut off), and the Debug window's fixed-width capture list squeezed the detail pane to a sliver. Both now scroll horizontally when content does not fit, and the Debug detail keeps a usable minimum width. See [SettingsApp.tsx](src/settings/SettingsApp.tsx), [DebugApp.tsx](src/debug/DebugApp.tsx).

### Changed

- **Every model picker reads consistently, and same-named models from different providers stay distinct.** The composer's model button now shows the provider icon + label + provider hint like the Settings default-model trigger (instead of a bare label), its dropdown section headers and rows are aligned to the same style, and the per-prompt / custom sub-agent model picker gained provider icons. A model with the same name from a different provider, or from a different OpenAI-Compatible endpoint (users can add more than one), stays a distinct entity throughout selection, pinning, and key checks. See [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx), [ModelSection.tsx](src/modules/ai/components/ModelSection.tsx), [SystemPromptsCard.tsx](src/settings/sections/components/SystemPromptsCard.tsx).
- **Internal cleanup: shared helpers and dead-code removal (no behaviour change).** Deduplicated the model-label formatter, the `/models` response parser, and the (id, provider) to ModelInfo resolver into `config.ts`; hoisted a shared settings `Label`, `matchesQuery`, `maskKey`, and `isSecondaryWindow`; and removed dead code (an unused status-bar model selector, deprecated type aliases, two never-called preference setters, and an unread recorder state). Net roughly 150 fewer lines, verified with `tsc` and the import-boundary check. See [config.ts](src/modules/ai/config.ts), [utils.ts](src/lib/utils.ts), [platform.ts](src/lib/platform.ts).

## [0.3.70] - 30-06-2026

### Added

- **Skills install/preview/update fetch a repo's text files via codeload instead of the GitHub REST API.** The skills installer used the REST API (git tree + per-file raw fetch), which is capped at 60 requests/hour unauthenticated. It now downloads the repo's source archive from `codeload.github.com` (not under that cap) through new Rust commands `github_head_sha` and `github_repo_text_files`, keeps only the small UTF-8 text files under fixed size caps, and never needs a token. Tradeoff: a skill repo that bundles a large binary asset (whole archive over the 50 MB download cap) can no longer be installed even if its `SKILL.md` is tiny. See [github.rs](src-tauri/src/modules/extensions/github.rs), [commands.rs](src-tauri/src/modules/extensions/commands.rs), [skills.ts](src/modules/ai/lib/skills.ts).

### Fixed

- **The AI agent no longer follows you into another folder mid-task.** Tools resolve relative paths and shell cwd through the *currently active* terminal, so working in folder A and then switching to (or opening) a tab in folder B would re-point every subsequent tool - and the agent's sub-agents - at folder B. The working directory and workspace root are now pinned to a snapshot taken at the start of each turn and held for the whole turn (sub-agents included); terminal and browser actions stay live. The pin mutates the stable per-session tool context (no per-turn clone) so the tool-schema cache keeps hitting. See [transport.ts](src/modules/ai/lib/transport.ts), [chatStore.ts](src/modules/ai/store/chatStore.ts), [context.ts](src/modules/ai/tools/context.ts).
- **A model reachable through a configured gateway no longer fails with "something went wrong - no API key".** When the provider resolved from a model id needs a key the user doesn't have, the model builder now falls back to any configured provider that serves the same id (e.g. `deepseek-v4-pro` routes to SumoPod when there's a SumoPod key but no native DeepSeek key), instead of throwing. It still throws when no configured provider can serve the model. See [agent.ts](src/modules/ai/lib/agent.ts), [config.ts](src/modules/ai/config.ts).
- **An OpenAI-Compatible endpoint's label and URL can be edited and saved.** A configured endpoint only showed a "Detect" button, so changing its label (or base URL) had no Save affordance unless you first entered key-replace mode. A "Save" button now appears whenever the label or URL differs from what's stored; saving keeps the existing key. See [OpenAICompatibleBlock.tsx](src/settings/sections/components/OpenAICompatibleBlock.tsx).
- **Security: the codeload skills extractor is bounded against a decompression bomb.** Decompressed bytes were counted toward the aggregate size cap only after the UTF-8 text check passed, so a hostile public repo full of highly-compressible non-UTF8 entries could decompress unbounded (a CPU/memory DoS) without ever tripping the cap. Bytes are now counted before the text filter, and the extraction runs off the async worker. See [github.rs](src-tauri/src/modules/extensions/github.rs).

### Changed

- **Multi-file builds fan out into parallel workers instead of one slow serial worker.** The orchestration guidance only *mandated* parallel sub-agents for explore/review intents and made parallel workers *optional* for implementation, so a "build this multi-file project" request often handed the entire build to a single worker that implemented serially. The prompt now directs a multi-file build to split into multiple worker tasks in one `run_subagents` call, each owning a disjoint file set (one per module or layer), running in parallel; a single worker is reserved for single-file or tightly-coupled changes. See [config.ts](src/modules/ai/config.ts).

## [0.3.69] - 30-06-2026

### Fixed

- **Models served by a gateway under a name that also exists natively no longer fail with "something went wrong - no API key".** A model id is not unique across providers: `deepseek-v4-pro` and `claude-sonnet-4-6` exist both as native-provider models and in the SumoPod catalogue. The request path re-derived the provider from the model id alone via `tryGetModel`, which prefers the static model table, so picking the SumoPod variant resolved to the native DeepSeek/Anthropic provider and threw because that provider had no key (while GLM via an OpenAI-Compatible gateway worked, because its id is namespaced). The provider the user actually picked was already tracked (`selectedProvider`) but dropped before the request. It is now threaded through the transport into the agent and wins over id-based lookup, and the send-gate / active-key check honour it too. The same disambiguation now covers the default-model picker, the per-prompt and custom sub-agent model overrides (a `modelProvider` is stored alongside the id), and orchestration fan-outs (sub-agents inherit the parent's provider). See [agent.ts](src/modules/ai/lib/agent.ts), [transport.ts](src/modules/ai/lib/transport.ts), [chatStore.ts](src/modules/ai/store/chatStore.ts), [runSubagent.ts](src/modules/ai/agents/runSubagent.ts), [prompts.ts](src/modules/ai/lib/prompts.ts).
- **The Settings tab bar is centered.** The tab container is laid out as a flex column (the `Tabs` base sets `flex-col` for horizontal orientation), so `justify-center` only centered on the vertical axis and the `w-fit` tab list sat against the left edge; it now uses `items-center` (the cross axis) so the tabs are horizontally centered. See [SettingsApp.tsx](src/settings/SettingsApp.tsx).

### Changed

- **OpenAI-Compatible endpoints are grouped by their own label in the model pickers, and the chat credits the endpoint by name.** Several OpenAI-Compatible endpoints can be added, but the chat and default-model pickers lumped them all under one generic "OpenAI Compatible" section and the message chip showed the provider name plus a meaningless gateway tag (e.g. `cx`). Each configured endpoint now gets its own section headed by its configured label (with per-endpoint detection status), and the sent-message chip credits the endpoint label instead of the provider name. See [config.ts](src/modules/ai/config.ts), [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx), [DefaultModelDropdown.tsx](src/settings/sections/components/DefaultModelDropdown.tsx), [AiChat.tsx](src/modules/ai/components/AiChat.tsx).

## [0.3.68] - 30-06-2026

### Fixed

- **The app no longer holds multiple GB of RAM long after a heavy-output burst.** On Windows the GUI host process (`TEDIApp.exe`) could climb past 3 GB of committed memory while driving heavy terminals (an AI CLI redrawing, dev-server logs, large builds across many panes) and never give it back, so it "stayed at ~1 GB" even at idle. This was not a leak: trimming the working set dropped resident pages to a few MB while the committed bytes stayed put, the signature of an allocator high-watermark. The default Windows system heap holds onto freed commit for the bursty, fragmented allocations the host makes while buffering base64 PTY output on its way to the webview. TEDI now uses **mimalloc** as its global allocator (the GUI and the `--pty-daemon` sidecar share the binary), which purges freed segments back to the OS on a timer, so the watermark recedes once a burst ends. The `--pty-daemon` sidecar and the in-process PTY backend were already bounded (1 MiB scrollback ring, 4 MiB pending cap); the host's commit retention was the remaining gap. See [Cargo.toml](src-tauri/Cargo.toml), [lib.rs](src-tauri/src/lib.rs).

## [0.3.67] - 30-06-2026

### Added

- **The Debug-requests viewer is now its own native window.** It moved from an in-app floating panel to a separate OS window (same owner-window chrome as Settings, opened from the toolbar Debug button). Because the capture store is in-memory in the main window, an event bridge mirrors it into the new webview: the main window broadcasts the capture array only while a Debug window is listening, and the Debug window pulls a snapshot on open and stays in sync. See [DebugApp.tsx](src/debug/DebugApp.tsx), [debugBridge.ts](src/modules/ai/store/debugBridge.ts), [DebugRequestViewer.tsx](src/modules/ai/components/DebugRequestViewer.tsx), [lib.rs](src-tauri/src/lib.rs).
- **Sub-agent results appear the moment each one finishes.** In a parallel `run_subagents` fan-out, each sub-agent's summary now shows in the live progress view (as collapsible markdown, expanded by default) the instant that agent lands, instead of all summaries appearing together when the whole call returns. See [subagentRunStore.ts](src/modules/ai/store/subagentRunStore.ts), [subagent.ts](src/modules/ai/tools/subagent.ts), [tool.tsx](src/components/ai-elements/tool.tsx).

### Changed

- **Sub-agent badges show the agent that actually runs.** A caller synonym like `explore` now resolves to its real agent name (`Comet`) at every badge site, via a single shared resolver that uses the same logic as the runtime, so the label matches what executed. See [resolveSubagent.ts](src/modules/ai/agents/resolveSubagent.ts), [tool.tsx](src/components/ai-elements/tool.tsx), [runSubagent.ts](src/modules/ai/agents/runSubagent.ts).
- **Sub-agent summaries render as formatted markdown** instead of raw monospace text, in both the live progress rows and the final result views. See [tool.tsx](src/components/ai-elements/tool.tsx).
- **The Settings window now matches the Debug window.** Its tab nav moved out of the title bar into the top of the body and is centered; the brand-blue accent outline on the window is now a neutral border (matching the in-app debug-panel look); and the header is a plain "Settings" title with a close button. See [SettingsApp.tsx](src/settings/SettingsApp.tsx), [globals.css](src/styles/globals.css).
- **Selected chips and cards use an accent-filled border, not a white one.** The white-ish `border-foreground` selection borders became `border-accent` so a selected item reads as a filled accent block: debug filter chips + capture rows, the sub-agent read-only tool toggles, the agent icon picker, and the OpenAI-compatible / SSH preset chips. See [DebugApp.tsx](src/debug/DebugApp.tsx), [SubagentsCard.tsx](src/settings/sections/components/SubagentsCard.tsx), [AgentsSection.tsx](src/settings/sections/AgentsSection.tsx), [OpenAICompatibleBlock.tsx](src/settings/sections/components/OpenAICompatibleBlock.tsx), [SshConnectionDialog.tsx](src/modules/ssh/SshConnectionDialog.tsx).
- **`/mcp` is compact: server name on the left (green when enabled), command on the right.** The dot gutter that left a large empty gap is gone; the row is now a clean two-column name/command layout, with the name tinted green when the server is enabled. See [slashCommands.ts](src/modules/ai/lib/slashCommands.ts), [InfoModal.tsx](src/modules/ai/components/InfoModal.tsx).

### Fixed

- **The Debug and Settings utility windows no longer trip main-window-only theme logic.** Window detection switched from "the `#settings-root` element is absent" (which was also true in the new Debug window) to "the `#root` element is present", so the Debug window opts out of the wallpaper migration and the whole-app opacity glass exactly like the Settings window. See [ThemeProvider.tsx](src/modules/theme/ThemeProvider.tsx), [customTheme.ts](src/modules/settings/customTheme.ts), [appOpacity.ts](src/modules/settings/appOpacity.ts).

## [0.3.66] - 30-06-2026

### Added

- **MCP image and audio tool results now reach the model.** A vision MCP tool (e.g. a screenshot from chrome-devtools) previously returned only an `[Image: ...]` placeholder string; image and audio content are now forwarded as real multimodal file parts via `toModelOutput`, and a side-effect-only success returns a clear marker instead of an empty string the model could mistake for a no-op. See [mcp.ts](src/modules/ai/tools/mcp.ts).
- **Skill installs from GitHub now include bundled files.** A skill whose `SKILL.md` references sibling scripts or reference docs previously installed broken because only the `SKILL.md` was fetched; install and update now co-fetch the skill's bundled text files (bounded, with each untrusted path checked so it cannot escape the skill dir; binary assets are skipped and counted). See [skills.ts](src/modules/ai/lib/skills.ts).
- **Browser keyboard shortcuts.** A new "Browser" shortcut group adds reload (Mod+Shift+R), back / forward (Alt+Left / Alt+Right), focus address bar (Mod+Shift+L), and split the active pane with a browser (Mod+Shift+B), each gated to a focused browser pane so they fall through to the terminal/editor everywhere else. See [shortcuts.ts](src/modules/shortcuts/shortcuts.ts), [App.tsx](src/app/App.tsx), [shortcutHandlers.ts](src/app/lib/shortcutHandlers.ts), [BrowserPane.tsx](src/modules/browser/BrowserPane.tsx).

### Changed

- **The MCP system-prompt summary is leaner and cache-stable.** It no longer re-lists every tool name (they are already in the model's tool list, so it duplicated tokens every turn) and no longer inlines a transient "(connection failed)" notice (which flipped the cacheable prefix and busted the provider prompt cache for the whole conversation); a failed reconnect reuses the last-known tool count instead. See [mcp.ts](src/modules/ai/tools/mcp.ts).
- **MCP connections are keyed per working directory.** Two workspaces, or concurrent sub-agents rooted in different dirs, no longer share one server process pinned to the first caller's cwd (a filesystem/git MCP server would otherwise read the wrong tree), and idle servers are reclaimed on a timer rather than only on the next connect. See [mcpClient.ts](src/modules/ai/lib/mcpClient.ts).
- **The Debug-requests viewer is a floating window.** It is now a draggable, resizable, non-modal in-app window (Esc to close, position persists across opens) instead of a modal dialog, and its toolbar button toggles it open and closed. See [DebugRequestViewer.tsx](src/modules/ai/components/DebugRequestViewer.tsx).
- **`/mcp` shows a status dot per server.** Each entry is marked with a filled or hollow dot and uses the server name as its label. See [slashCommands.ts](src/modules/ai/lib/slashCommands.ts).
- **Browser address-bar and new-tab menu show shortcut hints.** Back / Forward / Reload tooltips now show their keys, and the new-tab menu shows shortcut hints (the Browser item as Mod+Alt+P and "Split with browser" as Mod+Shift+B). See [BrowserAddressBar.tsx](src/modules/browser/BrowserAddressBar.tsx), [NewTabMenu.tsx](src/modules/tabs/components/NewTabMenu.tsx).

### Fixed

- **Multi-file and duplicate-named skills no longer install or load broken.** Two skills sharing a leaf folder name (e.g. a `review` skill from two different repos) collapsed to one invocable skill, nondeterministically; loading now dedups by group-qualified identity and disambiguates the slash command, so neither is silently shadowed. A `SKILL.md` with a UTF-8 BOM or a blank first line silently vanished, and a `requires:` written as a YAML block sequence parsed as empty; both forms are now handled. See [skills.ts](src/modules/ai/lib/skills.ts).
- **Skill update detection is honest and robust.** A failed update check (offline or GitHub rate-limited) is no longer reported as "all up to date"; an upstream default-branch rename is recovered by re-resolving the branch; a group installed in both the global and project roots now updates both copies; per-skill version and dependency metadata is no longer cross-contaminated from the first sibling on update; and a 403 rate limit shows an actionable "try again later" message. See [skills.ts](src/modules/ai/lib/skills.ts), [SkillsCard.tsx](src/settings/sections/components/SkillsCard.tsx).
- **A long MCP tool name no longer fails the whole turn.** An assembled `mcp__server__tool` key over the provider's 64-character limit was rejected with a 400 that failed the entire request, not just that tool; keys are now clamped with a stable hash suffix so they stay unique, shared with extension tool keys which had the same gap. See [mcp.ts](src/modules/ai/tools/mcp.ts), [extensions.ts](src/modules/ai/tools/extensions.ts).
- **The MCP server process and connection lifecycle is hardened.** On Unix an `npx`/`uvx` shim's `node`/`python` grandchild was orphaned on shutdown (the process group is now killed); a malformed server streaming stdout without a newline could exhaust host memory (now capped); a config edit during an in-flight connect could re-publish the stale client (now superseded by a generation guard); idle eviction could kill a connection with a tool call still in flight (now skipped while busy); and a server that launched but exposes no `tools/list` was misreported as a spawn failure. Server stderr is now captured and surfaced when a handshake fails, and an enabled-but-unreachable server is flagged in the UI instead of failing silently. See [mcpClient.ts](src/modules/ai/lib/mcpClient.ts), [mcp.rs](src-tauri/src/modules/mcp.rs), [mcp.ts](src/modules/ai/tools/mcp.ts).
- **Sub-agent fan-outs survive transient and non-English provider errors.** Fan-outs now retry 429 / 5xx / network failures with jittered exponential backoff (up to 4 attempts), spreading parallel retries so a shared per-minute rate limit no longer collapses the whole batch at once, and show live "Rate limited - retrying" progress; provider errors are classified by the HTTP status extracted from the SDK wrapper layers, so a rate-limit / auth / 5xx is detected even when the error body is non-English (e.g. a GenFlow Indonesian 429 message). See [runSubagent.ts](src/modules/ai/agents/runSubagent.ts), [errors.ts](src/modules/ai/lib/errors.ts).
- **Rebound arrow-key shortcuts render as arrow glyphs again** by comparing key names case-insensitively. See [shortcuts.ts](src/modules/shortcuts/shortcuts.ts).

## [0.3.65] - 30-06-2026

### Changed

- **The in-app browser is now called "Browser" instead of "Preview".** The `+` new-tab menu item, the "New browser tab" shortcut, the self-reference blocked screen, and the explorer's HTML context-menu action ("Open in Browser") were renamed for consistency with the rest of the UI, which already used "browser". Internal ids and the on-disk format are unchanged. See [NewTabMenu.tsx](src/modules/tabs/components/NewTabMenu.tsx), [shortcuts.ts](src/modules/shortcuts/shortcuts.ts), [BrowserPane.tsx](src/modules/browser/BrowserPane.tsx), [FileTreeNode.tsx](src/modules/explorer/FileTreeNode.tsx).

### Fixed

- **Ctrl/Cmd+W closed the whole app instead of the active tab.** A native shortcut intercepted the key before the app's own handler could run: on Windows, WebView2's browser accelerator keys treat Ctrl+W as "close window"; on macOS, the default app menu binds Cmd+W to "Close Window". TEDI now disables browser accelerator keys on the Windows main webview (which also frees Ctrl+P / Ctrl+R / Ctrl+F for the app's own shortcuts) and builds a custom macOS menu that keeps the standard App / Edit / Window items but omits Close Window. Ctrl/Cmd+W now closes the active tab (or the focused pane in a split) on every platform; Linux already behaved correctly. See [lib.rs](src-tauri/src/lib.rs).

## [0.3.64] - 30-06-2026

### Added

- **Auto-orchestration: broad commands fan out to sub-agents automatically.** When sub-agents are enabled and a request matches the orchestration intent (study, explore, review, audit, trace, analyze, and their Indonesian equivalents), the main agent's first step is pinned to a single `run_subagents` fan-out. This is model-agnostic: it makes models that otherwise ignore a soft prompt mandate (e.g. GLM-5.2 via an OpenAI-compatible gateway) delegate reliably instead of reading files inline - the same principle as opencode's tool-restricted orchestrator. See [agent.ts](src/modules/ai/lib/agent.ts).
- **Four new built-in sub-agents for full multi-agent parity.** Vega (read-only strategic planner), Zenith (autonomous multi-step plan executor with a verification gate), Aurora (read-only image/diagram/PDF analyst), and Meteor (autonomous focused leaf executor) join Comet, Nebula, Nova, Orbit, Eclipse, and Odyssey. Each is space-themed and adapted from the oh-my-openagent roster, and each is independently prompt/model/temperature-overridable in Settings. See [registry.ts](src/modules/ai/agents/registry.ts), [prompts.ts](src/modules/ai/lib/prompts.ts).
- **Find-in-files reveals the exact match in the editor.** Clicking a grep hit now jumps to and highlights the matched line (and the exact term within it) instead of only opening the file, via a small reveal bus. See [reveal.ts](src/modules/editor/lib/reveal.ts), [EditorPane.tsx](src/modules/editor/EditorPane.tsx), [ExplorerGrep.tsx](src/modules/explorer/ExplorerGrep.tsx).

### Changed

- **Sub-agent prompts aligned with the oh-my-openagent reference.** Odyssey gained a Manual QA Gate (verify by actually using the deliverable, not just a green build) and hard invariants (no `as any` / `@ts-ignore` to fake green, never delete a failing test, never run destructive git, never claim an un-run verification); Nova gained a Confidence tag and an opener blacklist. See [registry.ts](src/modules/ai/agents/registry.ts).
- **Orchestration prompt and tool descriptions are now roster-agnostic.** The system-prompt roster describes agents by category and points to the `run_subagents` tool's live list instead of hardcoding ids, so renaming or adding sub-agents never leaves the prompt stale. See [config.ts](src/modules/ai/config.ts), [subagent.ts](src/modules/ai/tools/subagent.ts).

### Fixed

- **Sub-agents returned "(no output)" on some models and gateways.** A model that returns empty `content` once the conversation contains tool calls (verified with GLM-5.2 via GenFlow), or a run cut off by the step budget, left the summary empty. The runner now recovers by re-summarizing in a clean tool-free text turn (with `reasoningText` as an intermediate fallback), and forces a tool call on the sub-agent's first step so it actually explores before answering. See [runSubagent.ts](src/modules/ai/agents/runSubagent.ts).
- **A sub-agent fan-out failed wholesale on a loose type name.** Models often name a task by intent ("explore", "review") rather than a roster id, which raised "unknown subagent type" and failed every task in the batch. Types now resolve by exact id, then case-insensitive id or label, normalized slug, semantic synonym, and finally category - never hard-failing, and never falling back to a worker, so a mislabeled task cannot silently edit files. This stays correct when built-ins are renamed or custom agents are added. See [runSubagent.ts](src/modules/ai/agents/runSubagent.ts).

## [0.3.63] - 29-06-2026

### Added

- **MCP server validation on add/edit.** Adding or editing an MCP server now spawns the process and runs the MCP handshake before saving, so arbitrary text can no longer be stored as a working server. A command that cannot launch is rejected (and kept in the input for correction), one that launches but fails the handshake is saved yet reported as failed, and a success shows the advertised tool count. The probe runs on a throwaway client with a timeout so a process that never speaks MCP cannot stall the check or pollute the connection cache. See [mcpClient.ts](src/modules/ai/lib/mcpClient.ts), [McpServersCard.tsx](src/settings/sections/components/McpServersCard.tsx).

### Changed

- **Agent output bans emoji and em dashes.** The system prompt now forbids both in the assistant's prose across the full and lite variants. See [config.ts](src/modules/ai/config.ts).
- **Dead-code sweep of the AI module.** Removed 17 unused exports (including two ~50-line tool label/icon maps) with no behaviour change, verified against the whole tree. See [agent.ts](src/modules/ai/lib/agent.ts).

### Fixed

- **Project memory cache never hit and leaked entries.** `readMemory` wrote its cache under the raw workspace key while reads and eviction used the normalized key, so `.tedi/memory` was re-listed every turn and stale entries were never evicted. See [transport.ts](src/modules/ai/lib/transport.ts).
- **Skill group update could desync disk from state.** `updateSkillGroup` now creates the destination directory and guards each write (matching install), so a skill added upstream since install can no longer abort the whole update mid-loop and leave the written files out of sync with the recorded state. See [skills.ts](src/modules/ai/lib/skills.ts).
- **Fetch abort timer leaked on the error path.** The request timeout is now cleared in a `finally` rather than only after a fully successful read. See [fetch.ts](src/modules/ai/tools/fetch.ts).
- **Needless re-renders and a render-time side effect.** Removed a `useMemo` that called `setState` during render in the debug request viewer, and a dead store subscription in the AI mini window. See [DebugRequestViewer.tsx](src/modules/ai/components/DebugRequestViewer.tsx), [AiMiniWindow.tsx](src/modules/ai/components/AiMiniWindow.tsx).

## [0.3.62] - 29-06-2026

### Added

- **MCP (Model Context Protocol) servers.** Connect external stdio tool servers
  (e.g. `npx -y chrome-devtools-mcp`); their tools reach the agent each turn
  behind per-call approval. A webview cannot spawn processes, so the stdio
  transport runs through the Rust backend (newline-framed JSON-RPC over a Tauri
  channel). See [mcp.rs](src-tauri/src/modules/mcp.rs),
  [mcpTransport.ts](src/modules/ai/lib/mcpTransport.ts),
  [mcpClient.ts](src/modules/ai/lib/mcpClient.ts).
- **`/skills` and `/mcp` composer commands.** List installed skills and
  configured MCP servers in a modal; Tab completes a partial command (typing
  `/sk` then Tab gives `/skills`). See
  [slashCommands.ts](src/modules/ai/lib/slashCommands.ts).

### Changed

- **Compact MCP server settings.** Adding a server is a single run-command input
  (name auto-derived); editing is one form too, with an optional credentials
  (env) field shown only when needed. See
  [McpServersCard.tsx](src/settings/sections/components/McpServersCard.tsx).

### Fixed

- **AI-native correctness pass (64 audited issues).** Across the agent loop,
  sub-agent orchestration, skills, MCP, tools, memory, checkpoint, and composer.
  Highlights: an MCP connect race that double-spawned and leaked a server
  process; a crashed MCP server staying "connected" with stale tools;
  `edit`/`multi_edit` failing to match on CRLF files; an invalid tool key
  (`Read Terminal`) that rejected strict providers; a boot path that could wipe
  a session's persisted messages; a plan-mode large-file write truncating the
  file on Restore; memory/TEDI.md cache invalidation no-op on Windows;
  false-positive tool-repetition stops; and streaming over-context recovery. See
  [agent.ts](src/modules/ai/lib/agent.ts),
  [transport.ts](src/modules/ai/lib/transport.ts),
  [edit.ts](src/modules/ai/tools/edit.ts),
  [skills.ts](src/modules/ai/lib/skills.ts).

### Security

- **Autonomous worker and shell guards hardened.** The Odyssey worker now
  refuses out-of-scope mutations (previously only reads were scoped) and writes
  directly past plan mode so its verification is honest. The `rm -rf ~/` family
  and a symlinked-parent write path are blocked; protected-directory and gcloud
  credential patterns extended; the `fetch` tool routes through the SSRF-guarded
  backend. See [security.ts](src/modules/ai/lib/security.ts),
  [fs.ts](src/modules/ai/tools/fs.ts), [fetch.ts](src/modules/ai/tools/fetch.ts).

## [0.3.61] - 29-06-2026

### Added

- **Space-themed agent roster with the Polaris orchestrator.** The built-in AI
  persona is now a single orchestrator, **Polaris**, that delegates to six
  specialist sub-agents: **Comet** (codebase search), **Nebula** (third-party
  library / dependency research), **Nova** (deep debugging / architecture
  advisor), **Orbit** (pre-planning analysis), **Eclipse** (plan / change
  review), and **Odyssey** (autonomous worker). See
  [registry.ts](src/modules/ai/agents/registry.ts), [agents.ts](src/modules/ai/lib/agents.ts).
- **Odyssey, an autonomous worker sub-agent.** Beyond the read-only explorers
  and advisors, Odyssey implements a scoped change end to end: it edits,
  creates, moves, copies, and deletes files and runs shell commands, then
  verifies. Its mutating tools auto-execute inside the sub-agent loop, guarded
  by the secret / system denylist, writable / deletable checks, and
  checkpoint / restore. See [runSubagent.ts](src/modules/ai/agents/runSubagent.ts).
- **Persistent project memory (`.tedi/memory`).** Markdown files under
  `.tedi/memory/*.md` are auto-loaded into context (Claude-CLI style) alongside
  `TEDI.md`, and the agent is told it can record durable facts there. See
  [transport.ts](src/modules/ai/lib/transport.ts), [agent.ts](src/modules/ai/lib/agent.ts).
- **Skills.** Install expert playbooks (`SKILL.md` folders) from any GitHub repo,
  globally or per-project, under `~/.tedi/skills` and `.tedi/skills`; the agent
  surfaces them by name + description and loads the full playbook on demand via
  the `skill` tool. See [skills.ts](src/modules/ai/lib/skills.ts),
  [SkillsCard.tsx](src/settings/sections/components/SkillsCard.tsx).
- **Debug capture.** A Debug toggle (Settings -> Agents -> Advanced & debugging)
  snapshots every request sent to the provider (system prompt, messages, model,
  params, tool list) in memory; a viewer in the chat input bar lists them and
  downloads each (or all) as JSON. No API keys are captured. See
  [debugStore.ts](src/modules/ai/store/debugStore.ts),
  [DebugRequestViewer.tsx](src/modules/ai/components/DebugRequestViewer.tsx).
- **`ultrathink` keyword.** When the latest message contains "ultrathink", the
  turn receives a provider-agnostic deep-reasoning directive. See
  [agent.ts](src/modules/ai/lib/agent.ts).

### Changed

- **Simplified AI settings.** The Agents section collapses every editable prompt
  and personal instructions into one "Advanced & debugging" accordion; the
  default surface is the persona, the Sub-agents toggle, and Skills. See
  [AgentsSection.tsx](src/settings/sections/AgentsSection.tsx).
- **Sub-agents have no step cap.** They run a task to completion; termination is
  a natural finish plus the main agent's anti-loop guards (tool-repetition and
  no-progress), with only a high runaway backstop. See
  [runSubagent.ts](src/modules/ai/agents/runSubagent.ts).
- **More context kept before compaction.** History compaction now triggers later
  (72% / 85% of the window, up from 60% / 80%). See [compact.ts](src/modules/ai/lib/compact.ts).
- **Consistent wide editor dialogs** via a single shared width constant. See
  [dialog.tsx](src/components/ui/dialog.tsx).

### Fixed

- **Custom instructions could not be cleared.** The Save button only appeared
  for non-empty text, so emptying the field could not be persisted; it now shows
  a Save / Clear action whenever the value changes. See
  [AgentsSection.tsx](src/settings/sections/AgentsSection.tsx).
- **`copy_file` is now checkpointed**, so a file copy made by the agent (including
  the autonomous worker) is undoable via restore. See [fs.ts](src/modules/ai/tools/fs.ts).

## [0.3.60] - 27-06-2026

### Added

- **Parallel sub-agent orchestration (`run_subagents`).** Building on the existing
  single `run_subagent`, the AI can now spawn a whole batch of isolated read-only
  sub-agents in one call to research / review / audit in parallel. `run_subagents`
  is a bounded-concurrency **DAG scheduler**: independent tasks fan out at once,
  and a task with `depends_on` waits for its upstream tasks and receives their
  summaries as context (scatter, then gather), with cascade-skip when a dependency
  fails and cycle / invalid-index detection. The AI sizes every batch itself (task
  count, max concurrency, per-task steps, summary size), each clamped to a built-in
  backstop it cannot exceed. See
  [subagent.ts](src/modules/ai/tools/subagent.ts),
  [runSubagent.ts](src/modules/ai/agents/runSubagent.ts).
- **A live "Sub-agents" strip.** Running sub-agents appear in a strip with a
  per-agent accordion, so you can see which session each belongs to, its current
  step, and its output as it streams. See
  [SubagentStrip.tsx](src/modules/ai/components/SubagentStrip.tsx),
  [subagentRunStore.ts](src/modules/ai/store/subagentRunStore.ts),
  [tool.tsx](src/components/ai-elements/tool.tsx).
- **Per-pane terminal theme.** Right-click a terminal pane's header and pick
  "Terminal theme" to give that pane its own palette (with swatch previews) or
  follow the global terminal theme. The choice persists across restarts. See
  [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx),
  [useTabs.ts](src/modules/tabs/lib/useTabs.ts),
  [panes.ts](src/modules/terminal/lib/panes.ts),
  [serialize.ts](src/modules/workspaces/serialize.ts),
  [TerminalPane.tsx](src/modules/terminal/TerminalPane.tsx).

### Changed

- **Sub-agents are a single on/off that also drives auto-orchestration.** When
  enabled, broad explore / review / audit / "study this whole project" requests
  auto-decompose into parallel sub-agents plus a synthesis step instead of reading
  files inline; the separate "Orchestration" toggle was merged into this one switch.
  Every number stays AI-decided (bounded by built-in caps), so there are no numeric
  settings. The auto-orchestration appendix and each per-type sub-agent prompt are
  user-editable in Settings -> Agents -> System prompts. See
  [SubagentsCard.tsx](src/settings/sections/components/SubagentsCard.tsx),
  [store.ts](src/modules/settings/store.ts),
  [agent.ts](src/modules/ai/lib/agent.ts),
  [config.ts](src/modules/ai/config.ts),
  [prompts.ts](src/modules/ai/lib/prompts.ts).
- **Token-optimized sub-agent prompts.** The `run_subagent` / `run_subagents` tool
  descriptions and the orchestration appendix were tightened (deduplicated the
  per-type Types list across the two tools, trimmed parameter descriptions,
  condensed the appendix) to cut per-turn schema cost while preserving every
  behavioral instruction. See
  [subagent.ts](src/modules/ai/tools/subagent.ts),
  [config.ts](src/modules/ai/config.ts).

### Fixed

- **grep / glob / list_directory no longer fail when the model passes a bare
  string for an array parameter.** A value like `glob: "**/*.ts"` (or a
  newline-wrapped one) is now coerced into a single-element array before
  validation instead of being rejected with `expected: array`, which previously
  could cascade into a "service error" before the model could retry. Splitting is
  on newlines only (so a glob brace `{a,b}` survives), and an omitted optional
  `glob` still stays undefined. See [schedule.ts](src/modules/ai/tools/schedule.ts).

## [0.3.59] - 26-06-2026

### Changed

- **Settings is consistent and more compact across every tab.** Every upload /
  import / file-pick button now shares one canonical control (the `.tedi` theme
  importer), extracted as a reusable `UploadButton`, so they look identical
  everywhere. Long or optional groups are tucked behind collapsible accordions to
  keep each tab compact but still clear: General's `tedi` command-line setup, the
  Agents System-prompts and Snippets sections, the Extensions install panel, and
  the About build-details block. Action-button sizes and icons were normalized
  across the Models, Extensions, Agents, and Code Editor tabs. See
  [UploadButton.tsx](src/settings/components/UploadButton.tsx),
  [GeneralSection.tsx](src/settings/sections/GeneralSection.tsx),
  [AgentsSection.tsx](src/settings/sections/AgentsSection.tsx),
  [ExtensionsSection.tsx](src/settings/sections/ExtensionsSection.tsx),
  [AboutSection.tsx](src/settings/sections/AboutSection.tsx).
- **The "Change Language Mode" picker is easier to navigate.** It now has an
  explicit close button, a clear-search button that resets the query, a visible
  scrollbar for the full language list, and it focuses the search field on open.
  See [LanguagePickerDialog.tsx](src/modules/editor/LanguagePickerDialog.tsx).

### Fixed

- **The SSH "Jump host" dropdown can be clicked again.** In the New / Edit SSH
  connection dialog the jump-host combobox only responded to the keyboard (Enter):
  a modal dialog disables pointer events outside its own layer and the popover's
  list inherited that, so mouse clicks were swallowed. The popover is now modal, so
  clicks register normally. See
  [SshConnectionDialog.tsx](src/modules/ssh/SshConnectionDialog.tsx).

## [0.3.58] - 26-06-2026

### Fixed

- **New terminal tabs and split panes no longer open blank.** On Windows
  (ConPTY), PSReadLine emits a DSR cursor-position query (`ESC[6n`) at startup
  and blocks until the terminal answers before drawing the prompt. The PTY
  daemon could deliver that query before `pty_open` resolved and assigned the
  session's PTY handle on the frontend, so xterm's auto-reply was written to a
  null handle and silently dropped; the shell then waited forever and the pane
  stayed blank with only a cursor. Terminal-originated bytes are now buffered
  while the handle is null and flushed the instant the PTY goes live, so the
  reply always reaches the shell. A blank-viewport repaint watchdog was added as
  a safety net (it nudges a redraw when a pane is still empty shortly after its
  first byte), and the daemon client buffers push output that arrives before the
  session channel is registered so the first prompt bytes can never be lost. See
  [pty-lifecycle.ts](src/modules/terminal/lib/pty-lifecycle.ts),
  [session-lifecycle.ts](src/modules/terminal/lib/session-lifecycle.ts),
  [sessionState.ts](src/modules/terminal/lib/sessionState.ts),
  [client.rs](src-tauri/src/modules/pty_daemon/client.rs).

### Changed

- **Settings UI refinements.** Theme and editor settings are grouped into
  collapsible accordion sections, and the app/terminal theme presets share a
  small palette-preview swatch so the available palettes are easier to scan. See
  [SettingsAccordion.tsx](src/settings/components/SettingsAccordion.tsx),
  [PalettePreview.tsx](src/settings/sections/theme/PalettePreview.tsx),
  [ThemeSection.tsx](src/settings/sections/ThemeSection.tsx).

## [0.3.57] - 26-06-2026

### Added

- **SSH host chaining (ProxyJump).** A saved connection can now tunnel through
  another saved host to reach a target that is not directly reachable (a bastion
  / jump host, like Termius). Pick a **Jump host** in the connection dialog; the
  chain is transitive (a jump host can have its own jump host). Each hop opens a
  `direct-tcpip` tunnel over the previous one and verifies + pins its own server
  key (trust-on-first-use), and the remote SFTP file browser works through the
  chain too. See [session.rs](src-tauri/src/modules/ssh/session.rs),
  [connections.ts](src/modules/ssh/connections.ts),
  [SshConnectionDialog.tsx](src/modules/ssh/SshConnectionDialog.tsx).
- **Independent Terminal theme.** The terminal is now its own theme domain with
  a dedicated **Terminal** settings panel and palette; by default it follows the
  app theme pixel-for-pixel, so existing setups look unchanged. See
  [TerminalThemePanel.tsx](src/settings/sections/TerminalThemePanel.tsx),
  [terminalPalette.ts](src/modules/settings/terminalPalette.ts).

### Changed

- **App, terminal, and editor/diff are now separate theme domains.** The editor
  and its side-by-side diff follow the editor theme independently of the app
  chrome, so changing one no longer repaints the others. See
  [terminalTheme.ts](src/styles/terminalTheme.ts),
  [tokens.ts](src/styles/tokens.ts).
- **SSH host-key confirmation dialog** buttons now fill the row in two equal
  columns, matching the app's other confirmation modals. See
  [HostKeyPromptDialog.tsx](src/modules/ssh/HostKeyPromptDialog.tsx).

### Fixed

- **SSH no longer hangs at "connecting" when confirming a new host key.** On a
  first connection to a new host the "Trust & connect" decision never reached
  the backend (the prompt id crossed the IPC channel snake_case while the
  frontend read camelCase), so the handshake stayed paused until a 120s timeout
  and the connection looked stuck. Confirming a new host now connects
  immediately. See [session.rs](src-tauri/src/modules/ssh/session.rs),
  [bridge.ts](src/modules/ssh/bridge.ts).

## [0.3.56] - 23-06-2026

### Fixed

- **Find in Files / Find in File results now scroll.** The filename-search and
  folder-wide grep result panes wrapped their `ScrollArea` in a flex column with
  no bounded height, so the list grew past the viewport instead of scrolling. The
  wrapper now fills the remaining explorer height while results are showing (and
  stays collapsed otherwise, so the tree layout is untouched), in both the main
  folder tree and the secondary folder tree. See
  [ExplorerSearch.tsx](src/modules/explorer/ExplorerSearch.tsx),
  [ExplorerGrep.tsx](src/modules/explorer/ExplorerGrep.tsx).
- **SSH connects to file-transfer-only servers.** A locked-down SFTP account
  (chroot, `PermitTTY no`, `ForceCommand internal-sftp`, a `nologin` login shell)
  denies the interactive PTY/shell, which used to abort the whole connection. The
  PTY and shell requests are now best-effort: a normal server is unchanged, while
  a shell-less server connects SFTP-only (the remote file browser works and the
  terminal shows a one-line notice) instead of failing outright. See
  [session.rs](src-tauri/src/modules/ssh/session.rs).
- **A right-docked sidebar section remembers its open/closed state.** A section
  moved to the right slot (for example SQL Explorer's Databases list) reopened on
  every launch because the slot's open state was session-only. Its last
  open/closed intent is now persisted and restored, so a section you closed stays
  closed (its status-bar icon still reopens it). See
  [useDockedSectionAutoOpen.ts](src/app/hooks/useDockedSectionAutoOpen.ts),
  [sidebarPlacementStore.ts](src/modules/extensions/sidebarPlacementStore.ts).

## [0.3.55] - 20-06-2026

### Fixed

- **No more stray terminal beep.** PSReadLine ships with `BellStyle = Audible`,
  which rings a real machine beep (`[Console]::Beep`) on a no-op completion or a
  prompt redraw after a resize. With Remote Access that surfaced as a "beep" when
  a browser opened or fit-resized a tab. The injected shell profile now sets
  `BellStyle = None`, so the shell stays quiet (the visible terminal is
  unchanged). Guarded for shells without PSReadLine.

## [0.3.54] - 20-06-2026

### Added

- **`ctx.ssh.closeConnection(sessionId)`** closes the desktop SSH tab whose live
  SSH session id matches (the runtime id from `ssh_list_sessions`). Lets a mirror
  like Remote Access close an SSH tab from the browser and have the desktop tab
  close too, not just the underlying session.

### Fixed

- **SSH tab numbers now reach extensions.** The app-context `terminals` snapshot
  only included local terminals (keyed by daemon ptyId); SSH leaves have no
  ptyId, so a mirror fell back to guessing their number. SSH leaves are now
  included keyed by their live session id (`ssh:<id>`), so the Remote Access
  browser labels SSH tabs with the same number the desktop shows.
- **No AI CLI approval beep on a session's first status.** The beep fired even on
  a leaf's very first observed status, so connecting to (or a remote mirror
  attaching to) a session that's already "blocking" beeped on connect, heard as
  an unwanted connection sound. It now beeps only on a genuine transition into
  blocking; the visual toast still shows.

## [0.3.53] - 20-06-2026

### Added

- **Extensions can open a saved SSH connection by id (`ctx.ssh`, gated by the new
  `ssh:connections` permission).** `ctx.ssh.listConnections()` returns the user's
  saved SSH hosts as SECRET-FREE metadata (id/name/host/user + a `pinned` flag);
  `ctx.ssh.openConnection(id)` opens one as a real SSH tab, reusing the app's
  keychain-backed connect flow. The SSH password/key never cross the boundary -
  only a connection id does. `openConnection` REFUSES a host with no pinned
  server key, so a remote caller can never trigger a first-connect host-key
  prompt (which needs human verification on the desktop). This backs the Remote
  Access "open SSH from the browser" feature.

### Security

- **SSH host-key algorithms hardened.** Dropped bare `ssh-rsa` (RSA with SHA-1
  signatures, collision-broken and disabled by default in OpenSSH since 8.8) from
  the accepted host-key set, keeping ed25519 / ecdsa / rsa-sha2-*. russh's vetted
  KEX / cipher / MAC / compression defaults are pinned so the posture is frozen
  across version bumps.
- **SSH host-key prompt lifecycle fixed.** A first-connect (TOFU) prompt that ends
  without an answer (rejected, 120s timeout, or an abandoned Test probe) is now
  dismissed from the shared queue, so a dead prompt can no longer shadow every
  later connect's prompt (which previously required an app restart to clear).

## [0.3.52] - 20-06-2026

### Added

- **Remote Access: terminals opened from the browser appear in the desktop app
  again (bidirectional dynamic tabs).** Re-enabled the GUI poll-adopt
  (`useAdoptDaemonSessions`): when a browser hits "+", the remote-access agent
  spawns a PTY in the shared daemon and the desktop now adopts it as a real tab
  (and a browser-initiated close tears that tab down too). Combined with the
  existing app->browser mirroring, tabs open safely from either side. This was
  withdrawn in 0.3.49 on the theory it caused the launch hang; the real cause
  was synchronous git commands on the UI thread (fixed in 0.3.50), so the
  feature is restored.
- **Remote Access: browser tab numbers match the desktop again.** Restored
  `AppContextSnapshot.terminals` (daemon `ptyId` -> the tab's `terminalOrdinal`),
  which the extension forwards to the browser so a mirrored tab shows the SAME
  number the desktop shows instead of guessing from position.

### Changed

- **`pty_list_sessions` now runs off the UI thread.** It is a blocking daemon
  round-trip bounded by a 30s timeout, and the adopt poll calls it every ~2s; on
  Windows a sync command runs on the WebView2 UI thread, so a slow or hung daemon
  could have frozen the app. It now hands the round-trip to the blocking pool, so
  the poll can never stall the UI (the same hardening applied to git in 0.3.50).

## [0.3.51] - 20-06-2026

### Added

- **Configurable terminal scrollback limit (Settings -> General).** Each terminal
  keeps a capped history ring (xterm `scrollback`); a smaller cap uses less
  memory per leaf, like a CMD screen-buffer height. Pick 200 / 500 / 1000 /
  2500 / 5000 / 10000 lines. Changes apply to already-open terminals instantly
  (lowering trims the buffer right away). The default drops from the old
  hard-coded 5000 to 1000 (roughly 6 MB to 1.2 MB per terminal) so the app is
  lighter out of the box.

## [0.3.50] - 20-06-2026

### Fixed

- **The app no longer freezes / shows "Not Responding" on launch (and on every
  Source Control refresh).** The git-decoration commands were synchronous
  `#[tauri::command]`s, and on Windows a synchronous command runs on the
  WebView2 UI (main) thread. On a large open workspace `git status` and
  `git ls-files` take several seconds, so each refresh blocked the UI thread for
  that long, which is enough for Windows to paint the window "Not Responding"
  and offer to force-close it. A minidump of the frozen process caught the main
  thread stuck in `NtCreateFile` inside `git_status` -> `count_file_lines`, and
  (after that one was fixed) in `git_ignored` waiting on a `git ls-files`
  subprocess. All eleven git commands (`git_status`, `git_ignored`, `git_log`,
  `git_file_head`, `git_file_at`, `git_diff_full`, `git_commit`,
  `git_commit_detail`, `git_discard_file`, `git_discard_all`, `git_push`) now
  run on the blocking pool via `async_runtime::spawn_blocking`, so git work never
  touches the UI thread. This was unrelated to the Remote Access extension; the
  open workspace simply grew large enough to expose a latent main-thread block.
- **`count_file_lines` can no longer block the decoration refresh.** It now skips
  symlinks and special files (named pipes, devices, sockets) via
  `symlink_metadata` + `is_file()` before reading, since opening such an entry
  can block forever in `NtCreateFile`.
- **git invocations can no longer stall on a prompt.** Every `git` child now
  spawns with a null stdin and `GIT_TERMINAL_PROMPT=0`, so a credential or
  host-key prompt fails fast instead of hanging a worker.

## [0.3.49] - 19-06-2026

### Reverted

- **Hotfix: reverted the daemon-session auto-adopt (0.3.47) and the per-terminal
  app-context publishing (0.3.48).** Those additions correlated with the app
  hanging on launch, so the startup path is restored to the stable 0.3.46
  behavior (the GUI no longer poll-adopts daemon sessions, and
  `AppContextSnapshot.terminals` is removed). The Remote Access "browser-opened
  terminal appears in the desktop app" and "browser tab numbers match the app"
  features are withdrawn until they can be reintroduced with proper runtime
  testing.

## [0.3.48] - 19-06-2026

### Added

- **Per-terminal tab numbers exposed to extensions.** The app-context bridge now
  publishes `AppContextSnapshot.terminals` (a `{ptyId, ordinal}` list keyed by
  daemon PTY id with each terminal's FIFO `terminalOrdinal`), so a mirror like
  the Remote Access browser client can label its tabs with the SAME number the
  desktop shows instead of guessing from left-to-right position.

## [0.3.47] - 19-06-2026

### Added

- **Terminals opened from the Remote Access browser now appear in the desktop
  app.** The GUI reconciles its tabs against the PTY daemon's session list every
  ~2s and adopts any new session created by another daemon client (the
  remote-access agent, when the browser hits "+"), attaching to it via the same
  reattach path used on workspace restore (`useAdoptDaemonSessions`). Because the
  GUI is now attached, closing such a terminal from the browser also closes the
  matching tab in the desktop app. Conservative guards (a creation-time
  watermark, an owned-set across all in-memory workspaces, and a
  "once-owned never re-adopt" rule) keep pre-existing or retained daemon sessions
  from being pulled in.

## [0.3.46] - 19-06-2026

### Added

- **Extension status-bar items can use host HugeIcons.** A `StatusItem` whose
  `icon` is `hugeicon:<Name>` (e.g. `hugeicon:Globe02Icon`) now renders the
  built-in line-art icon with theme-aware tinting, matching how header-bar items
  already resolve HugeIcons. Previously the status-bar slot only understood
  `data:`/`ext-asset:` icons, so a `hugeicon:` value showed as an empty square
  (the Remote Access globe was blank)
  ([ExtensionStatusItems.tsx](src/modules/extensions/components/ExtensionStatusItems.tsx)).

## [0.3.45] - 19-06-2026

### Fixed

- **SSH mirror sinks no longer leak.** The SSH read pump now prunes a mirror sink
  as soon as its channel closes, and caps the live sink count, instead of letting
  closed sinks from the Remote Access bridge accumulate across reconnects (which
  grew memory and wasted a clone + send on every byte of output)
  ([session.rs](src-tauri/src/modules/ssh/session.rs)).

## [0.3.44] - 19-06-2026

### Changed

- **Extension settings collapse into an accordion.** In Settings, each enabled
  extension's contributed settings now sit behind a collapsible "Settings · N"
  header (collapsed by default) with a rotating chevron, instead of always being
  expanded, so the Extensions list stays compact
  ([ExtensionCard.tsx](src/settings/sections/components/ExtensionCard.tsx)).

## [0.3.43] - 19-06-2026

### Added

- **Host commands to mirror SSH tabs (for the Remote Access extension).** New
  `ssh_list_sessions` and `ssh_attach` commands let a permission-gated extension
  enumerate open SSH tabs and stream each session's output (replayed ring plus
  live) through a Tauri `Channel`; the extension host gained
  `ctx.invokeChannel(command, args, onEvent)` to consume such a stream. The SSH
  read pump now fans `Data`/`Exit` to any attached mirror sinks alongside the
  GUI, so mirroring never disturbs the local view
  ([session.rs](src-tauri/src/modules/ssh/session.rs),
  [ssh/mod.rs](src-tauri/src/modules/ssh/mod.rs),
  [host.ts](src/modules/extensions/host.ts), [lib.rs](src-tauri/src/lib.rs)).
  This is what the `tedi.remote-access` extension needs to mirror SSH tabs to the
  browser; local terminals already mirror without core changes.

## [0.3.42] - 18-06-2026

### Fixed

- **Hardened the Claude Code `/tui` renderer-switch repaint so it fires reliably
  (builds on v0.3.41).** v0.3.41 triggered only on a full-screen clear
  (`\x1b[2J`), but capturing the real CLI showed the inline (classic) renderer
  does not always emit one, so the nudge could miss the switch. v0.3.42 also
  triggers on Claude's switch-confirmation text (`(classic|fullscreen|default)
  renderer`, e.g. "Switching back to the classic renderer"), which is emitted on
  every `/tui` toggle and was verified against real captured output for all three
  modes ([pty-lifecycle.ts](src/modules/terminal/lib/pty-lifecycle.ts):
  `outputSignalsRendererSwitch`). The repaint nudge now also clears the WebGL
  texture atlas (`clearTextureAtlas`) alongside the scroll-region reset, full
  refresh, and SIGWINCH round-trip, to drop any stale glyph cells left by the
  renderer-switch redraw. Still gated on an active AI CLI so a plain shell never
  triggers it.

## [0.3.41] - 18-06-2026

### Fixed

- **Terminal repaint on Claude Code's `/tui` renderer switch now triggers on the
  correct event (corrects v0.3.40, which was inert here).** Byte capture of
  Claude Code 2.1.181 showed its fullscreen renderer redraws on the NORMAL screen
  buffer (a full-screen `\x1b[2J` clear) and never enters the alternate screen,
  so v0.3.40's alternate-screen trigger (`onBufferChange`) never fired for this
  case. v0.3.41 instead detects a full-screen clear emitted by an active AI CLI
  ([pty-lifecycle.ts](src/modules/terminal/lib/pty-lifecycle.ts): `hasFullScreenClear`
  + `maybeNudgeOnRendererSwitch`) and nudges a repaint plus a SIGWINCH resize
  round-trip, the same recovery a manual window resize performs (Claude's
  documented remedy for renderer-switch glitches). The alternate-screen exit path
  is kept for TUIs that genuinely use it (vim, htop). Replaying Claude's real
  output through xterm renders cleanly, so the residual corruption is a TEDI-side
  render/timing desync that a forced repaint addresses; the trigger is verified
  against the captured bytes.

## [0.3.40] - 18-06-2026

### Fixed

- **Terminal pane no longer corrupts and goes input-dead when a fullscreen TUI
  toggles its renderer (e.g. Claude Code's `/tui fullscreen` to `/tui default`).**
  Leaving the alternate screen (`CSI ?1049l`) does not reset the normal buffer's
  DECSTBM scroll region in xterm, and a same-size `term.resize` is a no-op
  (`CoreBrowserTerminal` early-returns when the dimensions are unchanged), so
  TEDI's pixel-driven `ResizeObserver` never repainted. The relaunched classic
  renderer then painted its prompt box against the stale scroll margins
  (fragmented box plus stray horizontal rules) and its line-editor redraw landed
  off-screen, so input only looked dead while keystrokes were in fact still
  delivered. A new `armAltExitRepaintWatchdog`
  ([pty-lifecycle.ts](src/modules/terminal/lib/pty-lifecycle.ts)), fired on the
  alt-to-normal buffer edge via `term.buffer.onBufferChange`
  ([session-lifecycle.ts](src/modules/terminal/lib/session-lifecycle.ts)), resets
  the scroll region (cursor preserved), forces a repaint, then SIGWINCHes the PTY
  in a round-trip so the foreground program redraws at the correct size. It fires
  only on the exit edge, so launching a TUI (normal to alternate) is left
  untouched.

## [0.3.39] - 17-06-2026

### Fixed

- **Extension panels in a split-pane leaf now scroll when their content
  overflows.** The panel mount
  ([ExtensionPanelMount](src/modules/extensions/components/ExtensionPanelMount.tsx))
  now gets `h-full` so it has a definite height inside a split-pane leaf, whose
  body wrapper ([PaneTreeView](src/modules/panes/PaneTreeView.tsx)) is a
  relative block — there, `flex-1` alone left the mount unsized, so a tall panel
  (e.g. a short SQL Explorer pane) was clipped by the leaf frame with no
  scrollbar. The tab surface, whose wrapper is a flex container, already gave
  the mount a definite height and is unaffected. Pairs with SQL Explorer 0.4.5,
  which adds the in-pane scroll + collapsible editor.
- **Inactive-workspace browser previews no longer float over the active
  workspace.** An embedded preview's native webview composites above the DOM and
  is kept alive across workspace switches (so returning doesn't reload), but when
  its workspace goes inactive the `BrowserPane` unmounts and the rAF loop that
  hides the webview stops while the webview stays shown. The session-disposal
  hook ([useSessionDisposal](src/app/hooks/useSessionDisposal.ts)) now hides such
  webviews via a new `browserEmbedHide` (sets the preview invisible without
  destroying it), latched to fire once per switch-away; returning to the
  workspace remounts the pane and re-shows it.

## [0.3.38] - 17-06-2026

### Added

- **Live AI CLI status for hidden workspaces.** The Workspaces panel now keeps a
  running agent's spinner alive on a terminal row even while its workspace is
  inactive, via an attach-independent `useAiCliStatuses` store
  ([aiCliStatusStore.ts](src/modules/terminal/lib/aiCliStatusStore.ts)) written
  directly by each session's detector for the term's whole life — not the
  attach-bound `onAiCliStatus` callback chain that `detachSession` clears the
  moment a workspace goes inactive.
  [WorkspacesPanel](src/modules/workspaces/WorkspacesPanel.tsx) resolves
  terminal rows from an app-owned cache of every visited workspace's live tab
  trees, falling back to the persisted snapshot for cold (never-opened)
  workspaces.

## [0.3.37] - 16-06-2026

### Added

- **Extensions can contribute a left-sidebar section.** A new `ctx.sidebar`
  host API (`setSection` / `removeSection`, gated by a new low-risk
  `sidebar:write` permission) lets an extension publish a list section that the
  host renders with the exact [WorkspacesPanel](src/modules/workspaces/WorkspacesPanel.tsx)
  chrome (h-8 header with icon + title + action buttons, then a scrollable row
  list with hover row-actions and lifecycle-tone labels). Sections appear as
  dynamic, reorderable / collapsible [AppSidebar](src/app/components/AppSidebar.tsx)
  sections (keyed `xsec:<extId>:<sectionId>`) **only while the owning extension
  is active**, so they show/hide with enable/disable — no separate "is
  installed" gate; re-calling `setSection` with the same id updates the row
  list. Backed by a runtime `sidebarSectionsRegistry`
  ([registries.ts](src/modules/extensions/registries.ts)) +
  [`ExtensionSidebarSection`](src/modules/extensions/components/ExtensionSidebarSection.tsx),
  mirroring the existing header-/status-item registries. The SQL Explorer
  extension uses it to lift its connection list (add / refresh / list) out of
  the panel and into the workspace-style sidebar.
  - **Rows are rich tree nodes.** A row can nest with expand carets and
    `onItemToggle`-driven lazy children, show an engine-type badge, carry a
    lifecycle tone (connecting / connected / error), expose per-row hover
    action buttons, and resolve a host icon (`hugeicon:`, `fileicon:`, `data:`,
    or `ext-asset:`) ([registries.ts](src/modules/extensions/registries.ts),
    [ExtensionSidebarSection.tsx](src/modules/extensions/components/ExtensionSidebarSection.tsx)).
  - **Sections can opt into client-side filtering.** Setting `searchable`
    renders a filter input above the list that matches rows by label / sublabel
    (including already-loaded descendants, with matching branches
    auto-expanding) ([ExtensionSidebarSection.tsx](src/modules/extensions/components/ExtensionSidebarSection.tsx)).
  - **Movable sections can dock to the shared right panel.** A section marked
    `movableToRight` shows a move-to-right toggle; once docked it leaves the
    left sidebar, gains a status-bar icon to reopen it, and renders in the right
    slot (as the same React tree as the left sidebar, not a DOM panel renderer)
    with move-back-to-left and close controls. Placement persists per section
    and a docked section auto-opens on mount when the right slot is free
    ([sidebarPlacementStore.ts](src/modules/extensions/sidebarPlacementStore.ts),
    [SidebarSectionRightToggles.tsx](src/modules/extensions/components/SidebarSectionRightToggles.tsx),
    [useDockedSectionAutoOpen.ts](src/app/hooks/useDockedSectionAutoOpen.ts),
    [RightPanelHost.tsx](src/modules/extensions/components/RightPanelHost.tsx)).

- **Extensions can open a panel as a native split-pane leaf, not just a
  standalone tab.** The new `ctx.tabs.openExtensionPane({ panelId, title,
  icon?, reuseKey? })` (gated by `tabs:open`) mounts the panel in the same frame
  as a terminal / editor / browser leaf, so it is splittable and joinable like
  any other pane; re-opening focuses the existing live leaf and dedups instead
  of duplicating it, and the panel keeps its module singletons. The pane
  header label is tinted with the same connecting / connected / disconnected
  palette as the SSH label and ext-tab chip, driven by the leaf's `state` and
  persisted across pane clone ([host.ts](src/modules/extensions/host.ts),
  [tabsBridge.ts](src/modules/extensions/tabsBridge.ts),
  [useAuxTabs.ts](src/modules/tabs/lib/useAuxTabs.ts),
  [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx),
  [entries.ts](src/modules/tabs/lib/entries.ts),
  [renderEntryBody.tsx](src/modules/tabs/components/renderEntryBody.tsx)).

- **Local extension dev loop with no zip or publish step.** New
  [scripts/link-dev-extensions.mjs](scripts/link-dev-extensions.mjs)
  junctions / symlinks each `extensions/<id>/` working copy into the dev
  profile's app-data extensions dir so edits go live on a window reload; wired
  as `pnpm tauri:dev:ext`, `pnpm link:ext`, `pnpm relink:ext` (`--force`), and
  `pnpm unlink:ext`, with stale `state.json` entries reset so links load
  enabled with their current manifest permissions auto-approved.

- **`ctx.secrets.delete(name)` was added to the extension host API.** It
  removes a value from the OS keychain via the `secrets_delete` invoke, reusing
  the existing `secrets:write` gate ([host.ts](src/modules/extensions/host.ts)).

- **Shared CLI progress-bar vocabulary in `cli_paint`.** New
  `progress_bar` / `progress_line` / `print_download_progress` /
  `overwrite_line` / `end_progress_line` plus a shared `fmt_bytes` render an
  identical green-fill `████░░░░ NN%` bar across surfaces, only emitting
  carriage-return overwrites on a real TTY so piped output stays free of
  control bytes ([cli_paint.rs](src-tauri/src/modules/cli_paint.rs)).

- **Extension authors can resolve arbitrary Catppuccin icon names to data
  URLs.** A new `explorerIconUrl(name)` helper lets non-file surfaces reuse the
  file-tree icon pack ([iconResolver.ts](src/modules/explorer/lib/iconResolver.ts)).

### Changed

- **`tedi --update` and `tedi ext install` now share a live progress bar.**
  `tedi --update` downloads via `http_get_bytes_with_progress` feeding
  `print_download_progress`, ending with a green-check `Downloaded <size>` line
  in human-readable units instead of a raw byte count
  ([cli_update.rs](src-tauri/src/modules/cli_update.rs)); `tedi ext install`
  was rewritten to render the same `cli_paint` bar for both download and
  extraction (throttled to ~10 ticks plus a final tick) and dropped its private
  `fmt_bytes` ([install.rs](src-tauri/src/modules/cli_ext/install.rs)).

- **`tedi ext` list / update CLI output is now English and dimmed.**
  Empty-registry, cancelled, skipped, and non-interactive hint lines are
  painted dim, install-command hints are highlighted, and leftover Indonesian
  picker prompts ("Pilih extension", "Dibatalkan.") were translated to English
  ([commands.rs](src-tauri/src/modules/cli_ext/commands.rs)).

- **`setExtensionTabState` can now relabel the tab / pane and patches both
  surfaces at once.** It accepts an optional `title` (e.g. "SQL Explorer ·
  mydb") and applies the lifecycle tone + title to both a standalone
  `kind:"ext"` tab and a live extension-panel pane leaf matched on
  `(extensionId, panelId, reuseKey)` ([host.ts](src/modules/extensions/host.ts),
  [useAuxTabs.ts](src/modules/tabs/lib/useAuxTabs.ts),
  [panes.ts](src/modules/terminal/lib/panes.ts)).

- **The agent now keeps web research in a single reused browser tab.**
  `open_browser` defaults to navigating its existing research pane (or the only
  open browser) instead of spawning a new tab per page, lowering memory and tab
  clutter; results carry `reused: true`, and a new `new_tab: true` flag forces
  a separate tab when needed. The reuse target is tracked across
  `control_browser` and `navigate_and_read`
  ([terminal.ts](src/modules/ai/tools/terminal.ts),
  [config.ts](src/modules/ai/config.ts)).

- **Source Control can be moved between the left sidebar and the right panel
  from its header.** New "Move to right panel" / "Move to left sidebar"
  buttons in [PanelHeader](src/modules/scm/components/PanelHeader.tsx) flip the
  layout preference and open / close the corresponding panel in one click; the
  old General-settings "move Source Control to right panel" switch was dropped
  in favor of this (and replaced, when the SQL Explorer extension is installed,
  by a toggle that enables / disables it, adding or removing its Databases
  panel) ([GeneralSection.tsx](src/settings/sections/GeneralSection.tsx)).

- **The status bar's right-group toggles no longer reflow the row when their
  panel opens.** The AI, Source Control, movable-section, and extension
  right-panel toggles now stay in place at all times and render an active /
  pressed state (`aria-pressed`, accent background) with a "Close …" tooltip
  instead of vanishing once open; the entrance / launch animations were dropped
  for a stable icon row, the now-unused `hasComposer` prop was removed, and the
  text-label right-panel toggles were replaced with icon-only default toggles
  (`RightPanelTextToggles` renamed to `RightPanelDefaultToggles`). The panel
  manifest `compact` flag now only controls placement — every toggle is
  icon-only regardless, and `compact: true` simply clusters the toggle with the
  borderless extension status icons at the left of the right group
  ([StatusBar.tsx](src/modules/statusbar/StatusBar.tsx),
  [RightPanelToggleButtons.tsx](src/modules/extensions/components/RightPanelToggleButtons.tsx),
  [SidebarSectionRightToggles.tsx](src/modules/extensions/components/SidebarSectionRightToggles.tsx),
  [AiStatusBarControls.tsx](src/modules/ai/components/AiStatusBarControls.tsx),
  [manifest.ts](src/modules/extensions/manifest.ts)).

- **The sidebar section order persists built-in and extension keys together and
  reconciles them each render.** Persisted order is read verbatim and
  reconciled against currently-existing keys — dropping uninstalled-extension
  or removed keys and appending new ones in canonical / registry order — so a
  newly-active extension lands in a stable spot
  ([AppSidebar.tsx](src/app/components/AppSidebar.tsx)).

- **Destructive actions across the app now require confirmation instead of
  acting immediately.** Closing a workspace that has open tabs warns its tabs
  and running terminals will be closed (empty workspaces still close instantly)
  ([WorkspacesPanel.tsx](src/modules/workspaces/WorkspacesPanel.tsx)); deleting
  a chat from session history names the chat and warns the deletion is
  permanent ([SessionHistoryDialog.tsx](src/modules/ai/components/SessionHistoryDialog.tsx));
  deleting or resetting an agent, deleting a snippet, and resetting a system
  prompt to its default each open a dialog naming the item
  ([AgentsSection.tsx](src/settings/sections/AgentsSection.tsx),
  [SystemPromptsCard.tsx](src/settings/sections/components/SystemPromptsCard.tsx));
  and deleting a file or folder from the Explorer replaces the old inline
  "Click again to confirm" item with an AlertDialog that names the target
  ([FileTreeNode.tsx](src/modules/explorer/FileTreeNode.tsx)).

- **Misc UI polish.** Destructive controls read more clearly — the plan-diff
  "clear" action and the install-review button (when an extension requests
  `*` / `invoke:*` near-total access) use the solid destructive variant
  ([PlanDiffReview.tsx](src/modules/ai/components/PlanDiffReview.tsx),
  [InstallReviewDialog.tsx](src/settings/sections/components/InstallReviewDialog.tsx)),
  the image-lightbox close button moves to a secondary background with a
  destructive hover ([ImageLightbox.tsx](src/modules/ai/components/ImageLightbox.tsx)),
  and the SSH host-deletion confirm reads as destructive
  ([SshMenu.tsx](src/modules/ssh/SshMenu.tsx)). Secondary / Cancel buttons
  across dialogs switched from ghost to the more visible outline variant
  (agent, snippet, prompt-editor, install-review, new-editor, SSH host-key
  prompt, and updater dialogs)
  ([NewEditorDialog.tsx](src/modules/editor/NewEditorDialog.tsx),
  [HostKeyPromptDialog.tsx](src/modules/ssh/HostKeyPromptDialog.tsx),
  [UpdaterDialog.tsx](src/modules/updater/components/UpdaterDialog.tsx)). The
  additional-path probe indicators now use the `text-icon-working` /
  `text-diff-added` theme tokens instead of hardcoded amber / emerald
  ([AdditionalPathEditor.tsx](src/settings/sections/components/AdditionalPathEditor.tsx)),
  and the Explorer header gained a vertical separator before the search button
  ([ExplorerHeader.tsx](src/modules/explorer/components/ExplorerHeader.tsx)).

- **Extension-author docs expanded for the dev loop, src/→bundle pipeline, and
  CI releases.** [extensions/README.md](extensions/README.md) now documents
  local dev linking, the esbuild build pipeline (git-ignored generated
  `extension.js`), and tag-triggered CI packaging; [TEDI.md](TEDI.md) documents
  the newer `headerbar:write` / `sidebar:write` permissions and the
  sidebar-section / header-item registries (and notes the dev-link loop and the
  shared download progress bar).

### Fixed

- **Background (agent-opened) preview panes no longer steal keyboard focus.**
  `spawn_preview_child` takes a `focus_on_create` flag and creates off-screen
  background webviews with `focused(false)`, so an agent opening a browser to
  read in the background no longer yanks focus from the terminal / editor the
  user is typing in; foreground panes still take focus like a normal tab
  ([embed.rs](src-tauri/src/modules/preview/embed.rs)).

- **A right-panel section whose extension is disabled or uninstalled is now
  closed instead of leaving a dead header.** The right-panel defaults hook
  validates a docked section against the live sidebar-section registry and
  closes the slot when the section is no longer contributed
  ([useExtensionPanelDefaults.ts](src/app/hooks/useExtensionPanelDefaults.ts)).

- **The find-match highlight color now adapts to the active theme.** The
  current-match highlight switched from a hard-coded dark text color to
  `var(--background)`, fixing washed-out text on light or custom gold themes
  ([globals.css](src/styles/globals.css)).

- **A failed Explorer grep replace now surfaces as a toast instead of a
  blocking browser alert.** [ExplorerGrep](src/modules/explorer/ExplorerGrep.tsx)
  reports replace errors via an error-variant toast.

- **Panel toggle icons no longer double-announce their name to screen
  readers.** The decorative `<img>` now uses an empty `alt` and `aria-hidden`
  since the wrapping button already carries the `aria-label`
  ([RightPanelToggleButtons.tsx](src/modules/extensions/components/RightPanelToggleButtons.tsx)).

## [0.3.36] - 13-06-2026

### Added

- **Extension panels can live inside split panes.** An extension's
  workspace tab (e.g. the SQL Explorer) can now be split next to a
  terminal / editor / browser via the pane header's right-click
  "Split with…" menu, and dragged / grouped like any other pane leaf.
  Surface-aware extensions render header-less + compact in a pane (the
  pane frame supplies the title + drag handle + close); re-opening the
  panel focuses the existing pane instead of mounting a duplicate. A new
  `extension-panel` pane-leaf kind is threaded through the pane tree,
  render, serialize (session-only), and disposal paths.

## [0.3.35] - 13-06-2026

### Changed

- Development checkpoint — version bump to cut a build. Bundles in-progress
  local work across the explorer (git decorations), AI (approval-mode
  styling), terminal (session-lifecycle refactor), and pane/tab + SCM/git
  plumbing; see the commit history for per-area detail.

## [0.3.34] - 13-06-2026

### Fixed

- **The AI can now read an in-app browser it opened in the background, instead of giving up and doing a blind HTTP `fetch`.** When the agent opened a browser without focusing its tab (a price / exchange-rate / search lookup), the native webview was only created once the tab became visible — so `read_browser` found no webview, returned null, and the agent fell back to `fetch`, which returns empty HTML on JS-heavy sites (Google answer boxes, SPAs). The background-create path now spawns the webview **off-screen** so the page still loads and lays out for a headless read, without it painting over the foreground pane; focusing the tab later repositions it on-screen ([`embed.rs`](src-tauri/src/modules/preview/embed.rs), [`buildLiveContext.ts`](src/app/lib/buildLiveContext.ts), [`useAuxTabs.ts`](src/modules/tabs/lib/useAuxTabs.ts)).

### Changed

- **Dropped two unused frontend dependencies.** `@tauri-apps/plugin-log` and `@tauri-apps/plugin-window-state` were removed from `package.json` — only their Rust-side plugins are wired, the JS bindings had no importers ([`package.json`](package.json)).

## [0.3.33] - 12-06-2026

### Security

- **First connect to a new SSH host now pauses for fingerprint confirmation before any credential is sent.** Previously the server key was silently trusted on first use and auto-pinned, so a man-in-the-middle on that first connection could capture your password / private key invisibly. The backend now blocks the handshake, emits the SHA-256 fingerprint, and waits for an explicit Trust/Reject in a modal dialog; rejecting aborts before auth, and only on Trust is the fingerprint pinned for future mismatch detection. Mismatches on later connects stay a loud, non-auto-recovering error ([`session.rs`](src-tauri/src/modules/ssh/session.rs), [`mod.rs`](src-tauri/src/modules/ssh/mod.rs), [`HostKeyPromptDialog.tsx`](src/modules/ssh/HostKeyPromptDialog.tsx), [`ssh-session.ts`](src/modules/terminal/lib/ssh-session.ts)).
- **Backend HTTP requests can no longer be steered at cloud-metadata / link-local addresses (SSRF).** `http_ping`, `http_stream`, the `tedi-frame://` proxy, and the favicon resolver now resolve the target host and refuse IPv4 link-local (`169.254.0.0/16`, including the `169.254.169.254` AWS/GCP/Azure metadata endpoint) and IPv6 link-local (`fe80::/10`), plus the metadata hostnames. Loopback and private LAN stay allowed, so localhost dev servers and local AI gateways keep working ([`net.rs`](src-tauri/src/modules/net.rs), [`proxy.rs`](src-tauri/src/modules/preview/proxy.rs), [`embed.rs`](src-tauri/src/modules/preview/embed.rs)).
- **The AI's browser tools refuse `file://` and metadata URLs.** `open_browser`, `control_browser`, and `navigate_and_read` now reject non-`http(s)` schemes and link-local/metadata hosts, so a prompt-injected agent can't point the real webview at a local file (then read it back) or at the cloud-metadata service ([`terminal.ts`](src/modules/ai/tools/terminal.ts)).
- **The AI secret-path deny-list and out-of-scope read gate are tighter.** Protected-directory matching (`.ssh/`, `.aws/`, …) is now case-insensitive (it could be evaded on case-insensitive Windows/macOS filesystems), the basename list gained `.git-credentials`, shell/db `*_history`, `*.ovpn`, and `_netrc`, the out-of-scope read gate now fails closed when there is no workspace root or terminal cwd, and the read-only sub-agent refuses reads/searches outside the workspace — it has no approval surface, so it can no longer be used to auto-read arbitrary files ([`security.ts`](src/modules/ai/lib/security.ts), [`context.ts`](src/modules/ai/tools/context.ts), [`fs.ts`](src/modules/ai/tools/fs.ts), [`search.ts`](src/modules/ai/tools/search.ts), [`runSubagent.ts`](src/modules/ai/agents/runSubagent.ts)).
- **Remote SFTP reads are size-capped and the extension GitHub fetch no longer advertises the app name.** `ssh_sftp_read_file` refuses files over 16 MiB so a huge remote file cannot OOM the app, and the GitHub release/extension fetch `User-Agent` is now a generic token instead of `TEDI-Extensions/1.0`, trimming the app's network fingerprint ([`sftp.rs`](src-tauri/src/modules/ssh/sftp.rs), [`github.rs`](src-tauri/src/modules/extensions/github.rs)).

### Added

- **Browser tabs are now numbered like terminals.** Each in-app browser leaf gets a stable FIFO "Browser N" badge in the tab strip — its own sequence, independent of terminals — assigned at creation and preserved across split, drag, and restart, shown next to the favicon ([`useTabs.ts`](src/modules/tabs/lib/useTabs.ts), [`useAuxTabs.ts`](src/modules/tabs/lib/useAuxTabs.ts), [`EntryIcon.tsx`](src/modules/tabs/components/EntryIcon.tsx), [`panes.ts`](src/modules/terminal/lib/panes.ts)).

### Changed

- **The "preview" feature is now consistently called "browser" across the frontend.** The embedded-browser module, types, leaf kind, AI tool (`open_preview` → `open_browser`), and CSS accent token were renamed from `preview` to `browser` to match what it is — a live-preview browser. Saved workspaces with the old `leafKind: "preview"` and legacy standalone preview tabs still restore unchanged; the Rust IPC command names are intentionally left as `preview_*` ([`browser/`](src/modules/browser/), [`panes.ts`](src/modules/terminal/lib/panes.ts), [`config.ts`](src/modules/ai/config.ts)).
- **The terminal session hook was split into focused modules.** `useTerminalSession.ts` (941 → ~300 lines) now wraps an extracted imperative `session-lifecycle.ts` (construct / attach / detach / dispose) and a `webgl.ts` helper that de-duplicates four copies of the WebGL load/dispose dance — behavior preserved, structure clearer ([`useTerminalSession.ts`](src/modules/terminal/lib/useTerminalSession.ts), [`session-lifecycle.ts`](src/modules/terminal/lib/session-lifecycle.ts), [`webgl.ts`](src/modules/terminal/lib/webgl.ts)).
- **Dead code and redundant dependencies were removed.** An unused `useIsMobile` hook, three extension contribution categories that never had a consumer (`slashCommands` / `themes` / `editorThemes`), and two transitively-satisfied direct Cargo dependencies (`grep-matcher`, `async-trait`) are gone ([`registries.ts`](src/modules/extensions/registries.ts), [`manifest.ts`](src/modules/extensions/manifest.ts), [`Cargo.toml`](src-tauri/Cargo.toml)).

### Fixed

- **The Workspaces panel now shows a terminal's running title for inactive workspaces, not only the active one.** The program-set title (a running agent's task, a TUI's filename) is captured into the saved workspace snapshot when you switch away, so an inactive workspace's terminal row reads `folder · <task>` instead of just the folder name. Private terminals never persist their title ([`serialize.ts`](src/modules/workspaces/serialize.ts), [`store.ts`](src/modules/workspaces/store.ts), [`WorkspacesPanel.tsx`](src/modules/workspaces/WorkspacesPanel.tsx)).

## [0.3.32] - 11-06-2026

### Added

- **The terminal's "Additional PATH" now detects tools that live in Laragon-style versioned subfolders, and puts the right folder on PATH.** Laragon nests a toolchain one level down (`bin\php\php-8.3.1-Win32-vs16-x64\php.exe`, `bin\nodejs\node-v20...\node.exe`), so adding the natural parent (`bin\php`) used to report "no known tools detected" and wouldn't make the tool runnable. The probe now descends one level to find the executable, the detected badge shows which versioned child was picked (e.g. `php 8.3.1 · php-8.3.1-Win32-vs16-x64`), and PATH assembly adds that child folder — listed before the parent and de-duplicated — so the tool actually resolves in a freshly opened terminal ([`path_probe.rs`](src-tauri/src/modules/pty/path_probe.rs), [`shell_init.rs`](src-tauri/src/modules/pty/shell_init.rs), [`AdditionalPathEditor.tsx`](src/settings/sections/components/AdditionalPathEditor.tsx)).

### Fixed

- **"Additional PATH" no longer shows a PHP/Imagick startup warning where a tool's version should be.** Probing `php` / `composer` runs the tool to read its `--version`, but a mismatched Imagick extension prints `Warning: Version warning: Imagick was compiled against ImageMagick version 1808 but version 1810 is loaded …` ahead of the real output, and the probe took that first line as the version. It now reads both stdout and stderr, skips startup diagnostics (`Warning` / `Notice` / `Deprecated`), and prefers the line carrying a dotted version — so the badge reads `php 8.3.1` instead of the warning, falling back to "detected" rather than stray noise ([`path_probe.rs`](src-tauri/src/modules/pty/path_probe.rs)).
- **The Extensions marketplace no longer stays stuck on a transient load error.** The catalog fetch now routes through `corsFallbackFetch` (native WebView fetch first, then the Rust HTTP stack when the WebView blocks it — CORS, or a stale negative-DNS entry from before the host was live), retries once on a momentary network throw, and re-fetches on tab re-open after an `error` (only a `ready` or in-flight `loading` result is reused) — so a failure while the catalog host was still coming up self-heals instead of parking the panel until a manual Refresh ([`ExtensionsSection.tsx`](src/settings/sections/ExtensionsSection.tsx)).

## [0.3.31] - 11-06-2026

### Added

- **The in-app browser preview can now open local files, and HTML files get a "Preview in Browser" right-click action.** The preview accepts `file://` URLs, and a bare local path typed into the address bar — Windows drive (`D:\dir\f.html`), UNC (`\\server\share\f.html`), or POSIX absolute (`/dir/f.html`) — is converted to one automatically (each path segment percent-encoded, so spaces survive), so a local HTML report opens as a real browser tab; the address bar shows a "Local file" indicator for `file://`. In the File Explorer, right-clicking an `.html` / `.htm` / `.xhtml` file adds **Preview in Browser**, which opens it in a new preview tab via its `file://` URL. The AI `open_preview` tool accepts `file://` too ([`embed.rs`](src-tauri/src/modules/preview/embed.rs), [`PreviewAddressBar.tsx`](src/modules/preview/PreviewAddressBar.tsx), [`path.ts`](src/lib/path.ts), [`FileTreeNode.tsx`](src/modules/explorer/FileTreeNode.tsx)).

### Changed

- **Terminal titles no longer show a stray leading status glyph.** A running agent (Claude Code, Codex, …) prefixes its OSC 0/2 window title with a cycling spark/spinner glyph (e.g. `✳ Investigate double dots`), which looked like a stray dot next to the folder name in the Workspaces panel and pane header. That leading glyph — plus any surrounding whitespace or variation selectors — is now stripped before the title is stored. It reuses the AI-CLI detector's curated spinner alphabet, which already excludes the middle-dot `·` used as a path separator, so real titles stay intact ([`terminalTitles.ts`](src/modules/terminal/lib/terminalTitles.ts), [`aiCliDetector.ts`](src/modules/terminal/lib/aiCliDetector.ts)).

## [0.3.29] - 10-06-2026

### Changed

- **The Workspaces panel's terminal list is tidier, and the pane header now matches it.** The per-terminal `WORKING` / `IDLE` status word (and its pulsing animation) is gone; each row shows just the folder name plus the running program's title (e.g. `SIASKA-NEW · Comprehensive ...`), and that same label now appears in the pane header so the two surfaces read identically for the same terminal. The full status is still available on hover, and the terminal icon keeps a static color cue (green idle, yellow working, red waiting-for-approval) ([`WorkspacesPanel.tsx`](src/modules/workspaces/WorkspacesPanel.tsx), [`PaneTreeView.tsx`](src/modules/panes/PaneTreeView.tsx)).
- **The active AI CLI icon now breathes smoothly instead of hard-pulsing.** A custom `ai-breathe` keyframe (a gentle opacity ease-in-out) replaces Tailwind's `animate-pulse` for the working / waiting states across the tab strip, pane header, and Workspaces list, so a running prompt stays clearly indicated without the abrupt blink; idle stays solid, and `prefers-reduced-motion` disables it ([`aiCliStatus.ts`](src/modules/terminal/lib/aiCliStatus.ts), [`globals.css`](src/styles/globals.css)).

## [0.3.28] - 10-06-2026

### Security

- **The AI agent now asks before reading files outside your project.** `read_file`, `list_directory`, `grep`, and `glob` resolve their target and, when it falls outside both the workspace root and the active terminal cwd, raise a one-click approval card before running; reads inside the project stay automatic. This closes a path where a prompt-injected agent could silently read an arbitrary file off disk and exfiltrate it. Path matching collapses `..` and is case-insensitive (so `workspace/../secret` can't masquerade as in-project), and the read-only sub-agent keeps reads automatic since it has no approval surface ([`context.ts`](src/modules/ai/tools/context.ts), [`fs.ts`](src/modules/ai/tools/fs.ts), [`search.ts`](src/modules/ai/tools/search.ts), [`runSubagent.ts`](src/modules/ai/agents/runSubagent.ts), [`AiToolApproval.tsx`](src/modules/ai/components/AiToolApproval.tsx)).
- **The destructive-command and protected-write guards cover the cases they were missing.** `checkShellCommand` now also refuses `rm -rf` aimed at `/*`, `~`, or `$HOME` (including split `-r -f` flags), `find / -delete`, and writes/wipes to a raw block device (`> /dev/sd*`, `wipefs`, `shred`); the system-directory write block became case-insensitive and gained Windows roots (`C:\Windows`, `Program Files`, `ProgramData`) that the POSIX-only list had left unguarded on Windows; and `write_file` / `create_directory` resolve symlinks before the check so an innocently-named link can't redirect a write into a protected target ([`security.ts`](src/modules/ai/lib/security.ts), [`fs.ts`](src/modules/ai/tools/fs.ts)).
- **The terminal-typing tools can no longer be coaxed into running a command without consent.** `suggest_command` re-checks for an embedded newline _after_ a shell transformer runs (a transformer could otherwise inject one into the raw PTY write and auto-run it), `schedule_command` rejects a newline for its type-only `inject` action, and the shell approval card now shows the post-transform "Runs as" command so a rewrite (e.g. an RTK-style bridge) is visible before you approve ([`terminal.ts`](src/modules/ai/tools/terminal.ts), [`schedule.ts`](src/modules/ai/tools/schedule.ts), [`AiToolApproval.tsx`](src/modules/ai/components/AiToolApproval.tsx)).

### Fixed

- **The in-app browser no longer flails on a simple lookup.** `open_preview` returned the new pane's tab id mislabelled as its leaf id, so the model's follow-up `read_browser` / `navigate_and_read` couldn't resolve the pane and would re-open tabs or fall back to `curl`; it now resolves the real leaf id from the open-browsers list. It also gained a `read: true` option that opens a page and returns its loaded text in the same call, so a fact / price / rate lookup is one tool step instead of an open-then-read round-trip ([`terminal.ts`](src/modules/ai/tools/terminal.ts), [`context.ts`](src/modules/ai/tools/context.ts), [`chatStore.ts`](src/modules/ai/store/chatStore.ts)).
- **`run_in_terminal_by_id` no longer corrupts a busy terminal.** It now checks whether the target terminal is mid-command or running a full-screen TUI and refuses instead of typing into the running program's stdin ([`schedule.ts`](src/modules/ai/tools/schedule.ts)).

### Changed

- **Tool results that re-enter the model's context every step are now trimmed.** `bash_run`, `bash_logs`, and `run_subagent` cap their output to a head-plus-tail window (the native layer already hard-capped; this is the smaller model-facing trim), and the verbose `read_browser` description was tightened, cutting steady token overhead on long shell output, chatty dev-server logs, and every request's tool schema ([`shell.ts`](src/modules/ai/tools/shell.ts), [`subagent.ts`](src/modules/ai/tools/subagent.ts), [`context.ts`](src/modules/ai/tools/context.ts), [`terminal.ts`](src/modules/ai/tools/terminal.ts)).

## [0.3.27] - 10-06-2026

### Added

- **The terminal can prepend extra folders to its `PATH` via a new Settings -> General -> Terminal -> "Additional PATH" list.** Add directories that aren't on your OS `PATH` (e.g. a Laragon `composer`, a portable toolchain) and they resolve in TEDI's terminal without touching system environment variables. Each entry has its own enable/disable toggle and a remove button, added explicitly through an input + **Add** button so a change always persists immediately. The Rust PTY layer reads the enabled entries straight from the settings store at spawn and prepends them, so edits apply to newly opened terminals without a daemon restart; existing terminals keep their original `PATH` ([`AdditionalPathEditor.tsx`](src/settings/sections/components/AdditionalPathEditor.tsx), [`store.ts`](src/modules/settings/store.ts), [`GeneralSection.tsx`](src/settings/sections/GeneralSection.tsx), [`shell_init.rs`](src-tauri/src/modules/pty/shell_init.rs)).
- **The Workspaces panel now lists each workspace's open terminals.** Expand a workspace row to reveal its terminals: the active workspace shows them live with AI CLI status (Claude / Codex / Copilot / … shown as idle, working, or waiting-for-approval, color-coded) and labelled with the same ordinal badge as the tab strip plus the running program's title (so an agent like Claude Code shows its name next to the folder), and clicking one jumps straight to that terminal (activates the tab and focuses the pane). Inactive workspaces list their persisted terminals, and clicking switches to that workspace ([`WorkspacesPanel.tsx`](src/modules/workspaces/WorkspacesPanel.tsx), [`AppSidebar.tsx`](src/app/components/AppSidebar.tsx), [`App.tsx`](src/app/App.tsx)).

### Changed

- **The left sidebar's sections (Files, Source Control, Workspaces, and Remote files while an SSH session is open) can be reordered, resized, and collapsed.** Drag the grip in a section header to reorder the sections; drag the divider between two sections to move the boundary, using the same `react-resizable-panels` model and drag-handle indicator as the editor/terminal split panes; click the chevron to collapse a section down to just its header. While expanded, each section keeps a minimum height so its content stays visible, and the section order persists across launches ([`AppSidebar.tsx`](src/app/components/AppSidebar.tsx), [`resizable.tsx`](src/components/ui/resizable.tsx), [`ExplorerHeader.tsx`](src/modules/explorer/components/ExplorerHeader.tsx), [`PanelHeader.tsx`](src/modules/scm/components/PanelHeader.tsx)).
- **All resize handles now share one indicator.** The split-pane, sidebar-section, and side-panel dividers use a single styled `ResizableHandle` (a centered grip that highlights on hover and honors the customizable `--tedi-resize-handle` theme color), so every draggable boundary looks and behaves the same ([`resizable.tsx`](src/components/ui/resizable.tsx)).

### Fixed

- **Clicking a breadcrumb segment no longer garbles a busy terminal.** Writing `cd "…"` into the active terminal now only happens when the shell is idle at a prompt (an `isAtPrompt()` guard mirroring the `run_in_terminal` check); while a command is running, output is streaming, or a TUI owns the alt-screen, the shell write is skipped so the keystrokes don't land in that program's stdin. The explorer and AI workspace context still follow the click, and the next breadcrumb click once the command finishes cds for real ([`useTabActions.ts`](src/app/hooks/useTabActions.ts)).

## [0.3.26] - 08-06-2026

### Added

- **The editor and AI chat code blocks recognize more niche language syntaxes out of the box.** Added stream-language coverage for Odin, Zig, Nim, Solidity, Gleam, Hare, plus legacy-mode wiring for Haxe, LaTeX/TeX, WebAssembly text (`wat`/`wast`), NSIS, Smalltalk, Cypher, Turtle, SPARQL, and XQuery, so these files and fenced code blocks no longer fall back to plain text. The shared modern-language parsers are built on CodeMirror's bundled `clike` factory, so this expands coverage without adding dependencies ([`streamLanguages.ts`](src/modules/editor/lib/streamLanguages.ts), [`languageResolver.ts`](src/modules/editor/lib/languageResolver.ts), [`chat-code-lezer.ts`](src/components/ai-elements/chat-code-lezer.ts)).

### Fixed

- **Legacy stream tokenization in AI chat code blocks now classifies every token on a line correctly, not just the first one.** The highlighter now resets `StringStream.start` before each token, matching CodeMirror's real tokenizer driver so `stream.current()`-based parsers keep seeing the current token instead of the whole line-so-far ([`chat-code-lezer.ts`](src/components/ai-elements/chat-code-lezer.ts)).

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
