# TEDI.md

Workspace-root agent memory (loaded like `AGENTS.md` / `CLAUDE.md`) **and** the living architecture doc. Read before changing code; update when architecture shifts.

## Project

**TEDI** — Terminal Environment & Development Infrastructure. Lightweight cross-platform terminal with split panes, tab groups, workspaces, and a BYOK AI agent. Forked from [Crynta/Terax v0.5.9](https://github.com/crynta/terax-ai/releases/tag/v0.5.9).

| | |
|---|---|
| Stack | Tauri 2 + Rust (`portable-pty`) ⇄ React 19 + TS + xterm.js (webgl) |
| Bundle id | `id.ilhamrisky.tedi` |
| Keychain service | `tedi` |
| Package manager | **pnpm** |
| Platforms | macOS, Linux, Windows |
| Frontend check | `pnpm exec tsc --noEmit` |
| Rust check | `cd src-tauri && cargo check && cargo clippy` |
| Build | `pnpm tauri build` |
| Dev | `pnpm tauri dev` |
| Auto-updater | **Enabled** — signed updates via GitHub Releases (6h poll) |

## Architecture: two-process model

The webview never touches OS resources directly. Everything goes through `invoke()` → Tauri commands registered in [src-tauri/src/lib.rs](src-tauri/src/lib.rs).

### Rust (`src-tauri/src/modules/`)

| Module | Files | Commands | Purpose |
|---|---|---|---|
| `pty/` | `session.rs`, `shell_init.rs`, `job.rs`, `scripts/` | `pty_open/write/resize/close` | Long-lived interactive PTYs (xterm ↔ portable-pty). State: `RwLock<HashMap<id, Session>>`. Streams output via Tauri `Channel<PtyEvent>`. |
| `fs/` | `tree.rs`, `file.rs`, `mutate.rs`, `search.rs`, `grep.rs` | `fs_read_dir`, `list_subdirs`, `fs_read_file`, `fs_write_file`, `fs_stat`, `fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_delete`, `fs_search`, `fs_grep`, `fs_glob` | Explorer + editor IO; fuzzy finder + content search (powered by `ignore` + `grep-*` crates). |
| `shell/` | `session.rs`, `background.rs`, `ringbuffer.rs` | `shell_run_command`, `shell_session_open/run/close`, `shell_bg_spawn/logs/kill/list` | One-shot exec for AI tools (Windows: `pwsh -NoProfile -Command`; Unix: `$SHELL -lc`), persistent agent shell with state, and long-running background processes with bounded ring-buffer logs. **Distinct from interactive PTYs.** |
| `secrets.rs` | — | `secrets_get/set/delete/get_all` | OS keychain (`keyring` crate). Service = `tedi`. Linux falls back to a file store gated by `#[cfg(target_os = "linux")]`. |
| `net.rs` | — | `http_ping` | Minimal HTTP probe (dev-server detection etc.). |
| `lib.rs` | — | `open_settings_window` | Spawns the Settings webview. |

### PTY shell integration

Init scripts in [src-tauri/src/modules/pty/scripts/](src-tauri/src/modules/pty/scripts/) bootstrap shells to emit:
- **OSC 7** — cwd updates.
- **OSC 133 A/B/C/D** — prompt/command/output/exit-code boundaries (no prompt re-parsing needed).

| Platform | Shells | How injected |
|---|---|---|
| Unix | zsh (`zshenv/zprofile/zlogin/zshrc`), bash (`bashrc.bash`), fish (`init.fish`) | `ZDOTDIR` (zsh), `--rcfile` (bash) |
| Windows | pwsh 7+ → powershell 5.1 → cmd (no integration) | `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File profile.ps1`. Wraps the user's `prompt` fn **after** `$PROFILE` runs to emit OSC 7 + 133 A/B/D. |

[pty/shell_init.rs](src-tauri/src/modules/pty/shell_init.rs) is split into `#[cfg(unix)]` / `#[cfg(windows)]` modules — keep new platform code in the right arm.

#### Windows-specific gotchas

- **`SPAWN_LOCK`** ([session.rs](src-tauri/src/modules/pty/session.rs)) — `Mutex` around `openpty + spawn_command`. Concurrent ConPTY spawns stall the output pipe of one PTY. Don't remove without verifying first-tab stability under fast tab spam.
- **Job Objects** ([job.rs](src-tauri/src/modules/pty/job.rs)) — each ConPTY child is assigned to a per-session Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When the Job HANDLE drops (clean shutdown, panic, even SIGKILL'd TEDI), the kernel kills every descendant (e.g. `npm run dev` inside pwsh). Without it Windows orphans the whole subtree because `TerminateProcess` only kills the immediate child. `portable-pty::killer.kill()` only kills the immediate child too — the Job catches the rest.
- **Cwd normalization** — `CreateProcessW` misbehaves with forward-slash cwd. Normalize to backslashes before passing to ConPTY (`apply_common` handles PTY spawn; other call sites must normalize themselves).

macOS/Linux rely on `Drop for Session → killer.kill()`. Dev-time `Ctrl-C` on `cargo run` skips destructors → orphans possible there too. Acceptable for dev.

### Frontend (`src/`)

Single-window React app, path alias `@/*` → `src/*`. Tabs are a tagged union (`{ kind: "terminal" | "editor" | "preview" | "ai-diff", … }`) and **not** unmounted on switch — hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

[App.tsx](src/app/App.tsx) is a coordinator only — features live in `src/modules/<area>/`.

**`AiComposerProvider` is mounted unconditionally at the App root.** A conditional wrapper would change parent element type when keys load, remounting the entire tree (re-spawning every PTY) the moment `getAllKeys()` resolves. Prod dodges this because keychain reads sometimes land in the same paint frame; dev didn't. Keep the unconditional wrap.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, owns its hooks under `lib/`. **13 modules:**

| Module | Role |
|---|---|
| **terminal/** | `TerminalPane` keeps one mounted xterm per tab via `lib/useTerminalSession` + `lib/pty-bridge`. `lib/osc-handlers.ts` parses OSC 7 (with Windows drive-letter normalization: `/C:/Users/foo` → `C:/Users/foo`) and OSC 133. Themes in `lib/themes.ts`. |
| **editor/** | CodeMirror 6 stack (`EditorPane` mirrors `TerminalPane`). `lib/extensions.ts` configures language modes; `lib/autocomplete/` provides AI inline completion. Vim mode + prebuilt themes (Tokyo Night, Nord, GitHub, Atom One, Aura, Copilot, Xcode). |
| **explorer/** | File tree with Material/Catppuccin icons (`lib/iconResolver.ts`), fuzzy search, keyboard nav, inline rename, context actions. Backslash-aware `basename`. |
| **panes/** | Split-pane orchestration. `PaneStack` + `PaneTreeView` manage horizontal/vertical splits using `react-resizable-panels`. |
| **workspaces/** | Workspace persistence + switching (`store.ts`, `serialize.ts`). |
| **preview/** | Auto-detected dev-server preview tab; status-bar pill suggests opening when a `localhost` URL is detected. |
| **tabs/** | `lib/useTabs` is source of truth for tab list + active id. `lib/useWorkspaceCwd` derives explorer root + inherited cwd for new tabs. `basename` splits on **both** `/` and `\`. |
| **header/** | Top bar + inline search (`SearchInline` adapts to terminal vs editor via `SearchTarget`). `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (Linux + Windows; macOS uses native traffic lights). |
| **statusbar/** | Bottom bar, `CwdBreadcrumb` (Unix paths + Windows drive letters + `~` home via `lib/pathUtils.segmentsFromCwd`), AI tools indicator. |
| **shortcuts/** | Keymap registry (`shortcuts.ts`) + `lib/useGlobalShortcuts`. Handlers live in `App.tsx`, passed in by id (`tab.new`, `ai.toggle`, …). Use `metaKey \|\| ctrlKey` for cross-platform Cmd/Ctrl. |
| **settings/** | Settings store (`store.ts` via `tauri-plugin-store`), preferences hook (`preferences.ts`), settings window opener. |
| **theme/** | `next-themes` provider. |
| **ai/** | See AI subsystem below. |

> **Note:** OSC event handling lives inside `terminal/lib/`, not a separate `shell-integration/` module. `updater/` module hosts the in-app updater (status-bar pill + dialog) on top of `tauri-plugin-updater`.

### AI subsystem (`src/modules/ai/`)

BYOK, multi-provider via `@ai-sdk/*`: **OpenAI, Anthropic, Google, Groq, xAI, Cerebras, OpenAI-compatible** (LM Studio for local/offline). Provider list in [config.ts](src/modules/ai/config.ts) (`PROVIDERS`); model registry includes `DEFAULT_MODEL_ID` + `DEFAULT_AUTOCOMPLETE_MODEL`.

#### Keys

Stored only in the OS keychain via Rust `secrets_*` commands. `KEYRING_SERVICE = "tedi"`. **Never** persist keys to disk, settings store, or `localStorage`.

#### Core pieces (`lib/`)

| File | Role |
|---|---|
| `agent.ts` | `Experimental_Agent` with `stopWhen: stepCountIs(MAX_AGENT_STEPS)` + system prompt from `config.ts`. Provider branching lives here. Keep the `Agent` / `DirectChatTransport` shape — the rest depends on AI SDK v6 chat semantics. |
| `agents.ts` / `agents/registry.ts` / `agents/runSubagent.ts` | Named sub-agents with their own system prompts + tool subsets, invoked by the main agent via the `run_subagent` tool. |
| `sessions.ts` + `store/chatStore.ts` | Conversations organized into named sessions, persisted via `tauri-plugin-store` at `tedi-sessions.json` (list + `activeId` + per-session `messages:<id>` keys). Module-scoped `Map<sessionId, Chat<UIMessage>>`; `getOrCreateChat(apiKey, sessionId)` lazily constructs a `Chat`, seeded from `hydrateSessions()` (called once from App.tsx). `AgentRunBridge` mirrors active-session messages to disk on every change and derives titles from the first user message. Switching the API key wipes the chat map; sessions persist. |
| `composer.tsx` | React context: shared input state (text, attachments, voice) for both the docked `AiInputBar` and any other surface. Attachments: image, text-file, and `selection`. Selections come from `useChatStore.attachSelection(text, source)` (drained into chips, not pasted into the textarea) and wrap as `<selection source="terminal\|editor">…</selection>` blocks at submit. Composer derives `isBusy` from `agentMeta.status` so it mounts safely before sessions hydrate. |
| `transport.ts` | `DirectChatTransport` bridging AI SDK Chat ↔ Agent. |
| `security.ts` | **Deny-list** refusing obvious secret paths (`.env*`, `.ssh/`, credentials, keychain dirs). Applied on **both** read and write paths. Don't bypass. |
| `keyring.ts`, `native.ts` | Tauri command wrappers. |
| `slashCommands.ts`, `snippets.ts`, `placeholders.ts`, `todos.ts` | Composer affordances (slash commands, reusable prompt fragments, placeholders, in-conversation todos). |

#### Tools (`tools/`)

| File | Tools | Approval |
|---|---|---|
| `fs.ts` | `read_file`, `list_directory` | auto |
| `search.ts` | `fs_search`, `fs_grep` | auto |
| `edit.ts` | `write_file`, `create_directory`, `rename`, `delete` | **needsApproval** |
| `shell.ts` | `run_command`, `shell_session_run`, `shell_bg_spawn` | **needsApproval** |
| `terminal.ts` | Read live terminal buffer/cwd | auto |
| `context.ts` | Workspace context helpers | auto |
| `subagent.ts` | `run_subagent` | auto |
| `todo.ts` | Todo manipulation | auto |
| `tools.ts` | Orchestrator/aggregator | — |

Approval-gated tools pause via `lastAssistantMessageIsCompleteWithApprovalResponses`; auto-send after user confirms in the in-UI card.

**AI-proposed edits** open in a side-by-side diff tab (`ai-diff` kind, [src/modules/editor/AiDiffPane.tsx](src/modules/editor/AiDiffPane.tsx)); user accepts/rejects per hunk **before** the write tool actually runs.

#### Live context bridge

`App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the *currently active* terminal's cwd + last 300 lines. **Lazy by design** — don't pre-snapshot.

#### Voice input

Streamed transcription pipeline. Toggled from the composer.

## UI conventions

- **shadcn/ui** ([components.json](components.json) — style `radix-luma`, base `mist`, icons **hugeicons**). Primitives in [src/components/ui/](src/components/ui/) — don't hand-edit; re-run `pnpm dlx shadcn add` to upgrade.
- **AI Elements** (Vercel) in [src/components/ai-elements/](src/components/ai-elements/) via the `@ai-elements` registry. Same rule: regenerate, don't hand-patch — composition wrappers belong in `modules/ai/components/`.
- **Tailwind v4** — no `tailwind.config.*`; config is in [src/App.css](src/App.css) via `@theme`. Use `cn()` from [@/lib/utils](src/lib/utils.ts).
- Animation: `motion` (Framer Motion successor). Resizable layout: `react-resizable-panels`.
- Imports: always `@/…`, never relative across modules.
- **Path separators** — anywhere a path may originate from OSC 7, the explorer, or the OS, split with `.split(/[\\/]/)` not `.split("/")`.
- **Canonical path form on the frontend is forward-slash.** `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx `setHome`). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.

## Window styling

| Platform | Source | Behavior |
|---|---|---|
| macOS | `tauri.conf.json` | `titleBarStyle: Overlay` + `hiddenTitle: true` (native traffic lights via overlay) |
| Linux | `tauri.linux.conf.json` | `decorations: false` + `transparent: true`; re-asserted post-realize for GNOME/Mutter CSD |
| Windows | `tauri.windows.conf.json` | Same as Linux; React renders custom `WindowControls` |

## Tauri capabilities

[src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) is the allowlist for plugin APIs exposed to the webview. Adding a plugin requires **3 steps**:

1. `Cargo.toml` dependency.
2. `.plugin(...)` call in `lib.rs` `run()`.
3. Capability entry in `default.json` (and `desktop.json` if desktop-only).

Already wired: `dialog`, `autostart`, `window-state`, `store`, `opener`, `os`, `log`, `process`. Updater plugins are **removed**.

## Cross-platform conventions

- **HOME / cache dirs** — `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`). Never raw `$HOME` / `%USERPROFILE%`.
- **Shell init scripts** — gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- **Terminal input** — send `\r` (CR) for Enter, not `\n` (LF). PowerShell on Windows requires CR.

## Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS** — `minimumSystemVersion: 10.15`.
  - **Linux** — deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows** — NSIS installer in `currentUser` mode (no admin), WebView2 via `embedBootstrapper` (offline install).
- Auto-updater **enabled**: `tauri-plugin-updater` (Rust, desktop-only) + `@tauri-apps/plugin-updater` (JS). Endpoint is GitHub Releases `latest.json`; signature verified against `plugins.updater.pubkey` in `tauri.conf.json`. Private key + password injected as `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub secrets during release builds (see `.github/workflows/release.yml`).

## Known gotchas

- **React 19 strict-mode double-mount** — `useEffect` runs twice in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. `SPAWN_LOCK` serializes this. Don't panic at `pty opened id=1` → `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle** — `portable-pty::killer.kill()` only kills the immediate child. Descendants (e.g. `npm run dev` inside pwsh) survive unless something else kills them. The Job Object in [pty/job.rs](src-tauri/src/modules/pty/job.rs) handles the TEDI-process-death case; an explicit `pty_close` from JS also relies on the Job to kill descendants. Don't disable the Job without a replacement.
- **Tab `cwd` storage** — comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both. `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.
- **Don't mount `AiComposerProvider` conditionally** — see frontend section above.

## File map quick-reference

```
src-tauri/src/
  lib.rs                  ← all invoke_handler registrations
  main.rs
  modules/
    pty/{mod,session,shell_init,job}.rs + scripts/
    fs/{mod,tree,file,mutate,search,grep}.rs
    shell/{mod,session,background,ringbuffer}.rs
    secrets.rs
    net.rs

src/
  app/App.tsx             ← coordinator (NOT a feature dump)
  modules/
    ai/        editor/    explorer/   header/    panes/
    preview/   settings/  shortcuts/  statusbar/ tabs/
    terminal/  theme/     workspaces/
  components/
    ui/                   ← shadcn (don't hand-edit)
    ai-elements/          ← Vercel AI Elements (don't hand-edit)
```
