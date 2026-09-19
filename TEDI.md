# TEDI.md

Working map of this codebase for AI agents and contributors. It is preloaded as
project memory (alongside `AGENTS.md` if one exists), so it is ordered by what a
task needs FIRST and kept under 500 lines: only the first ~12 KB is preloaded,
the rest is one `read_file` away. Rationale lives in
[ARCHITECTURE.md](ARCHITECTURE.md), build and PR rules in
[CONTRIBUTING.md](CONTRIBUTING.md).

**Writing rule**: facts, paths and gotchas only. No history, no rationale essays,
no feature tours. If a line does not change what somebody types next, delete it.

## Project

**TEDI** (Terminal Director), v0.4.64: cross-platform terminal with split panes,
tab groups, workspaces, a CodeMirror editor, a BYOK AI agent and a runtime
extension system. Forked from [Crynta/Terax v0.5.9](https://github.com/crynta/terax-ai).

|           |                                                                          |
| --------- | ------------------------------------------------------------------------ |
| Stack     | Tauri 2 + Rust (`portable-pty`) <-> React 19 + TS + xterm.js (WebGL)     |
| UI        | CodeMirror 6, shadcn/ui (`radix-luma`/`mist`), lucide icons, Tailwind v4 |
| AI        | `@ai-sdk/*` v6, 12 providers, BYOK, keys in the OS keychain only         |
| Ids       | bundle `id.ilhamrisky.tedi` (dev: `.dev`), keychain service `tedi`       |
| Platforms | Windows, macOS, Linux. pnpm. No bundled Chromium, no Node runtime        |
| Ships as  | ~9.5 MB Windows `.exe`, ~19 MB installed; signed auto-updates, 6 h poll  |
| Budget    | RAM and idle CPU, NOT download size (invariant 7)                        |

## Commands

|             |                                                                                   |
| ----------- | --------------------------------------------------------------------------------- |
| Typecheck   | `pnpm exec tsc --noEmit`                                                          |
| Rust        | `cd src-tauri && cargo check && cargo clippy` (clippy is `-D warnings` in CI)     |
| Self-checks | `pnpm verify` runs all 95 `scripts/**/*-verify.ts`; `pnpm verify ai` filters      |
| Format      | `pnpm format` is REPO-WIDE. Prettier only your own paths                          |
| Build       | `pnpm tauri build`                                                                |
| Dev         | `pnpm tauri:dev` (isolated `.dev` data dir) / `pnpm tauri dev` (shares prod data) |
| Dev + exts  | `pnpm tauri:dev:ext` symlinks local `extensions/*` into the dev profile           |

CI runs six things: tsc, clippy, `pnpm verify`, `format:check`, import discipline
and `cargo test`. Run the first four before you push.

## Invariants

Break one and it is a bug, not a style question.

1. **Two processes.** `src/` (React webview) owns UI; `src-tauri/` (Rust) owns
   every OS resource. The webview reaches the OS only via `invoke("cmd", args)`;
   streaming comes back over a Tauri `Channel`. `src-tauri/src/lib.rs`
   `invoke_handler` lists all **121 commands** and is the whole backend API index.
2. **Separate webviews** (main, Settings, `debug.html`, `float.html`) share state
   through `tauri-plugin-store`, never React. `src/settings/` is the Settings UI,
   `src/modules/settings/` is the state layer.
3. **Modules are self-contained.** Import through the `@/*` alias only, never a
   relative path leaving your own module (enforced by `scripts/check-imports.mjs`).
   A module's `index.ts` is a convenience re-export, not a required door, so
   `@/modules/<mod>/<file>` is normal and a new file needs no barrel entry.
4. **Tabs never unmount.** Inactive tabs hide with the `invisible` +
   `pointer-events-none` pair, so PTYs and dev servers keep streaming.
5. **Secrets live only in the OS keychain** (`secrets_*`, service `tedi`). Never
   on disk, in the settings store, or in `localStorage`.
6. **App.tsx coordinates, it does not implement.** Cross-module wiring only;
   feature logic goes in `src/modules/<area>/`.
7. **The budget is RAM and idle CPU, not bundle size.** The old "stay under
   10 MB" cap is RETIRED: ship what the feature needs, as long as it runs. What
   still has to stay small is the RESIDENT cost. Measured, ~1.1 GB total is
   ~700 MB of WebView2 and ~120 MB of Rust host, so the wins are in what the
   webview and the pollers do, never in a byte-shaving build flag: no per-tick
   process spawn (stream ONE sampler, `procs.rs`), watch instead of poll
   (`git/watch.rs` replaced ~200 git processes/min), keep the WebView2
   anti-throttle timer flag or xterm drains at 1 Hz, and COVER the window to
   measure idle CPU, never minimize it.

**Deliberately absent** (verified, do not report as gaps): no LSP client, no
general filesystem watcher (the only `notify` watcher is git-specific,
`git/watch.rs`), AI is local-only, and Skills were REMOVED.

## Layout

```
src-tauri/
  src/lib.rs                  invoke_handler (121 commands) + boot + CLI dispatch
  src/modules/
    pty/{session,shell_init,job,path_probe}.rs + scripts/   interactive PTYs
    pty_daemon/{protocol,transport,server,client,spawn}.rs  sidecar, outlives the GUI
    fs/ shell/ git/ ssh/ extensions/ cli_ext/ browser/ preview/ + the flat .rs
                                files (one bullet each under Backend modules)
  tedi-cli/                   Windows console-subsystem `tedi` launcher (own crate)
  capabilities/               plugin API allowlist for the webview

src/                          alias @/* -> src/*
  main.tsx  app/App.tsx       entry + top-level coordinator (~1200 lines of wiring)
  settings/ debug/ float/     three SEPARATE webviews with their own entries
  components/ui/ + ai-elements/   shadcn and AI Elements, SCAFFOLDED then OWNED
  lib/  styles/  modules/     helpers; globals.css + @theme; the 22 modules below
scripts/ extensions/          95 *-verify.ts (mcp/ is a bundle resource); gitignored ext copies
```

## Backend modules

- **`pty/`**: `pty_open/attach/write/resize/close/list_sessions/kill_all`. Daemon backend by default, in-process fallback
- **`pty_daemon/`**: Sidecar owning PTYs across GUI restarts (`--pty-daemon`, no Tauri commands)
- **`fs/`** + **`shell/`**: `fs_read_dir/read_file/read_file_portion/write_file/create_*/rename/delete/search/grep/glob/replace_in_file`; and `shell_run_command`, `shell_session_*`, `shell_bg_*`, which are NOT the interactive PTYs
- **`git/`**: `git_status/diff_full/commit/push/log/discard_*`; `git_run` is an argv allowlist (includes `worktree`). `watch.rs` is a notify watcher, NOT a poll
- **`ssh/`**: `ssh_connect/run/disconnect`, `ssh_agent_keys`, `ssh_sftp_*`. ProxyJump chaining, agent auth (named pipe / Pageant / `SSH_AUTH_SOCK`)
- **`extensions/`**: `ext_install_from_zip/_from_github`, `ext_peek_*`, `ext_check_update`, `ext_list/enable/disable/uninstall`, `ext_read_manifest/asset/asset_bytes`
- **`browser/`**: `browser_place/close/navigate/zoom/list/cdp`. A Tauri CHILD WEBVIEW per pane; `cdp.rs` speaks DevTools in-process via `ICoreWebView2::CallDevToolsProtocolMethod`, so no port and no socket. WINDOWS ONLY
- **`mcp_bridge.rs` + `local_socket.rs`**: Named pipe (Windows) / unix socket an outside AI CLI reaches a running window through: the DEFAULT MCP transport. `mcp_devtools.rs` adds in-process CDP, so no MCP tool needs the automation port
- **`automation.rs`**: Reads `automationPort` from the settings file at STARTUP: WebView2 fixes its browser arguments before the first webview exists, so an env var is too late
- **`chatgpt_auth.rs`**: OAuth PKCE with a ChatGPT account (loopback 1455, refresh token straight to the keychain) so a subscription pays for a turn
- **`snapshot.rs`**: `snapshot_watch` polls OS screenshot folders by directory mtime (1 Hz, parks when off) and emits `tedi:snapshot`; `snapshot_drag` starts a native drag (`SHDoDragDrop` on Windows). Clipboard-only captures are invisible to it
- **`procs.rs` + `preview/`**: `process_sample`, a host-side sampler (it replaced an extension's PowerShell loop costing 122 MB and 18% of a core); and the `tedi-frame://` proxy, which strips X-Frame-Options / CSP frame-ancestors so the marketplace card can iframe a page that refuses
- **`secrets.rs`**: `secrets_get/set/delete/get_all` (keychain, Linux file-store fallback). `get_all` is never exposed to extensions
- **smaller**: `format.rs` `fmt_run_external` (15 s, 8 MiB cap); `backup.rs` PBKDF2 + AES-256-GCM for SSH export; `net.rs` `http_ping`; `clipboard.rs` host-process read (Linux WebKitGTK paste); `cli*.rs` the CLI verbs

Wired plugins (`lib.rs` `.plugin(...)` + `capabilities/default.json`): `autostart`,
`dialog`, `log`, `opener`, `os`, `process`, `single-instance`, `store`,
`updater`, `window-state`.

## Frontend modules (`src/modules/`, 22)

- **`terminal/`**: One mounted xterm per tab (`useTerminalSession` + pty-bridge), OSC 7/133 handlers, themes
- **`editor/`**: CodeMirror 6 (`EditorPane`), 179 language modes, AI inline autocomplete, format-on-save, vim mode. `lib/notes.ts`: `+` -> Note makes a real `note-N.md` under app data that autosaves and restores
- **`explorer/`**: File tree (Material/Catppuccin icons), fuzzy search, keyboard nav, inline rename
- **`panes/`**: Split orchestration (`PaneStack`, `PaneTreeView`, react-resizable-panels) plus `CanvasView`; geometry math in `canvasViewport.ts`
- **`tabs/`** + **`workspaces/`**: source of truth (`useTabs`, `useWorkspaceCwd`), plus workspace persistence and switching (`store.ts`, `serialize.ts`)
- **`header/`**: View toggle (tabs/kanban/canvas), `SearchInline`, light/dark toggle, Install MCP, `WindowControls`
- **`statusbar/`**: Bottom bar, cwd breadcrumb, AI tools indicator, zones
- **`shortcuts/`**: Keymap registry + `useGlobalShortcuts`; `isDisabled` decides who owns a chord (focused terminal keeps control codes, vim keeps `isVimControlChord`, core beats any extension via `coreShortcutFor`)
- **`commandPalette/`**: Ctrl+Shift+P over the shared `commandRegistry`, a STACK per id
- **`settings/`**: Settings store (`tauri-plugin-store`), preferences, window opener
- **`theme/`**: Theme provider; light/dark toggles from the header, one preset covers chrome AND terminal
- **`ai/`**: Agent subsystem (below)
- **`scm/`**: `SourceControlPanel` + `GitDiffPane`, `api.ts` over `git_*`, AI commit messages, `worktrees.ts`
- **`ssh/`**: Connection manager + SFTP explorer; `connections.ts` persists hosts (secret in keychain, or `agent` mode which stores nothing) and owns `authFields`
- **`scheduler/`**: Deferred commands into a terminal, surviving restarts. Reached by `schedule_command` and the MCP `schedule` tool via `lib/bridge.ts`
- **`notes/` + `snapshot/`**: the USER's notes/todos panel (`notesAutomation.ts` is the one action handler both the agent and MCP call), and the screenshot card with its native OLE drag out
- **`updater/`**: In-app updater on `tauri-plugin-updater`, listens for `tedi:trigger-update`
- **`extensions/`**: Extension host: install UI, permission-gated `ctx`, contribution registries
- **`automation/`**: `bridge.ts`, ONE registry of everything an outside driver can call in-realm; `window.__tedi` is a view of it, published only with the automation flag
- **`mcpInstall/`**: The Install MCP button: registers the stdio server with installed AI CLIs and writes `automationPort`, global or per-project (`Scope` in `install.ts`)

## Panes, tabs and workspaces

**Tab model** (`tabs/lib/tabTypes.ts`): `Tab = PaneTab | AiDiffTab | GitDiffTab |
ExtensionTab | ScmTab`; a `PaneTab` holds a split tree whose leaves are exactly
SIX kinds (`terminal/lib/panes.ts` `LeafState`): `terminal` / `editor` /
`extension-panel` / `board` / `scm` / `ai`. **There is no `ssh` leaf**, SSH is a
TERMINAL leaf carrying `sshConnectionId` and `leafKindTag` only renders "ssh" as
a display tag. `PaneTab.title/cwd/path/dirty` MIRROR the active leaf via
`syncPaneMirror`, which calls `leafLabel` with no sshHosts map, so an SSH leaf's
`tab.title` is the literal `"ssh"`: call `leafLabel(leaf, sshHosts)` instead.
Tree surgery lives in `panes.ts` as pure functions that return the SAME node by
reference on a no-op. Editor and git-diff share ONE preview slot (`isPreviewTab`).

**Workspace views** (`Workspace.view`: `tabs | kanban | canvas`), persisted per
workspace, toggled left of the tab strip: `tabs` is the classic strip plus
splits, `kanban` gives the area to `WorkspaceBoard`, and `canvas`
(`panes/CanvasView.tsx`) floats every pane as a draggable window on one edgeless
dot-grid surface. The strip hides under the latter two, and `WorkspaceArea` HIDES
rather than swaps panes (unmounting would tear down every xterm and CodeMirror):

- Geometry lives on the LEAF (`PaneLeaf.canvasRect`, percentages) so it travels
  with a pane through the existing serializer, and `setCanvasRects` merges FIELD
  BY FIELD, since a drag reads the rect after the click already raised the window.
- A point at `p` sits at `pan + p * zoom`: ONE mapping for drag math, pan clamp
  and minimap, pure in `panes/canvasViewport.ts` and covered by a verify script.
- Offscreen windows are culled to `visible: false`. That is a BUG FIX: a terminal
  holds a WebGL context only while visible, Chromium caps live contexts near 16,
  and an evicted one paints BLANK. Per-window zoom rides `CanvasRect.zoom` per
  leaf kind, since CSS `zoom` breaks WebGL cursor positioning (a terminal scales
  xterm's `fontSize` instead).

**Agent status and AI panes**: TEDI's own chats report the same four states a
terminal's AI CLI does (`AiCliState`: idle / working / blocking / done) per
session from `useAiSessionStatus`, each `AiPanePanel` deriving its own because
`agentMeta` is one global field. `blocking` outranks everything; `done` is the
working -> quiet EDGE, held until the chat is read, and the Board charts both
kinds of agent in one set of columns. An `ai` leaf holds a chat SESSION id
(deduped by `openAiPane`), so chats open in splits or on canvas, one per
conversation, but ONE is active: composer, `agentMeta`, plan mode, approvals.

## PTY

Init scripts in `pty/scripts/` bootstrap shells to emit **OSC 7** (cwd) and
**OSC 133 A/B/C/D** (prompt, command, output, exit), parsed in
`terminal/lib/osc-handlers.ts`, so nothing re-parses a prompt. `shell_init.rs`
splits into `#[cfg(unix)]` / `#[cfg(windows)]` arms. Shells are NOT at parity:

| Shell     | OSC 7 | 133 A/B | 133 C  | 133 D | `tedi_open` / `tp` (OSC 8888) |
| --------- | ----- | ------- | ------ | ----- | ----------------------------- |
| zsh, bash | yes   | yes     | yes    | yes   | yes                           |
| fish      | yes   | yes     | yes    | yes   | no                            |
| pwsh      | yes   | yes     | **no** | yes   | no                            |

pwsh has no pre-exec hook (a PSReadLine Enter chord was tried and crashed the
shell), so the frontend synthesises command-start from the keystroke
(`terminal/lib/aiCliDetector.ts`): nothing may assume 133 C arrived. Windows
falls back pwsh 7+ -> powershell 5.1 -> cmd (no integration).

**Daemon**: PTYs survive a window close; a reboot or daemon crash clears them and
the GUI respawns fresh (by design). Length-prefixed JSON, version-gated by
`Hello`; push events (`Data`/`Exit`) carry no `req_id`. Socket
`$XDG_RUNTIME_DIR/tedi-ptyd.sock` (0600) or `\\.\pipe\tedi-ptyd-<fnv1a(USERNAME)>`.
Scrollback is a 1 MiB ring per session, replayed as one `AttachOk`. Each terminal
leaf carries `ptyId?` (persisted by `workspaces/serialize.ts`); `attachSession`
tries `reattachPty` and falls back to `openPty` at the saved cwd, with a repaint
watchdog (`pty-lifecycle.ts`) nudging a resize when an alive reattach paints
blank. Idle self-shutdown 24 h (`TEDI_PTYD_IDLE_SECS`); logs under
`<data_dir>/id.ilhamrisky.tedi/logs/` (`TEDI_PTYD_LOG=debug`).

**Windows gotchas**: `SPAWN_LOCK` (`pty/session.rs`) gates ConPTY LIFECYCLE (not
IO), held across `openpty + spawn_command` and across the `Arc<Session>` drop so
`ClosePseudoConsole` cannot race a sibling's openpty and leave a blank pane (test
fast tab spam and a 3+ pane workspace restore before touching it). Each child
joins a per-session Job with `KILL_ON_JOB_CLOSE` (`pty/job.rs`) so the kernel
kills the subtree, since `portable-pty::killer.kill()` only kills the immediate
child; macOS/Linux rely on `Drop for Session -> killer.kill()`. Normalize cwd to
BACKSLASHES before ConPTY, because `CreateProcessW` misbehaves with forward ones.

## AI subsystem (`src/modules/ai/`)

**Providers** (12, `config.ts` `PROVIDERS` / `MODELS` / `DEFAULT_MODEL_ID` is the
source of truth): OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek,
SumoPod, AgentRouter, OpenAI-compatible, LM Studio, ChatGPT account. Local models
go through LM Studio or OpenAI-compatible, which takes several endpoints at once
(`OPENAI_COMPATIBLE_PRESETS`: Ollama / llama.cpp / vLLM / OpenRouter / 9Router).
A loopback base URL is keyless (`isLoopbackBaseURL`): a local server needs no key, a remote gateway still gets "add a key".

**Engine** (`lib/`): `agent.ts` (`streamText` + `buildLanguageModel` + system
prompt composition), `transport.ts` (`DirectChatTransport`, per-turn `<env>`,
project memory), `projectMemory.ts` (which docs preload, and the budget),
`sessions.ts` + `store/chatStore.ts` (sessions in `tedi-sessions.json`, GLOBAL
not per-workspace), `security.ts` (symlink-resolved secret deny-list on read AND
write), `cache.ts` (Anthropic breakpoints), plus `composer.tsx`, `compact.ts`,
`checkpoint.ts`, `errors.ts`, `mcpClient.ts`, `prompts.ts`, `goalRunner.ts` +
`goalJudge.ts`, `loop.ts` and `tediMcpServer.ts`.

**Agent loop**: `MAX_AGENT_STEPS = 50`, last step forced to text so a capped turn
still ends with a summary. Two more stop guards, identical tool+input three times
(`noToolRepetition`) and two consecutive text-only steps (`noProgressStop`), each
surfacing as a `stopReason`. Typing `ultrathink` deepens reasoning for a turn.

**Slash commands** (`slashCommands.ts`): `/help /new /clear /history /compact
/mcp /init /plan /schedule /loop /goal`. `>plan` (or `/plan`) queues mutations
into `planStore` for one review diff.

- `/goal` runs an EVALUATOR call after every turn (`goalJudge.ts`) over the goal,
  the todos and the transcript tail: MET / NOT MET / BLOCKED. The working model
  saying "GOAL COMPLETE" is only evidence. Open todos block completion with no
  model call, NOT MET feeds its reason into the next continue prompt, and
  BLOCKED / an errored turn / Stop / repetition PAUSE the run (bare `/goal`
  resumes, 25 turns max). `/loop <interval> <prompt>` re-queues a prompt.
- **Stop** kills a running `bash_run` (`shell_session_cancel`) and
  `settleInterruptedToolParts` closes the turn's unfinished tool parts, or the
  SDK re-sends an approved call after a graceful abort. Every request also runs
  `closeDanglingToolCalls` (a call with no result is a 400 on every provider) and,
  on OpenAI-compatible gateways, `stripToolResultMedia`.

**Context and memory**: `compact.ts` is elide-first in three stages (drop
superseded `read_file` results, then old tool results at 72% of the window, then
hard-drop at 85%), and runs again between steps against a flat resend budget.
Project memory is `<workspace>/AGENTS.md` and `<workspace>/TEDI.md`, read
together and SHARING one 12 KB preload budget (`projectMemory.ts`), plus
`<workspace>/.tedi/memory/*.md` (32 KB). Each doc is head-bounded at a markdown
header and carries a pointer to `read_file` the rest; writes invalidate through
`memoryCache.ts`, and the cache otherwise holds 30 s. **Voice input** is a mic
button in the composer and status bar (`hooks/useWhisperRecording.ts`,
`MediaRecorder` plus OpenAI `whisper-1`).

**Native tools** (`tools/`, 26; keep in sync with the `needsApproval` flags):

- **`fs.ts`** (mixed): `read_file` (text or image), `list_directory` (auto); `write_file`, `create_directory`, `move_file`, `copy_file`, `delete_file`, `replace_in_files`
- **`edit.ts`** (approval): `edit`, `multi_edit` (need a prior `read_file`, serialized per path)
- **`search.ts`** (auto): `grep`, `glob`
- **`fetch.ts`** (mixed): `fetch` (GET auto, POST approval, no JS execution)
- **`shell.ts`** (mixed): `bash_run`, `bash_background`; `bash_logs`, `bash_list`, `bash_kill` (auto)
- **`schedule.ts`** (mixed): `list_schedules`, `cancel_schedule` (auto); `schedule_command`
- **`subagent.ts`** (auto): `run_subagent`, `run_subagents` (bounded-concurrency `depends_on` DAG, cascade-skip)
- **`todo.ts`** (auto): `todo_write`, the agent's per-turn plan, NOT the user's list
- **`notes.ts`** (mixed): `notes_read` (auto); `notes_write` add/edit/complete/reopen/delete
- **`mcp.ts` / `extensions.ts`** (approval): MCP-server and extension tools, merged BEFORE built-ins so neither can shadow `bash_run`

**Panes and terminals are not in that list.** They are MCP tools on TEDI's own
in-process server (`lib/tediMcpServer.ts`, see MCP below), called as
`mcp__tedi__*`: `sh` (runs in the user's VISIBLE terminal; `submit:false` types
without running, which is how you drive an AI CLI in a full-screen pane), `read`,
`state`, `wait_for_terminal`, `focus_pane`, `pane`, `worktree`, `open_file`,
`workspace`. What stays native is file IO and the agent's own hidden shell,
because sub-agents get `bash_*` and no MCP tools at all. Approval-gated tools
pause and render an in-UI card; proposed edits open in a side-by-side `ai-diff`
tab, accepted or rejected per hunk before any write. An MCP call always raises a
card except a `readOnlyHint` tool or an `action` the shared table marks `auto`.

**Sub-agents** (`agents/registry.ts`, one on/off in Settings -> Agents): ten
agents. Exploration (`comet`, `nebula`), advisor (`nova`, `orbit`, `eclipse`,
`vega`) and media (`aurora`) are read-only; workers (`odyssey`, `zenith`,
`meteor`) also edit and run commands, auto-approving mutations (a `generateText`
loop has no approver) and bounded instead by the deny list, out-of-scope refusal
and checkpointing. Recursion is structurally impossible: `run_subagent` is never
built inside a sub-agent. Prompts, per-agent model and temperature are
user-overridable via `prompts.ts`.

**Live-context bridge**: `App.tsx` `setLive({...})` lets tools read the active
terminal's cwd and scrollback lazily; the per-turn `<env>` carries
`workspace_root`, `active_terminal_cwd`, `active_file` and the terminal list.
Both memory docs are read against the SESSION-PINNED root, never the live one,
or focusing a terminal elsewhere re-prices every cached token.

## MCP

TEDI is an MCP client (stdio servers configured in Settings, tools merge in as
`mcp__<server>__<tool>`, always approval-gated) and an MCP SERVER that drives a
running window, over **24 tools** (or `pnpm mcp <verb>` by hand).

**One definition, two transports.** `scripts/mcp/tools.mjs` holds every tool
name, pack, description and JSON Schema; both servers read it. It imports
NOTHING, because it ships as a bundle resource beside `server.mjs` with no
`node_modules` (the app reaches it through the `@mcp/` alias). Handlers stay
separate (`server.mjs` drives the window, `ai/lib/tediMcpServer.ts` calls the
same functions in-realm over `InMemoryTransport`) but the contract cannot drift:
`driver-verify` asserts `tediMcpServer.ts` declares no description or schema of
its own. `server.mjs` is DUAL-ERA (`conformance-verify.ts`): the legacy session
model every AI CLI speaks (`initialize`, negotiating `2025-11-25` down to
`2024-11-05`), plus modern `2026-07-28` stateless on top (`server/discover`,
`-32022` on an unsupported `_meta` version).

- **The local socket is the default** (`mcp_bridge.rs` <-> `socket.mjs`): every
  platform, many clients at once, per-run token auth, no restart. It calls
  bridge capabilities by name in the app's own realm.
- **CDP is pulled up lazily**, only for real keyboard/mouse input, window capture
  and DOM reads, because a synthetic DOM event is not a trusted one. Windows
  only, one client, unauthenticated, needs the debug port; a session calling none
  of `keys`/`type_text`/`click`/`drag`/`screenshot`/`eval_js`/`read source:"dom"`
  opens no DevTools connection.
- `state` returns EVERY pane in EVERY tab from the TAB TREE, not the DOM, where
  neither a terminal (WebGL) nor a long file (virtualised) is readable. **Private
  panes are absent from all of it** (`app/lib/terminalSnapshot.ts`).
- **Efficiency is a constraint**: the tool list rides every request of every
  connected CLI, so `inspect`/`read` are single verbs with an enum, and every
  terminal read REDUCES IN THE PAGE (a tail, a hash) not 20 KB of scrollback.
- **Pack switches are enforced at CALL time on both transports**, not just in
  `tools/list`. `set_setting` cannot write `approvalMode`, `disabledTools`, the
  provider base URLs or `terminalEnvPath` (`AGENT_DENIED_PREFS`); installing an
  extension is refused outright, and no API key can come back.
- **Turning it on**: `TEDI_DEBUG_PORT=9222` before launch, or the header's
  Install MCP button, which writes `automationPort` for Rust to read at startup
  and registers the server with Claude Code / Codex / Gemini / opencode / Copilot
  CLI / Cursor plus a project `.mcp.json`. ONE switch governs the port and the
  `window.__tedi` flag; it takes effect on the NEXT launch.

## Extensions

Runtime-installed JS packages at `<app_data_dir>/extensions/<id>/`:
`manifest.json` + optional `extension.js` (`activate(ctx)` / `deactivate()`) +
assets. Two install channels only, a local `.zip` (`ext_install_from_zip`) or a
GitHub `owner/repo` release (`ext_install_from_github`); `loader.ts` boot-scans
and mints a fresh Blob-URL module per activation. Author guide and manifest
schema: [extensions/README.md](extensions/README.md).

**`ctx` surface** (`host.ts`, every gated method checks its permission). Ungated:
`storage`, `os`, `logger`, `paths.home`, `app.getContext / onContextChange /
setSidebarVisible`, `ui.mountFolderTree / icon / codeEditor`, `ai.getState /
onStateChange / stop`. Gated, permission -> method: `settings:read|write`,
`secrets:read|write`, `events:emit|listen`, `editor:read|write`, `tabs:open` and
`ui:toast` guard the API of the same name. The rest: `workspaces:manage` ->
`app.createWorkspace / setActiveWorkspace`; `invoke:<cmd>` (globs ok) -> `invoke`
/ `invokeChannel`; `statusbar|headerbar|sidebar:write` -> the three bar APIs;
`ssh:connections` -> `ssh.*`; `shell:transform` -> `shell.registerCommandTransformer`;
`panels:register` -> `panel.*` (a manifest `contributes.panels[]` entry is seeded
ungated); `ai:configure|prompt` -> `ai.setModel / setSubagentsEnabled`, `ai.sendPrompt`.

Per-id namespacing: settings `ext:<id>:<key>`, events `ext://<id>/<name>`,
storage `tedi-ext-<id>.json`, keychain `tedi-ext:<id>`. Hard-denied even with
`*`: `secrets_get_all`, `secrets_get/set/delete` and the five `ext_install_*` /
`ext_enable` / `ext_disable` / `ext_uninstall` commands. Raw `@tauri-apps/api`
imports bypass the gate, so **the trust boundary is install-time review**, backed
by a consent gate that refuses any permission the review dialog did not show.
Grants are install-TIME: a NEW permission in an update self-grants unless the
review runs again.

**Registries** (`registries.ts`, `KeyedRegistry<T>` base): `settingsRegistry`,
`commandsRegistry` + `keybindingsRegistry` (rebindable in Settings -> Shortcuts),
`panelsRegistry` + `panelRenderersRegistry`, `statusItemsRegistry`,
`headerItemsRegistry`, `sidebarSectionsRegistry`, `shellTransformersRegistry`,
`aiToolsRegistry`. A manifest declares five `contributes.*` categories
(`settings`, `commands`, `keybindings`, `panels`, `aiTools`), and every object
schema in `manifest.ts` is `.passthrough()` that MUST stay looser than Rust: Rust
decides what INSTALLS, Zod only what RENDERS. A field Rust accepts and Zod
rejects is a GHOST, installed with a success toast, then dropped by
`listInstalled`, never activating, not uninstallable. An extension's AI tools
reach the in-app agent through `tools/extensions.ts` and are re-advertised to
outside CLIs as `ext_<name>` with their real schema, so one call works from
either side; a name collision drops one, silently.

**Reference extensions** live in their own repos and ship in no binary.

- **`tedi.browser`**: A pane that is a Tauri child webview, driven over in-process CDP. One `browser` tool, 21 actions, keyed by `paneId`. Windows only
- **`tedi.sql-explorer`**: `panels[] surface:"tab"` + `tabs:open`, `settings:*`, `secrets:*`, `ctx.ui.codeEditor`, sidebar connection list
- **`tedi.api-client`**: Postman-style workbench; `invoke:http_stream`/`http_abort` as the whole backend, two sidebar sections, `ctx.storage` for bulk plus `ctx.secrets` for secret variables
- **`tedi.secondary-folder-tree`**: `panels[] surface:"right"`, `commands` + `keybindings`, `ctx.ui.mountFolderTree`; **`tedi.beautify`** adds `headerbar:write`, an `editor:read/write` round-trip and a native sidecar
- **`tedi.rtk-bridge`**: `shell:transform` rewriting every AI shell command
- **`tedi.process-monitor`**: ONE streamed sampler over `shell_bg_spawn_direct` (not a spawn per tick), meter with a pixel-chart tooltip, process-tree tab
- **`tedi.ai-usage`**: Status-bar meters: `statusbar:write` with label + progress, gated `invoke`

Others in local copies: `remote-access` (terminal mirrors over a relay),
`android-mirroring` (scrcpy + WebCodecs), `discord-rich-presence`, `devenv`, `network-monitor`, `screenshot`.

There is **no cross-extension channel**: every API hard-wires the caller's id.
Two extensions that must talk hand off through a file in `~/.tedi/`.

**Local loop**: `pnpm tauri:dev:ext` symlinks `extensions/<id>/` into the dev
profile (`link:ext` / `relink:ext` / `unlink:ext`); `extension.js` edits are
picked up on window reload, no re-install. Authoring: `tedi ext create` ->
esbuild -> `tedi ext validate` -> zip.

## Worktrees (`scm/worktrees.ts`)

Several checkouts of one repo, each on its own branch, so two agents work at
once. Composed in TypeScript over `git_run`: every git command already resolves
its repo with `rev-parse --show-toplevel`, which inside a linked worktree answers
with THAT worktree, so only create/list/remove were missing.

1. **Writes run from the MAIN worktree** (`mainWorktreePath`), never the one
   being acted on. `git worktree remove` on the worktree git stands in
   half-succeeds on Windows: deregistered, then "Permission denied" on the
   folder, leaving a directory `list` no longer knows about.
2. **A branch another worktree holds cannot be checked out or deleted at all**,
   `-D` included. `BranchMenu` marks those rows, `worktreeConflictMessage` the race.
3. **New worktrees land in `<repo>/.worktrees/<branch-slug>`**, hidden from git by
   one write of `*` to `.worktrees/.gitignore`, which excludes itself.

Create lives in `worktreeCreate.ts` because two surfaces offer it (Source
Control's header menu and the Workspaces panel, where rows group by PROJECT);
opening one is an ordinary `newTab` via `worktreeBridge`. An agent drives it
through one `worktree` MCP tool with a five-action enum over ONE bridge
capability (`worktreeAutomation.ts`); `prWorktree.ts` checks a PR into a DETACHED
worktree and runs `gh pr checkout` inside it.

## Formatters

Two pipelines under one prefs schema (`editor/lib/formatters/`). `builtin`
(`prettier.ts`) lazy-imports Prettier 3 standalone plus only the needed plugins
(parsers in `lang.ts`), reading `.editorconfig` + `.prettierrc(.json|.json5)` /
`package.json#prettier` walked up from the file; it does NOT support
`.prettierrc.{js,cjs,mjs,yaml,yml}`. `external` (`external.ts` ->
`fmt_run_external`) direct-spawns with `${file}` temp-file or stdin mode,
`cwd = dir(file)`, 15 s timeout, 8 MiB cap, 30+ presets. Resolution:
`languageFromPath` -> `formatters[lang]` (per-language `formatOnSave` overrides
global) -> dispatch. Failures toast and fall through to a plain save.

## Conventions

- **Imports**: always `@/...`, never relative across modules.
- **Paths**: split with `.split(/[\\/]/)`. Canonical frontend form is
  forward-slash; convert `homeDir()` backslashes at the boundary. OSC 7 arrives
  forward-slash after `parseOsc7` strips the `/C:` drive prefix.
- **Icons**: `lucide-react` by name, brand marks in `components/BrandIcon.tsx`.
  Dynamic and extension icons resolve in ONE place (`lib/iconRegistry.ts`
  `resolveExtIcon`, `extensions/icon.ts` `useExtensionIcon`); core has no table.
- **Styling**: Tailwind v4 (`styles/globals.css` + `shadcn-tailwind.css`
  `@theme`, no `tailwind.config.*`), `cn()` from `@/lib/utils`. shadcn/ui and AI
  Elements were scaffolded and are now OWNED: add a NEW component with the CLI,
  never re-run it over an existing one, which silently reverts TEDI's tokens.
  Forms go through one `ui/field.tsx`, never a native `<select>`.
- **Terminal input**: send `\r` (CR) for Enter, never `\n`. PowerShell needs CR.
- **Cross-platform**: HOME and cache via the `dirs` crate, never raw env vars;
  `cfg(not(windows))` code NEVER compiles on Windows, so cross-check in CI. macOS
  uses native traffic lights, Linux and Windows are borderless `WindowControls`.
- **`AiComposerProvider` is mounted unconditionally** at the App root: a
  conditional wrapper changes the parent element type when keys load, remounting
  the tree and respawning every PTY. Tauri commands must be async, too: a sync
  one stalls the UI thread.
- **Prose**: no em-dashes. Use commas, colons or parentheses.
- **Traps**: never make a `Popover` inside a `Dialog` `modal`, and Radix
  `*SubContent` clips without its own portal. `@layer components` LOSES to
  utilities, a `gap` DOUBLES a gutter's hit rect, a controlled `open` never fires
  `onOpenChange`, React bubbles up the REACT tree. Zod STRIPS unknown keys (hence
  raw JSON Schema for MCP), `serde_json` re-sorts keys. On a "not working" report
  about a shipped feature, check the INSTALLED exe FileVersion first.

## Workflow

- **`tedi` CLI** (`cli.rs`): `tedi .` / `tedi <path>` opens a folder or file in
  the running window (single-instance forward, `tedi:open-cli-target`).
  `tedi cmd <id>` runs a command-registry id (`tedi:run-command`), the only
  automation channel reaching an ALREADY-RUNNING session, since
  `TEDI_DEBUG_PORT` must be set before launch. Fire-and-forget: a miss is a toast in the window, not on the
  caller's stdout. `--version` / `--help`, `tedi ext`, `tedi theme` and
  `tedi --update` all short-circuit GUI boot. On Windows the user-facing `tedi`
  is the console-subsystem launcher in `tedi-cli/`; a PATH shim
  (`~/.local/bin/tedi` on macOS/Linux) installs from Settings and self-heals.
- **Dev data**: `pnpm tauri:dev` uses `tauri.dev.conf.json`, so workspaces,
  extensions, PTY socket and logs read from `.dev`; the daemon outlives it, so set `TEDI_PTYD_IDLE_SECS=60` while iterating.
- **Release**: a tag push triggers `.github/workflows/release.yml`, building
  signed updates (`TAURI_SIGNING_PRIVATE_KEY*`) and a DRAFT GitHub Release, which
  ships nothing until published. FOUR version files must agree, never blanket-sed
  `Cargo.lock`, and `git fetch` first: local `main` has held hundreds of
  rewritten-but-unpushed commits, invisible until you compare both directions.
