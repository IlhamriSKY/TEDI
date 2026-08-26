# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.4.32] - 26-08-2026

### Added

- **Any AI CLI can now drive TEDI, and one button wires it up.** A plug icon sits beside the extensions puzzle in the header; it registers TEDI's MCP server with the agents you actually have on this machine (Claude Code, Codex, Gemini CLI, opencode, GitHub Copilot CLI, Cursor, plus a project `.mcp.json`), and only with those, since every target is gated on a config path that must already exist. Nothing is created for a CLI nobody installed. The entry shapes were checked against the real config files rather than inferred, which is how the Codex writer learned that a server owns its nested `[mcp_servers.<id>.tools.*]` sub-tables: removing only the header would have orphaned them onto whichever server happened to precede it. Merges are surgical either way, and a dry run against a 140,000-byte `.claude.json` left all 87 top-level keys and the sibling MCP server byte-identical. The button also owns the half that used to be impossible from inside the app: WebView2 fixes its browser arguments before the first webview exists, so the automation port could only ever be set by relaunching from a shell that exported it. It is now a stored setting Rust reads at startup, the environment variable still wins when set, and the indicator tells the truth about which state you are in: a dot only when installed, one colour while the channel is actually live and another while it is written but waiting for a restart. See [install.ts](src/modules/mcpInstall/install.ts), [McpInstallButton.tsx](src/modules/mcpInstall/McpInstallButton.tsx), [automation.rs](src-tauri/src/modules/automation.rs).
- **A driving agent can now reach the settings and the extensions, not just the panes.** `inspect` lists commands, extensions, every preference the app is running on, and the window's console output and uncaught errors, which is the one thing about TEDI nothing could see before. `set_setting` changes a preference live and `extension` enables, disables, reloads, updates or uninstalls one. Settings go through the store rather than the Settings page, which is a separate webview no tool driving the main window can read or click, so "change the theme" was undrivable through the entire surface; the write broadcasts, so an open Settings window follows it without a reload. Installing an extension is deliberately absent and refuses with the route instead: it runs third-party code under a permission set you have to see, and that review belongs to you. No API key can come back this way, because keys live in the OS keyring and never in the settings store. See [director.mjs](scripts/director/director.mjs), [mcp.mjs](scripts/director/mcp.mjs), [preferences.ts](src/modules/settings/preferences.ts).
- **TEDI's own agent got the same reach, without going through MCP to get it.** `tedi_settings` and `tedi_extensions` read and change exactly what an outside CLI can, and they call the same four functions the MCP surface calls rather than a second copy of the logic. Routing the built-in agent through its own MCP server would have meant spawning node and connecting back over a DevTools socket to the page it is already running in, it would have stopped working whenever the automation port is off, which is the default, and a page target accepts exactly one DevTools client, so it would have been competing for the socket with your real CLI session. The transports stay separate and the definition is shared; a check fails the build if either side re-implements the other. See [tedi.ts](src/modules/ai/tools/tedi.ts), [director-verify.ts](scripts/director-verify.ts).
- **Review a pull request inside TEDI, and stage a change hunk by hunk.** A PR opens into a review view that splits `gh pr diff` into per-file blocks instead of rendering one thirty-thousand-line wall, and the working-tree rows gained a hunk list so a commit can take part of a file. The patch splitter is deliberately not a diff parser: hunk headers, context and both change signs are kept exactly as git printed them, which keeps it pure text in and plain data out, so real patch shapes (rename, binary, new file, deletion) are asserted without a repository. See [patch.ts](src/modules/scm/patch.ts), [PrReviewView.tsx](src/modules/scm/PrReviewView.tsx), [HunkList.tsx](src/modules/scm/components/HunkList.tsx).

### Changed

- **The MCP tool list got smaller while gaining all of the above.** That list is loaded into every request of every connected AI CLI, for the whole session, whether it drives TEDI or not, so it is a tax on every turn and not a one-off cost. The listing verbs merged into one `inspect` and the three read verbs into one `read`, which means the next thing worth listing costs an enum value instead of another full tool description forever; descriptions kept the traps that produce a silently wrong answer and moved the ones that raise a loud error into the errors, where they cost nothing until they fire; and `state` no longer returns its sixty-entry list of clickable labels unless asked, which is the saving that actually shows up in a session. Eighteen tools and 9135 characters became seventeen and 8642. Underneath, `state` went from four DevTools round trips to one, and every terminal read now reduces inside the page: a tail, a substring test, or a buffer hash, so a poll loop ships back an answer instead of twenty kilobytes of scrollback per pane. See [mcp.mjs](scripts/director/mcp.mjs), [director.mjs](scripts/director/director.mjs).
- **The ChatGPT-account model list leads with the models every plan can use.** The accepted set is plan-gated and the endpoint's only signal is a 400 naming the model, so a list that opened on a Codex id simply failed for anyone below Plus. The plan-agnostic pair sits at the head, which is what a fresh sign-in lands on, and the labels say which tier the rest need. See [config.ts](src/modules/ai/config.ts).

### Fixed

- **The AI tools picker no longer opens in a different direction depending on where the panel is docked.** The AI panel is one section in a stack you can move, so its header can sit anywhere from the top of the window to the bottom, and the popover flipped above the button whenever the section happened to be docked low: the same click, a different place, decided by a layout choice made days earlier. It now always opens downward, and the two jobs the flip was quietly doing are handled properly instead: the height follows the space actually below the trigger, so a short window scrolls the list rather than clipping the All on / All off row, and the width follows the space available, so it cannot slide off screen. See [ToolsPicker.tsx](src/modules/ai/components/ToolsPicker.tsx).
- **A provider error mid-stream no longer arrives as a blank card.** The AI SDK fills the message from the body only when the body matches OpenAI's shape and otherwise falls back to the status text, which the Rust proxy leaves empty, so the ChatGPT-account endpoint answering with its own `detail` field produced nothing at all to read. See [errors.ts](src/modules/ai/lib/errors.ts).

### Security

- **The automation channel is disclosed, opt-in, and visible while it is on.** Turning it on opens a WebView2 DevTools port on loopback, and DevTools has no authentication of any kind, so while it is on anything already running as you can drive the window and read what is in it, not only the CLI you meant to connect. That is the same boundary as your own shell, which is why it stays off until you ask, why it needs a restart to take effect, and why the header keeps showing a dot for as long as it is live. Three lines hold inside it: panes you marked private are absent from the whole surface rather than merely unreadable, API keys never pass through it, and installing an extension is refused. The port setting is deliberately not a preference, so the tool that changes settings cannot reach it and an agent cannot make its own access permanent. See [SECURITY.md](SECURITY.md), [automation.rs](src-tauri/src/modules/automation.rs).

## [0.4.31] - 26-08-2026

### Added

- **You can sign in with a ChatGPT account instead of pasting an API key.** Settings, Models now leads with a sign-in card: it opens your browser to OpenAI, and once you come back the turns run against your ChatGPT Plus or Pro subscription rather than billing API credits. The exchange is OAuth 2.0 authorization-code with PKCE, and it lives in Rust because nothing else can do it. The redirect has to land on a real listener at `127.0.0.1:1455`, which a webview cannot bind; the token endpoint sends no CORS headers, so a webview request to it is blocked outright; and a refresh token is a long-lived credential that has no business in page-reachable storage. The listener binds before the browser opens rather than after, because a port already taken by another client mid-login is something you need to hear now and not after you have authenticated into a callback nobody is listening to. The tokens go into the OS keychain beside the API keys, the access token is refreshed five minutes ahead of expiry so a long turn cannot expire mid-stream, and concurrent turns share one refresh instead of each burning their own. Two details are load-bearing and neither is obvious: the Responses API stores a conversation server-side by default and this endpoint refuses a request that asks it to, so `store: false` is what makes it answer at all; and the built model is deliberately never cached, because the cache key is fixed before the provider is chosen while the access token rotates on every refresh, so a cached model would keep serving an expired token until the app was restarted. This targets the endpoint OpenAI's own client uses rather than a documented public API, so it can change without notice, and every failure path reports what actually went wrong instead of collapsing to "login failed". See [chatgpt_auth.rs](src-tauri/src/modules/chatgpt_auth.rs), [chatgptAuth.ts](src/modules/ai/lib/chatgptAuth.ts), [ChatGptAccountCard.tsx](src/settings/components/ChatGptAccountCard.tsx), [agent.ts](src/modules/ai/lib/agent.ts).

### Security

- **Reaching a new host now asks first.** Every guard in the AI module was about what gets in: a read outside the workspace raises an approval card, secret files are refused by name and by symlink target, a sub-agent may not read or write past the project. Nothing guarded the way out. `Fetch` on a GET, `Open Browser` and `Navigate And Read` all executed with no card at all, against any host, with a URL and headers the model chose. That is the whole prompt-injection exfiltration path in one step: anything the agent reads, a file in the repository, a page it fetched, the description an MCP server hands it, could tell it to append what it knows to a URL, and it would, silently. First contact with a host now raises an approval card that leads with the host rather than burying it in a JSON dump, and approving once keeps that host quiet for the rest of the session. The host is recorded from inside the tool's own execute step, which the SDK only runs once approval has resolved, so remembering what you allowed needs no separate bookkeeping and nothing survives a restart. Loopback and `.test` dev servers are trusted from the start, because a dev server is the common case and cannot leave the machine. See [security.ts](src/modules/ai/lib/security.ts), [fetch.ts](src/modules/ai/tools/fetch.ts), [terminal.ts](src/modules/ai/tools/terminal.ts), [AiToolApproval.tsx](src/modules/ai/components/AiToolApproval.tsx).
- **`Fetch` no longer takes the webview's route to the network.** Its cloud-metadata block could only compare the hostname as a string, so a perfectly ordinary-looking name that resolves into the link-local range walked straight past it on the native path. Every request now goes through the Rust proxy, which resolves DNS, checks each resolved address, and checks again on every redirect hop. It also removes the CORS failure the native-first fallback existed to work around. See [fetch.ts](src/modules/ai/tools/fetch.ts), [net.rs](src-tauri/src/modules/net.rs).

### Fixed

- **The system prompt no longer describes tools the model was not given.** Switching tools off in the picker filtered the tools and nothing else, so a session with one extension tool ticked still sent a prompt instructing the model to use `edit`, `read_file`, `bash_run` and `run_subagents`, told it to write files into `.tedi/memory`, and announced that a 29-tool MCP server was "available in your tool list" while all 29 were unticked. Instructions for absent tools are billed on every single message and are a guaranteed failed call, which is exactly what a small model does with them. The prompt is now composed from the tool set the turn actually sends: it is a list of sections each tagged with the tools it talks about, and a section whose tools are all off is not emitted, taking its heading with it so no empty `# Browser` is left behind. The MCP block is counted from the surviving tools rather than from the live server list, so a server whose tools are unticked, or one that failed to connect, is no longer advertised. The memory block keeps the saved content and drops the "write a file there" half when there is no tool that could. A prompt you have overridden yourself still goes out verbatim; you wrote it, and TEDI does not get to prune it. Measured on the reported session: 3346 characters down to 1818, and no tool named that the model does not hold. See [config.ts](src/modules/ai/config.ts), [agent.ts](src/modules/ai/lib/agent.ts), [catalog.ts](src/modules/ai/tools/catalog.ts).
- **A nearly full context window no longer fails the whole turn.** When a conversation outgrows the window the oldest messages are dropped, and that cut only skipped a leading tool result. A turn is a user message followed by a run of assistant and tool messages, so only one index in four is a safe place to land, and a cut that stopped on an assistant message produced a history beginning with one. Anthropic rejects that outright, so the request that was supposed to rescue an over-long conversation was the one that failed it, and it fired precisely when the window was fullest. Replaying the old cut over a realistic forty-turn history put an assistant at the head at two of four window sizes. The first attempt at a fix, cutting only at a user boundary, was wrong in the other direction and an existing test caught it: with no later user message, which is the runaway-assistant case that forces this stage in the first place, it refused to drop anything at all. The cut now happens as before and the head is anchored instead, with a short line saying the earlier conversation was dropped to fit. See [compact.ts](src/modules/ai/lib/compact.ts).
- **One failed shell start no longer breaks the shell for the rest of the session.** Each chat keeps a persistent shell so the working directory survives between commands, and it is held as the promise that opened it. A promise that rejected was cached exactly like one that succeeded, so a single transient spawn failure was re-awaited by every later `bash_run` in that session and the shell could never come back. See [shell.ts](src/modules/ai/tools/shell.ts).
- **A large JSON response no longer fills the context window.** `max_chars` bounded a text response and was skipped entirely on the JSON path, so a two megabyte JSON body came back parsed and whole. Over the limit it now falls back to the clamped text, which is worth more than structured data that does not fit. The read also stops pulling from the network once the size cap is hit instead of leaving the connection draining into a body nobody reads. See [fetch.ts](src/modules/ai/tools/fetch.ts).
- **The tool picker shows what each tool does again.** A row put the name and the description in one piece of text under a single truncation rule, so a long name, which is every MCP tool, consumed the row and the description never rendered at all. They are now two independently truncating pieces with the name capped, so both always appear. An MCP row also drops the `mcp__<server>__` prefix, since the group header directly above it is the server name and repeating it was what made the names long enough to do the damage. Group headers stay put while the list scrolls, the filter matches a group name so typing "browser" finds a whole family, and the panel now sizes itself to the window rather than to a fixed width. The bulk buttons follow what you are looking at: with a filter narrowing the list to three, "All off" used to switch off all eighty-eight, which is the kind of surprise you discover a turn later when the model has no tools. See [ToolsPicker.tsx](src/modules/ai/components/ToolsPicker.tsx), [catalog.ts](src/modules/ai/tools/catalog.ts).
- **A `claude` started in a TEDI terminal keeps its colours and its transcript.** Launching TEDI from inside a Claude Code session leaves that session's environment markers on the TEDI process, and the PTY daemon passes its environment to every terminal it opens from then on. A `claude` started in one of them reads those markers, decides it is a nested sub-session, and stops saving transcripts, while the colour suppression Claude uses for tool output leaves the whole shell monochrome. Those markers are now stripped on the way into a PTY, gated on the marker itself so an ordinary launch still passes your own `NO_COLOR` through untouched. See [shell_init.rs](src-tauri/src/modules/pty/shell_init.rs).

### Changed

- **Stale environment blocks are no longer replayed to providers that cannot cache them.** Each past message carries the `<env>` block it was sent with, which keeps the byte-exact prefix a prompt cache needs. A provider without one, which is every gateway plus Groq, Cerebras and LM Studio, re-reads the whole payload each turn regardless, so those replayed blocks were roughly ninety tokens per past turn of pure spend on every request. They are now sent only where something reads them. See [envContext.ts](src/modules/ai/lib/envContext.ts), [transport.ts](src/modules/ai/lib/transport.ts).
- **A provider you sign into is not offered until you sign in.** The check behind the model picker asked whether a provider takes a pasted key, which is a different question and the wrong one for an account you log into: the answer is no, so every gate read it as ready and offered its models to someone who had never signed in. Picking one then failed at request time, which is the definition of a control that looks live and is not. The picker now asks whether the provider is actually connected. See [config.ts](src/modules/ai/config.ts), [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx).
- **The built-in Polaris agent no longer carries its own copy of the sub-agent roster.** It listed six agents by name, which duplicated the live list in the spawn tool's own description and went stale whenever that list changed, and it told the model to delegate on turns where the picker had switched the spawn tools off. It now points at the tool description for the roster and conditions the advice on whether the spawn tool is in the tool list, which is something the model can check for itself. See [agents.ts](src/modules/ai/lib/agents.ts).

## [0.4.30] - 26-08-2026

### Fixed

