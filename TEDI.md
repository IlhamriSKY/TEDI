# TEDI.md

Dense map of the TEDI codebase for AI assistants and contributors: what the
project is, where everything lives, the conventions, and the patterns. This
file is also preloaded as workspace-root agent memory, so the most important
facts are front-loaded. For the design rationale and the core/extension
contract see [ARCHITECTURE.md](ARCHITECTURE.md); for build/PR rules see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Project

**TEDI** (Terminal Director): a lightweight,
cross-platform terminal with split panes, tab groups, workspaces, a CodeMirror
editor, and a bring-your-own-key AI agent. Forked from
[Crynta/Terax v0.5.9](https://github.com/crynta/terax-ai). Current version 0.4.36.

|                  |                                                                             |
| ---------------- | --------------------------------------------------------------------------- |
| Stack            | Tauri 2 + Rust (`portable-pty`) <-> React 19 + TS + xterm.js (WebGL)        |
| Editor / UI      | CodeMirror 6, shadcn/ui (`radix-luma` / `mist`, lucide icons), Tailwind v4  |
| AI               | `@ai-sdk/*` v6, multi-provider, BYOK                                        |
| Bundle id        | `id.ilhamrisky.tedi` (dev profile: `id.ilhamrisky.tedi.dev`)                |
| Keychain service | `tedi`                                                                      |
| Package manager  | pnpm                                                                        |
| Platforms        | macOS, Linux, Windows                                                       |
| Frontend check   | `pnpm exec tsc --noEmit`                                                    |
| Rust check       | `cd src-tauri && cargo check && cargo clippy`                               |
| Build            | `pnpm tauri build`                                                          |
| Dev              | `pnpm tauri:dev` (isolated data dir) or `pnpm tauri dev` (shares prod data) |
| Extension dev    | `pnpm tauri:dev:ext` (symlinks local `extensions/*` into the dev profile)   |
| Auto-updater     | Enabled: signed updates via GitHub Releases, 6 h poll                       |

## Mental model

Six invariants (rationale in [ARCHITECTURE.md](ARCHITECTURE.md#2-design-principles)):

1. **Two processes.** Frontend (`src/`, React webview) owns UI; backend
   (`src-tauri/`, Rust) owns every OS resource. The webview reaches the OS only
   via `invoke("cmd", args)`; streaming output returns over a Tauri `Channel`.
   Every command is registered in `src-tauri/src/lib.rs` (`invoke_handler`, 124
   commands) which is the whole backend API index.
2. **Two webviews.** The main window and a separate Settings window
   (`src/settings/`). They share state via `tauri-plugin-store`, not React.
   `src/settings/` is the Settings UI; `src/modules/settings/` is the state layer.
3. **Modules are self-contained.** Import only through the `@/*` alias, never a
   relative path across modules (enforced by `scripts/check-imports.mjs`).
4. **Tabs never unmount.** Inactive tabs are hidden with `invisible
pointer-events-none` so PTYs and dev servers keep streaming.
5. **Secrets live only in the OS keychain** (`secrets_*` commands, service
   `tedi`). Never disk, settings store, or `localStorage`.
6. **App.tsx coordinates, it does not implement.** It owns cross-module wiring;
   feature logic lives in `src/modules/<area>/`.

## Project structure

```
src-tauri/                      Backend (Rust)
  src/lib.rs                    invoke_handler (all 124 commands) + boot + CLI dispatch
  src/main.rs                   thin shim
  src/modules/
    pty/{mod,session,shell_init,job,path_probe}.rs + scripts/   interactive PTYs
    pty_daemon/{mod,protocol,transport,paths,server,client,spawn}.rs   sidecar
    fs/{mod,tree,file,mutate,search,grep,atomic}.rs
    shell/{mod,session,background,ringbuffer}.rs
    git/{mod,commands,...}.rs   scm backend
    ssh/{mod,session,sftp}.rs   ssh + sftp + ProxyJump
    extensions/{mod,commands,install,github,manifest,state,version}.rs
    cli_ext/{mod,commands,registry,install,helpers,types,scaffold,validate}.rs    headless `tedi ext`
    preview/{mod,embed,proxy,util,browser_ext}.rs   native-webview preview backend
    format.rs secrets.rs net.rs mcp.rs backup.rs clipboard.rs appimage.rs
    cli.rs cli_theme.rs cli_update.rs cli_paint.rs events.rs ids.rs lockext.rs
  tedi-cli/                     Windows console-subsystem `tedi` launcher (separate crate)
  capabilities/                 plugin API allowlist for the webview

src/                            Frontend (React webview), alias @/* -> src/*
  main.tsx                      main-window entry -> app/App
  app/App.tsx                   top-level coordinator (~1200 lines; wiring, not features)
  settings/                     Settings UI (SEPARATE webview, entry settings/main.tsx)
  debug/                        AI debug-capture viewer (SEPARATE webview, entry debug.html)
  float/                        Floated pane window (SEPARATE webview, entry float.html)
  components/ui/                shadcn (generated; don't hand-edit)
  components/ai-elements/       Vercel AI Elements (generated; don't hand-edit)
  components/BrandIcon.tsx      provider/brand marks without a Lucide equivalent
  lib/                          shared helpers (cn, path, format, iconRegistry, ...)
  styles/                       global CSS / theme tokens
  modules/
    ai/        browser/       commandPalette/  editor/    explorer/
    extensions/ header/       panes/           scheduler/ scm/
    settings/  shortcuts/     ssh/             statusbar/ tabs/
    terminal/  theme/         updater/         workspaces/
```

## Backend (`src-tauri/src/modules/`)

| Module         | Key commands / role                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pty/`         | `pty_open/attach/write/resize/close/list_sessions/kill_all`. Two backends: daemon (default) falls back to in-process.                                                                                                                                                                                                                                                                                                                   |
| `pty_daemon/`  | Sidecar owning PTYs across GUI restarts (`--pty-daemon` flag, no Tauri commands).                                                                                                                                                                                                                                                                                                                                                       |
| `fs/`          | `fs_read_dir/read_file/read_file_portion/write_file/create_*/rename/delete/search/grep/glob`.                                                                                                                                                                                                                                                                                                                                           |
| `shell/`       | `shell_run_command`, `shell_session_*`, `shell_bg_*`. Distinct from interactive PTYs.                                                                                                                                                                                                                                                                                                                                                   |
| `git/`         | `git_status/diff_full/commit/push/log/discard_*` for the SCM panel.                                                                                                                                                                                                                                                                                                                                                                     |
| `ssh/`         | `ssh_connect/run/disconnect`, `ssh_agent_keys`, `ssh_sftp_*`. `russh` + `russh-sftp`, ProxyJump chaining, ssh-agent auth (named pipe / Pageant / `SSH_AUTH_SOCK`).                                                                                                                                                                                                                                                                      |
| `extensions/`  | `ext_install_from_zip/from_github`, `ext_peek_*`, `ext_check_update`, `ext_list/enable/disable/uninstall`, `ext_read_manifest/asset/asset_bytes`.                                                                                                                                                                                                                                                                                       |
| `preview/`     | `preview_embed_*` native-webview compositing (update/navigate/dispatch/read/act/console/screenshot/set_bg/close); `tedi-frame://` proxy for remote marketplace icons; `browser_ext_*` manages MV3 extensions loaded into the preview webview (Windows only). Every pane gets a document-start script that records console errors, uncaught exceptions, and unhandled rejections into a capped ring, drained by `preview_embed_console`. |
| `format.rs`    | `fmt_run_external` direct-spawn external formatter (15 s timeout, 8 MiB cap).                                                                                                                                                                                                                                                                                                                                                           |
| `secrets.rs`   | `secrets_get/set/delete/get_all` (keychain; Linux file-store fallback). `get_all` never exposed to extensions.                                                                                                                                                                                                                                                                                                                          |
| `net.rs`       | `http_ping` dev-server probe.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mcp.rs`       | Model Context Protocol support for the AI subsystem.                                                                                                                                                                                                                                                                                                                                                                                    |
| `backup.rs`    | `backup_seal/backup_open`: PBKDF2 + AES-256-GCM encrypted blobs for SSH connection export/import.                                                                                                                                                                                                                                                                                                                                       |
| `clipboard.rs` | `clipboard_read_text`: host-process clipboard read (Linux WebKitGTK paste workaround).                                                                                                                                                                                                                                                                                                                                                  |
| `cli*.rs`      | `tedi` CLI entry, `tedi ext`, `tedi theme`, `tedi --update` (see CLI section).                                                                                                                                                                                                                                                                                                                                                          |

Wired Tauri plugins (`lib.rs` `.plugin(...)` + `capabilities/default.json`):
`autostart`, `dialog`, `log`, `opener`, `os`, `process`, `single-instance`,
`store`, `updater`, `window-state`.

### PTY shell integration

Init scripts in `pty/scripts/` bootstrap shells to emit **OSC 7** (cwd) and
**OSC 133 A/B/C/D** (prompt/command/output/exit boundaries), parsed in
`terminal/lib/osc-handlers.ts` (no prompt re-parsing). Unix: zsh (`ZDOTDIR`),
bash (`--rcfile`), fish. Windows: pwsh 7+ (falls back to powershell 5.1, then cmd
with no integration). `pty/shell_init.rs` is split into `#[cfg(unix)]` /
`#[cfg(windows)]` arms; keep new platform code in the right arm.

### PTY daemon (persistence)

PTYs survive a window close; a PC restart or daemon crash clears sessions and the
GUI respawns fresh (out of scope by design). Protocol: length-prefixed JSON,
version-gated via `Hello`; push events (`Data`/`Exit`) carry no `req_id`. Socket:
Unix `$XDG_RUNTIME_DIR/tedi-ptyd.sock` (mode 0600), Windows
`\\.\pipe\tedi-ptyd-<fnv1a(USERNAME)>`. Scrollback: per-session ring capped at
1 MiB, replayed as one `AttachOk { scrollback_b64 }` on attach. Restore: each
terminal leaf carries `ptyId?`, persisted by `workspaces/serialize.ts`;
`attachSession` calls `reattachPty` and falls back to `openPty` at the saved cwd
on unknown uuid. A blank-reattach repaint watchdog
(`pty-lifecycle.ts`) nudges a SIGWINCH-style resize if an alive reattach nets to
a blank viewport. Idle 24 h self-shutdown (`TEDI_PTYD_IDLE_SECS` overrides).
Logs at `<data_dir>/id.ilhamrisky.tedi/logs/tedi-ptyd.log` (`TEDI_PTYD_LOG=debug`).

### Windows PTY gotchas

- **`SPAWN_LOCK`** (`pty/session.rs`): a `Mutex` gating ConPTY lifecycle. Held by
  `spawn()` across `openpty + spawn_command` and by `drop_session()` across the
  `Arc<Session>` drop, so `ClosePseudoConsole` cannot race a sibling's openpty
  (which corrupts the fresh console and leaves the pane blank). It gates lifecycle,
  not IO. Do not remove without testing fast tab spam and workspace restore with
  3+ panes.
- **Job Objects** (`pty/job.rs`): each ConPTY child joins a per-session Job with
  `KILL_ON_JOB_CLOSE`, so the kernel kills the whole subtree (e.g. `npm run dev`
  inside pwsh) when the Job handle drops. `portable-pty::killer.kill()` only kills
  the immediate child.
- **Cwd normalization**: `CreateProcessW` misbehaves with forward-slash cwd;
  normalize to backslashes before ConPTY.

macOS/Linux rely on `Drop for Session -> killer.kill()`.

## Frontend (`src/modules/`, 19 modules)

| Module            | Role                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal/`       | One mounted xterm per tab via `useTerminalSession` + pty-bridge; OSC 7/133 handlers; themes.                                                                                                                                                                   |
| `editor/`         | CodeMirror 6 (`EditorPane`), language modes, AI inline autocomplete, format-on-save, vim mode, prebuilt themes.                                                                                                                                                |
| `explorer/`       | File tree (Material/Catppuccin icons), fuzzy search, keyboard nav, inline rename. `basename` splits on `/` and `\`.                                                                                                                                            |
| `browser/`        | The preview/browser tab: a real native webview (WebView2/WebKit) docked over the pane via `preview_embed_*` (not an iframe), with address bar, back/forward, favicon. Status-bar pill suggests opening on a detected `localhost` URL.                          |
| `panes/`          | Split-pane orchestration via `react-resizable-panels` (`PaneStack`, `PaneTreeView`).                                                                                                                                                                           |
| `tabs/`           | Source of truth: `useTabs` (tab list + active id), `useWorkspaceCwd`, serialization.                                                                                                                                                                           |
| `workspaces/`     | Workspace persistence + switching (`store.ts`, `serialize.ts`).                                                                                                                                                                                                |
| `header/`         | Top bar, inline search (`SearchInline` adapts terminal vs editor), custom `WindowControls` (Linux/Windows).                                                                                                                                                    |
| `statusbar/`      | Bottom bar, cwd breadcrumb, AI tools indicator.                                                                                                                                                                                                                |
| `shortcuts/`      | Keymap registry + `useGlobalShortcuts`; handlers wired in App.tsx by id. Use `metaKey \|\| ctrlKey`.                                                                                                                                                           |
| `commandPalette/` | Ctrl+Shift+P palette over the shared `commandRegistry` every `useGlobalShortcuts` caller populates, so component-owned commands run too.                                                                                                                       |
| `settings/`       | Settings store (`store.ts` via `tauri-plugin-store`), preferences, window opener.                                                                                                                                                                              |
| `theme/`          | `next-themes` provider.                                                                                                                                                                                                                                        |
| `ai/`             | AI agent subsystem (below).                                                                                                                                                                                                                                    |
| `scm/`            | `SourceControlPanel` + `GitDiffPane`; `api.ts` wraps `git_*`; AI commit-message affordance.                                                                                                                                                                    |
| `ssh/`            | Connection manager + remote SFTP explorer; `connections.ts` persists hosts (password/key in keychain, or `agent` mode which stores nothing and lets the local ssh-agent sign) and owns `authFields`, the one mode-to-wire mapping; ProxyJump chain resolution. |
| `scheduler/`      | In-conversation task/timer surface for the AI agent (distinct from Rust `shell` background jobs).                                                                                                                                                              |
| `updater/`        | In-app updater UI on `tauri-plugin-updater`; listens for `tedi:trigger-update`.                                                                                                                                                                                |
| `extensions/`     | Extension host: install UI, permission-gated `ctx` API, contribution registries (see Extensions).                                                                                                                                                              |

**Tab model** (`tabs/lib/tabTypes.ts`): `Tab = PaneTab | AiDiffTab | GitDiffTab |
ExtensionTab | ScmTab`. `PaneTab` (`kind:"pane"`) holds a split tree whose leaves
are `terminal` / `editor` / `browser` / `ssh` / `extension-panel`.

## AI subsystem (`src/modules/ai/`)

BYOK, multi-provider via `@ai-sdk/*`. Eleven providers: OpenAI, Anthropic, Google,
xAI, Cerebras, Groq, DeepSeek, SumoPod, AgentRouter, OpenAI-compatible, LM Studio. `config.ts`
(`PROVIDERS`, `MODELS`, `DEFAULT_MODEL_ID`) is the source of truth; add providers
there. Keys live only in the keychain via `secrets_*`.

**Local models** run through either LM Studio (keyless, own base URL) or
OpenAI-compatible, which accepts several endpoints at once. `OPENAI_COMPATIBLE_PRESETS`
ships OpenAI / Ollama / llama.cpp / vLLM / OpenRouter / 9Router base URLs. A loopback base
URL is treated as keyless (`isLoopbackBaseURL`), so a local server needs no API key
while a remote gateway still gets the actionable "add a key" error.

Engine (`lib/`): `agent.ts` (`streamText` + `buildLanguageModel`), `transport.ts`
(`DirectChatTransport`, injects the per-turn `<env>`), `composer.tsx` (shared input
state), `sessions.ts` + `store/chatStore.ts` (sessions at `tedi-sessions.json`,
global not per-workspace), `security.ts` (symlink-resolved secret deny-list on read
and write), `cache.ts` (Anthropic cache breakpoints), `compact.ts`, `checkpoint.ts`,
`errors.ts`, `skills.ts`, `mcpClient.ts` / `mcpTransport.ts`, `prompts.ts`.

**Voice input**: a mic button in the composer and the status bar
(`hooks/useWhisperRecording.ts`, `AiInputBar.tsx`, `AiStatusBarControls.tsx`)
records via `MediaRecorder` and transcribes with OpenAI `whisper-1`, so it needs
an OpenAI API key (`apiKeys.openai` in the chat store).

**Agent loop**: `MAX_AGENT_STEPS = 15` plus two more stop guards, identical
tool+input three times (`noToolRepetition`) and two consecutive text-only steps
(`noProgressStop`); whichever trips is surfaced as a `stopReason`. `>plan` toggles
**plan mode**, which queues mutations into `planStore` for one review diff.
Typing `ultrathink` appends a deeper-reasoning directive for that turn.

**Context**: `compact.ts` is elide-first in three stages (drop superseded
`read_file` results, then old tool results at 72% of the window, then hard-drop at
85%), and runs again between steps against a flat resend budget. Project memory is
`<workspace>/TEDI.md` (capped at 12KB, so keep this file tight) plus
`<workspace>/.tedi/memory/*.md` (32KB). **Skills** are `SKILL.md` folders under
`~/.tedi/skills` and `<workspace>/.tedi/skills`; name and description go in the
prompt, the body is loaded on demand. **MCP** is stdio-only, configured in
Settings; tools merge in as `mcp__<server>__<tool>` and always need approval.

**Tools** (`tools/`, the real capability surface; keep in sync with the
`needsApproval` flags):

| File                       | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                 | Approval |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `fs.ts`                    | `read_file` (text or image), `list_directory` (auto); `write_file`, `create_directory`, `move_file`, `copy_file`, `delete_file`, `replace_in_files` (approval)                                                                                                                                                                                                                                                                        | mixed    |
| `edit.ts`                  | `edit`, `multi_edit` (need a prior `read_file`; serialized per path)                                                                                                                                                                                                                                                                                                                                                                  | approval |
| `search.ts`                | `grep`, `glob`                                                                                                                                                                                                                                                                                                                                                                                                                        | auto     |
| `fetch.ts`                 | `fetch` (GET auto, POST approval; no JS execution)                                                                                                                                                                                                                                                                                                                                                                                    | mixed    |
| `shell.ts`                 | `bash_run`, `bash_background` (approval); `bash_logs`, `bash_list`, `bash_kill` (auto)                                                                                                                                                                                                                                                                                                                                                | mixed    |
| `terminal.ts`              | terminal: `suggest_command`, `read_terminal` (auto); `open_terminal`, `run_in_terminal`, `consolidate_terminals`, `group_tabs`, `rotate_pane`, `close_terminal` (mixed). browser: `open_browser`, `control_browser`, `navigate_and_read`, `read_browser`, `read_browser_console`, `browser_scroll`, `browser_hover`, `browser_screenshot` (auto); `browser_type`, `browser_click`, `browser_click_at`, `browser_press_key` (approval) | mixed    |
| `schedule.ts`              | terminal/schedule listing + send (auto); `run_in_terminal_by_id`, `schedule_command` (approval)                                                                                                                                                                                                                                                                                                                                       | mixed    |
| `subagent.ts`              | `run_subagent` (one), `run_subagents` (bounded-concurrency `depends_on` DAG, cascade-skip)                                                                                                                                                                                                                                                                                                                                            | auto     |
| `skill.ts`                 | `skill` (loads an installed `SKILL.md`; hidden when none installed)                                                                                                                                                                                                                                                                                                                                                                   | auto     |
| `todo.ts`                  | `todo_write`                                                                                                                                                                                                                                                                                                                                                                                                                          | auto     |
| `mcp.ts` / `extensions.ts` | MCP-server and extension-contributed tools, merged before built-ins so neither can shadow `bash_run`                                                                                                                                                                                                                                                                                                                                  | approval |

Approval-gated tools pause and render an in-UI card; AI-proposed edits open in a
side-by-side `ai-diff` tab accepted/rejected per hunk before any write.

**Sub-agents** (`agents/registry.ts`, single on/off in Settings -> Agents): ten
named agents in four categories. Exploration (`comet`, `nebula`) and advisor
(`nova`, `orbit`, `eclipse`, `vega`) and media (`aurora`) are read-only; workers
(`odyssey`, `zenith`, `meteor`) also edit files and run commands, auto-approving
mutations because a `generateText` loop has no approver, and are bounded instead by
the deny-list, out-of-scope refusal, and checkpointing. Recursion is structurally
impossible (`run_subagent` is never built inside a sub-agent). Every built-in
prompt, and per-agent model and temperature, is user-overridable via `prompts.ts`.

**Live-context bridge**: App.tsx `setLive({...})` lets tools read the active
terminal's cwd + scrollback lazily and drive terminals and browser panes; the
per-turn `<env>` block carries `workspace_root`, `active_terminal_cwd`,
`active_file`, and the open terminal and browser lists.

## Extension ecosystem

Extensions are runtime-installed JS packages: `manifest.json` + optional
`extension.js` (`activate(ctx)` / `deactivate()`) + assets, at
`<app_data_dir>/extensions/<id>/`. Two install channels only (generic HTTPS-URL
installs were removed): a local `.zip` (`ext_install_from_zip`) or a GitHub
`owner/repo` release (`ext_install_from_github`). `loader.ts` boot-scans, mints a
fresh Blob-URL module per activation, and calls `activate(ctx)`. Full author
guide and manifest schema: [extensions/README.md](extensions/README.md).

**Host `ctx` surface** (`host.ts`, every gated method checks its permission):
`storage`, `os`, `logger` (no gate); `app.getContext/onContextChange/
setSidebarVisible` (no gate) and `app.createWorkspace/setActiveWorkspace`
(`workspaces:manage`); `settings` (`settings:read|write`); `invoke` /
`invokeChannel` (`invoke:<cmd>`, globs ok); `secrets.get/set/delete`
(`secrets:read|write`); `events.emit/on` (`events:emit|listen`); `ui.toast`
(`ui:toast`) and `ui.mountFolderTree` / `ui.icon` / `ui.codeEditor` (no gate);
`statusBar` / `headerBar` / `sidebar` (`statusbar|headerbar|sidebar:write`);
`editor.getActive/setActiveContent` (`editor:read|write`);
`tabs.openExtensionTab/openExtensionPane` (`tabs:open`); `ssh.*`
(`ssh:connections`); `shell.registerCommandTransformer` (`shell:transform`);
`panel.*` + `registerPanelRenderer` + runtime `contribute.panels`
(`panels:register`; a manifest `contributes.panels[]` entry is seeded ungated);
`ai.getState/onStateChange/stop` + `paths.home` (none), `ai.setModel/
setSubagentsEnabled` (`ai:configure`), `ai.sendPrompt` (`ai:prompt`).
Plus `*` for power-user installs. Per-id namespacing: settings `ext:<id>:<key>`,
events `ext://<id>/<name>`, storage `tedi-ext-<id>.json`, keychain
`tedi-ext:<id>`. `secrets_get_all` (plus `secrets_get/set/delete`) and the five
`ext_install_from_zip|_from_github|ext_enable|ext_disable|ext_uninstall`
commands are hard-denied even with `*`. Raw
`@tauri-apps/api` imports bypass the gate: the trust boundary is install-time
review, backed by a consent gate that refuses any permission the review dialog
did not show.

**Contribution registries** (`registries.ts`, `KeyedRegistry<T>` base):
`settingsRegistry`, `statusItemsRegistry`, `headerItemsRegistry`,
`sidebarSectionsRegistry`, `panelsRegistry` (+ `panelRenderersRegistry`),
`commandsRegistry` + `keybindingsRegistry` (rebindable in Settings -> Shortcuts),
`shellTransformersRegistry`, `aiToolsRegistry`. Removed categories
(`slashCommands`, `themes`, `editorThemes`) still install via `.passthrough()`
but render nothing.

**Reference extensions** live in their own repos and ship in no binary. The
`extensions/` folder here is gitignored (only `extensions/README.md` is
committed) and holds working copies for local iteration:

| Extension                    | Demonstrates                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tedi.beautify`              | `headerbar:write`, `editor:read/write` round-trip, native sidecar, multi-language formatting.                                                                                                   |
| `tedi.discord-rich-presence` | `app.onContextChange`, `statusbar:write`, gated `invoke`, idempotent `deactivate`.                                                                                                              |
| `tedi.sql-explorer`          | `panels[] surface:"tab"` + `tabs:open`, `settings:*`, `secrets:*`, `ctx.ui.codeEditor`, sidebar connection list.                                                                                |
| `tedi.api-client`            | Postman-style API workbench. `invoke:http_stream`/`http_abort` as the whole backend (no sidecar), two `ctx.sidebar` sections, `ctx.storage` for bulk data + `ctx.secrets` for secret variables. |
| `tedi.secondary-folder-tree` | `panels[] surface:"right"`, `commands` + `keybindings`, `ctx.panel.toggle`, `ctx.ui.mountFolderTree`.                                                                                           |
| `tedi.screenshot`            | Status-bar toggle + capture-phase click interception, native sidecar.                                                                                                                           |
| `tedi.rtk-bridge`            | `shell:transform` rewriting every AI shell command.                                                                                                                                             |
| `tedi.remote-access`         | Browser mirrors of live TEDI terminals via a self-hosted relay.                                                                                                                                 |

**Local dev loop**: `pnpm tauri:dev:ext` symlinks each `extensions/<id>/` into
the dev profile's app-data dir (`link:ext` / `relink:ext` / `unlink:ext` manage
links; dev profile only). Edits to `extension.js` picked up on window reload, no
re-install.

## Formatters (format on save)

Two pipelines under one prefs schema (`editor/lib/formatters/`). `builtin`
(`prettier.ts`): lazy-imports Prettier 3 standalone + only needed plugins;
supported parsers in `lang.ts` (JS/TS/JSX/TSX, JSON/JSONC, CSS/SCSS/LESS,
HTML/Vue, YAML, Markdown, GraphQL); project config from `.editorconfig` +
`.prettierrc(.json|.json5)` / `package.json#prettier` walked up from the file.
`external` (`external.ts` -> `fmt_run_external`): direct-spawn, `${file}`
temp-file mode or stdin mode, `cwd = dir(file)`, 15 s timeout, presets for 30+
tools. Resolution: `languageFromPath` -> `formatters[lang]` (per-language
`formatOnSave` overrides global) -> dispatch. Failures toast and fall through to
a plain save; formatting never blocks persistence. Not supported in builtin mode:
`.prettierrc.{js,cjs,mjs,yaml,yml}` (use `external` + `prettier --stdin-filepath
${file}`).

## Conventions and patterns

- **Icons**: `lucide-react` imported by name (`import { Search } from
"lucide-react"`). Brand marks: `components/BrandIcon.tsx`. Dynamic/extension
  icons: `lib/iconRegistry.ts` `resolveExtIcon` (accepts `lucide:<Name>` and
  legacy `hugeicon:<Name>`).
- **Styling**: Tailwind v4 (`src/App.css` `@theme`, no `tailwind.config.*`);
  `cn()` from `@/lib/utils`. shadcn/ui + AI Elements are generated, not hand-edited.
- **Imports**: always `@/...`, never relative across modules.
- **Paths**: split with `.split(/[\\/]/)`; canonical frontend form is
  forward-slash (convert `homeDir()` backslashes at the boundary). OSC 7 arrives
  forward-slash after `parseOsc7` strips the `/C:` drive prefix.
- **Terminal input**: send `\r` (CR) for Enter, not `\n` (PowerShell needs CR).
- **Cross-platform**: HOME/cache via the `dirs` crate, never raw env vars.
- **`AiComposerProvider` is mounted unconditionally** at the App root: a
  conditional wrapper would change the parent element type when keys load and
  remount the tree (respawning every PTY).
- **Window styling**: macOS native traffic lights via Overlay title bar; Linux +
  Windows are borderless with React `WindowControls`. Windows adds
  `apply_windows_frame_fixes` (main window only) for maximize-clamp and minimize.
- **Docs and prose**: avoid em-dashes; use commas, colons, or parentheses.

## Development workflow

- **Checks before commit**: `pnpm exec tsc --noEmit` and, in `src-tauri`,
  `cargo check && cargo clippy` (clippy is `-D warnings` in CI). Rust tests:
  `cargo test`.
- **Dev**: `pnpm tauri:dev` uses `tauri.dev.conf.json` (bundle id
  `id.ilhamrisky.tedi.dev`), so workspaces/extensions/PTY socket/logs all read
  from the `.dev` data dir and cannot stomp the installed release. `pnpm tauri
dev` shares prod data. The daemon outlives the dev GUI; set
  `TEDI_PTYD_IDLE_SECS=60` when iterating on daemon code.
- **`tedi` CLI** (`cli.rs`): `tedi .` / `tedi <path>` opens a folder or file in
  the running window (single-instance forward, `tedi:open-cli-target` event).
  `tedi cmd <id>` rides the same forward to run a command registry id
  (`tedi:run-command`) - the only automation channel that reaches a session
  already running, since `TEDI_DEBUG_PORT` (below) must be set before launch.
  Fire-and-forget: the forwarding process exits on handover, so a miss reports
  as a toast in the window, not on the caller's stdout.
  `--version` / `--help` print and exit before Tauri boots. `tedi ext <sub>`
  (`cli_ext`), `tedi theme <sub>` (`cli_theme`), and `tedi --update` (`cli_update`,
  headless updater) each short-circuit GUI boot. On Windows the user-facing `tedi`
  is the console-subsystem launcher in `tedi-cli/`. A PATH shim
  (`~/.local/bin/tedi` on macOS/Linux) is installed from Settings and self-heals
  on launch.
- **MCP server** (`scripts/mcp/`): how an outside AI CLI drives a RUNNING TEDI.
  `server.mjs` speaks JSON-RPC over stdio and reaches the window through one of
  **two transports** (`transport.mjs` picks per call) - **20 tools**, or
  `pnpm mcp <verb>` by hand.
  - **The local socket is the default** (`mcp_bridge.rs` <-> `socket.mjs`): a
    named pipe on Windows, a unix socket elsewhere. Every platform, many clients
    at once, authenticated by a per-run token, no restart to enable. It calls
    capabilities by name in the app's own realm - the registry in
    `modules/automation/bridge.ts`, which seven files register into and which
    `window.__tedi` is now merely a view of.
  - **CDP is pulled up lazily**, only for real keyboard/mouse input, window
    capture and DOM reads, because a synthetic DOM event is not a trusted one.
    Windows-only, one client, unauthenticated, needs the debug port - which is
    why it is no longer the way in, only the way to do those five things. A
    session that never calls `keys` / `type_text` / `click` / `drag` /
    `screenshot` / `eval_js` / `state` / `read source:"dom"` opens no DevTools
    connection at all. Real keys and mouse, any
    command id, and it reads back what it did. `state` returns EVERY pane in EVERY
    tab from the tab tree (not the DOM), each with its cwd / ssh host / running AI
    CLI / open file / owning extension, so a driver can target or wait on a pane in
    a tab it is not looking at; `sh` runs a command in one and returns the output;
    `wait_for_terminal` blocks until a pane is back at its prompt (or prints a
    string) instead of polling. Neither a terminal (WebGL canvas) nor a long file
    (CodeMirror virtualises) can be read from the DOM, so both go through
    `window.__tedi`, which **six** files now contribute to. **Private panes are
    absent from all of it**, the same rule `app/lib/terminalSnapshot.ts` enforces
    for the built-in agent.
  - **Beyond panes**: `inspect` lists commands / extensions / **settings** /
    **logs**; `set_setting` writes a preference live (via the store, because the
    Settings page is a separate webview nothing here can click); `extension`
    enables, disables, reloads, updates or uninstalls one. **Installing is
    refused** - new third-party code goes through the user's permission review.
    No API key can come back: keys live in the keyring, never in the store.
  - **Efficiency is a design constraint, not an afterthought.** The tool list is
    loaded into every request of every connected AI CLI, so `inspect`/`read` are
    single verbs with an enum instead of seven tools, and `state` no longer
    returns its 60-entry button list unless asked. Every terminal read REDUCES IN
    THE PAGE - a tail, a substring test, a buffer hash - so a poll loop ships back
    an answer instead of ~20KB of scrollback per pane; `state` went from four
    DevTools round trips to one.
  - **ONE DEFINITION, TWO TRANSPORTS.** `scripts/mcp/tools.mjs` holds every tool
    name, pack, description and JSON Schema, and BOTH servers read it: the stdio
    one above, and the in-process one TEDI's own agent talks to
    (`ai/lib/tediMcpServer.ts`, an SDK `Server` over `InMemoryTransport`). The
    file imports nothing, because it ships as a bundle resource beside
    `server.mjs` with no `node_modules`; the app reaches it through the `@mcp/`
    alias. Handlers stay separate - one drives the window over CDP, the other
    calls the same functions in its own realm - but the CONTRACT cannot drift.
    It used to: both sides declared their own schemas, and `ssh` ended up meaning
    `{action, id}` on one and `{connectionId}` on the other, so the documented
    call silently LISTED connections instead of opening one. `driver-verify`
    now asserts the rule directly - `tediMcpServer.ts` may declare no description
    or schema of its own - rather than diffing two hand-kept name lists.
  - **The stdio server is NOT the route for TEDI's own agent.** Pointing it there
    would spawn node and connect back over CDP to the page it already runs in,
    would break whenever the automation port is off (the default), and would
    fight the user's real CLI for the single DevTools client slot.
  - **The pack switches are enforced at CALL time**, on both transports. The
    stdio server used to filter only `tools/list`, so a switched-off tool -
    `eval_js` included - still ran when called by name, against the exact client
    the switch exists to constrain. `set_setting` likewise cannot write
    `approvalMode`, `disabledTools`, the provider base URLs or `terminalEnvPath`
    (`AGENT_DENIED_PREFS`): those decide what the agent may do and where its
    credentials go, so an agent must not be able to re-grant itself either.
  - **Turning it on**: `TEDI_DEBUG_PORT=9222` before launch, or the header's
    **Install MCP** button, which writes `automationPort` into the settings file
    for Rust to read at startup (`modules/automation.rs`) and registers the
    server with Claude Code / Codex / Gemini / opencode / GitHub Copilot CLI /
    Cursor, plus a project `.mcp.json`. Entry shapes were checked against the
    real config files, which is how the Codex writer learned that a server owns
    its nested `[mcp_servers.<id>.tools.*]` sub-tables. One switch
    governs both halves - the port AND the `window.__tedi` flag - in dev and
    release builds alike, so an ordinary launch has neither. It takes effect on
    the NEXT launch (WebView2 fixes its browser arguments before the first
    webview exists), and the button's dot says so rather than pretending.
    It does not record video.
- **Release**: tag push triggers `.github/workflows/release.yml`, which builds
  signed updates (`TAURI_SIGNING_PRIVATE_KEY*` secrets) and a draft GitHub Release.

## Recent capabilities

- **PTY daemon** persistence across window close, with scrollback replay.
- **Native-webview `browser/` preview**: real WebView2/WebKit, not an iframe, so
  logged-in apps, DRM video, WebSockets, and HMR work. The agent drives it with a
  full tool set and can read the page's **console errors** (`read_browser_console`),
  which closes the run-it, see-it-break, fix-it loop.
- **Skills** (`SKILL.md` folders, progressive disclosure) and **MCP** (stdio).
- **Sub-agent DAG orchestration** (`run_subagents` with `depends_on`), ten agents.
- **Plan mode** (`>plan`) queuing mutations into one review diff.
- **Autocomplete on any provider**, including local (LM Studio, Ollama, llama.cpp,
  vLLM); a loopback endpoint needs no API key.
- **Voice input** in the composer and status bar (OpenAI whisper-1 transcription;
  needs an OpenAI key).
- **Format-on-save** with built-in Prettier and 30+ external presets.
- **SSH ProxyJump** chaining, SFTP explorer, and read-only remote source control.
- **Command Palette** (Ctrl+Shift+P) over a shared command registry.
