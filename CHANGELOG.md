# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.2.2] - 2026-05-18

The 0.2.x line rolled in over a single development burst, so the three patch releases that came out within 48 h are consolidated here for readability. Headline user-facing surface: **Restore checkpoint** (undo the agent's last turn), the **`tedi` CLI launcher** with cross-platform shim install (`tedi .` to open the current folder, `tedi --update` to trigger the in-app updater), **AI-generated commit messages** with one-click commit + push from the Source Control panel, **unified content zoom** scaling editor + diff + terminal together, and a **rebuilt updater UX** that surfaces errors instead of hiding them and lets you download + install directly from Settings without waiting for the status-bar pill. Under the hood: provider-aware prompt-cache adapter, paged `read_file`, PTY observability + spawn-race fixes that should kill the "terminal opens black forever" reports for good, and a project-wide Prettier + rustfmt sweep with zero behaviour change.

### Added

#### Updater & CLI
- **`tedi --update` / `-u`.** Triggers the in-app updater from the terminal. Works in two scenarios: (1) no instance running — the binary boots, drains `INITIAL_UPDATE_REQUEST` via `cli_take_initial_update_request`, opens the dialog and runs `checkForUpdate()` immediately; (2) instance already running — `tauri-plugin-single-instance` forwards argv, `lib.rs` emits `tedi:trigger-update`, `useUpdater`'s listener pops the dialog and re-checks. Windows `tedi.cmd` intercepts the flag, prints "Opening TEDI to check for updates...", then `start TEDI.exe --update`. Linux/macOS shims pass the flag through verbatim via `exec`. Frontend uses a `forceOpenSeq` counter so the dialog opens deterministically even when the updater state is `idle` / `checking`.
- **Settings → About: inline download + install.** "Check for updates" now exposes a full state machine inside the panel — `available` → "Download & install vX.Y.Z" button + release notes inline, `downloading` → progress bar + byte counter, `ready` → "Restart to apply vX.Y.Z". No more "see the status bar" indirection. Linux falls back to "Download vX.Y.Z" opening the GitHub release page since deb/rpm/AppImage can't be applied in-place. The `Update` plugin handle is held in `useRef` because it's a non-serialisable native object.
- **Updater dialog & pill surface errors.** Previously the pill only showed for `available` / `downloading` / `ready` — when a check failed (network, signature mismatch, corporate proxy) the pill stayed hidden and the user had no way to learn there was a problem. Now: error state lights up the pill in destructive colour with an AlertCircle icon and a tooltip showing the error message, the dialog offers a Retry button, and the dialog can render `idle` / `checking` states standalone when invoked via `--update` ("Checking for updates…" / "You're on the latest version of TEDI"). The 8 s startup-check timer now guards against state-clobbering when `tedi --update` fires first, so the downloading UI can't get wiped by a stale check that fires while the user is already installing.
- **`tedi` CLI launcher.** `src-tauri/src/modules/cli.rs` + `tauri-plugin-single-instance`: `tedi .` / `tedi <path>` opens a folder as the workspace root, `tedi <file>` adopts the file's parent as the root and opens the file in an editor tab. `--version` / `--help` short-circuit before GUI init so terminal users get plain stdout instead of a spawned window. When TEDI is already running, a second invocation forwards argv into the live window over `tedi:open-cli-target` (no duplicate window).
- **Windows installer shim (`src-tauri/installer.nsh`).** NSIS post-install hook writes a `tedi.cmd` next to `TEDI.exe`, appends the install dir to user `PATH` (`HKCU\Environment` + `WM_SETTINGCHANGE` broadcast) so freshly-spawned shells see `tedi` without logging out. `--version` / `--help` / `--update` are intercepted by the `.cmd` because the GUI binary is built with `windows_subsystem = "windows"` and has detached stdio. Pre-uninstall deletes the shim; the PATH entry is intentionally left alone.
- **Unix `tedi` shim install command (`cli_install_path_shim`).** Writes `~/.local/bin/tedi` with a `# tedi-cli-shim v1` marker, chmod 0755, and surfaces `on_path` to the UI so the user knows whether their shell will find it. The shim self-heals on launch via `cli::refresh_shim_if_present` — handles macOS `.app` relocations and AppImage filename changes that would otherwise leave the shim pointing at a moved binary. Windows returns `NotApplicable` since NSIS owns the shim there.

#### AI & agent
- **Restore checkpoint — "undo the agent's last turn".** A new `RestoreCheckpointButton` sits next to the most recent user message (hidden mid-stream) and rolls the session back to the pre-turn state: every file the agent mutated this turn is reverted to its original content, chat history is trimmed back to before the user prompt, and the read-cache is cleared so the next turn must re-read before editing. One checkpoint per session, opened on `sendMessage` and discarded on the next prompt (no arbitrary history travel). Mutating tools (`edit`, `multi_edit`, `write_file`, `create_directory`) and the plan-review apply path all record into the active checkpoint via `recordFileMutation`. **Files you've manually edited since the agent wrote are preserved** — restore compares the on-disk content against `writtenContent` per path and skips any divergence (created files: deleted only if untouched; created dirs: deleted only if still empty). Restore-in-progress races are guarded by a `restoringSessions` Set so a quick "Restore → Send" can't lose or interleave with a `messages = trimmed` mid-flight. Checkpoints live in-process only (not persisted across app restarts). New `fs_delete` Tauri command + `native.deletePath` bridge backs the create-file rollback path.
- **AI-generated commit messages.** `src/modules/scm/commitAi.ts`: the Sparkles button in the Source Control panel calls `generateCommitMessage()`, which pulls the staged + working-tree diff via the new `git_diff_full` Tauri command (capped at 80 KB ≈ 20 K tokens host-side), sends it through the currently active model (resolution mirrors App.tsx boot-restore: prefs `lastModelId/lastProviderId` → `defaultModelId` → chatStore → hardcoded `DEFAULT_MODEL_ID`), and returns a Conventional-Commit one-liner written into the panel's message input. 30 s timeout, never throws — falls back to a deterministic `fallbackCommitMessage` derived from the change mix.
- **Commit + push from the Source Control panel.** Message input, commit button (Enter), and push button. Backend gains `git_commit` (stages everything via `git add -A` then commits), `git_push` (uses upstream if set, else `push -u origin <branch>`), and `git_diff_full` — all in `src-tauri/src/modules/git/commands.rs`. Friendly stderr translation via `friendlyGitError` covers the common failure modes ("nothing to commit", missing identity, non-fast-forward, network/auth, `index.lock` held). Every op captures `startRoot` so switching folders mid-flight doesn't leak UI state into a different repo; HEAD changes detected during a session toast a "Switched to branch X" notice and the commit-message draft is preserved across branch switches.
- **Upstream tracking and ahead/behind counts in `git_status`.** Returns `upstream`, `ahead`, `behind` via `rev-parse @{u}` + `rev-list --left-right --count HEAD...@{u}`. Surfaced as up/down arrow chips in the panel header and as a numeric badge on the Push button when there are unpushed commits.
- **Per-change line stats in `git_status`.** `GitChange` gains `added` / `removed` / `binary`, populated by a single `git diff --numstat HEAD` call (handles both `old => new` and `dir/{old => new}/file` rename forms). Untracked files counted from disk with a 512 KB cap and a NUL-byte binary sniff (`count_file_lines`) so a 50 MB log file doesn't stall the panel.
- **Session token-usage display.** The context indicator popover gains a *Session usage* section showing cumulative **Input** / **Output** / **Cached (prompt cache hit)** tokens with a hit-rate percentage that turns emerald when ≥50%. New `SessionUsage` type on `agentMeta.usage` accumulated from per-step `onUsage` deltas (cached count comes from `inputTokenDetails.cacheReadTokens`, 0 on providers that don't report it). Reset on session switch / clear.
- **`read_file` paging.** `read_file` now accepts `offset` (0-based line) and `limit` (max 2000 lines, default 2000). The byte cap stays at 200KB as a final safety net, but trims to the last complete newline so the output is always parseable and `nextOffset` reflects the included line count. The compact pass keys reads by `path#offset:limit` so two paged reads of the same path are never collapsed as redundant.
- **Provider-aware prompt-cache adapter (`lib/cache.ts`).** Extracted the Anthropic cache-breakpoint placement from `agent.ts` into a provider-keyed registry. Marks three breakpoints on Anthropic requests — system message (caches system + tool schemas), last user message (conversation prefix up to current turn), last tool-result message (rolling write that advances each tool step) — for compounding savings on long tool loops. OpenAI / xAI / DeepSeek / SumoPod / Google rely on implicit prefix caching. Groq / Cerebras / LM Studio have no prompt cache (gateway is stateless).
- **Subagents now flow through `generateText` with cache breakpoints.** Switched from `Experimental_Agent.generate(...)` to `generateText({ messages, tools, stopWhen })` so we can inject Anthropic cache markers on the subagent's system/user messages too. Unknown subagent model ids fall back to SumoPod's runtime-discovery shape. `openaiCompatibleBaseURL` is plumbed through from preferences so subagents reach the same custom endpoint the main agent uses.
- **Subagent UI: real output rendering.** `run_subagent` now renders its result properly: the **type** chip + description label, the summary in a bordered card, and footer chips for step count + duration. Opens by default when a summary is present; auto-opens on error.
- **Lite system-prompt heuristic.** A regex pattern auto-picks the lite system prompt for runtime-detected models without registry entries (SumoPod auto-discovery, custom OpenAI-Compatible gateways, future models). Conservative on purpose — false positive loses some prompt detail, false negative costs a few hundred tokens.
- **Tools cache.** `buildTools(ctx)` is memoised per-context via a `WeakMap` — fresh chat session = fresh ctx = fresh build, but within a session the ~12 zod schemas don't get recreated on every user turn.

#### Editor / terminal / UI
- **Content-zoom shortcuts.** New `view.zoomIn` / `view.zoomOut` / `view.zoomReset` bound to Cmd/Ctrl+= (with or without Shift), Cmd/Ctrl+-, Cmd/Ctrl+0. New `Preferences.contentZoom` (clamped 0.5×–3.0×, 0.1 step, persisted). App.tsx exposes the factor as a `--content-zoom` CSS variable for CodeMirror surfaces; `useTerminalSession.ts` multiplies it into xterm's `fontSize` directly — deliberately NOT CSS `zoom`, which breaks xterm's canvas glyph positioning at non-integer factors. Editor, diff, and terminal scale together from one control.
- **`terminal.close` shortcut (Ctrl+Shift+X).** Closes the focused terminal pane, but blocked when it's the last terminal in the workspace so the user never ends up in an empty UI.
- **GitDiffPane polish.** Added/removed line-count chip, "HEAD → Working tree" header, "New file" / "Removed" badges, status-coloured variants per change type, shared `DIFF_THEME` matching `AiDiffPane`. `collapseUnchanged` removed — full file is always rendered so unchanged context is visible.
- **`Cmd/Ctrl+P` freed for future quick-open.** The tab-cycle binding moved to `Cmd/Ctrl+Alt+P`.
- **Per-tab-type accent stripe.** The 2.5px coloured stripe on the active tab is now per-kind: **emerald** local shell, **sky** SSH, **blue** file editor, **cyan** preview, **violet** AI diff, **amber** git diff. Painted by a child `<span>` rather than `data-state=active:after:` because the primitive `TabsTrigger` attaches its own `::after` that collides at equal specificity.
- **PTY spawn / no-data watchdogs.** Two new failsafes on the local-PTY codepath: (1) `withSpawnTimeout` rejects `pty_open` after **15 s** if it neither resolves nor rejects — funnels a hung spawn into the existing retry-banner path. If the underlying promise resolves later (the spawn did eventually complete) the stray PTY is closed so Rust doesn't leak. (2) `armNoDataWatchdog` fires after **5 s** of total silence post-`pty_open` — surfaces the case where ConPTY/profile init wedges after acking spawn but never emits a prompt.
- **PTY lifecycle debug traces.** Default-on console logging (`[tedi-pty]`) covers attach geometry, spawn success time, first-byte latency, and exit code/total bytes — makes "my terminal opens black" reports diagnosable from devtools. Silence with `localStorage.TEDI_DEBUG_PTY = "0"`.

### Changed
- **PTY observability + epoch correctness.** Backend logs `pty_open invoke` *before* `SPAWN_LOCK` so wedged ConPTY spawns finally leave a trail. `retryPty` / `respawnSession` rewritten to capture `myEpoch` *after* the synchronous `ptySpawnEpoch` bump in `openPtyForSession` and drop stale results, fixing a race where a duplicate retry could clobber the newer spawn. New `STUCK_RECOVERY_MS = 8 s` watchdog forces a `retryPty` / `retrySsh` when both `lastPtyError` and `pty` stay null past the 2 s container-settle budget — observed on workspace restore with split panes.
- **SCM panel header redesigned.** Branch + change count, ahead/behind chips, vertical separator, discard-all and refresh icons; clearer disabled/busy states; tooltips on every action.
- **Editor / diff / terminal scale together via `--content-zoom`** instead of each surface owning its own zoom logic — single source of truth, single shortcut group.
- **Read cache lives at module scope, keyed by sessionId.** The per-session "files the model has read" Set used to be captured inside `makeChat`'s closure; moved to a module-level `Map<sessionId, Set<string>>` so `restoreToLastCheckpoint` can clear it as part of the rollback. After a restore, the model's "I've read this" knowledge has to be revoked too — otherwise the next turn would let it `edit` a file it can no longer prove it read.
- **Subagent prompt is "heavy input" now.** `run_subagent` joins `write_file` / `edit` / `multi_edit` / `todo_write` in `HEAVY_INPUT_TOOLS` so its streamed input body isn't re-rendered on every token.
- **PTY size syncs on visibility flip.** `useTerminalSession`'s visible-flag effect now calls `syncPtySize(s)` on hidden→visible because `ResizeObserver` only fires on dimension changes — a session that fitted at the wrong size while hidden would never push the corrected `cols/rows` to the shell when shown.
- **Tab strip queue chip.** The "Queued" pill collapses to a single clock-icon prefix and the per-item amber number is dropped — the chip row already implies the order, the count was redundant noise.
- **Diff view runs without minimap.** `GitDiffPane` passes `showMinimap: false` — the merge view already has dual scrollbars and the unchanged-region collapser.
- **`src-tauri/Cargo.toml`** adds `tauri-plugin-single-instance = "2"`.
- **`package.json`** adds `prettier` + `prettier-plugin-tailwindcss` devDeps and new scripts: `format`, `format:check`, `lint:rust` (`cargo fmt --check && cargo clippy -D warnings`), `fmt:rust`.
- **`tauri.windows.conf.json`** now references `./installer.nsh` for the NSIS post-install hook.
- **Docs reformatted + CONTRIBUTING gained a "Formatting standard" section** documenting the new `pnpm format` / `pnpm fmt:rust` commands.

### Fixed
- **Updater pill silently hid errors.** When `check()` failed (network unreachable, signature mismatch, proxy blocking GitHub) the pill stayed invisible and the user had no diagnostic path. Now the pill lights up in destructive colour with the error message in tooltip + dialog.
- **No-data watchdog killing healthy shells.** The 5 s post-`pty_open` watchdog could fire on a shell whose prompt arrived between Rust handing back the spawn ack and the `invoke` promise resolving on the JS side (Tauri Channel `onmessage` is wired before the `await`, so bytes can land first). Fix: track `firstByteEpoch` per-session and refuse to arm the watchdog if bytes already arrived for that epoch.
- **Forever-blank terminal on workspace restore.** When a tab opened with two split panes, one could land in `lastPtyError === null && pty === null` simultaneously; the Enter-to-retry handler gates on `lastPtyError !== null`, so the leaf was silently dead. The new `STUCK_RECOVERY_MS` watchdog forces a recovery retry after 8 s of no PTY *and* no error.
- **Stale retries clobbering newer spawns.** `retryPty` / `respawnSession` now capture and check `ptySpawnEpoch` after the synchronous epoch bump in `openPtyForSession`, dropping late-arriving results from superseded spawns instead of stomping the newer session's state.
- **Tab accent stripe flicker in multi-tab / split layouts.** A 2nd-tab open used to silently break the stripe because the primitive `TabsTrigger`'s built-in `::after` and ours fought at equal specificity. Resolved by painting the stripe as a child `<span>` whose visibility is computed in JS.
- **Hung `pty_open` left panes black forever.** A workspace-restore race on Windows could land the `invoke("pty_open")` promise in a never-settle state. The new 15 s spawn timeout funnels it into the retry path.
- **Compact pass dropped distinct paged reads as redundant.** When the model read the same file with different `offset`/`limit`, the older pages got elided by the "same path read later" heuristic. Compact now keys reads by `path#offset:limit`.
- **NSIS installer crash on Windows runner.** `pnpm/action-setup@v6`'s self-installer crashed on `windows-2025` runners with `STATUS_STACK_BUFFER_OVERRUN (0xC0000409)`. Pinned to `@v4` which uses a different install mechanism that works on all platforms.
- **Installer `${StrStr}` resolution.** Switched from `nsis_tauri_utils::FindInString` to NSIS's bundled `StrFunc.nsh` `${StrStr}` macro — the former is not available in Tauri's NSIS template.
- **TabBar narrowing + cli `ShimInstall::NotApplicable` dead-code warning.** Cleared release-time clippy / TS warnings that broke CI green.

### Removed
- **`AgentUsageDelta.lastInputTokens` / `lastCachedTokens`.** Per-step "last" fields are no longer surfaced from the agent loop — cumulative totals are computed in `chatStore` from per-step deltas.
- **`DEFAULT_SUBAGENT_MODEL` export and the legacy `extractText` helper** from `runSubagent.ts`. The new `generateText` path has typed `result.text` / `result.steps` so the response-shape-juggling code is gone.
- **Inline `applyCacheBreakpoints` in `agent.ts`.** Moved to `lib/cache.ts`; agent.ts now imports the registry instead of carrying its own provider-conditional.

### Internal / Tooling
- **Project-wide Prettier sweep (~170 files).** New `.prettierrc.json` (semi, double quotes, 2-space, printWidth 100, trailing comma `all`, LF, `prettier-plugin-tailwindcss`). Future contributors run `pnpm format` once and CI is happy.
- **`rustfmt.toml`** — edition 2021, max_width 100, tab_spaces 4, `use_field_init_shorthand`, `use_try_shorthand`, `reorder_imports`, `reorder_modules`. Applied across the Rust tree.
- **`.editorconfig`** — 2-space default, 4-space for `*.{rs,toml}`, tab for Makefile, LF + UTF-8 + final-newline + trim-trailing-whitespace (markdown excluded so deliberate trailing spaces survive).
- **`.gitattributes`** — forces LF on TS/Rust/etc. sources, CRLF on `*.{bat,cmd,ps1,nsh}`, marks `pnpm-lock.yaml` and `Cargo.lock` as generated so GitHub collapses them in diffs.
- **`.prettierignore`** — build output, lockfiles, `src-tauri/target` / `gen`, `CHANGELOG.md`, `LICENSE`, `NOTICE`.

## [0.1.9] - 2026-05-16

### Added
- **Preview proxy (`tedi-frame://`).** A new custom URI scheme proxies arbitrary HTTP(S) URLs and strips `X-Frame-Options` / `Content-Security-Policy` (plus `*-COOP/COEP/CORP`, `Set-Cookie`, HSTS, stale `content-encoding`) so the in-app preview pane can embed public sites that would otherwise refuse to render in an iframe. Implementation uses Tauri 2's stable `register_asynchronous_uri_scheme_protocol` (no localhost port, no unstable `add_child`). The address bar gains a **shield toggle** to flip between proxied and direct loads; in-page link clicks and GET form submissions are re-routed back through the proxy so navigation stays inside the iframe, and a 25 MB body cap + 20 s upstream timeout keeps the scheme from being a runaway DoS surface. Spoofs a current desktop Chrome UA so UA-gated sites give us the desktop layout.
- **Bundled Nerd Font.** `JetBrainsMono Nerd Font Mono` (regular + bold woff2, ~2 MB total) ships with the app under `public/fonts/` and is **always prepended** to the terminal/editor font chain via `@font-face` in `globals.css`. Oh-my-zsh / Powerlevel10k / Starship glyphs and developer-icon ligatures render correctly out of the box even when the host OS has no Nerd Font installed. `font-display: swap` so the prompt isn't blank during the ~100 ms it takes the woff2 to land.
- **CJK font fallback chain.** The default mono family now appends pan-CJK Noto + Windows YaHei/JhengHei/Meiryo/MS Gothic/Malgun Gothic + macOS Hiragino / PingFang / Apple SD Gothic Neo for per-glyph fallback. Korean / Japanese / Chinese characters get real glyphs instead of tofu when the primary coding font lacks them; the CSS engine silently skips missing families so listing OS-specific names in one chain is safe.
- **Terminal copy / paste shortcuts.** `Ctrl+Shift+C` copies the current xterm selection (no-op when nothing is selected; bare `Ctrl+C` still sends SIGINT), and `Ctrl+Shift+V` pastes through xterm's `term.paste()` so the shell sees a **bracketed paste** and multi-line snippets aren't executed line-by-line under bash/zsh. New `Terminal` shortcut group in Settings → Shortcuts, both bindings rebindable.
- **Layout-independent shortcut matching.** New `canonicalKey()` helper folds `KeyboardEvent.code` (`KeyT`, `Digit5`) into the canonical `"t"` / `"5"` form before comparing against bindings. Fixes two real-world breakage cases: (1) macOS `Option+Z` used to emit `key: "Ω"` and never match a stored `{ alt: true, key: "z" }`; (2) on non-Latin layouts (Cyrillic, Greek, Arabic, Devanagari) the same physical "T" key fired `key: "т"` so the default Latin bindings didn't work at all. Punctuation, function keys and named keys still match on `e.key`. The Settings → Shortcuts recorder also stores the canonical form, so a binding captured on a Mac or a Cyrillic layout replays correctly.
- **PTY spawn-crash recovery.** A new 3-second `SPAWN_GRACE_MS` window catches shells that exit with a non-zero code shortly after spawn (transient ConPTY init failure, profile script error, a workspace-restore race disposing the wrong leaf). Instead of forwarding the exit and silently shrinking the restored layout, the leaf is held in place with a retry banner so the user can recover with Enter.
- **Spawn-epoch race guard for terminal respawn.** A per-session `ptySpawnEpoch` counter is bumped on every `openPtyForSession`; late `onExit` events for a superseded PTY now detect `myEpoch !== s.ptySpawnEpoch` and bail out before touching state owned by the newer spawn — fixes spurious "shell exited" banners that could fire on the new PTY when an old one died mid-respawn.
- **Source Control panel toggle.** New `showSourceControl` preference (default on) in Settings → General lets users hide the SCM sidebar panel; reduces sidebar clutter for users who don't want the panel and don't open repos.
- **Tab right-click context menu.** Tabs gain a right-click menu carrying **Close**, **Close Others**, **Close All**, plus per-pane **Move to group** submenu and **Toggle Split Orientation**. The inline rotate-split and move-to-group buttons that used to live in the tab strip have been removed in favour of the menu, so the strip stays uncluttered at narrow widths.
- **SQL syntax highlighting in AI chat code blocks.** Lezer/CodeMirror modes for `sql`, `pgsql`, `mysql`, `sqlite` with aliases for `postgres` / `postgresql` / `plpgsql` / `psql` / `mariadb` / `sqlite3`. AI-generated `` ```sql `` blocks render with proper highlighting now.

### Changed
- **PTY size floor.** Every resize that crosses the bridge to the backend is now floored to `MIN_PTY_DIM = 2` (cols and rows). xterm's `FitAddon` briefly computes 0×0 or 1×1 dimensions when a container collapses during a drag, layout transition or hidden-tab switch; pushing those through to the PTY would leave TUIs (nvim, btop, nano) unrecoverable until the next resize event happened to fire. The floor + de-dup + bookkeeping are now centralised in one `syncPtySize()` helper used by every callsite (initial attach, ResizeObserver tick, font-size effect, retry, respawn, SSH reconnect) so the behaviour is identical everywhere.
- **IME composition guard for `Ctrl+Backspace`.** Pressing `Ctrl+Backspace` mid-composition no longer injects `\x17` into the PTY and corrupts the on-screen buffer; mid-composition keys (`isComposing` true or legacy `keyCode === 229`) now defer entirely to the browser/IME. Affects Japanese candidate-delete, Hangul jamo correction, and similar two-stage input on every IME the platform exposes.
- **Active-tab pane wrapper paints `bg-background`.** Without this, WebView2 was still compositing `.xterm-viewport`'s native scrollbar from a *hidden* tab on top of the visible one — especially obvious when the inactive tab was split and the inter-pane scrollbar landed mid-workspace. The active wrapper now fully covers any inactive tab underneath.
- **Tooltip refactor across the UI.** Replaced raw `title="…"` attributes with proper Radix `Tooltip` for: tab close button, SCM branch / file rows / discard button, file-explorer search / grep buttons, workspaces tab-count chip, AI input chips and attachment rows, AI status-bar pin/unpin button, chat-code "Run in terminal" button, AiDiff / GitDiff path label, model dropdown remove-key button. Consistent positioning, dark-mode contrast and accessibility — keyboard focus shows the same tooltip the pointer does.
- **Preview empty-state copy** rewritten to reflect the proxy: "public sites are routed through TEDI's strip-XFO proxy so they render inline — toggle it off with the shield button if a site looks broken." The old amber XFO hint banner is gone (proxy makes it stale).

### Fixed
- **Stray `- -` line in README.md** between the *Quality* section and the *Configure AI* heading. Looked like a paste accident.

### Removed
- **`fs_stat` Tauri command** and its `FileStat` / `StatKind` types — no remaining frontend callers; explorer / editor IO go through `fs_read_dir` and `fs_read_file`.
- **`ShellSession::started_at_ms`** field — never read anywhere, kept only for an `#[allow(dead_code)]` warning suppression.
- **`SshEvent::Error` enum variant** — never emitted (commented as "future error paths"), so dropped to keep the SSH event surface honest.
- **Unused shadcn UI components.** Deleted `src/components/ui/{card,checkbox,empty,item,label,menubar,radio-group,select,sheet,skeleton,slider,toggle-group}.tsx` (~1.3 k LOC). None of them had any importers; cleanup keeps `pnpm` install slim and the design-system surface area honest. Re-add via `pnpm dlx shadcn@latest add <name>` if a future feature needs one.
- **`src/modules/ai/lib/placeholders.ts`** — the static placeholder list it exported was unused by the composer; the input bar resolves placeholders inline now.
- **SSH status pill wiring through App.tsx → StatusBar.** The reconnect / disconnect / edit handlers and the `activeSsh*` memos no longer round-trip through the root component. The pill itself stays on the leaf; this just trims props the StatusBar wasn't reading.
- **`.tauri` ignore entry.** No tooling writes to a top-level `.tauri` directory in Tauri 2 — the entry was a hold-over from an older project layout.

## [0.1.8] - 2026-05-15

### Added
- **Prompt queue.** While the agent is busy, Ctrl/Cmd+Enter queues the current draft instead of dropping it. Queued prompts render as numbered amber chips above the input bar and fire one-by-one when the agent settles. The status-bar Send button gets a dropdown with **Send now (interrupt)** and **Add to queue** while busy. A `firingRef` latch prevents the queue from draining in a single render pass.
- **Approval modes** for AI tool calls. New `approvalMode` preference (Ask / Semi / Full Auto), picked from the AgentSwitcher dropdown with a colored dot + description for each mode. `AgentRunBridge` auto-approves matching tool calls (dedup'd by `approvalId`):
  - **Ask** (default): every mutating tool still pauses for the user.
  - **Semi**: shell commands matching a conservative read-only prefix list (`ls`, `pwd`, `cat`, `grep`, `git status`, `node --version`, …) auto-approve; file mutations still ask.
  - **Full Auto** (yolo): every tool auto-approves without interruption.
- **Active model + provider persist across launches.** New `lastModelId` and `lastProviderId` preferences captured by a `useChatStore.subscribe` listener; boot restore picks the saved pair (falling back to the workspace default if the key is missing or the model is gone). The boot path is gated by a ref so a delayed `openai-compatible` `/v1/models` refresh can't demote the user's pick.
- **Per-message model chip** in the chat: every user message displays the model + maker that was active at send time (`UserMessageModelChip`). Powered by a new `TediUserMetadata` bag (`tediModel`, `tediModelLabel`, `tediProvider`, `tediOwnedBy`, `sentAt`) stamped onto outgoing messages. `openai-compatible` passes through the gateway's `owned_by` so a model like `mimo` is credited to **Xiaomi**, not the proxy.
- **ExplorerGrep panel** — a "Search in files" surface in the file explorer, opened by the file-search icon in the explorer header or by `Ctrl+Shift+F`. The existing "Go to file by name" picker moves to `Ctrl+Shift+P` (renamed in the placeholder too).
- **Minimap toggle** in Settings → General. Stored as `showMinimap` (default true) and applied live via a CodeMirror compartment so the open editor reconfigures on the fly without a full state rebuild.
- **HTTP ping accepts Bearer auth** (`http_ping(url, auth)`). The OpenAI-Compatible and Autocomplete "Test endpoint" probes now send the API key as a bearer token so endpoints that require auth can be validated; the dialog auto-saves a key that was just typed but not yet stored.
- **Workspaces panel tab count.** Each workspace row shows the number of open tabs (live count for the active workspace, persisted `tabs.length` for the others). The chip fades out on hover so the rename/delete actions slot in cleanly.
- **OpenAI-Compatible models refresh on startup.** App boot kicks a `/v1/models` fetch when both the API key and base URL are present, so a fresh launch lands on the saved model without waiting for the user to open Settings → Models.
- **Pinned models qualified by provider** (`provider::modelId` key). Two models with the same id (e.g. `mimo-v2.5-pro` proxied by both SumoPod and an OpenAI-Compatible gateway) can be pinned independently. Legacy unqualified pins are honoured for backwards compat and upgraded to the qualified form on the next toggle.
- **Floating prompt pin tracks every user message.** Scrolling deep into chat history pins the *most recent* user prompt that's above the viewport — not just the global "last user message" — so the matching question stays visible while you read its reply.
- **AI shortcut documentation rows** in Settings → Shortcuts: read-only entries for "Send prompt" (Enter), "Queue prompt while AI is busy" (Ctrl/Cmd+Enter), and "New line in prompt" (Shift+Enter). They're hardcoded in the textarea handler — listing them makes the bindings discoverable without an editable recorder.

### Changed
- **`reqwest` gains `rustls-tls` + `http2` features.** The Tauri backend can now talk to HTTPS endpoints out of the box (no system OpenSSL dependency) and negotiate HTTP/2 — required for "Test endpoint" against cloud gateways and the OpenAI-Compatible `/v1/models` fetch.
- **Scroll-to-bottom button** redesigned: pill-shaped "Scroll to bottom" with an arrow icon, animated in/out via `motion`'s spring `AnimatePresence`. Replaces the round icon-only button.
- **Conversation scroller** switched to `scrollbar-gutter: auto`. `use-stick-to-bottom` hardcoded `stable both-edges` inline, which reserved 16px on both sides even when no scrollbar was showing; the trailing-`!` Tailwind utility now beats the inline style so short chats render flush.
- **Reasoning trigger** picks up `cursor-pointer select-none` so the disclosure feels clickable.
- **AiMiniWindow header** padding/spacing tightened (session picker grows; busy spinner gets right-padding instead of bigger gaps).
- **Status-bar AI controls** redesigned: drops the "close panel" `Cmd+I` chip; Send button repaints as a 24px rounded square; while busy, the Send button becomes a split-button dropdown with "Send now (interrupt)" and "Add to queue" options.
- **SumoPod model hint** is now always `via SumoPod`. The upstream API returns `owned_by: "openai"` for every model regardless of the real maker, so the gateway label is more honest. The chat chip continues to credit SumoPod as the gateway as well (no `ownedBy` stamped on SumoPod-detected models).
- **OpenAI-Compatible key block** restyled: side-by-side **Save** button next to the input, `pr-12` clearance for the Show/Hide pill, and tightened "detected"/"failed" messages.
- **Model dropdown trigger** picks the user's saved provider when synthesising a `ModelInfo` for a runtime-detected id, so the trigger pill no longer mis-labels openai-compatible models as `SumoPod` (or vice versa).
- **Ctrl+Shift+P / Ctrl+Shift+F bindings** swapped: file-name picker → `Ctrl+Shift+P` (was Ctrl+Shift+F); content search → `Ctrl+Shift+F`. Matches VS Code muscle memory.

### Fixed
- **Radix `<ScrollArea>` horizontal overflow.** Radix wraps the viewport's children in an inner `display:table` div, which shrinks-to-fit its widest descendant — long unbreakable paths in grep results / file explorer / SSH connection list pushed it past the viewport and triggered an unwanted horizontal scrollbar (and killed `truncate`/`break-all` on inner rows). Coerced to `display:block; width:100%; min-width:0` globally.
- **Model picker race on cold boot.** When two providers race to register the same model id, the dropdown trigger could mis-label the active model (or fall back to "SumoPod" for an openai-compatible pick). `selectedProvider` is now stored alongside `selectedModelId` and used as the source of truth.

### Dependencies
- Backend: `reqwest = { default-features = false, features = ["rustls-tls", "http2"] }` — adds `hyper-rustls`, `webpki-roots`, `h2`, `quinn`/`quinn-proto` (HTTP/3 fallback path via reqwest), `rand 0.9`, `web-time`, plus internal `bs58`, `lru-slab`, etc., into the Cargo lockfile.

## [0.1.7] - 2026-05-15

### Added
- **SSH session lifecycle.** SSH leaves now expose their state to the UI via a typed `SshStatus` (`idle | connecting | connected | reconnecting | disconnected | error`). The tab strip paints a small colored dot on the SSH leaf icon (yellow connecting / reconnecting, green connected, red disconnected / error) and the SSH tab tooltip shows the matching status line.
- **SSH status pill in the status bar.** When the active leaf is SSH-bound, a chip sits next to the updater pill with the live status, server fingerprint, "last connected" timestamp, and disconnect reason. The popover exposes **Reconnect / Disconnect / Edit connection** actions; "Reconnect" also works on a live session to force a fresh handshake (fingerprint refresh).
- **SSH auto-reconnect with backoff.** Unintentional drops trigger up to 3 reconnect attempts on a 1s / 3s / 7s schedule, with an inline `[tedi]` banner in the terminal. After the schedule is exhausted, pressing **Enter** in the dead pane re-arms a fresh 3-attempt window.
- **Test connection** button in the SSH dialog: probes the handshake against the current form values (no keychain write) and reports server fingerprint + roundtrip ms on success.
- **Import private key from file** in the SSH dialog: native file picker (Tauri `dialog.open`) reads the key into the form so you don't have to paste it.
- **Duplicate connection** action in the SSH menu: clones secrets + settings into a new `… copy` entry.
- **Per-connection metadata persisted:** `lastConnectedAt` and `lastFingerprint` are written on every successful handshake, surfaced as `· last 2h ago` in the SSH menu and in the status pill popover.
- **SSH leaves persist across workspace switches and restarts.** Saved tab tree now carries `sshConnectionId` on terminal leaves so the connection is re-bound automatically when the workspace is rehydrated.
- **Editor scrollbar marker overlay.** A 10px overlay column on the right paints the current caret position and selection range over the native vertical scrollbar — VS Code-style. Tracks scroll, selection, and pane-resize changes; falls back to a geometric estimate when the position is outside the viewport.
- **Editor minimap** (`@replit/codemirror-minimap`) with a color gutter: lines that start with a color literal get a thin colored swatch in the minimap so palette files and theme tokens are scannable at a glance.
- **Inline color decorations** in the editor: `#rgb` / `#rrggbb` / `#rgba` / `#rrggbbaa` and functional `rgb(a)` / `hsl(a)` literals get a colored swatch background with auto-contrast text color. Parsed colors are cached (1024-entry LRU) and the scan caps at 5000 lines so a 200k-line minified file doesn't stall the UI.
- **Retry-on-Enter for failed PTY spawns.** When local shell startup errors (missing binary, bad cwd), the error is rendered inline and pressing **Enter** in the dead pane triggers a fresh spawn instead of forcing a tab close.

### Changed
- **Global scrollbar pass.** Every native scrollbar in the app (editor, settings, dialogs, dropdowns, file tree, terminal viewport, anywhere `overflow:auto|scroll`) is now a single 10px boxy style: `--border` thumb, `--muted-foreground` on hover, transparent track, no border-radius. The Radix `<ScrollArea>` thumb is repainted to the same palette so panels with `<ScrollArea>` and panels with plain `overflow-auto` no longer disagree on scrollbar width. macOS keeps its native overlay scrollbar.
- **Ctrl+T (new tab) and Ctrl+D / Ctrl+Shift+D (split) anchor to the explorer root** instead of the inherited PTY cwd, so a fresh terminal always starts in the folder you're browsing.
- **Move leaf to group** no longer treats `editor ↔ editor` as forbidden — a tab can now hold multiple editor leaves. The `editor-conflict` toast path and the "Editor" disabled label in the move menu are gone.
- **Updater dialog date formatting.** Tauri's `2024-01-15 12:34:56.000 +00:00:00` string is normalized to ISO and rendered as `dd MMM yyyy HH:mm` (en-GB locale, 24h).
- **Updater first-check timer no longer rearms on state change.** The auto-check `setInterval` was being rebuilt on every `state.kind` transition, which closed the dialog mid-interaction; the periodic check now lives in its own effect keyed by a ref so the dialog stays put.
- **General settings tooltip** dropped the fixed `max-w-65` clamp so the WebGL renderer explanation can use the default tooltip width.
- **Editor padding** trimmed to `8px 0 0 8px` so the vertical scrollbar, the minimap, and the horizontal scrollbar all sit flush with the pane edges (no 8px dead strip between scrollbar and border).

### Fixed
- **Radix `<ScrollArea>` thumb width.** The wrapper was 10px wide but the thumb only painted at 8px due to a `p-px` + transparent border combo, making `<ScrollArea>` regions look thinner than plain `overflow-auto` regions. The padding/border is gone; the thumb now fills the 10px wrapper and matches every other scrollbar.

### Dependencies
- Bumped the AI SDK suite (`@ai-sdk/anthropic`, `cerebras`, `google`, `groq`, `openai`, `openai-compatible`, `react`, `xai`) to the latest 3.x line, plus `ai` to 6.0.182.
- Bumped CodeMirror (`@codemirror/view` 6.43, `@codemirror/autocomplete` 6.20.2, `@codemirror/lint` 6.9.6, `@codemirror/legacy-modes` 6.5.3).
- Bumped React to 19.2.6, `react-resizable-panels` 4.11.1, `tailwindcss` 4.3.0, `zod` 4.4.3, `zustand` 5.0.13, `vite` 7.3.3, `@tauri-apps/cli` 2.11.1, `@tauri-apps/api` 2.11.0.
- Added `@replit/codemirror-minimap` for the new editor minimap.

## [0.1.6] - 2026-05-14

### Added
- **Word wrap toggle** for the active editor leaf: header button (next to the search field, only shown when an editor leaf is active and Markdown preview is hidden) and **Alt+Z** shortcut. Persisted as the `lineWrap` preference; reconfigures the open editor live via a CodeMirror compartment.

### Fixed
- **Settings window opens on the wrong monitor.** Tauri's default placement centers on the primary monitor even when the main window is on a secondary display. The settings window now re-centers over the main window on both first open and subsequent re-opens, so it follows wherever you're working.
- **Settings panel had no visible scrollbar.** The settings content area now opts back into the slim themed scrollbar (`themed-scroll`) instead of inheriting the global hide-scrollbar rule.

### Changed
- README polished: dropped the redundant H1, the auto-update banner, the OSC 8889 sub-bullet, and tightened the editor feature list.

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