- **Coming back to the window after minimizing it or switching away no longer freezes the app.** Windows recorded these as "top level window is idle", meaning the process had stopped answering messages at all, and the app log filled with failed script evaluations in the seconds before each one. The cause was the git poll. The Source Control panel and the explorer's git decorations both refresh when the window returns, and both ask git for the state of the working tree with every untracked file listed. That is the right question for an ordinary repository and a ruinous one for a very large working tree: measured on a real case, a `git init` left in a home directory makes every file under it untracked, and the answer came back with 1,492,848 entries, roughly 130 MB of output and over thirty seconds of cold disk walk, on a poll that repeats every 2.5 seconds. Nothing downstream of it was bounded either, so each of those rows was serialized to JSON, crossed the IPC boundary, was parsed again in the webview, sorted, and rendered as its own DOM node. One refresh took the process from 188 MB to 8.2 GB in eight seconds, and two of them run on every return. The list is now capped, and the walk that produces it is given a budget: past three seconds it settles for the listing that folds untracked files into their directories, which is the only form whose cost is bounded by the repository rather than by the working tree, and that decision is remembered per repository for five minutes so the next poll does not pay the budget again to rediscover it. The panel says when it is showing a partial list rather than passing one off as the whole working tree. The ignored-file lookup behind the dimmed rows in the explorer had the same unbounded walk, 41.8 seconds on the same repository and running in the same pass, and now shares the budget. The poll also stopped taking git's index lock, which it never needed and which a poll must not hold. Same repository, same code path, measured after: 118 ms. An ordinary repository is unchanged, still listing its files individually. See [commands.rs](src-tauri/src/modules/git/commands.rs), [SourceControlPanel.tsx](src/modules/scm/SourceControlPanel.tsx), [types.ts](src/modules/scm/types.ts).
- **A terminal keeps its fast renderer across repeated locks of the machine.** Locking Windows resets the GPU context, and a pane recovers by reloading its WebGL renderer. That recovery is capped at three attempts, so a genuine context storm settles on the slower DOM renderer instead of looping forever. The cap counted every context loss a pane had ever seen rather than every loss in the current storm, and one lock costs one attempt, so the third lock of a window left open all day spent the last one and every terminal then sat on the DOM renderer until TEDI was restarted. That is the same "everything got sluggish after I unlocked" the cap exists to prevent, arrived at from the other direction. Losses more than a minute apart are now treated as separate events and start a fresh budget, which leaves the storm case behaving exactly as before. See [webgl.ts](src/modules/terminal/lib/webgl.ts), [sessionState.ts](src/modules/terminal/lib/sessionState.ts).
- **Closing a modal overlay inside a TUI no longer makes the screen jump.** When a program left the alternate screen, the pane's repaint watchdog resized the PTY down by one row and back again 50 ms later to force a `SIGWINCH`, on the theory that only a real size change would make the program redraw. Programs that re-anchor their cursor with a device status report on resize race that artificial double resize, and the viewport thrashes: the screen shakes up and down on the way out of a settings or model picker. The nudge is gone from that path. What remains there, clearing the renderer's stale glyph atlas and forcing a repaint, is the better-aimed remedy anyway, since replaying the real byte stream through a headless terminal had already shown it renders clean and the corruption is a render-timing problem rather than anything in the bytes. The nudge stays where it is genuinely load-bearing, recovering a pane that came back live but blank. Reported, diagnosed and fixed by [@khalidinsan](https://github.com/khalidinsan) in [#21](https://github.com/IlhamriSKY/TEDI/pull/21). See [pty-lifecycle.ts](src/modules/terminal/lib/pty-lifecycle.ts).

## [0.4.29] - 25-08-2026

### Added

- **A connecting SSH pane shows where the connect actually is.** It used to print three dim banner lines into the terminal, which say that a connect is happening but not which part of it is stuck. On a jump chain that distinction is the whole question: a stall at the bastion and a stall at the target produce identical scrollback, so the only way to tell them apart was to wait and guess. The pane now draws the route as a chain, one node per host in connect order, with a travelling pulse on the segment the handshake is working on and each node turning green as that hop authenticates. The pulse is transform-only so it composites off the main thread, which matters precisely here: the connect is blocking on the network and a paint-driven animation would stutter exactly while the user is watching it. The old route pill is gone rather than kept alongside, because two indicators for one connect is how they drift apart. See [SshConnectOverlay.tsx](src/modules/ssh/SshConnectOverlay.tsx), [TerminalPane.tsx](src/modules/terminal/TerminalPane.tsx).
- **The status bar says which OS is on the other end of an SSH session.** Knowing whether a host is Debian, Alpine or Arch decides whether the next command is `apt`, `apk` or `pacman`, and until now the only way to find out was to run something and read the error. It is read from `/etc/os-release` over the SFTP channel the session already holds, so there is no exec channel, no new Rust command and no extra round trip per pane: one read per session, cached by session id, and a reconnect mints a fresh id and re-probes. See [remoteOs.ts](src/modules/ssh/remoteOs.ts), [OsPill.tsx](src/modules/statusbar/OsPill.tsx), [BrandIcon.tsx](src/components/BrandIcon.tsx).

### Fixed

- **Returning to the window no longer runs every refresh twice.** Coming back to a locked or backgrounded machine fires `visibilitychange` and then `focus` a few milliseconds apart, and both mean the same thing, so every panel that refreshes on return had registered for both and ran its whole refresh on each. Unlocking therefore kicked off two directory listings, two git-status passes and two remote listings at once, against a disk cache that had just gone cold, which is the worst possible moment to double the work. The two events are now coalesced in one place that five callers read through, rather than each deciding for itself which of the two to trust. One case deliberately opts out: a refresh answering a mutation the app itself just made must never be dropped for landing near a focus change. See [windowResume.ts](src/lib/windowResume.ts), [gitDecorations.tsx](src/modules/explorer/lib/gitDecorations.tsx).
- **Git decorations could paint the wrong repository's status.** The fetch is asynchronous and the workspace root can change while one is in flight, so a slow answer for the previous root arrived after the switch and decorated the new tree with the old repo's modified files. The result is now checked against the root it was started for and dropped if that has moved on, and switching roots clears the decorations until the first fetch for the new one lands, so the tree shows nothing rather than something false. A missing git or a directory that is not a repository leaves them empty and keeps polling instead of giving up for the session. See [gitDecorations.tsx](src/modules/explorer/lib/gitDecorations.tsx).

### Changed

- **Editor themes load on demand.** All nine `@uiw/codemirror-theme-*` packages were imported eagerly at 10-25 KB each, so every launch paid about 100 KB to have eight themes nobody had selected sitting in memory. Each is now fetched when it is actually chosen. See [themes.ts](src/modules/editor/lib/themes.ts), [EditorPane.tsx](src/modules/editor/EditorPane.tsx).
- **A deduplication pass across the app, 619 lines lighter.** Nothing here changes behaviour; each is one implementation replacing several that had drifted. The skills installer and the skills updater wrote a resolved skill to disk with identical code apart from a label, so the write step is now one function both call. The editor find bar and the markdown find bar counted matches with their own caps, so the two search surfaces disagreed about when to say "999+"; they now share one. Grep, glob and replace each built their own `.gitignore`-aware directory walk, so which ignore sources were honoured depended on which entry point you came through; there is now one walk configuration behind all three. Opening the SFTP subsystem moved out of the session type, which keeps the session decoupled from the wire-protocol details it does not otherwise care about. See [skills.ts](src/modules/ai/lib/skills.ts), [EditorFindReplace.tsx](src/modules/editor/EditorFindReplace.tsx), [grep.rs](src-tauri/src/modules/fs/grep.rs), [sftp.rs](src-tauri/src/modules/ssh/sftp.rs).

## [0.4.28] - 24-08-2026

### Fixed

- **Copy and paste in a terminal no longer need the terminal to hold the caret.** `Ctrl+Shift+C` and `Ctrl+Shift+V` were decided purely on which element had keyboard focus, and with nothing inside a terminal holding it the shortcut was switched off outright, without a sound. That state is far more common than it sounds: connecting from the SSH menu leaves focus on the SSH-connections button, clicking a tab leaves it on the tab button, and so does every pane-header icon, so the chord you reach for to get a login code from this machine into a remote shell simply did nothing. Checked against a live SSH session before touching anything, to be sure the gate was at fault and not the SSH write path: with the pane's own text area focused the clipboard went straight into the remote shell, and with focus on a button the same chord produced nothing at all. A focus that lands outside every terminal now falls back to the active pane, which is what Termius does and what the handler already resolved to. Two exclusions keep that safe. The bare `Ctrl+C` and `Ctrl+V` variants stay pinned to a genuinely focused terminal, because everywhere else in the app they are the operating system's copy and paste and the shell's interrupt. An editable target keeps its native paste, because Chromium maps `Ctrl+Shift+V` to paste-without-formatting and `Shift+Insert` pastes as well, and the AI composer needs both. See [App.tsx](src/app/App.tsx).
- **The dev-server globe stays on the pane that printed the address.** It was drawn on whichever pane held focus, so in a split it chased the pointer: start a server in one pane, click into another to do something else, and the offer to open it moved to the header of a pane with nothing running behind it. Focus is not what makes a server run, and the offer has no reason to move when you do. It now renders on the leaf that actually printed the address, worked out where that ownership is already known rather than by adding a second source of truth. Two addresses belong to no pane in view and still follow the active one: the address a project declares in its own config, and one printed by a terminal in another tab, where the offer should travel with you rather than disappear. There is still exactly one globe, because a leaf id is unique and it is resolved against the visible tab before it reaches the header. Unchanged, and still the price of keeping the globe out of the status bar: no pane header is drawn at all on a Source Control, diff or extension tab, so the offer is unreachable from those. See [useActiveLeafSurface.ts](src/app/hooks/useActiveLeafSurface.ts), [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx).

## [0.4.27] - 24-08-2026

### Fixed

- **Opening the right pane no longer blanks the workspace.** It threw `Layout not found for Panel right-slot`, and because the throw came out of an effect it reached the ErrorBoundary and took the whole pane stack with it. The right column renders no panel at all while it holds nothing, so the first section to arrive both mounts the panel and bumps the section count, and the effect that reacts to the count then reads a ref that is already set while the group has not registered a layout for that brand-new panel. The existing `panel &&` guard cannot catch that, because the ref is non-null by then. Clicking the right-panel toggle with nothing docked reproduced it every time: the null branch opens the AI panel, and that is what trips the race. All four accessors throw, not just the read. `getSize`, `expand`, `collapse` and `isCollapsed` resolve the panel through the same two lookups and the library offers no non-throwing way to ask, so reading safely and then acting blind crashes just the same, which is how the two column toggles, the extension visibility bridge and six calls in the section stack were still exposed after the obvious site was covered. That knowledge now lives in exactly one file with fourteen call sites reading through it, and `isCollapsed` keeps its own wrapper rather than being folded into the width check: a side column collapses to zero so its width answers the question, but a section inside a column collapses to its header height, and using width there would report every minimized section as still open. See [panelSize.ts](src/app/lib/panelSize.ts), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx), [SectionStack.tsx](src/app/components/SectionStack.tsx).

### Changed

- **A pinned tab keeps the sizing every other tab uses.** Pinning applied a compact padding rule of its own and pushed the tab towards a square, which fought the shared sizing rather than following it. It now runs the same padding expression as any tab and simply loses its label, so the chip ends up narrower because a glyph is narrower than a name, as a consequence of dropping the title rather than as a second competing decision about width. The pin sits where the title was, and the close button comes back with it: only the title was in the way, and a pinned tab that cannot be closed from the strip is a worse trade than one that can be closed by accident. The name moves to the hover, since dropping the title otherwise removes the only thing telling two pinned terminals apart. The pin sizes itself with a CSS class rather than a `size` attribute, because the tab trigger forces `size-4` onto any icon that omits one and it would otherwise render as large as the identity icon beside it. See [renderEntryBody.tsx](src/modules/tabs/components/renderEntryBody.tsx).
- **The detected dev server is offered from the pane header again, not the status bar.** Two doc comments still described a pane-header globe; the prop they documented had been deleted when the offer moved to the status bar, and the comments were left attached to unrelated fields. The globe now sits on the focused pane's header beside the float button and the status-bar pill is gone, so there is one copy instead of two with different gates, and it renders only on the focused pane so a split does not show the same globe three times. The trade is deliberate: the pane header is not rendered at all on a Source Control, diff or extension tab, which is exactly why the pill was moved to the status bar, so the offer is unreachable from those. The address is most useful next to the terminal that printed it. See [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx).
- **The right-panel toggle button next to Settings is gone.** `Ctrl+Alt+B` still minimizes and restores that column, and always did so through the same handler rather than through the button, so this removes a duplicate control and not the capability. See [Header.tsx](src/modules/header/Header.tsx).

## [0.4.26] - 24-08-2026

### Added

- **The SSH file tree can now move files, not just open them.** It could read and write a remote file but had no way to get one across the boundary, so putting a build on a host meant leaving the app. Uploads and downloads now stream in both directions, folders included, and dragging a row onto another remote folder is a move on the server rather than a round trip through this machine. A permissions dialog edits the mode, recursively when you ask it to. Four SFTP behaviours had to be worked around and each is now pinned by a check: `FileAttributes::default()` is not empty, it carries a zero size and a 0o777 mode, so a chmod built from it truncates the file and chowns it to root; `rmdir` clears an empty directory only, which is why deleting a populated remote folder had always failed silently; `SETSTAT` is `chmod`, which follows symlinks, so a recursive apply skips links the way `chmod -R` does; and `READDIR` reports `lstat`, so a symlink to a directory arrived as a plain link and the tree refused to expand it, which is every one of `/var/www/html`, `/lib` and `current`. See [sftp.rs](src-tauri/src/modules/ssh/sftp.rs), [useSshTransfers.ts](src/modules/ssh/useSshTransfers.ts), [SshPermissionsDialog.tsx](src/modules/ssh/SshPermissionsDialog.tsx).
- **Extensions have a typed API and a toolkit to build against it.** Until now an author coded against a surface with no types anywhere, and a misspelled member surfaced as a `TypeError` inside an async click handler, which is an unhandled rejection nobody sees unless DevTools happens to be open. Two of the bundled extensions had already given up on it in a telling way: both carried a JSDoc annotation pointing at a types file that was never written, so the annotation was dead and `ctx` stayed `any`. `extensions/tedi.d.ts` is that surface, standalone and import-free, so plain JavaScript gets completion and real diagnostics with nothing installed. `tedi ext create` scaffolds a working extension around it, `tedi ext types` refreshes it, and `tedi ext validate` is the pre-publish check for the mistakes that are otherwise invisible at runtime, like a keybinding aimed at a command id that does not exist. Both the types and the manifest schema are embedded in the binary, which is the whole design: authors have the `tedi` binary rather than this repo, so what they code against comes from the host they are testing on and cannot go stale against it. Three guards keep the published types honest against the real context, the Zod manifest schema and the Rust structs, because a drifted `.d.ts` is worse than none. See [tedi.d.ts](extensions/tedi.d.ts), [scaffold.rs](src-tauri/src/modules/cli_ext/scaffold.rs), [validate.rs](src-tauri/src/modules/cli_ext/validate.rs).
- **The commands extensions call most now resolve to a real shape.** `ctx.invoke` returned `unknown`, and while a TypeScript extension can write `ctx.invoke<T>`, plain JavaScript cannot, so every property read off a result was an error and the only escape was a cast asserting a shape nobody had checked against Rust. Naming those shapes once took seven of the nine bundled extensions from type errors to zero. The list is deliberately short and covers only what the fleet actually calls: a shape written from memory would be a type that lies, which is worse than `unknown`. `ctx.has` answers for the rest of that problem, the option fields and callback arguments a newer host added and an older one silently ignores, which `typeof` cannot see. See [host.ts](src/modules/extensions/host.ts).
- **Saving an extension reloads it, with no window reload.** Edit the bundle or the manifest and the running extension restarts itself, so adding a command, a panel or a permission takes effect on save. A changed file has to settle before it is imported, because a bundler writes its output in chunks and a poll that catches a half-written module fails activation for code the author wrote correctly. Activation timing is recorded per extension now as well, and an `activate` slower than half a second says so, since attributing a slow launch to an extension previously meant bisecting. See [autoReload.ts](src/modules/extensions/autoReload.ts).
- **Tabs and workspaces can be pinned from the right-click menu.** A pinned tab sorts to the front of the strip and shrinks to an icon chip the way a browser does, so the handful of things always open stop competing for width with whatever is being worked on; workspaces pin the same way and rise to the top of the panel. Pinning is a property of the tab rather than of a pane, which is what keeps a split group unambiguous: the strip draws one chip per pane, so a split tab looks like several tabs, but the unit that can be reordered is the tab, and a pane can only move inside its own split. Right-clicking any pane of a split therefore offers "Pin Group", and the marker draws once for the group. A pinned tab hides its close button and is skipped by "close tabs to the right", because pinning is a promise that the tab stays put. See [pinned.ts](src/lib/pinned.ts), [renderEntryBody.tsx](src/modules/tabs/components/renderEntryBody.tsx).

### Fixed

- **An extension reload ran twice in the window that started it.** `emit` self-delivers in Tauri 2, so the announcement that tells the other webview to resync came back to the sender, which then repeated the whole deactivate-and-activate cycle on top of the one it had just performed. At once per install that was invisible; it stops being invisible now that saving a file can trigger it. See [store.ts](src/modules/extensions/store.ts).
- **Three statements in the extension author guide were wrong, two of them inverted.** It claimed the manifest schema is strict and that an unknown top-level key fails the parse, when the opposite is true and deliberate: a key the frontend rejects and Rust accepts produces an install that reports success and then vanishes from Settings with no way to uninstall it, which has shipped once already. It also described `ctx.invoke("shell_bg_spawn_direct")` as returning an object to destructure a pid out of, when it returns a bare handle, and counted the hard-denied commands as four when there have been nine for some time. See [extensions/README.md](extensions/README.md).

## [0.4.25] - 22-08-2026

### Added

- **Any panel can now live in either side column, and either column can be closed.** The two columns were only half symmetric, and the gaps were the kind you feel rather than read about: Source Control and Remote had a "move to the other side" button that worked and a drag that quietly did nothing, the AI panel could not leave the right column at all, and the right column had no way to be closed while the sidebar had both a toolbar button and Ctrl+B. One routing table now serves both the buttons and the drag, so a panel that can move one way can move the other, and the AI panel joins Files, Workspaces, Source Control, Remote and an extension's sections in docking to whichever side you want it. The right column closes from a toolbar button beside the window controls or with Ctrl+Alt+B, matching VS Code's secondary side bar. Its width floor had to match the sidebar's exactly, not merely be small: a collapsible panel snaps shut at the midpoint between its collapsed size and its minimum, so the larger floor it used to carry made the right handle need a longer drag before it closed and spring back short of that, which is precisely what "this side refuses to close" felt like. See [sectionDock.ts](src/app/lib/sectionDock.ts), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx), [AppSidebar.tsx](src/app/components/AppSidebar.tsx).
- **Every section in a column can be minimized at once.** Collapsing them one at a time used to stall with the last one stuck open. A panel group has to fill its container, so with only real sections in it the layout kept one expanded to absorb the space a stack of collapsed headers leaves over, and collapsing one section pushed its freed space onto the next and popped a collapsed neighbour back open. A trailing zero-width filler takes the leftover now, and each toggle re-asserts the whole minimized set until it holds. See [SectionStack.tsx](src/app/components/SectionStack.tsx).
- **Dragging a panel into a column that is empty or closed now works.** The drop test is a rectangle, and a column holding nothing renders no panel to aim at while one that is minimized sits in the DOM at zero width, so a drag toward either simply died with no feedback. Both sides put up a labelled rail while the other column has a panel in hand, the hit test takes the first non-empty target rather than the first one it finds, and a panel that lands in a closed column opens it so the drop is never invisible. See [SectionDropRail.tsx](src/app/components/SectionDropRail.tsx).
- **Bare Ctrl+C and Ctrl+V reach the PC clipboard, in SSH sessions and floated panes too.** Ctrl+Shift+C and Ctrl+Shift+V still work; the bare pair is the one Termius and Windows Terminal bind, and it is what makes the desktop clipboard usable inside a remote shell. Ctrl+C only copies while the terminal actually has a selection, and the handler clears that selection afterwards, so pressing it again falls through to the shell as SIGINT. The gate reads real keyboard focus rather than the active pane, because the two disagree whenever something moves the active pane while the caret stays put, and both chords are intercepted the instant they match. See [session-lifecycle.ts](src/modules/terminal/lib/session-lifecycle.ts), [shortcuts.ts](src/modules/shortcuts/shortcuts.ts).
- **The director drives and reads the whole app, and answers over MCP.** It used to reach a terminal buffer and a command id and nothing else, which left most of the app undrivable: an editor could not be read at all, since CodeMirror virtualises and scraping the DOM returns only the scrolled-in window of a long file while looking plausibly complete. It now carries every pane in every tab with the identity that picks it out, live editor buffers, open-by-path, save and focus, the installed extension list, and the commands extensions declare, which live in a registry the shortcut registry never sees. A dependency-free MCP server holds one connection for a whole session rather than paying a fresh attach per command, and a page target accepts exactly one DevTools client, so each attach and detach was also a chance to wedge it. Panes marked private are filtered at the source, on reads and writes alike. See [scripts/director/](scripts/director/).

### Changed

- **Every panel in both side columns now draws the same header.** Seven surfaces each drew their own, at three different heights, with the bottom border optional, so "header" and "body" were only sometimes distinguishable and an extension's panel read as a foreign surface next to Files. One rule replaces all of them, tinted from the same pair of tokens the app's own toolbar and tab strip use, so it follows every theme preset without a new setting. Two things fall out of it: a minimized section is a plain label row everywhere rather than in two places out of seven, and the row finally fits. The Files header wanted about 252 pixels of fixed chrome against the sidebar's default 225, and because a header clips from the right, the Move and Close buttons at the end were the first to be sliced off. Convenience actions that are duplicated in a context menu now step aside below a threshold, leaving the title and the few that matter. See [globals.css](src/styles/globals.css), [ExplorerHeader.tsx](src/modules/explorer/components/ExplorerHeader.tsx).
- **The file tree's search buttons say when they are on.** Both search toggles and a non-default sort now colour their glyph, so a filter you left open is visible instead of having to be rediscovered. In the secondary folder tree the separate "open a folder" button is gone: the folder icon left of the name is the picker, which is one fewer thing competing for room in a row that was already running out of it. See [ExplorerHeader.tsx](src/modules/explorer/components/ExplorerHeader.tsx).
- **A detected dev server is offered from everywhere, and only while it answers.** The offer used to be a globe in the focused pane's header, which can never be always visible: the pane stack is blanked entirely on any Source Control, diff or extension tab, so the address you had just started serving disappeared the moment you looked at a diff. It sits in the status bar now, and it is decided by a live probe rather than once at detection time, so a server you stopped stops being offered and one you started after navigating is still found. It takes two dead rounds to drop a URL, because a hot restart leaves a one to three second hole and one strike blinks it off every time. See [useProjectUrl.ts](src/app/hooks/useProjectUrl.ts), [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx).
- **`ctx.app.setRightSidebarVisible` is now a true mirror of its left twin.** It used to close the right column's surfaces and replay a snapshot to put them back, because the column had no collapse of its own; hiding the sidebar lost nothing and restored exactly, while hiding the right one tore its contents down and rebuilt them approximately. A panel whose extension had since been uninstalled never came back, and Source Control was carved out of the replay entirely. It collapses the column now and closes nothing, so what you hide is what returns, and `true` really shows it instead of being the documented no-op. An extension that relied on the close to tear its panels down should close them itself. See [extensions/README.md](extensions/README.md).

### Fixed

- **Source Control could end up in neither column when moved to the right.** Which column renders it is a persisted preference written over IPC, while the right column's open flag is set synchronously, so for a few ticks the app saw "open on the right" together with "not docked right", which is exactly the state its housekeeping exists to clean up, so it closed the panel that had just been opened. Once the preference echoed back the sidebar dropped the section too, and it stayed in neither column until its status-bar icon was found. The same held for Remote. See [preferences.ts](src/modules/settings/preferences.ts).
- **The zoom control no longer disappears when the status bar is folded.** Compact mode folded it away with everything else, but it already hides itself at 100%, so keeping it costs a compact bar nothing in the normal case, and folding it while you were actually zoomed took away the only way back to 100% that is not a keyboard shortcut. See [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx).
- **A dev build no longer clones tabs into an installed one.** Debug builds already read and write a separate data directory, but the PTY daemon socket was left out of that isolation, and it is the piece that leaks the most: the daemon is a shared, persistent process holding live shells, and the app adopts any live session it does not own that appeared after it started watching. So a terminal opened in a development build grew a duplicate tab in the installed app running beside it. Release builds keep the socket name they have always used and can still reattach to a daemon a previous version left running. See [paths.rs](src-tauri/src/modules/pty_daemon/paths.rs).
- **A cross-column drag finally shows where it will land.** The code has been marking the column under the pointer since the drag was written, and no rule was ever added to draw it, so the mark was invisible. See [globals.css](src/styles/globals.css).

## [0.4.24] - 17-08-2026

### Added

- **`tedi cmd <id>` runs a command in the window that is already open.** Driving a running TEDI from a script meant `TEDI_DEBUG_PORT`, which has to be set before launch because WebView2 fixes its browser arguments when it creates its environment, so a session already in progress could not be reached at all without restarting it and losing the state that made it worth driving. The `cmd` verb rides the same single-instance forward `tedi .` already uses: the id is handed to the running window, run against the command registry, and the forwarding process exits. It grants nothing new and opens no socket, since a local process could already synthesise the keystroke behind any of these commands. An unknown id reports as a toast in the window rather than doing nothing at all, because the caller's shell is gone by the time the result is known. The verb also wins over a path when both parse, so a folder named `cmd` sitting in the working directory cannot quietly turn the command into a folder open. See [cli.rs](src-tauri/src/modules/cli.rs), [useWorkspaceRoot.ts](src/app/hooks/useWorkspaceRoot.ts).

- **`ctx.ui.codeEditor` speaks `http`, so an extension can edit a `.http` document.** The editor an extension mounts covered SQL, JSON and JavaScript, which left a request document as plain text in the one place an API client most wants it coloured. `http` joins the list, drawn by the CodeMirror legacy mode already in the dependency tree, so nothing new is pulled in. Worth knowing if you write one: that mode is strict about the first line, which must be `METHOD URL HTTP/1.1`, and anything else makes it paint an error token that some editor themes do not colour at all, so a document that looks fine on one theme can be red on another. A host that predates a language still falls back to plain text rather than failing, so an extension can opt in without raising `engines.tedi`. See [codeEditor.ts](src/modules/extensions/codeEditor.ts), [extensions/README.md](extensions/README.md).

### Changed

- **Commit authors carry their picture in the history graph.** The coloured initials dot told two contributors apart but never said who either one was, so a repository with more than a handful of people still had to be read through the tooltip a row at a time. The dot now holds the author's avatar when their email is a GitHub `users.noreply.github.com` address, which is where the URL comes from: no API call, no hashing, and no real email address handed to anyone. Anything else keeps the initials, which stay underneath as the fallback for an account that was deleted or a machine that is offline. See [historyMeta.ts](src/modules/scm/historyMeta.ts), [GitGraphView.tsx](src/modules/scm/GitGraphView.tsx).
- **The history row now sheds columns in a deliberate order as the panel narrows.** The width gates predated the avatar and were never retuned around it, so at about 300 pixels the sha, the ref chips and the author were all still competing and each got a sliver. They drop cheapest-first now: the short sha first, since the hover peek and the commit card both repeat it, then the ref chips, and the clock never. The gates are set from rendered pixels rather than guessed, including keeping one off the side panel's exact 416 pixel width so a single-pixel resize cannot flicker a column in and out. See [GitGraphView.tsx](src/modules/scm/GitGraphView.tsx).

### Fixed

- **A long branch name tore the graph's lane lines.** The ref chip wrapped inside itself when the name was long enough, which grew the text column past the fixed height the lane lines are drawn at, so every branch line in the graph opened a gap at that row. The row is pinned to its drawn height and a chip clamps to one ellipsised line. The hover peek still lists every ref in full, so nothing is lost, and the commit card keeps letting a long name wrap across its wider space. See [GitGraphView.tsx](src/modules/scm/GitGraphView.tsx), [RefBadge.tsx](src/modules/scm/components/RefBadge.tsx).
- **A pushed branch was labelled twice on the same commit.** Git lists `feat/x` and `origin/feat/x` separately, so the busiest row in the history carried the same long name back to back, which is most of what was overflowing it. A remote ref can only sit on the same commit as its local branch when the two are in sync, so the remote copy says nothing the branch chip does not, and it is dropped for the same reason `origin/HEAD` already was. A remote with no local twin, which is the case that actually carries information, is untouched. See [historyMeta.ts](src/modules/scm/historyMeta.ts).

### Security

- **`SECURITY.md` claimed three things the code does not do.** Reported in [#15](https://github.com/IlhamriSKY/TEDI/issues/15) and [#16](https://github.com/IlhamriSKY/TEDI/issues/16). No behaviour changed and nothing was exploitable that is not still true, but a security document that overstates its guarantees is its own defect, so each claim now matches the implementation. **Secrets** were described as living in the OS keychain and not on disk, which holds only on macOS: Windows keeps a DPAPI-encrypted file in the app data directory, and Linux keeps a `0600` JSON file that is not encrypted, because an AppImage, deb or rpm install cannot assume a Secret Service daemon is running. All three are spelled out now, along with what the Linux case means in practice, that a backup or an unencrypted disk carries those secrets in the clear. **Updates** were described as manual with no silent network calls, when the app has checked GitHub Releases every six hours since the updater landed; the check is automatic, the install is still your click, and both are now stated that way. **Extensions** are not sandboxed: their JavaScript runs in the main webview with the app's full privileges, and the permission list is an install-time review rather than an enforced boundary, exactly as the install dialog and `TEDI.md` have both said since 0.3.92. `SECURITY.md` was the one place that did not, and its wording about allow-listed commands implied otherwise. It now says so plainly, says why a real boundary needs the extension API rewritten around an isolated worker rather than patched, and adds the case to the out-of-scope list so the expectation is set before a report rather than after. Also documented: the history graph fetches author avatars from GitHub, which the old blanket "only talks to the network when you ask it to" did not cover. See [SECURITY.md](SECURITY.md).

## [0.4.23] - 12-08-2026

### Added

- **Pull requests live in Source Control now.** Reviewing or opening a PR meant leaving the editor for a browser or a terminal, so the branch you were standing on and the pull request describing it were never in the same place. Source Control gains a Pull Requests tab that lists what is open, opens one for the current branch against a base you pick, and checks an existing one out. It drives the GitHub CLI rather than carrying a REST client of its own, because `gh` already holds the credential: no second login, and no token stored here. **Stacked pull requests** come with it, since a stacked PR is simply one whose base is another feature branch, so the base picker covers that on its own; where GitHub's `gh-stack` extension is installed, the stack view and the cascading rebase come through as well. See [PullRequestsView.tsx](src/modules/scm/PullRequestsView.tsx).
- **The git operations a modern editor is expected to have.** Stash, tags, merge, rebase, revert, cherry-pick, reset, branch rename, undo last commit, sync, initialize repository and publish to GitHub were all missing, so reaching for any of them meant dropping into a terminal. They live in one overflow menu rather than spreading across the header, and each is composed in the same operation runner the existing commands already use, so a local repository and one reached over SSH get every operation from a single implementation instead of two that drift apart. A half-finished merge or rebase now shows a Continue / Abort strip, driven by git's own marker files rather than inferred from the last command's output. See [SourceControlPanel.tsx](src/modules/scm/SourceControlPanel.tsx).

### Changed

- **The history graph groups commits by day and stops repeating your name.** Every row carried the full author name, which on a repository with one author is the same string a hundred times over, and nothing separated today's work from last month's. Commits sit under day separators now, with the graph's lanes redrawn through each one so the branch lines stay continuous rather than breaking at the gap, the author became a coloured dot of their initials, and merge commits are drawn hollow so a merge is tellable from ordinary work without reading it. See [GitGraphView.tsx](src/modules/scm/GitGraphView.tsx).
- **A debug build stopped writing gigabytes nothing reads.** The library still declared the iOS and Android crate types the project template ships with, though this app has no mobile target and nothing in the tree or in CI consumes them, so every build linked the entire dependency graph twice more and wrote about 3GB of artifacts that were never opened. Dependencies also carried full debug information at no optimisation, which is what let the build directory reach 262GB and what made a debug build feel sluggish next to a release one, since the crypto, search and allocator crates all run an order of magnitude slower unoptimised. Dependencies are built at `opt-level = 1` without debug info now; our own crate keeps its own, which is the only part a breakpoint ever lands in. See [Cargo.toml](src-tauri/Cargo.toml).
- **A scripted driver for the app, for demo and walkthrough footage.** `scripts/director/` drives a running TEDI over the WebView2 DevTools Protocol with real key and mouse events, reads editor panes and terminal buffers back, and can capture the window. It is contributor tooling rather than a feature, and it is off unless TEDI is started with `TEDI_DEBUG_PORT`, which is the single switch that opens the port and exposes anything to it, so an ordinary launch is untouched. See [scripts/director/README.md](scripts/director/README.md).

### Fixed

- **The commit subject could be squeezed to nothing by its own branch labels.** On the most recent commit the ref chips, the branch name plus its remote plus HEAD, were laid out so that they never gave ground, and at 256 pixels of a 416 pixel row there was nothing left for the message the row exists to show. The chips are capped and allowed to shrink now, so the subject keeps its space. See [GitGraphView.tsx](src/modules/scm/GitGraphView.tsx), [RefBadge.tsx](src/modules/scm/components/RefBadge.tsx).
- **The "open preview" globe followed the focused pane instead of the running server.** A dev server prints its address, the button to open it appears, and then clicking into an editor pane made it disappear as though the server had stopped. It rides detection rather than focus now: the newest address any terminal printed stays on offer from any pane, and goes away only when that pane is closed or the address is already open in a browser tab. See [useActiveLeafSurface.ts](src/app/hooks/useActiveLeafSurface.ts).

## [0.4.22] - 10-08-2026

### Added

- **The Command Palette finds files: type `@`.** `Ctrl+Shift+P` listed commands and nothing else, so opening a file by name meant leaving it for the explorer's own search box. Typing `@` as the first character switches the palette to the files in the open folder, and Enter opens the one you picked. It runs the same search the explorer's "Go to file" already used, so the ranking, the ignore rules and the show-hidden-files preference are identical in both places rather than two implementations drifting apart. Folders are left out, since a folder is not something the editor can open, and each row carries the file tree's own icon and the path relative to the root so two files with the same name stay tellable apart. With no folder open it says so instead of showing an empty list. See [CommandPalette.tsx](src/modules/commandPalette/CommandPalette.tsx).

### Fixed

- **`Ctrl+/` now comments in 30 more languages.** The shortcut itself was never missing, and in most languages it was already correct: `//` in JavaScript, `#` in Python, `/* */` in CSS. But it reads the comment syntax off the language, and 36 of the bundled languages shipped none at all, so in those the key did nothing whatsoever and gave no clue why. JSON, INI, nginx, CMake, Protobuf, Puppet, Fortran, COBOL, VBScript, Gherkin, Pug, WebAssembly text, Smalltalk, APL and 16 more now carry their own syntax and toggle properly. Six are deliberately left alone, `http`, `diff`, `asciiarmor`, `mbox`, `brainfuck` and `textile` have no comment syntax to use, so the key stays inert there rather than inserting something that is not a comment. The registry's self-check now fails if this table ever names a language that does not exist, which is the one way the table could quietly stop working again. `Ctrl+/` is also listed in Settings > Shortcuts now, so it is findable. See [languages.ts](src/modules/editor/lib/languages.ts), [shortcuts.ts](src/modules/shortcuts/shortcuts.ts).

## [0.4.21] - 10-08-2026

### Changed

- **The status bar's compact switch is a menu icon that folds into a cross.** The button that folds the status bar down to its essentials was an eye, which says "visibility" but not which way the click goes. It is a menu glyph while the bar is folded, so the three bars read as the items waiting to come back, and a cross while everything is showing, so the click that puts them away is the obvious one. The two states are the same three strokes: the outer pair slide together and cross, the middle one retracts, all in one two-hundred-millisecond motion rather than one icon being replaced by another. See [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx).
- **Expanding a section turns its chevron instead of replacing it.** Five collapsible headers, the sidebar sections, a workspace's tab list, an extension's sidebar group, a Source Control group and a search result's file row, each rendered one chevron when open and a different one when closed. Swapping two icons replaces the element, so there was nothing for the browser to animate and the arrow jumped. Each one is a single chevron that rotates now, matching the file tree, which already worked this way. See [SectionStack.tsx](src/app/components/SectionStack.tsx), [WorkspacesPanel.tsx](src/modules/workspaces/WorkspacesPanel.tsx), [ChangeSection.tsx](src/modules/scm/components/ChangeSection.tsx), [GrepFileRow.tsx](src/modules/explorer/components/GrepFileRow.tsx).
- **Staging a whole Source Control group folds the plus into a minus.** The button that stages every change in a group, and unstages them again once they are all staged, swapped between a plus and a minus. Both glyphs are the same horizontal stroke, so only the upright one moves now: it retracts into the crossbar when the group is fully staged and grows back out when it is not. See [ChangeSection.tsx](src/modules/scm/components/ChangeSection.tsx).
- **Revealing a saved API key draws a slash across the eye.** The reveal button in a provider's key field swapped between two eye icons whose outlines differ, so the shape jumped on every click. The eye stays put now and a slash draws itself across it from the corner. Both provider forms, the built-in list and the OpenAI-compatible block, use one button, so they can no longer drift apart. See [RevealKeyButton.tsx](src/settings/components/RevealKeyButton.tsx).
- **A checkbox's mark appears rather than materialising.** The tick and the partial-selection dash were inserted with no animation at all. They scale up over a tenth of a second now, which covers every checkbox in the app including the Source Control group headers. See [checkbox.tsx](src/components/ui/checkbox.tsx).

### Fixed

- **An extension's button in a pane header was drawn a third larger than the buttons beside it.** The Beautify wand sat next to the markdown, word-wrap, float and close buttons at sixteen pixels against their twelve. Those buttons set their size through the icon's own attribute, which a stylesheet rule on the shared button component silently overrode. The wand asks for its size the way the rule expects now, and the close cross, alone on thirteen pixels, came down to twelve with the rest. See [ExtensionHeaderItems.tsx](src/modules/extensions/components/ExtensionHeaderItems.tsx), [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx).
- **Nine buttons changed colour on hover with no fade.** Seven collapse and reveal buttons carried a hover colour but no transition, so the change landed in a single frame. Four more, the stage-all and discard-all buttons, a branch's delete button and a model's pin, appear only when the row is hovered and popped into place, because the transition they inherited covers colour but not opacity. Both groups fade now, matching the thirteen places in the app that already did. See [ChangeSection.tsx](src/modules/scm/components/ChangeSection.tsx), [BranchMenu.tsx](src/modules/scm/components/BranchMenu.tsx), [ModelSection.tsx](src/modules/ai/components/ModelSection.tsx).
- **The browser's reload and stop buttons were drawn at different stroke weights.** The reload arrow and the cross that cancels a load shared one slot in the address bar but not one line thickness, so the button changed weight the moment a page started loading. See [BrowserAddressBar.tsx](src/modules/browser/BrowserAddressBar.tsx).

## [0.4.20] - 09-08-2026

### Added

- **The Files tree can move to the right panel, and back.** Every other sidebar section, Source Control, Remote, Workspaces and the ones extensions contribute, could be handed to the right column by the button in its header or by dragging its grip across, but the primary folder tree was pinned to the left. Two things had kept it there: the right column used to hold one surface at a time, so the tree would have contested that slot with the Secondary Folder Tree extension, and a guard written for extension panels closed a docked built-in section the instant it opened. The column stacks its surfaces now, and that guard knows about built-in sections, so neither reason survives. Files moves by the same "Move to right panel" button and the same drag as its neighbours, comes back by the "Move to left sidebar" button on the docked copy, closes to a status-bar icon that reopens it, and remembers where you left it across a restart. Note the tree draws no header until a folder is open, so the move button appears with the folder. See [sidebarPlacementStore.ts](src/modules/extensions/sidebarPlacementStore.ts), [AppSidebar.tsx](src/app/components/AppSidebar.tsx), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx).

### Changed

- **The zoom pill sits to the left of the AI usage meters.** It was grouped with the status bar's action buttons, which left it stranded after the meters, the extension icons and a divider, away from the corner the eye goes to when the zoom level is the thing being read. It now has a group of its own immediately before the usage meters. It still appears only while the zoom is away from 100%, and its divider goes with it. See [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx).

## [0.4.19] - 08-08-2026

### Added

- **A Board that shows every terminal in the workspace by what its AI agent is doing.** Running several agents at once meant checking each tab to find the one waiting on you. The Workspaces panel now offers a kanban icon on the active workspace: it opens a Board of four columns, Idle, Working, Blocked and Done, with one card per terminal. Clicking a card focuses that pane. The Board is an ordinary pane, so it has the same header, close button and split behaviour as any terminal, it can be popped out into its own always-on-top window, and it survives a restart. Each card carries the pane's own icon and number, the agent running in it, its folder and its git branch. See [WorkspaceBoard.tsx](src/modules/workspaces/WorkspaceBoard.tsx), [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx), [floatHost.ts](src/modules/panes/floatHost.ts).
- **A Board card shows the agent's todo list.** A card for a terminal running Claude Code carries a `todo 3/7` line that expands into the items, ticked ones struck through. The list is read from the agent's own session record rather than scraped off the screen, so it does not vanish when the terminal scrolls and it still shows the finished items after the agent has moved on. Terminals running something with no adapter simply show no todo line at all. See [agentTodos.ts](src/modules/terminal/lib/agentTodos.ts).

### Changed

- **The per-file toolbar buttons moved onto the pane they act on.** The detected-URL globe, the word-wrap switch and the Beautify wand all sat in the app toolbar, which meant that with two panes open they could only ever address whichever one had focus. They now sit in each pane's own header next to the float button, fenced off from the float, theme and close buttons by a rule so the two groups read apart. On a narrow pane the group steps aside instead of pushing the close button off the edge. The toolbar keeps only what is genuinely global: search, SSH, extensions and settings. See [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx), [Header.tsx](src/modules/header/Header.tsx).
- **An extension's `placement: "left"` header button now belongs to the editor pane.** It used to sit in the app toolbar; it renders in the focused editor pane's header instead, at that row's smaller scale, and shows nothing while a terminal or browser pane has focus. Extensions that want an always-visible button should use the default `"right"` placement. See [extensions/README.md](extensions/README.md).

## [0.4.18] - 08-08-2026

### Added

- **The code editor's font ligatures can be turned off.** A coding font fuses `=>` into an arrow and `!=` into `≠`. That is a font feature and not an edit, but it reads as one when you are hunting for the characters you actually typed. `Settings > Code Editor > Font ligatures` now switches it, on by default so nothing changes for anyone who likes them. A single CSS variable drives the editor, the diff panes and an extension's own editor together, so the three cannot disagree about whether a pair is drawn as one glyph. See [fonts.ts](src/lib/fonts.ts), [extensions.ts](src/modules/editor/lib/extensions.ts), [CodeEditorSection.tsx](src/settings/sections/CodeEditorSection.tsx).

### Changed

- **The markdown preview toggle moved out of the toolbar onto the pane it acts on.** It sat in the app header beside the word-wrap button, so two markdown files open side by side shared one button, and it could only ever address whichever pane had focus. It now lives in each pane's own header next to the float button, which lets two panes sit in different modes and puts the control beside the text it switches. See [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx), [Header.tsx](src/modules/header/Header.tsx).

### Fixed

- **Selecting text in a dialog no longer drags the whole window.** Dragging across the text of an SSH connection dialog moved the app, and double-clicking a word maximised it. The window-drag handler lives on the header row, and the SSH menu that owns those dialogs is inside that row: React sends an event up the component tree rather than the document tree, so a mousedown on a dialog portaled to `body` still arrived at the header. The `data-tauri-drag-region="false"` markers that already guard the tab strip could not help, because they are found by walking the DOM and a portaled dialog has no header in its DOM ancestry. The handler now ignores anything not genuinely inside the row it is attached to, which covers the dropdown menus, tab context menus and tooltips the header opens as well. Tauri's own drag region was never involved: it walks the composed path, so a portal can never match it. See [Header.tsx](src/modules/header/Header.tsx).

## [0.4.17] - 06-08-2026

### Added

- **A terminal the agent names in its answer is a link you can click.** Ask which terminals are open and the reply comes back as `#392`, `#387`, `#405`, the same numbers on the tab badges, because the agent reads them from the `<env>` block it gets every turn. They were text, so you still had to go and find the tab yourself. Those references now activate the owning tab and focus the pane. Only a number matching a terminal that is open right now becomes a chip, so "issue #12" and "PR #407" stay ordinary text, and a chip whose terminal has since been closed says so instead of doing nothing. It works wherever the model writes markdown, in replies and in tool summaries alike, and deliberately not in your own markdown files: a `.md` mentioning `#392` is not a terminal. The obvious implementation, an anchor with a fragment href, silently could not work: with link-safety on, a markdown link renders as a `<button>` and the href never reaches the DOM, so both a click handler and a CSS rule would have been matching something that was never there. See [terminal-refs.ts](src/components/ai-elements/terminal-refs.ts), [message.tsx](src/components/ai-elements/message.tsx), [buildLiveContext.ts](src/app/lib/buildLiveContext.ts).
- **`>` picks an open terminal to talk about.** The composer had `@` for files and `/` for commands but no way to point at a terminal, so naming one meant knowing its number by heart. `>` opens a picker listing every open terminal with its number, title and working directory, and inserts the reference the agent already understands. See [AiInputBar.tsx](src/modules/ai/components/AiInputBar.tsx), [SnippetPicker.tsx](src/modules/ai/components/SnippetPicker.tsx).
- **A saved SSH host can be duplicated.** Using the same key, password or agent against a different host or port meant retyping the form and re-importing the credential. Duplicating copies the record with its secrets and opens the copy, ready for the one field that differs. The pinned server key is deliberately not copied: it belongs to the machine that presented it, and carrying it to another host would fail the next connect as a key MISMATCH, which reads as an attack rather than as a copy. See [connections.ts](src/modules/ssh/connections.ts), [SshMenu.tsx](src/modules/ssh/SshMenu.tsx).
- **The header search box shows which match you are on.** It had no counter and no arrows, so stepping through hits meant holding Enter and watching the document. It now reads `3/17` with previous and next buttons, for terminals, the code editor and the markdown preview alike, turns red when nothing matches, and widens only once something is typed. See [SearchInline.tsx](src/modules/header/SearchInline.tsx), [EditorPane.tsx](src/modules/editor/EditorPane.tsx).

### Changed

- **The composer's `#` commands moved to `>`.** `#` had to be free before `#392` could be typed as a terminal reference, since typing it opened the snippet picker instead. Tag commands are now `>init` and `>plan`, snippet handles are `>handle`, and `#` is ordinary text. Both system prompts now tell the model to name a terminal as `#<ordinal>`, so the reference is written consistently rather than by chance. See [pickerTrigger.ts](src/modules/ai/lib/pickerTrigger.ts), [slashCommands.ts](src/modules/ai/lib/slashCommands.ts), [snippets.ts](src/modules/ai/lib/snippets.ts).

### Fixed

- **A rejected password no longer re-asks the SSH host-key question on every retry.** The fingerprint was pinned only after a fully successful connect, so anything that failed afterwards, a wrong password or a dropped link, left the host unknown and the first-connect dialog came back. It is now recorded the moment the user says yes, which is what `openssh` does when it writes `known_hosts` before sending a credential. The prompt names only the host, and one connect can be dialling several, so the key is pinned on every saved connection pointing at that machine rather than assumed to be the target: a ProxyJump hop's key lands on the hop's own record. See [hostKeyPrompt.ts](src/modules/ssh/hostKeyPrompt.ts), [connections.ts](src/modules/ssh/connections.ts), [ssh-session.ts](src/modules/terminal/lib/ssh-session.ts).
- **A server key trusted while testing a new SSH host survives being saved.** Test and Save disagreed about the pin: `editing` is a snapshot from when the dialog opened, so a key trusted during Test was dropped by the save that followed, and a key just cleared with "Forget" came back from the stale prop. The dialog's own pin state is now the single source of truth for both, and it is discarded when the host field changes, since a pin belongs to one machine. The port is not part of that: one sshd presents the same host key on every port it listens on. See [SshConnectionDialog.tsx](src/modules/ssh/SshConnectionDialog.tsx).
- **A popover inside a dialog answers the mouse again.** Picking a jump host only responded to Enter, never to a click. The cause was not the dialog's focus trap: the popover is portaled to `body`, a modal layer sets `pointer-events: none` there, and the content inherited it. The apparent cure, marking the popover modal as well, bought the click by making everything else inert, so the fields behind froze and clicking away could not even close it. The content now restores pointer events for itself and the page stays live. See [popover.tsx](src/components/ui/popover.tsx).
- **Several UI strings dropped the em dash** for the punctuation the rest of the app uses. See [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx), [BrowserExtensionsMenu.tsx](src/modules/browser/BrowserExtensionsMenu.tsx), [formatters/index.ts](src/modules/editor/lib/formatters/index.ts).

## [0.4.16] - 06-08-2026

### Added

- **An SSH connection can authenticate through the local ssh-agent, so the private key never reaches TEDI.** Until now a key-auth host meant pasting or importing the key itself, which TEDI then kept in the OS keychain: a second copy of the one secret that should exist once, and one more place to audit after a leak. The new `SSH agent` mode asks the agent to sign each handshake instead, so nothing is read, stored, or carried into a `.tedi-ssh` backup, and saving an existing host into this mode deletes the key it had. It works for the target and for every hop of a ProxyJump chain. Windows talks to the OpenSSH Authentication Agent's named pipe, or whatever `SSH_AUTH_SOCK` points at, or Pageant, which is what PuTTY and Bitvise expose; macOS and Linux use `SSH_AUTH_SOCK`. Because there is no field to fill in, the dialog answers the only question that matters up front: it lists the keys the agent is holding, or says exactly which service to start. Connecting is deliberately not blocked on a live agent at save time, since the agent may be started afterwards. Keys are offered in the agent's own order until one is accepted, and certificates are skipped rather than burning the server's auth attempts on a flow TEDI does not implement. See [session.rs](src-tauri/src/modules/ssh/session.rs), [connections.ts](src/modules/ssh/connections.ts), [SshConnectionDialog.tsx](src/modules/ssh/SshConnectionDialog.tsx).

### Changed

- **The auth mode of a saved SSH host is turned into credentials in one place.** The same three-way mapping was spelled out at four call sites: the terminal session, the tunnel used by extensions, jump-hop resolution, and the dialog's Test button. A fourth mode had to be added to all four, and any one missed would connect with no credentials at all rather than fail. It now lives in `authFields`, which also turns an empty secret into nothing at all, so a host with a missing credential hits the backend's explicit guard instead of attempting an empty password. See [connections.ts](src/modules/ssh/connections.ts).
- **The installer's copyright line names the fork.** It still read as the upstream project's alone. It now credits both, in the wording Settings already uses for the same fact: `Copyright © 2026 IlhamriSKY. Built on Terax © 2026 Crynta. Apache License 2.0.` One field feeds the installer footer, the executable's properties, the macOS bundle and the deb/rpm metadata. See [tauri.conf.json](src-tauri/tauri.conf.json).

### Fixed

- **A status-bar divider no longer hangs off a group with nothing in it.** The right cluster drew its separators as standalone elements between groups, and a separator cannot know that everything after it rendered nothing: the zoom pill is hidden at 100%, the update pill exists only when there is an update, the agent pill only when the agent is busy, and the extension items only when an extension registered one. So the common case was a hairline with empty space on one side, and two touching hairlines in compact mode. Each group now draws its own leading divider, hidden unless a non-empty group actually precedes it, which also removes the dead gap an empty group used to leave. Deciding this in JavaScript would have meant duplicating each extension registry's filtering in the status bar; the DOM already knows. See [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx), [globals.css](src/styles/globals.css).
- **A `/goal` that the agent finished now stops its clock by itself.** The run ends when the model closes a message with a `GOAL COMPLETE` line, but the match was byte-exact, so `**GOAL COMPLETE**`, a trailing full stop, a heading or a bullet all went unheard: the loop kept sending turns until its 25-turn budget ran out while the strip carried on counting. The line may now carry the markdown a model actually writes. It stays anchored to a whole line so the marker inside a sentence cannot end the run on turn one, and a blockquote is still refused because quoting the instruction back is exactly the shape that misfires. See [goalRunner.ts](src/modules/ai/lib/goalRunner.ts).
- **A finished goal shows what it took and nothing else.** Its strip kept offering "mark done" and "hide", one of which is meaningless once the goal has closed itself. Both controls now belong to a goal still in flight. See [GoalStrip.tsx](src/modules/ai/components/GoalStrip.tsx).

## [0.4.15] - 05-08-2026

### Changed

- **`/goal` now works the goal instead of only holding it in mind.** Setting one wrote a line into the system prompt and then sat there until the user typed something else, so the command read as a no-op. `/goal <text>` now sends the opening turn and keeps the agent going after each one until it ends a message with a `GOAL COMPLETE` line, which also freezes the goal's clock. The auto-send rides the composer's existing queue drain rather than the stream's finish callback, because that is the only place already holding the three guards an unattended send needs: it waits for the agent to be idle, refuses while a tool approval is pending, and opens a restore checkpoint first. The user's own queued prompts still go first. An unattended run is bounded at 25 turns, and every way of taking control back ends it: Stop, Restore, `/clear`, `/goal done`, `/goal clear`, deleting the session. Arming lives in memory while the goal itself is persisted, so a restart leaves the goal standing and the loop off rather than resuming a run nobody is watching. See [goalRunner.ts](src/modules/ai/lib/goalRunner.ts), [composer.tsx](src/modules/ai/lib/composer.tsx), [slashCommands.ts](src/modules/ai/lib/slashCommands.ts).
- **`read_file` returns the whole file instead of the first 2000 lines.** The tool had two ceilings, 2000 lines and 200KB, and lines are the wrong unit: the largest source file in this repo is 2562 lines but only 83KB, so the line cap fired on ordinary files while the byte cap never could. The model was handed two thirds of a file plus a paging round-trip that costs more context than reading it whole. The default line budget is now the same 10000 the Rust side already enforced, so the two cannot drift, and the 200KB byte cap is the only thing that normally truncates a read, which is the honest limit because bytes are what actually enter a context window. See [fs.ts](src/modules/ai/tools/fs.ts).
- **Renaming a tab replaces its name, not what it is.** An SSH pane, a SQL Explorer panel and an API Client panel all say which they are in their derived title, and a rename threw that away, leaving the icon as the only clue in the tab strip and in the Workspaces panel. The kind tag now stays in front of whatever the user types: `ssh:prod`, `SQL:staging`, `API:checkout`. The extension tag is the first word of the extension's own title, so core carries no table of which extensions exist, and a tab that has not been renamed is left exactly as the extension wrote it. See [tabHelpers.ts](src/modules/tabs/lib/tabHelpers.ts), [entries.ts](src/modules/tabs/lib/entries.ts).

### Fixed

- **A delete button lost its red the moment the pointer entered its row.** The cause was not the buttons. A menu row repaints every one of its descendants on hover, and that rule paints the SVG element itself at a specificity a plain `hover:text-destructive` cannot beat, so the trash glyph on "delete branch", "delete SSH host" and "delete session" turned grey while the row was highlighted. The obvious fix, narrowing the row's rule to direct children, silently breaks every two-line menu item, whose muted second line is a grandchild. Destructive controls now opt out by importance instead, on the button and on its glyph, which no ancestor rule can outrank. They are also a constant red now rather than fading up from 75% on hover, since a destructive action should look the same before and after you point at it. The SSH menu's own local workaround for the same cascade was narrowed to the label spans so it stops reaching into the row's action buttons. See [toolbarButton.ts](src/lib/toolbarButton.ts), [context-menu.tsx](src/components/ui/context-menu.tsx), [SshMenu.tsx](src/modules/ssh/SshMenu.tsx).
- **Renaming a tab and pressing Enter unchanged could double its prefix.** Both rename fields, in the tab strip and in the Workspaces panel, started from the full label, so keeping an SSH tab's name stored `ssh:prod` as the name and the tab then read `ssh:ssh:prod`. The field is now seeded with the name alone, and a pane whose saved connection was deleted, which reads as a bare `ssh`, seeds empty rather than offering its own tag to be committed as a name. See [tabHelpers.ts](src/modules/tabs/lib/tabHelpers.ts), [renderEntryBody.tsx](src/modules/tabs/components/renderEntryBody.tsx).
- **Ctrl+L was swallowed by the terminal even when there was something to ask about.** Terminal panes let control chords fall through to the shell so readline keeps working, which cost `ai.askSelection` entirely. It now fires when the focused local or SSH terminal actually holds selected text and is not private; with no selection Ctrl+L still reaches the shell as clear-screen. See [App.tsx](src/app/App.tsx).

## [0.4.14] - 05-08-2026

### Added

- **A session goal, with a clock.** `/goal <text>` sets one standing objective the agent keeps in view for the whole session, shown in a strip above the input bar with the time it has been open. `/goal done` freezes that clock rather than deleting the goal, so a finished goal still shows what it took; `/goal clear` drops it. The goal rides in the system prompt as its own block, appended last so the cached prefix stays byte-stable between turns, and a completed goal stops steering the agent while the strip still displays it. The timer counts from when the goal was SET and is derived from that stamp rather than accumulated, so it survives a reload, a session switch, and a restart. See [goal.ts](src/modules/ai/lib/goal.ts), [GoalStrip.tsx](src/modules/ai/components/GoalStrip.tsx), [slashCommands.ts](src/modules/ai/lib/slashCommands.ts).
- **The open-in-browser pill now fires for a dev server TEDI never saw start.** It only ever watched terminal output, so a server started outside a TEDI terminal, or before the app opened, was invisible. TEDI now reads the url the project itself declares (`.env` `APP_URL`, a vite `server.port`, a `package.json` dev script) and TCP-probes that one port. Off by default. Laragon's default TLD is `.dev`, a registrable public TLD, so a suffix allowlist cannot tell `myapp.dev` from any real domain: the hosts file is the only ground truth and is what gets consulted. The probe is a plain `TcpStream::connect` rather than an HTTP request, because reqwest is built against bundled webpki roots and reads a live Laragon server's self-signed https as dead; it resolves first and refuses any non-loopback address, so it cannot be used as a port scanner over IPC. See [projectUrl.ts](src/modules/browser/lib/projectUrl.ts), [useProjectUrl.ts](src/app/hooks/useProjectUrl.ts), [net.rs](src-tauri/src/modules/net.rs).
- **Grep can answer "which files" without reading every matching line.** A new `output_mode` returns file paths or per-file counts instead of content. Asking which files touch a symbol used to cost the full text of every hit; on this repo that is 20.6K tokens where the file list is 1.3K. See [search.ts](src/modules/ai/tools/search.ts).

### Changed

- **A tool result now carries only what the model needs, which cut billed input tokens by 70%.** Two things were re-sending text nobody reads. `edit` and `multi_edit` echoed the whole before/after diff back, up to 240K characters from one call, although the model already holds both strings from its own tool call and the text exists only to draw the chat card. `grep` repeated an absolute AND a relative path on every hit, which on a deep project is mostly the same directory prefix over and over, measured at about half of a 402-hit result. Both now have a `toModelOutput` that shapes the model-facing copy while the chat card keeps every field. The load-bearing half is that `convertToModelMessages` is finally given the tool set: without it the SDK falls back to the raw result for every past call, so a fix like this would apply only to the turn that produced it and silently revert on the next one. Measured end to end against a real model: 13,289 to 3,938 input tokens on one two-call turn. See [edit.ts](src/modules/ai/tools/edit.ts), [search.ts](src/modules/ai/tools/search.ts), [agent.ts](src/modules/ai/lib/agent.ts).
- **Sub-agents are switched in the tool picker, like every other tool.** There were two switches for one feature and they could disagree: the Settings toggle hid `run_subagent` / `run_subagents` while the picker still listed them as available. The toggle is gone and the picker is the only control. Switching the spawn tool off now also drops the orchestration prompt, which otherwise told the model to delegate while holding no tool to delegate with. An existing "off" is migrated into the picker's off-list on first load, so nobody who deliberately turned sub-agents off gets them back silently. See [catalog.ts](src/modules/ai/tools/catalog.ts), [SubagentsCard.tsx](src/settings/sections/components/SubagentsCard.tsx), [store.ts](src/modules/settings/store.ts).
- **A button is drawn by its face, not its outline.** The neutral button leaned on `--tedi-button-border`, and a border alone is nearly invisible where two surface tokens sit a step apart, which is what made Cancel, Save and Import read as loose text. It now paints a `--tedi-button-face` fill held to a contrast floor against the worst surface it can land on, with its own floor for the label, since a fill can fail two ways: invisible against the surface, or visible with an unreadable label. The 1px border stays transparent so focus can paint the ring without resizing the button. See [buttonFace.ts](src/modules/settings/buttonFace.ts), [globals.css](src/styles/globals.css).
- **The model picker opens tidy.** Every provider section was expanded, so the list ran to hundreds of rows and the model actually in use was somewhere off-screen. Sections now start collapsed except the two worth landing on: Pinned, and the group holding the current model. A search still opens everything, or it would hide its own matches. See [ModelDropdown.tsx](src/modules/ai/components/ModelDropdown.tsx).
- **Settings no longer nests an accordion inside an accordion.** "Advanced & debugging" held the debug switch, custom instructions, and the system prompts card, which draws its own accordion, so prompts sat two levels deep and one summary line had to describe three unrelated things. They are three siblings now: Custom instructions, System prompts, Debugging. See [AgentsSection.tsx](src/settings/sections/AgentsSection.tsx).
- **A chat no longer rewrites the whole history three times a second.** Every session lives in one store file, and the plugin serializes all of them on any change, so one message update during streaming rewrote every session's accumulated history. Measured at 1.6 MB across 9 sessions. The debounce moves from 300 ms to 2 s, which is safe because the tail is flushed the moment a turn ends, on session switch, and on unmount. See [chatStore.ts](src/modules/ai/store/chatStore.ts).
- **The comments across the AI module say the same things in a third fewer lines.** Multi-paragraph rationale had grown around decisions that need a sentence. Measured facts, non-obvious constraints and anti-regression warnings are kept verbatim; the narration around them is gone. Two docstrings turned out to have drifted away from what they describe and were reattached: one belonged to `checkReadableResolved`, which had none, and one to `RESEND_COMPACTION_BUDGET`, thirty lines from its constant. See [security.ts](src/modules/ai/lib/security.ts), [compact.ts](src/modules/ai/lib/compact.ts).

### Fixed

- **The open-in-browser pill never fired for `npm run dev`.** Vite bolds its port, and the escape that does it ends in `m`, a word character, sitting directly against `http` so the pattern's leading word boundary never matched; the same bold also split the port off the host. Laravel worked only by luck, printing a `[` that gave the boundary the non-word character it needed. Escape sequences are now stripped before matching, and the pattern moved to a node-safe module so the real captured banners can be pinned in a check. Closing the auto-opened tab also used to reopen it instantly, because the guard went null once a browser held the origin. See [detectUrl.ts](src/modules/terminal/lib/detectUrl.ts), [useActiveLeafSurface.ts](src/app/hooks/useActiveLeafSurface.ts).
- **One grep hit could outweigh the entire rest of a request.** Ripgrep returns whole lines and nothing capped them, so a match inside a minified bundle handed the model a single line hundreds of KB wide. Lines are now capped, and the stray carriage return every hit in a CRLF file carried is stripped, while leading indentation is kept because it tells the model how deeply the match is nested. See [search.ts](src/modules/ai/tools/search.ts).

## [0.4.13] - 05-08-2026

### Fixed

- **Dragging a section between the columns only worked one way.** Left to right handed the section over; right to left did nothing. The right column keys a docked BUILT-IN section by its plain id (`workspaces`) rather than the `xp:<ext>:<panel>` shape everything else there uses, and the undock resolver only understood the latter, so `moveRight` was reachable and `moveLeft` was not for the one section most likely to be dragged. Worse, the check that shipped with it asserted `undockTarget("workspaces") === null` as correct, because it was written against invented keys instead of the ones the column actually pushes; it now reads the key shapes out of the source. See [sidebarPlacementStore.ts](src/modules/extensions/sidebarPlacementStore.ts), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx).
- **A cross-column drag said nothing about where it would land.** The insertion line only ever previewed a reorder inside one column, so dragging toward the other was a leap of faith, and the source column's line kept promising a reorder that was not going to happen. The target column is now marked while the pointer is over it, and only when the section in hand is actually movable; the source column's line is suppressed. The mark is written to that column's DOM node rather than lifted into React state: it belongs to a sibling component with no shared ancestor holding drag state, and this fires on every pointer move, where re-rendering two whole columns costs far more than one attribute write. See [SectionStack.tsx](src/app/components/SectionStack.tsx).
- **The AI panel's close X was the odd one out.** Every other panel close is red at rest at `size-6` with a 13px glyph and rounded corners; this one was grey-until-hovered at `size-7` with an 11px glyph and square corners, having been missed by the sweep that unified the rest. See [AiMiniWindow.tsx](src/modules/ai/components/AiMiniWindow.tsx).

## [0.4.12] - 04-08-2026

### Added

- **A sidebar section moves between the columns by dragging it there.** Docking Workspaces or an extension's section into the right column, or bringing it back, meant finding the "Move to right panel" button in that section's header; the grip already dragged, but only within its own column. Dragging a section's grip across now hands it over. Which sections may go is read off the same condition that shows the move button, so the two routes cannot disagree, and the primary Files tree stays left-only: a right dock there collides with the Secondary Folder Tree extension that already lives in that column, and the placement store force-reverts it anyway. The two columns are separate drag contexts, so a drop is matched by POINTER position against the other column's box rather than by drag-and-drop collision, which still reports a neighbour in the column the drag started in. Dragging into an empty right column is not possible (it renders nothing to aim at); the move button still covers that. See [SectionStack.tsx](src/app/components/SectionStack.tsx), [sidebarPlacementStore.ts](src/modules/extensions/sidebarPlacementStore.ts).

### Fixed

- **A sidebar row's hover actions no longer print on top of its label.** In the API Client's tree, hovering a folder drew Run / Rename / Delete straight over the folder's name: the action cluster is absolutely positioned, which is what stops an unhovered row being indented by buttons it is not showing, but absolute also means it occupies no width. The badge and the loading spinner already dealt with this by fading out on hover; text cannot. The label now reserves the width the cluster will cover, sized from what it actually measures (`size-5` buttons, a 2px gap, pinned 4px from the edge) and stepped by how many actions the row has. See [ExtensionSidebarSection.tsx](src/modules/extensions/components/ExtensionSidebarSection.tsx).
- **Every icon button in a sidebar is one size, left column and right.** The box sizes already matched, but the glyphs inside them did not: eight header buttons carried an 11px or 12px icon where the standard is 13px (Refresh and Close in Files, Refresh and Close in Remote, Refresh / open-in-editor / Close in Source Control, and Close in the secondary folder tree). There are exactly two families now, a section-header button at `size-6` with a 13px glyph and a hover-revealed row action at `size-5` with 11px, and `scripts/connection-ux-verify.ts` holds both. See [ExplorerHeader.tsx](src/modules/explorer/components/ExplorerHeader.tsx), [PanelHeader.tsx](src/modules/scm/components/PanelHeader.tsx).
- **A sidebar row action no longer flashes the toolbar's accent on hover.** The rename and close buttons on a listed tab, and an extension sidebar row's actions, painted `TOOLBAR_HOVER`, which is a saturated `--accent` fill (`#0a2870` under the default dark theme). Every other icon button in a sidebar takes the ghost variant's muted hover, so those rows lit up solid blue while the header button beside them went grey. `TOOLBAR_HOVER` is a top-toolbar treatment and its nine remaining call sites are all toolbar or menu surfaces. See [WorkspacesPanel.tsx](src/modules/workspaces/WorkspacesPanel.tsx), [ExtensionSidebarSection.tsx](src/modules/extensions/components/ExtensionSidebarSection.tsx).
- **A panel's close X reads as a close button.** It was `text-muted-foreground` until hovered, which put it at the end of a header row among four or five other grey glyphs with nothing to distinguish it: the secondary folder tree's close was reported as missing when it was there all along. Every panel close is now red at rest across all eight surfaces (Files, Remote, Source Control in both its headers, Workspaces, an extension sidebar section, the right column's panel host, and the secondary folder tree), the same treatment the workspace and tab closes already use. See [toolbarButton.ts](src/lib/toolbarButton.ts), [FolderTreeShell.tsx](src/modules/extensions/components/FolderTreeShell.tsx).

## [0.4.11] - 04-08-2026

### Fixed

- **Sidebar row actions are one size, and the right column's panel header matches the left's.** The rename and close buttons on a tab listed in the Workspaces panel were `size-4` around a 10px glyph, tighter than every other hover-revealed row action in the app, so the hover box hugged the icon instead of reading as a button. They are now `size-5` around 11px, which is what the extension sidebar's row actions already used. The right column's panel header was the only section header on `size-7` with square corners; it is now `size-6` and rounded like every other one. See [WorkspacesPanel.tsx](src/modules/workspaces/WorkspacesPanel.tsx), [RightPanelHost.tsx](src/modules/extensions/components/RightPanelHost.tsx).
- **A comment in `globals.css` claimed a contrast guarantee it does not provide.** The `--tedi-button-border` fallback said 50% of the foreground clears the 3:1 floor on every surface. Measured across the presets it bottoms out at 2.08:1 on Kanagawa light's card. The value is unchanged, because the load-time repair added in 0.4.10 is what actually guarantees a visible control boundary and this declaration only covers first paint, but the comment no longer promises something it cannot keep. See [globals.css](src/styles/globals.css).

## [0.4.10] - 04-08-2026

### Added

- **A workspace and the tabs inside it close from the Workspaces panel.** The close button existed but read as absent, painted the same muted grey as everything else and only appearing on hover, and the tabs listed under a workspace could not be closed at all. Both are now red at rest and both confirm first. The rule for when a close is offered is the tab strip's own (`canClose = totalEntries > 1`), read from the same entry list the strip builds, so the panel can never offer a close the strip would refuse: one workspace and one tab always survive. A listed tab is closable only on the ACTIVE workspace, because an entry's ids address the live tab tree and no inactive workspace has one. The close routes through the same handler as the strip's X, so a busy terminal or an unsaved editor still gets its own prompt. See [WorkspacesPanel.tsx](src/modules/workspaces/WorkspacesPanel.tsx), [App.tsx](src/app/App.tsx).
- **The git branch glyph has a colour of its own.** It borrowed `--muted-foreground` in the Source Control header and the branch switcher, and `--tedi-icon-working` on the Source Control tab, which means "an agent is busy" and made a branch read as activity. A new `iconBranch` token paints it violet everywhere a branch NAME is shown, editable in Settings and shipped in a hue matched to each preset's own palette. The status bar deliberately keeps the monochrome glyph; that row is grey by design. See [globals.css](src/styles/globals.css), [colorFields.ts](src/settings/sections/theme/colorFields.ts).

### Changed

- **One glyph per action, everywhere including extensions.** The same action wore four different icons: rename was `SquarePen` in Settings, `Pencil` in the database tree, `FolderPen` on an Open Folder button; settings was a gear in one place and the sliders glyph in another. Rename is now `Pencil`, settings is the gear, and delete is `Trash2` painted red AT REST rather than only under the pointer, since a delete has to be findable and avoidable before you are on it. The legacy `Edit02Icon` / `PencilEdit02Icon` aliases were remapped too, or an extension installed before the Lucide migration would have kept drawing the old pen no matter how many components were fixed. `scripts/icon-consistency-verify.ts` holds the vocabulary. See [toolbarButton.ts](src/lib/toolbarButton.ts), [iconRegistry.ts](src/lib/iconRegistry.ts).
- **The secondary folder tree wears its controls on one row.** A panel that asks for no host header still needs somewhere for the section stack's drag grip and minimize chevron, and it got a slim rail of its own above the tree: two header rows where the primary explorer has one. The panel now renders a slot in its OWN header and the host portals the controls into it. A portal rather than a prop because the panel body is a second React root, where the drag listeners would lose their dnd-kit context and the chevron would stop tracking the collapsed state. The rail survives as the fallback for a panel that renders no slot, so none is ever left undraggable. See [RightPanelHost.tsx](src/modules/extensions/components/RightPanelHost.tsx), [FolderTreeShell.tsx](src/modules/extensions/components/FolderTreeShell.tsx).
- **`pnpm verify` finds its checks instead of listing them.** The script was a 1480-character chain of 38 `&&`-joined commands: adding a check meant editing one enormous line, and the chain stopped at the first failure, hiding the results of the other thirty-seven. It now globs `scripts/*-verify.ts`, reports every failure in one run, and takes a filter (`pnpm verify ssh`) for iterating on one check. See [verify-all.mjs](scripts/verify-all.mjs).

### Fixed

- **A saved theme could keep a button border you cannot see.** The presets were retuned in 0.4.9 to clear the 3:1 floor for a control boundary, and `theme-verify.ts` holds them there, but picking a preset SNAPSHOTS its colours into the saved theme. The retuned value is only a fallback for keys the payload is missing, and this one was present, so an install that had ever picked a theme kept its old hairline forever and every dialog's Cancel still read as bare text. Measured on a real install: `#3a3a3a` on a `#363636` popover is 1.06:1. The floor is now enforced where the payload is read, which is the one door both disk hydration and `.tedi` import come through, and the replacement is derived from the theme's own hue rather than snapped to a generic grey. Not enforced on write, where it would fight the colour picker mid-drag. See [buttonBorder.ts](src/modules/settings/buttonBorder.ts), [customTheme.ts](src/modules/settings/customTheme.ts).

## [0.4.9] - 04-08-2026

### Added

- **Saved SSH connections export and import as one encrypted file.** Moving to another machine meant retyping every host, port, user, jump chain and credential by hand, and there was no way to back them up at all. A `.tedi-ssh` file now carries the lot, encrypted with a passphrase you choose (PBKDF2 + AES-256-GCM). The crypto lives in Rust rather than the webview, because `crypto.subtle` is secure-context only and the app origin is plain http, so the browser API is simply unavailable here. `ring` was already in the tree as russh's crypto backend, so this promotes a transitive dependency to a direct one instead of adding supply-chain surface. See [backup.rs](src-tauri/src/modules/backup.rs), [backup.ts](src/modules/ssh/backup.ts), [SshBackupDialog.tsx](src/modules/ssh/SshBackupDialog.tsx).
- **An extension can open an SSH tunnel, so a database behind a bastion is reachable.** A helper that speaks TCP had no way to get through a jump host. Extensions may now ask for a forward by naming a **saved** connection id: credentials never cross the extension boundary, the host key must already be pinned or the request is refused, and the tunnel rides the existing session so a ProxyJump chain applies for free. Gated on the `ssh:connections` permission. SQL Explorer 0.5.0 is the first user. See [tunnel.ts](src/modules/ssh/tunnel.ts), [host.ts](src/modules/extensions/host.ts).
- **A dev server started over SSH opens locally by itself.** A remote shell printing `http://localhost:5173` was announcing a port on the far side of the connection, so clicking it reached nothing. TEDI now opens an ephemeral `-L` forward for that port and re-points the url at the local end before offering it. No new Rust was needed: the forward path already bound port 0 on request. See [forwardUrl.ts](src/modules/terminal/lib/forwardUrl.ts), [ssh-session.ts](src/modules/terminal/lib/ssh-session.ts).
- **The status bar shows the route a chained session actually took.** With ProxyJump the connection crosses hosts you never see; it now reads `[this PC] > bastion > prod-db`, one dot per hop, coloured by how far the handshake got, so a chain that dies names the host it died at. It rides on the existing status object rather than a store of its own, so no new plumbing. See [SshRoutePill.tsx](src/modules/ssh/SshRoutePill.tsx), [status.ts](src/modules/ssh/status.ts).
- **The Workspaces panel lists every tab, renames them, and shows each one's branch.** It listed only terminals, named them after their folder, and drew its own icons, so a renamed tab and an `ssh:<host>` pane both read wrong there while reading right in the tab strip. It now renders the tab strip's own entries: same name, same icon, same ordinal badge, same status colour, so a connected host is green in both places. Rows rename in place (double-click, or the pencil on hover) through the same handler the tab strip uses, and a terminal row carries the branch its working directory is on, read over that pane's own SSH session for a remote one. Nothing is shown outside a repository. See [WorkspacesPanel.tsx](src/modules/workspaces/WorkspacesPanel.tsx), [branch.ts](src/modules/scm/branch.ts).
- **A running agent shows its own logo.** Seven terminals each running a different CLI were seven identical terminal glyphs. A pane with an agent in it now carries that agent's vendor mark (Claude, Codex, Gemini, Grok, Copilot) in the tab strip, the pane header, the drag overlay and the Workspaces panel, still tinted by its idle/working/blocked status. The completion and approval toasts carry it too, so which of several agents wants you is answered by the glyph rather than by reading the sentence. See [LeafIcon.tsx](src/components/LeafIcon.tsx), [toast.tsx](src/components/ui/toast.tsx).
- **An extension's tree rows can open a context menu.** A row offered a couple of hover actions and nothing else, which is thin for a database schema or a file list. See [registries.ts](src/modules/extensions/registries.ts).

### Changed

- **One place decides what a pane is called.** The same label was derived independently in four files, and the Workspaces panel's copy knew about neither renames nor SSH. Adding a naming rule meant finding all four, and missing one showed the user two different names for one pane. There is now a single `leafLabel`, and the tab strip, the pane header, `tab.title` and the panel all read it. See [tabHelpers.ts](src/modules/tabs/lib/tabHelpers.ts), [entries.ts](src/modules/tabs/lib/entries.ts).
- **The AI context meter knows the newer model windows.** An OpenAI-compatible endpoint is selected as `instance::model`, and the window belongs to the raw model rather than the configured endpoint, so a correctly configured model still metered against the conservative fallback. Snapshot suffixes now resolve by family too. See [config.ts](src/modules/ai/config.ts).

### Fixed

- **Outline buttons had a border you could not see.** Cancel in a dialog was genuinely invisible: the fallback border resolved to `--border`, a hairline tuned to separate panels rather than to draw a control, landing at 1.06:1 against a dialog surface. All twenty preset variants failed the 3:1 floor for a control boundary. The fallback is now derived from the foreground so one declaration serves light, dark and glass, and `scripts/theme-verify.ts` holds the ratio. See [globals.css](src/styles/globals.css), [customTheme.ts](src/modules/settings/customTheme.ts).
- **Source Control could act on the wrong repository.** Focusing a tab that owns no pane (Settings, a diff, the Source Control tab itself) left the active pane null, and the panel silently fell back to the LOCAL repo while still showing a remote session's context, so a discard aimed at a remote file would have hit local ones. The resolution moved into a plain function with a `fromActiveLeaf` flag and a test, rather than staying inline where it could not be exercised. See [sshContext.ts](src/app/hooks/sshContext.ts).
- **`Cargo.lock` recorded a dependency the manifest had already declared.** `ring` was a direct dependency in `Cargo.toml` with no matching edge in the lock, which `cargo check --locked` in CI would eventually have rejected.

## [0.4.8] - 03-08-2026

### Added

- **SSH local port forwarding.** A saved connection can now declare `ssh -L` forwards: TEDI binds `127.0.0.1:<local>` and tunnels every connection to `<host>:<port>` as resolved from the server, so a database only reachable from inside the remote network becomes reachable from a local client. Because the tunnel rides the live session, a ProxyJump chain applies for free. A local port of 0 picks a free one and reports back what it bound. Forwards are declared on the connection and re-opened on every connect, so the session's own teardown is the only lifecycle they need. See [session.rs](src-tauri/src/modules/ssh/session.rs), [mod.rs](src-tauri/src/modules/ssh/mod.rs), [SshConnectionDialog.tsx](src/modules/ssh/SshConnectionDialog.tsx).
- **The AI tool card shows which lines an edit changed.** It said "1 replacement" and nothing about where, so the only way to see what moved was to open the diff tab. A card now reports the line each replacement landed on and its `+N -M` delta: one replacement shows its line inline, several get an aligned row each. The numbers are computed where the edit is applied, the only place that holds both the file text and the offset the replacement landed at, since the card cannot re-derive them once the result has travelled through the model's context. Write File deliberately reports a plain line count rather than a synthetic delta, because it replaces the whole file. See [lineStats.ts](src/modules/ai/lib/lineStats.ts), [edit.ts](src/modules/ai/tools/edit.ts), [tool.tsx](src/components/ai-elements/tool.tsx).

### Fixed

- **An open editor no longer shows stale text after the AI edits that file.** The edit landed on disk but the editor kept the old content until you closed the tab and reopened it. The only thing that triggered a reload was the ai-diff bridge, which fires when a diff tab flips to approved, and an auto-approved tool call carries no approval object at all, so no diff tab was ever opened and the reload never ran. There is no filesystem watcher either. The fix reuses the refresh signal every write site already dispatches, which until now broadcast only the parent directory and so could not say which file changed. Reload stays a silent no-op while the buffer is dirty, so unsaved edits are never clobbered, and remote leaves opt out because the AI's file tools are local-only. See [fsRefresh.ts](src/modules/explorer/lib/fsRefresh.ts), [EditorPane.tsx](src/modules/editor/EditorPane.tsx).
- **Vim mode shows a mode line.** With Vim mode on, the editor opened in normal mode with nothing on screen saying so: typing ran commands instead of inserting, backspace only moved the cursor, and Ctrl+S did nothing because the vim keymap is mounted at the highest precedence and swallowed it. Every one of those reads as a broken editor rather than a mode. The `-- INSERT --` / `-- NORMAL --` panel is now shown. See [EditorPane.tsx](src/modules/editor/EditorPane.tsx).
- **Keyboard focus returns to where you left it after Alt-Tab.** Switching away and back dropped DOM focus to the document body, so the caret that was in the AI prompt was gone and the next keystroke landed nowhere. TEDI now remembers the element that had focus when the window blurred and hands it back. It is deliberately element-based, so the AI prompt, a terminal and the editor are all covered without naming any of them. A deliberate click into a pane, or typing straight away, always wins over the restore. See [focusRestore.ts](src/lib/focusRestore.ts).
- **The Restore button names its unit.** A bare "2" beside an undo arrow read as a count of steps to undo rather than of files that would be reverted; it now says "2 files", matching the wording the tooltip already used. See [RestoreCheckpointButton.tsx](src/modules/ai/components/RestoreCheckpointButton.tsx).
- **The inline rename field is legible.** It selects its whole value on mount, and with no themed selection colour every rename opened as a solid slab of the OS highlight, with the tab's close button crowding the field and closing the very tab being renamed if you hit it. The selection is now a translucent primary and the close button hides while renaming. Fixed in the shared field, so the file explorer, the SSH explorer and the tab bar all stop showing the slab. See [InlineInput.tsx](src/modules/explorer/InlineInput.tsx), [renderEntryBody.tsx](src/modules/tabs/components/renderEntryBody.tsx).

## [0.4.7] - 03-08-2026

### Added

- **The right column stacks its panels instead of holding one at a time.** It could show exactly one of the AI panel, Source Control, Remote, a docked sidebar section or an extension panel, and opening any of them closed the rest, so "keep the AI open while I watch git" was not a thing you could ask for. Every surface there is now a resizable panel that minimizes to its header and drag-reorders by the grip in that header, with the order remembered per column. Both columns render through one shared stack, so the left sidebar's behaviour and the right column's are the same behaviour rather than two copies. See [SectionStack.tsx](src/app/components/SectionStack.tsx), [AppRightSlot.tsx](src/app/components/AppRightSlot.tsx), [rightPanelStore.ts](src/modules/extensions/rightPanelStore.ts).
- **Live clocks while the agent works, so a long turn cannot be mistaken for a freeze.** During a long tool call (an extension's HTTP request, a slow provider) nothing on screen moved: the chat's busy indicator was gated on the last message still being yours, so it disappeared the moment the assistant replied, which is exactly when tool calling starts. A running tool card now counts its own elapsed time, the chat keeps a running indicator for the whole turn, and the status bar shows a run clock while the AI panel is closed, which was the only place a background turn was invisible entirely. See [elapsed.ts](src/modules/ai/lib/elapsed.ts), [tool.tsx](src/components/ai-elements/tool.tsx), [AgentStatusPill.tsx](src/modules/ai/components/AgentStatusPill.tsx).
- **The status bar reads in three groups, and folds.** The right cluster was one undifferentiated run of a dozen glyphs; it now goes update prompt, then things you read (agent state, AI meters, Discord, Remote, scheduler), then things you click (actions first, panel toggles after), separated by hairlines. A toggle at the far right folds it down to the update prompt, the AI meters and the AI panel button. See [StatusBar.tsx](src/modules/statusbar/StatusBar.tsx).
- **An extension button can act instead of opening a panel.** A manifest panel may declare `kind: "action"`, which runs its `toggleCommand` and never slides the right slot out; a status item may declare `kind` to pick its status-bar group. Until now a button that just wanted to DO something had to intercept its own click in the capture phase to stop a panel appearing, and that broke whenever this markup moved. Screenshot 0.5.7 is the first user. See [manifest.ts](src/modules/extensions/manifest.ts), [registries.ts](src/modules/extensions/registries.ts).
- **An extension pane carries its own icon, and its reuse key is part of its identity.** A pane hosting an extension panel always drew the generic database glyph, and a panel that runs one instance per key opened its second key into the first pane, because the duplicate-mount guard matched on extension plus panel alone. The key travels to the float window too. API Client 0.4.3 uses both to give each collection its own pane. See [useAuxTabs.ts](src/modules/tabs/lib/useAuxTabs.ts), [LeafIcon.tsx](src/components/LeafIcon.tsx).

### Changed

- **An extension's code editor follows the editor pane's theme and font.** `ctx.ui.codeEditor` painted its own surface and a hardcoded 12px, so an extension's editor read as a different tool from the editor pane next to it. It now takes your mono font, editor font size and content zoom, and resolves the same editor theme. See [codeEditor.ts](src/modules/extensions/codeEditor.ts).
- **The tools picker keeps its count.** The on/off number vanished three ways: it was hidden whenever every tool was on, unknown until you had opened the picker once, and thrown away whenever the AI panel unmounted. It is now seeded on mount, cached across remounts and always shown. Each tool row also drops the OS tooltip for the app's own. See [ToolsPicker.tsx](src/modules/ai/components/ToolsPicker.tsx).
- **Settings drops the toast preview row** from General. It existed to check every toast variant by clicking rather than hunting for a git error to reproduce; the restyle is done and `scripts/toast-verify.ts` covers the variants. See [GeneralSection.tsx](src/settings/sections/GeneralSection.tsx).

### Fixed

- **The AI panel header is no longer flush against the panel edge, and holds up when the column is narrow.** The close button sat hard against the border. The header is also a container query now, so it drops what does not fit at the width you actually dragged the column to: the step label goes first, then the clock, and the buttons never shrink. The empty state gained a scroll container as well, since the panel now shares the column and its suggestion cards were bleeding over the composer. See [AiMiniWindow.tsx](src/modules/ai/components/AiMiniWindow.tsx).

## [0.4.6] - 03-08-2026

### Added

- **An extension's sidebar badge can carry a semantic tone.** The badge took the four generic `<Badge>` variants, so every category an extension wanted to mark rendered as the same grey chip: the API Client's request tree showed GET, POST and DELETE identically, on the one field you scan a tree for. `tone` now tints it from an existing theme token (`success` / `warning` / `error` / `info` / `primary` / `muted`), so a tinted badge follows the active theme and travels with an exported one. Deliberately no raw-colour escape hatch. See [registries.ts](src/modules/extensions/registries.ts), [ExtensionSidebarSection.tsx](src/modules/extensions/components/ExtensionSidebarSection.tsx).

### Changed

- **An extension editor's fold arrow is the editor pane's own chevron.** `ctx.ui.codeEditor` shipped CodeMirror's default text glyphs (`⌄` / `›`) while the editor pane draws an SVG chevron, so the same control looked like two different things depending on which pane you were in. The glyph moved into its own tiny module that both import, so they cannot drift apart again, and a collapsed marker now goes full strength here too. See [foldMarker.ts](src/modules/editor/lib/foldMarker.ts), [codeEditor.ts](src/modules/extensions/codeEditor.ts).

## [0.4.5] - 03-08-2026

### Added

- **Any extension panel can be floated into its own window.** The pop-out button on a pane header was limited to terminals, editors, browsers and tables; the API Client and SQL Explorer panes had no way out of the main window. An extension panel hands off the way an editor does, but by re-running its renderer: panel registries are per-webview, so the float window activates the extension in its own JS context and mounts the panel there while the main pane unmounts its copy. That makes two live copies against one `ctx.storage`, which is a contract panels have to handle, so both shipped panels now re-read on mount (guarded so a read in flight cannot overwrite a local save). See [floatProtocol.ts](src/modules/panes/floatProtocol.ts), [FloatApp.tsx](src/float/FloatApp.tsx), [PaneTreeView.tsx](src/modules/panes/PaneTreeView.tsx).
- **`ctx.ui.codeEditor` folds.** A fold gutter with visible chevrons, plus the fold keymap, so a JSON response or a JavaScript body in an extension pane collapses object by object and array by array. Languages whose parser reports no fold ranges (`plain`, the SQL stream modes) simply keep an empty gutter column. Works in a read-only editor, since a fold is state rather than a document change. See [codeEditor.ts](src/modules/extensions/codeEditor.ts).

### Fixed

- **Selecting text in an extension's code editor made it unreadable.** CodeMirror's own base theme styles the drawn selection through a five-class selector, and this editor is not tagged dark, so its LIGHT default (`#d7d4f0`) beat the theme rule and painted an opaque pale block over dark-theme text. It now carries the same rule the main editor pane does. See [codeEditor.ts](src/modules/extensions/codeEditor.ts).
- **A delete action in an extension's sidebar section was grey until you hovered it.** A destructive affordance has to be findable, and avoidable, before the pointer lands on it. Both the row and the header variants are red at rest now. See [ExtensionSidebarSection.tsx](src/modules/extensions/components/ExtensionSidebarSection.tsx).

## [0.4.4] - 02-08-2026

### Fixed

- **A toast raised from the Settings window or a floated editor went nowhere.** Toast listeners are per-webview, and only the main window rendered a `<Toaster/>`. Every extension install, update and error toast in Settings, and every "Format failed" from a floated editor, was fired into a window with nothing listening. Both render one now. See [SettingsApp.tsx](src/settings/SettingsApp.tsx), [FloatApp.tsx](src/float/FloatApp.tsx).
- **An extension's status-item meter ignored the theme.** The three severities were hard-coded emerald / amber / red, so an AI-usage meter sat at those colours in a warm or monochrome preset while everything around it did not. They ride the theme's status triad now (`icon-idle` / `icon-working` / `icon-blocked`), the same tokens the AI CLI badge already used, which is why the error tone alone happened to look right. See [ExtensionStatusItems.tsx](src/modules/extensions/components/ExtensionStatusItems.tsx).
- **Two theme tokens were written by every preset and read by nothing.** `--tedi-button-border` is what the outline Button paints its border with now, so the "Button border" control in Settings finally does something, and `--tedi-icon-done` is themable instead of a fixed hue. See [button.tsx](src/components/ui/button.tsx), [customTheme.ts](src/modules/settings/customTheme.ts).

### Changed

- **Toasts restyled.** Sharp corners, because this app sets `--radius` to 0 and a pill toast was the only rounded thing on screen; a drain bar that runs the toast's own duration and freezes on hover in step with the dismiss timer; tone colours from the theme. See [toast.tsx](src/components/ui/toast.tsx).
- **The theme presets are a folder, not a 988-line file.** One module per family (base, catppuccin, kanagawa, matrix, monokai, nebula, nord, solarized, tokyoNight) behind an index, so adding a preset touches one small file. A single preset entry still covers app chrome *and* the terminal: the terminal palette is derived off the dark variant and keyed by slug, so a preset can never ship a themed window with an unthemed terminal. See [themePresets/](src/modules/settings/themePresets/).
- **The branch / tag / HEAD chips are shared between the commit graph and the commit detail pane.** `GitGraphView` owned them privately, so the detail pane could not show them without a second copy. See [RefBadge.tsx](src/modules/scm/components/RefBadge.tsx).

### Added

- **A Nebula theme preset.**
- **`pnpm verify` gained two guards.** `theme-verify` checks both directions of the token contract: every preset defines every token the app reads, and every token the app reads is defined by every preset. `toast-verify` checks that every window able to raise a toast mounts a `Toaster`, and that the drain bar and the dismiss timer read the same duration. See [theme-verify.ts](scripts/theme-verify.ts), [toast-verify.ts](scripts/toast-verify.ts).

## [0.4.3] - 02-08-2026

### Fixed

- **An extension that asked for an icon by a name Lucide does not have crashed the call instead of warning.** `ctx.ui.icon` resolves a name and, when the lucide chunk has not landed yet, subscribes to retry once it does. An UNKNOWN name takes that same branch, and by then the chunk is usually cached, so `onIconsReady` ran the callback immediately, inside the `const unsub = ...` it was declared by. The callback's own `unsub()` therefore hit the temporal dead zone and threw `ReferenceError: Cannot access 'unsub' before initialization`, which surfaced as a failed render rather than the intended "unknown icon" console warning. Hoisted to `let`, so a bad name now degrades to a warning and an empty span the way it was meant to. Any extension could hit this; it took one wrong icon name to find. See [host.ts](src/modules/extensions/host.ts).
- **`ctx.ui.codeEditor` advertised a `json` language and gave you plain text.** The type accepted `json`, the switch returned no language extension at all, and the code comment said to switch to `lang-json` if you wanted real parsing. `@codemirror/lang-json` was already a dependency. It is wired up now, and `javascript` joins it from `@codemirror/lang-javascript`, also already present, so an extension that hosts a request body or a user script gets real highlighting. Additive: a host that predates a language falls back to plain text, so an extension can opt in without raising `engines.tedi`. See [codeEditor.ts](src/modules/extensions/codeEditor.ts).

### Changed

- **The selected tab is now the brand accent surface everywhere, not just in the workspace tab bar.** The tab bar already painted its active entry `bg-accent` / `text-accent-foreground`; the shared `Tabs` primitive did not, so the Settings window, the Debug window and the Source Control panel used its default instead. In dark mode that default was `bg-input/30` sitting on a `bg-muted/40` track: two greys one step apart, which meant you had to hunt across eight Settings tabs for the one you were on. All four surfaces now agree. See [tabs.tsx](src/components/ui/tabs.tsx).

### Added

- **[API Client](https://github.com/IlhamriSKY/TEDI.api-client)**, a Postman-style API workbench, joins the reference extensions. It runs entirely on the host's `http_stream` command, so it ships no sidecar binary: collections that own their own variables and environments, eight verbs plus custom ones, path and query parameters, Bearer / Basic / API-key / OAuth 2.0 auth, every body mode, pre-request and test scripts with a `pm` shim, a collection runner, generated Markdown and OpenAPI docs, and Postman / OpenAPI / cURL import-export. Documented in [TEDI.md](TEDI.md) and the [extension author guide](extensions/README.md).

## [0.4.2] - 01-08-2026

### Fixed

- **Resizing a terminal pane no longer shreds what is running in it.** Drag a splitter, or make the window bigger, and a running Claude Code or Codex would come back as soup: a box drawn across the wrong rows, input that looked dead because the line you were typing was being redrawn off screen. It read as the CLI breaking, and it was not. TEDI never told its terminal it was talking to Windows ConPTY, so the terminal used the rules for a Unix shell instead. The two disagree on exactly one thing, and it is the thing that was going wrong: when the terminal gets taller, the Unix rule pulls old scrollback back down into view, because a Unix shell does not redraw itself when it is resized. ConPTY does redraw, over the whole visible area. So the old lines that were just dragged in survive wherever the redraw does not cover them, and the cursor ends up on a different row than the shell believes. Anything that draws relative to the cursor, which is what both of those CLIs do in their normal mode, then puts every frame after that in the wrong place. Measured on a five-row terminal grown to eight: before, the cursor moved three rows away from where the shell left it; now it stays. A full-screen program on the alternate screen (vim, htop, lazygit) is provably untouched by this, in every direction, because that screen has no scrollback for the old rule to pull from; column rewrapping is unchanged too. One thing does look different on Windows: making a pane taller now adds blank rows rather than pulling history back into view, which is what ConPTY has always meant by it and what Windows Terminal shows. SSH panes are unaffected, since that shell really is on a Unix machine. See [session-helpers.ts](src/modules/terminal/lib/session-helpers.ts), [terminal-resize-verify.ts](scripts/terminal-resize-verify.ts).
- **A CLI that draws its own screen now hears about a resize while you are still dragging.** TEDI held the new size back for 90ms after the last movement, which is right for a bare shell prompt that would otherwise flicker, and wrong for anything painting a full frame. It told them apart by asking whether the program had taken over the screen, but Claude Code and Codex draw their frames inline on the ordinary screen instead, so they fell on the quiet side and only found out once you let go. They now get the size as the drag happens, at the same rate a full-screen program already did. See [session-lifecycle.ts](src/modules/terminal/lib/session-lifecycle.ts).
- **A repaint nudge no longer leaves the shell wrapping at a width the pane does not have.** To make a program redraw, TEDI briefly changes the terminal height and puts it back a moment later. It was putting back the height it had measured before that pause, so if the pane changed size during it, by switching tabs or changing the font size, the shell was left at the old width with TEDI believing it had been told the new one, and nothing was left to correct it. It now reads the size at the moment it restores. See [pty-lifecycle.ts](src/modules/terminal/lib/pty-lifecycle.ts).
- **A terminal popped out into its own window follows the same rules as the pane.** The float builds a second terminal over the same output and is resized by the pane it mirrors, so it had the same problem for the same reason. It could not tell a local shell from an SSH one on its own, so the pane now tells it. See [FloatTerminal.tsx](src/float/FloatTerminal.tsx).

### Changed

- **The tool picker and the debug button moved to the top of the AI panel.** The row under the message box was carrying four controls; the two that are not about the message you are writing now sit in the panel header. The tool list also opens collapsed, one row per server with its own on/off count, so several MCP servers read as a short list of headings rather than every tool at once, and each tool is now a single line with its description trailing beside the name. See [AiMiniWindow.tsx](src/modules/ai/components/AiMiniWindow.tsx), [ToolsPicker.tsx](src/modules/ai/components/ToolsPicker.tsx).

## [0.4.1] - 31-07-2026

### Added

- **Chat mode, for the turns that are only conversation.** Saying "hi" was priced like asking for a refactor. Every message carries the agent's instructions and the description of all 77 tools it can reach for, and that fixed weight is about 12,800 tokens before a single word of yours is counted; the greeting itself is two characters. The switch is in the agent chip under the message box, and while it is on TEDI sends a one-paragraph instruction and no tools at all, which takes the same greeting to roughly 79 tokens. Nothing is loaded to be thrown away either: the project notes, the saved memory, the installed skills and the MCP servers are all skipped, so no server is started for a turn that could not have called it. What you wrote in Settings stays: your custom instructions and the selected agent's own instructions still go, because you wrote those and quietly dropping them would be a surprise rather than a saving. The text of the one-paragraph instruction is editable in **Settings -> Agents -> System prompts**. Turning it on part-way through a conversation is safe: earlier tool calls are stripped from what gets sent, which some providers reject outright when no tools are offered alongside them. See [agent.ts](src/modules/ai/lib/agent.ts), [transport.ts](src/modules/ai/lib/transport.ts), [compact.ts](src/modules/ai/lib/compact.ts).
- **Every tool has a checkbox.** The wrench beside the agent chip lists everything the AI can reach for, grouped and searchable, and each one can be switched off: the browser controls, the terminal and shell tools, file reading and editing, search, sub-agents, and equally every tool from an MCP server you added or an extension you installed. Each server gets its own group, so a single tool can be turned off without turning off the server. What is unticked is removed at the one point where the built-in, MCP and extension tools have already been merged, so a tool cannot be off in the list and still reach the model by another route. The list is read from the live session, which means it can only ever show what would actually be sent. Preferences record what is switched *off*, so a tool that arrives with a future update, or with the next MCP server you add, is available immediately rather than missing until you go looking for it. See [ToolsPicker.tsx](src/modules/ai/components/ToolsPicker.tsx), [catalog.ts](src/modules/ai/tools/catalog.ts).

### Fixed

- **The prompt cache now survives past the first reply.** Providers charge much less for a prompt they have already seen, but only for the part that is byte-for-byte identical to last time, and only up to the first thing that differs. TEDI prefixes each message you send with a short block describing your workspace: the folder, the open terminals, the browser panes. That block was added to the newest message on its way out and was not kept, so on the following turn the very same message went back one block shorter than it had gone the first time. The point of difference therefore sat at your previous message and crept forward with the conversation, and everything after it, including every file the AI had read that turn, was charged at full price again on every subsequent turn. In practice nothing beyond the opening instructions was ever reused. Each message now goes with exactly the block it was first sent with, so a turn pays for its own new content and nothing else. This is not specific to one provider: it is what both the explicit cache markers and the automatic ones all key on. The cost is a small stale block per past turn, against re-sending the entire conversation each time. See [envContext.ts](src/modules/ai/lib/envContext.ts), [prompt-cache-verify.ts](scripts/prompt-cache-verify.ts).
- **A reseller endpoint that does cache is no longer treated as one that does not.** TEDI assumes a third-party gateway has no prompt cache, because what sits behind one is anybody's guess and expecting a discount that is not there is the expensive mistake. That assumption is not free: on such an endpoint TEDI rewrites the conversation between steps to keep it small, and rewriting an earlier message is precisely what throws away a cache the gateway did keep. Those endpoints already report how much of a request was served from cache, so the guess is now dropped the moment that report disagrees: one real cache hit and TEDI stops rewriting for that endpoint and lets the prefix stand. The change is one-way, so a single miss on a cold prefix cannot flip it back and restart the rewriting that caused the miss. See [cache.ts](src/modules/ai/lib/cache.ts).

## [0.4.0] - 31-07-2026

### Added

- **AgentRouter is a provider you pick, instead of an address you guess at.** Adding it as an OpenAI-compatible endpoint could never work, and the address was never the reason it failed. AgentRouter resells access to Claude Code and Codex, and it checks *which program is asking*: a request that does not announce itself as one of those is turned away with the same "unauthorised" answer an expired key gives, so the obvious conclusion is that the key is wrong. It is not. Changing nothing but that announcement is enough to prove it, with one key listing the entire catalogue under one name and being refused under another. A hand-configured endpoint cannot get past that check, because the browser engine TEDI's interface runs in does not allow a page to set that field at all, and drops it in silence rather than reporting it, so the request leaves unidentified no matter what is typed into Settings. AgentRouter is therefore sent through TEDI's own network layer rather than the browser's, which is the only path where the field survives. Pick it in **Settings -> Models -> Add provider**, paste the key, and its catalogue is detected the way SumoPod's already is. Detection deliberately makes the very same request a real message does, so a catalogue that loads is evidence that chat will work rather than merely evidence that the host is reachable. See [agentrouter.ts](src/modules/ai/lib/agentrouter.ts), [httpProxy.ts](src/modules/ai/lib/httpProxy.ts), [config.ts](src/modules/ai/config.ts), [agentrouter-verify.ts](scripts/agentrouter-verify.ts).

## [0.3.99] - 31-07-2026

### Added

- **Browser extensions install straight from the Chrome Web Store or Edge Add-ons.** Paste the listing page link, or just the extension id, and TEDI fetches the extension from the same update endpoint the browser itself uses. Until now that link was treated as an ordinary download, so it pulled the listing *page* and failed with "not a zip", which reads as the installer being broken rather than as the wrong kind of link. The two stores do not always carry the same build of the same extension, so whichever listing is pasted is the one installed. See [browser_ext.rs](src-tauri/src/modules/preview/browser_ext.rs).
- **An extension that publishes its settings page can now have it opened, and one that does not no longer pretends otherwise.** A browser reaches an extension's settings through its toolbar popup, which a browser pane has nowhere to display, so opening the page directly is the only route left. Where the extension has published that page, a settings button now opens it; the address needs the id the engine assigned the extension, which is derived from the folder it was loaded from and cannot be worked out from this side, so it is asked of the engine directly. Where it has not, no button appears, because such a page renders blank rather than failing and a button that opens nothing is worse than none. That matters more than it sounds: several ad blockers keep their stronger filtering behind exactly such a page, so it cannot be switched on from here. The same answer from the engine also gives an honest "is this actually running", and an extension that is installed but was never loaded now says so instead of looking fine. See [embed.rs](src-tauri/src/modules/preview/embed.rs).
- **The extensions menu opens the Chrome Web Store, and offers to install whatever listing you are looking at.** A button goes to the store, and once the pane is on a listing the menu offers that extension directly, the way a browser's own "Add to Chrome" button does. It replaces a paragraph of explanation with the two actions the paragraph was describing. Anchored to the three real store hosts, so no ordinary page can produce that offer by shaping its address like a listing. See [extensions.ts](src/modules/browser/lib/extensions.ts), [browser-store-verify.ts](scripts/browser-store-verify.ts).
- **Browser extensions have a button in the browser toolbar.** The puzzle-piece button next to the address bar lists what is installed, switches each one on or off, removes them, and installs a new one from a GitHub `owner/repo`, a link to a `.zip` or `.crx`, or a file on disk. Nothing about it is specific to ad blocking or to any other category: it installs *an extension* and knows nothing about what any of them do. Everything here also lives in **Settings -> Extensions**, on a card with room to explain it; the toolbar is simply where anyone looking for an ad blocker looks first, and a feature nobody can find is a feature nobody has. Windows only, so the button is absent on the platforms whose engines cannot load extensions. See [BrowserExtensionsMenu.tsx](src/modules/browser/BrowserExtensionsMenu.tsx).
- **An extension install shows what it is doing.** Downloading and unpacking each get their own labelled bar with real byte counts, because for a store ad blocker both take minutes: AdBlock is 77 MB to fetch and then 337 MB to write to disk. One undifferentiated spinner sat still twice over and read as a hang. See [browser_ext.rs](src-tauri/src/modules/preview/browser_ext.rs), [extensions.ts](src/modules/browser/lib/extensions.ts).

### Fixed

- **A terminal pane you cannot see no longer holds on to the graphics card.** An inactive tab keeps its terminal mounted but hidden, and each one was still holding a live hardware-accelerated renderer and its glyph cache for as long as TEDI ran. The memory was the lesser half: the browser engine allows only about sixteen of those at once, so past that point panes start evicting each other, and an evicted one falls back to the slower renderer permanently. That is the "it got sluggish and stayed sluggish" complaint, and it lands on the panes you are actually looking at. A hidden pane now hands its renderer back and takes it again on the way in, and a restored-but-hidden tab never grabs one on the way up. See [webgl.ts](src/modules/terminal/lib/webgl.ts).
- **An AI endpoint that answers with a web page instead of an API says so.** A base URL missing its `/v1` is answered by the gateway's own website, and the worst shape of that returns a normal-looking success with the landing page in it. The reply parser then found nothing to read and the whole turn ended empty, with no error anywhere to explain it. Such a response is now refused with a message naming the endpoint and the fix. Test Endpoint agreed it was fine too, because it only read a status code, which cannot tell an API from a website; it now makes the same request a real message does, under a timeout so a host that connects and then goes quiet cannot leave it spinning. See [httpProxy.ts](src/modules/ai/lib/httpProxy.ts), [OpenAICompatibleBlock.tsx](src/settings/sections/components/OpenAICompatibleBlock.tsx).
- **One unreadable folder no longer stops every extension after it from loading.** The browser engine walks the extensions folder and gives up at the first entry it rejects, in name order, silently. Removing an extension while a browser tab is open can leave an empty folder behind, because the engine still holds it, and that leftover was enough to stop the extensions sorted after it from ever loading. Empty leftovers are now cleared before the folder is handed over. See [browser_ext.rs](src-tauri/src/modules/preview/browser_ext.rs).
- **A menu opened over a browser pane no longer takes the page away with it.** Opening anything on top of a browser pane - a dropdown, a dialog, the new extensions menu - blanked the whole page for as long as it stayed open, which looks less like a menu opening than like the page crashing. A pane is a real browser surface layered over the interface rather than drawn into it, so until now the only way to show something on top of it was to take the page away. On Windows the pane is now cut to its own shape minus the menu instead: the page stays on screen, keeps playing and keeps its scroll position, the menu sits in the gap, and clicks in that gap reach the menu rather than the page. Tooltips gain from the same change and were the worse half of the old trade-off, since counting them would have flashed the page away on every hover, so they were ignored and rendered *behind* the page instead, i.e. not at all. macOS and Linux keep the old behaviour, where the pane is a different kind of surface and no such shape can be cut. See [embed.rs](src-tauri/src/modules/preview/embed.rs), [overlaySuppress.ts](src/modules/browser/lib/overlaySuppress.ts).

- **An installed extension now says On or Off in words, not only as a switch position.** A freshly installed extension is already enabled, so the obvious next move - pressing the switch to "turn it on" - silently turned it off instead. Nothing blocked anything afterwards, and nothing said why. See [BrowserExtensionsMenu.tsx](src/modules/browser/BrowserExtensionsMenu.tsx).

- **Source Control no longer re-reads every untracked file on each refresh.** Git can say how many lines changed in a file it already tracks, but not in one it has never seen, so TEDI opened and read each untracked file itself to put the `+12` beside it. Each read was capped at 512 KB, the number of them was not, and the panel refreshes on a timer - so a folder full of untracked files, a build output not yet added to `.gitignore` for instance, got read start to finish every few seconds. Past five hundred untracked entries the count is now left off; the file is still listed, and the skip is written to the log instead of just happening. See [commands.rs](src-tauri/src/modules/git/commands.rs).
- **Memory TEDI has finished with is handed back to Windows.** Freed memory was being kept by the process rather than returned, so the longer TEDI ran the more it had reserved, and reserved memory counts against the system-wide limit on how much all programs together may claim even while nothing is using it. Measured on its own: a burst of just over a gigabyte, allocated, written to and then fully released, left every last megabyte of it still reserved. The memory manager brought in for exactly this in 0.3.76 was returning none of it. TEDI now asks for it back every thirty seconds, which recovers 99.8% of such a burst, on its own thread so nothing on screen ever waits for the sweep. See [lib.rs](src-tauri/src/lib.rs).
- **Returning from the lock screen asks each panel to refresh once instead of twice.** Windows delivers a return to the desktop as two separate signals a few milliseconds apart, and every panel that reloads on return was listening for both, so unlocking started two rounds of directory listing, two of git status and two of remote listing at the same moment. That is the worst moment to ask for it twice, since nothing has been read from disk for the length of the lock. A refresh you triggered yourself still runs immediately. See [windowResume.ts](src/lib/windowResume.ts).
- **Coming back to a locked machine no longer finds TEDI unresponsive.** Listing a folder was a synchronous backend call, and on Windows those run on the very thread that draws the window, so nothing else happens while one is in flight. Listing costs one filesystem query per entry, and the file explorer refreshes every open folder both when the window regains focus and when it becomes visible again - an unlock fires both. So one unlock meant two passes over every expanded folder, one after another, against a disk cache gone cold for the length of the lock. On the four-second refresh during normal use the same work is unnoticeable; only that cold doubled pass ran long enough for Windows to call the app hung. Folder listing, path resolution, and file and folder creation and rename now run off that thread, as copy and delete already did. Three calls sitting in the same place went with them: writing to an MCP server, which could park TEDI for as long as that server stopped reading its input, and the two background process launchers. See [tree.rs](src-tauri/src/modules/fs/tree.rs), [mcp.rs](src-tauri/src/modules/mcp.rs), [shell/mod.rs](src-tauri/src/modules/shell/mod.rs).
- **The mainstream ad blockers are no longer refused for being too big.** Installing AdBlock or Adblock Plus stopped with "file too large", and raising that one number would only have moved the failure two steps later. Three limits were all sized against the wrong evidence: the blockers that install from a GitHub release are small (uBlock Origin is 4.2 MB, uBlock Origin Lite 9.3 MB), but the store versions carry their whole rule set inside the package, so AdBlock is 77 MB compressed and 337 MB unpacked. The download ceiling, the unpacked ceiling and the one-minute request deadline all fell short, and the deadline in particular was inherited from a helper written to fetch files a thousand times smaller. All three now match what real extensions weigh, and the Install button says what it is doing rather than showing an ellipsis for the minutes such a download takes. See [browser_ext.rs](src-tauri/src/modules/preview/browser_ext.rs), [github.rs](src-tauri/src/modules/extensions/github.rs).
- **A browser pane popped out into its own window no longer paints its page over the main window.** The pop-out window came up empty while the page appeared behind it, spread across TEDI's own interface at the size of the window that was supposed to contain it. A browser pane is a real native webview positioned over a rectangle, and that rectangle is measured relative to whichever window owns the webview, but the create path always attached it to the main window and the reposition path never checked which window was asking. So the floating window's coordinates were applied inside the main one. The webview is now attached to, and moved into, whoever is driving it, before any rectangle is applied. See [embed.rs](src-tauri/src/modules/preview/embed.rs), [FloatApp.tsx](src/float/FloatApp.tsx).

## [0.3.98] - 30-07-2026

### Added

- **The browser pane runs Chrome and Edge extensions, so an ad blocker is yours to choose.** Rather than TEDI shipping a blocker and maintaining its filter lists, you install the one you already trust and it keeps its own lists current. **Settings -> Extensions -> Browser extensions** installs from a GitHub `owner/repo`, from a direct link to a `.zip` or `.crx`, or from a file already on disk, with an on/off switch and a Remove per extension. Nothing about it is specific to blocking: any unpacked extension installs through the same field. Three things worth knowing. Browser tabs move to their own webview profile once the first extension is installed, which is what keeps an extension out of TEDI's own window, and it also means sites you were signed into in a browser tab will ask again. Extension popups and toolbar buttons have nowhere to appear inside a webview, so open an extension's own dashboard page in a browser tab to configure it. Windows only: macOS cannot load extensions at all, and on Linux the equivalent setting wants compiled WebKitGTK plugins rather than Chrome extensions, so the card explains that instead of offering a field that would do nothing. See [browser_ext.rs](src-tauri/src/modules/preview/browser_ext.rs), [BrowserExtensionsCard.tsx](src/settings/sections/components/BrowserExtensionsCard.tsx).
- **A browser pane pops out into its own window, the way a terminal already could.** The page is not reloaded to get there: the same webview is moved into the float window, so the scroll position, signed-in sessions and anything playing all survive the trip, and closing the window hands it back. While it is popped out the tab keeps tracking wherever you browse, so its title and the address the AI sees stay current. See [FloatApp.tsx](src/float/FloatApp.tsx), [embed.rs](src-tauri/src/modules/preview/embed.rs).
- **Zoom and stop, in the browser toolbar.** Zoom out and zoom in, with the current level shown between them once it leaves 100% and clicking it resetting to 100%; `Ctrl` with plus, minus or the scroll wheel works as well. The level is read back from the page rather than assumed, so it stays honest after the keyboard changed it. The reload button becomes a stop button while a page is loading, so a page that hangs can be cancelled instead of spun on, and the AI's Control Browser gained the same `stop`. On a narrow pane the zoom controls step aside rather than squeeze the address field. See [BrowserAddressBar.tsx](src/modules/browser/BrowserAddressBar.tsx).
- **TEDI appears in Explorer's "Open with" submenu on Windows.** Two different mechanisms are easy to conflate here: the shell verbs shipped through 0.3.97 put a top-level "Open with TEDI" line on the context menu, but Explorer builds its **Open with >** submenu from a separate registration, so TEDI was missing from that submenu even while its own line sat on the same menu. Registered the way VS Code does it, and removed on uninstall. See [installer.nsh](src-tauri/installer.nsh).
- **A model id can be typed by hand for an OpenAI-compatible endpoint.** The endpoint was only usable if its `GET /models` catalogue could be read, and plenty of gateways cannot be read that way: some never implement it, and some serve `/chat/completions` while refusing the catalogue. Their own documentation then hands you a model id and expects you to enter it, which is what Cline and Cursor allow. Until now such an endpoint saved cleanly, detected nothing, and could not be selected, which reads as not being addable at all even when the URL and key were right. Hand-typed ids are stored on the endpoint, restored before detection runs on the next launch, and merged with whatever detection finds rather than replaced by it. See [OpenAICompatibleBlock.tsx](src/settings/sections/components/OpenAICompatibleBlock.tsx), [openaiCompatible.ts](src/modules/ai/lib/openaiCompatible.ts).
- **Rename a tab from its right-click menu.** A tab is no longer stuck with the name of the folder it opened in. It works on terminal, editor, browser and extension panes, reads the same in the pane header as in the tab strip, survives a restart, and **Reset Name** puts the derived name back. See [renderEntryBody.tsx](src/modules/tabs/components/renderEntryBody.tsx), [panes.ts](src/modules/terminal/lib/panes.ts).

### Fixed

- **Programs launched from the Linux AppImage build no longer load the wrong system libraries.** The AppImage runtime points `LD_LIBRARY_PATH` at its own bundled library directory, and every process TEDI spawned inherited it, so a system program resolved its dependencies against TEDI's libraries instead of the distribution's. It failed as an undefined symbol rather than as anything naming the cause: PHP loading `curl.so` against a bundled `libcurl.so.4` is the reported case. The variable is now stripped from shell commands, background processes, external formatters, PTY sessions, MCP servers and the system `git`, and deliberately left alone where the child process is TEDI itself, since the PTY daemon and the updater need those bundled libraries to load at all. Contributed in [#12](https://github.com/IlhamriSKY/TEDI/pull/12) by [@rendi-febrian](https://github.com/rendi-febrian), extended here to cover `git`, which is the most exposed of the set because it links libcurl for https. See [appimage.rs](src-tauri/src/modules/appimage.rs), [commands.rs](src-tauri/src/modules/git/commands.rs).
- **Opening a file with TEDI no longer spawns a stray terminal beside it.** "Open with TEDI" on a file produced the editor tab plus an unasked-for shell. The workspace root was already being adopted from the file's parent, and the editor tab appends itself, so there was never a terminal to attach to. Every other file-open path, an explorer click, a drag and drop, `OSC 8889`, the New File dialog, behaved correctly already. See [useWorkspaceRoot.ts](src/app/hooks/useWorkspaceRoot.ts).
- **A base URL that serves a web page instead of an API says so.** Leaving `/v1` off the end of a gateway's base URL makes the catalogue request return that site's front page, and the failure surfaced as `Unexpected token '<'`, which names the symptom and not the cause. It now says the URL returned a web page and points at the base URL. See [openaiCompatible.ts](src/modules/ai/lib/openaiCompatible.ts).
- **Extension downloads re-check every redirect hop.** Both installers, TEDI's own extensions and the new browser ones, refuse cloud-metadata and link-local addresses, but only vetted the URL they were handed: a public URL that redirected into that address range was followed anyway. The block is now re-applied on each hop. See [github.rs](src-tauri/src/modules/extensions/github.rs).

## [0.3.97] - 30-07-2026

### Added

- **The About panel links to the TEDI website.** Build details listed both source repositories but never the project site itself. See [AboutSection.tsx](src/settings/sections/AboutSection.tsx).

### Changed

- **The terminal AI agent roster moved to General.** The roster decides which CLIs the tab strip's `+` menu can launch, which is terminal configuration; the Agents tab is about the in-app AI instead, its personas, sub-agents, skills and MCP servers. It now sits in **General → Terminal** next to the other terminal settings, collapsed behind an accordion so a dozen agent rows no longer dominate the page, with the agent count on the collapsed row. See [CliAgentsCard.tsx](src/settings/sections/components/CliAgentsCard.tsx), [GeneralSection.tsx](src/settings/sections/GeneralSection.tsx).

### Fixed

- **Pasting into a terminal works on Linux.** Copy worked and paste did nothing, on every Linux desktop, with nothing in the log to explain it. The webview's clipboard read can never succeed here: the underlying WebKitGTK flag that permits it is only set when the webview is built with clipboard access enabled, Tauri leaves that off by default, and there is no configuration knob to turn it on for a window declared the way TEDI's is. Writes were unaffected because they ride the keystroke itself, which is exactly why only paste appeared broken. The clipboard is now read in TEDI's own process rather than the webview, on all three platforms, so there is one path to reason about. Three places were broken rather than the one reported: the paste shortcut (`Ctrl+Shift+V` and `Shift+Insert`), right-click paste in a terminal, and the editor's context-menu paste. Reported in [#10](https://github.com/IlhamriSKY/TEDI/issues/10). See [clipboard.rs](src-tauri/src/modules/clipboard.rs), [clipboard.ts](src/lib/clipboard.ts).
- **Borders are visible again on dark dialogs and menus.** Dialogs, dropdowns, context menus, popovers, tooltips and the command palette paint a surface that in dark mode sits a hair lighter than the border colour, so every bordered child on top of it disappeared: an outline button read as an invisible Cancel, inputs lost their box, separators vanished. The colours were tuned against the app canvas rather than against chrome stacked on top of it, and are now re-scoped on the elevated surface itself. See [globals.css](src/styles/globals.css).
- **A browser pane the AI opens in the background keeps loading on macOS.** Such a pane is parked off-screen so it can be read without stealing the foreground, and macOS suspends a webview that is not in a window, so the read came back empty. Favicon fetching also stops at `</head>` to avoid pulling a multi-megabyte body, but missed the tag whenever it straddled two chunks of the response and downloaded everything anyway. See [embed.rs](src-tauri/src/modules/preview/embed.rs).

## [0.3.96] - 29-07-2026

### Added

- **"Open with TEDI" in your file manager, on all three platforms.** Right-click a folder or a file and TEDI opens it, exactly the way `tedi <path>` does, forwarded to the running window if one is already up. Windows registers folders, drives, folder backgrounds and files (Windows 11 puts classic verbs under **Show more options**, the same limit VS Code's "Open with Code" lives with) and removes them on uninstall. macOS adds **Open With → TEDI** plus dropping a folder on the Dock icon, registered as an alternate handler so it never takes over your default app. Linux `.deb` and `.rpm` add the entry to Nautilus, Dolphin, Thunar and Nemo. Dragging a path onto TEDI now routes through the same classifier, so a folder becomes a terminal tab, a file becomes an editor tab, and a dangling path is ignored instead of opening an editor onto something unreadable. See [installer.nsh](src-tauri/installer.nsh), [Info.plist](src-tauri/Info.plist), [tedi.desktop](src-tauri/tedi.desktop), [cli.rs](src-tauri/src/modules/cli.rs), [useEditorFileDrop.ts](src/app/hooks/useEditorFileDrop.ts).
- **Start a CLI agent straight from the `+` menu.** The menu's Editor entry becomes **Agent...**, a card grid of your configured agents with a count per agent, so three Claude panes is one action rather than three, and a row / column / grid layout choice. Settings gains a roster where each agent's start command can be edited, custom agents added, and favourites pinned. A programmatic launch now also lights the AI-CLI status badge, which it previously could not: writing to the pane goes straight to the PTY and never passes through the detector that watches what you type. See [cliAgents.ts](src/modules/terminal/lib/cliAgents.ts), [AgentSpawnDialog.tsx](src/modules/tabs/components/AgentSpawnDialog.tsx), [CliAgentsCard.tsx](src/settings/sections/components/CliAgentsCard.tsx).
- **Source Control reaches VS Code parity, including over SSH.** The row checkbox now means staged rather than selected, branches can be created, switched, merged and deleted from the panel, pull and fetch join push, and every write that worked on a local repository now works against a focused SSH session. Three bugs surfaced while wiring the checkbox to real index state: a file both staged and dirty (`MM`) collapsed into one row and lost whichever half you were not looking at, `DD` and `AA` were not recognised as conflicts, and discard probed the index instead of `HEAD`, so discarding a staged edit restored the staged content rather than the committed one. See [api.ts](src/modules/scm/api.ts), [SourceControlPanel.tsx](src/modules/scm/SourceControlPanel.tsx), [commands.rs](src-tauri/src/modules/git/commands.rs).
- **Syntax highlighting covers 179 languages, up from 78.** The parsers were already installed and simply not wired up, including GLSL/HLSL and 13 SQL dialects. The editor and the AI chat had also drifted into two separate highlighter tables, which is how a ` ```jl ` fence ended up rendering as Octave; chat now falls back to the shared registry. See [languages.ts](src/modules/editor/lib/languages.ts), [streamLanguages.ts](src/modules/editor/lib/streamLanguages.ts).
- **A PDF opens in the browser pane instead of the editor.** `fs_read_file` sniffs a PDF as binary, so an editor tab could only ever print "Binary file", while both WebView2 and WebKit ship a real PDF viewer. See [path.ts](src/lib/path.ts).

### Fixed

- **The Windows installer no longer wipes your user `PATH`.** Installing TEDI could leave the user `PATH` holding a single entry, the TEDI install directory, with everything else gone. NSIS reads a registry value into a fixed 1024-character buffer, and above that `ReadRegStr` does not return a truncated string, it returns an empty one; the installer read that as "this user has no `PATH` yet" and wrote its own directory over the top. Measured against the NSIS 3.08 the Tauri bundler ships: a 1023-character `PATH` reads fine, 1024 comes back empty, and a 1573-character one came back out as 32 characters of install directory. Just under the limit the concatenation truncated instead, appending half a directory as a junk entry. Both modes were silent, and any development machine clears 1024 characters easily. The whole read-modify-write now runs through PowerShell, where the registry API has no length limit, keeping `%VAR%` entries unexpanded and preserving the `REG_EXPAND_SZ` type. Only the user `PATH` was ever affected; the system `PATH` was never touched. Present since v0.2.1, and the uninstaller has no backup to restore, so if you were hit, an application still running from before the install holds the old `PATH` in its environment and is the best place to recover it from. Reported in [#9](https://github.com/IlhamriSKY/TEDI/issues/9). See [installer.nsh](src-tauri/installer.nsh).
- **A remote file tab comes back as a remote file tab.** v0.3.95 dropped remote editor panes from the saved layout because restoring one was worse than losing it: the pane was bound to a live SSH session number, which means nothing after a restart, so the tab returned as a local file, read your own disk at that path, and the next save overwrote whatever sat there. The pane now stores its SSH connection and resolves the session when it renders, so it restores properly; a pane whose connection has no live session offers Reconnect, which opens a normal SSH tab so host-key prompts and jump hosts still run through the usual flow, and rebinds itself once the session lands. Closes [#8](https://github.com/IlhamriSKY/TEDI/issues/8). See [serialize.ts](src/modules/workspaces/serialize.ts), [panes.ts](src/modules/terminal/lib/panes.ts), [useSshLeafState.ts](src/app/hooks/useSshLeafState.ts).
- **Submenus in the context and dropdown menus are visible again.** Radix's submenu content, unlike its top-level content, does not portal itself, so it rendered inside a menu that clips its own overflow for scrolling and collapsed to zero area: invisible, unclickable, and with no console error to point at it. See [dropdown-menu.tsx](src/components/ui/dropdown-menu.tsx), [context-menu.tsx](src/components/ui/context-menu.tsx).
- **TEDI stays responsive coming back from the lock screen.** Three separate causes behind the same freeze. A hidden window is throttled by the browser engine, so a terminal still producing output queued its writes without bound and the backlog had to drain before your first keystroke landed; that queue is now capped, dropping the middle of a burst rather than the tail so what you see is current. Writing, resizing and closing a terminal were synchronous calls that could block the window's UI thread for a full 30-second daemon round-trip, and are now one-way. And a lost GPU context on resume was never recovered, leaving a blank pane; recovery is now automatic and bounded, settling on the software renderer instead of looping. See [writeMeter.ts](src/modules/terminal/lib/writeMeter.ts), [webgl.ts](src/modules/terminal/lib/webgl.ts), [client.rs](src-tauri/src/modules/pty_daemon/client.rs).

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
