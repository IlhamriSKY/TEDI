# TEDI

Cross-platform terminal with split panes, tab groups, workspaces, a CodeMirror
editor, a BYOK AI agent and a runtime extension system. Tauri 2 + Rust owns every
OS resource; a React 19 webview owns the UI. Forked from
[Crynta/Terax v0.5.9](https://github.com/crynta/terax-ai).

Stack: Tauri 2, Rust (`portable-pty`, `russh`), React 19 + TS, xterm.js (WebGL),
CodeMirror 6, shadcn/ui, Tailwind v4, `@ai-sdk/*` v6. Package manager is **pnpm**.

## Commands

```bash
pnpm exec tsc --noEmit    # frontend types
pnpm lint:imports         # module import discipline
pnpm verify               # the invariant suite; `pnpm verify ai` filters to one folder
pnpm build                # frontend build
pnpm tauri:dev            # dev, ISOLATED data dir (`pnpm tauri dev` shares prod data)
pnpm tauri:dev:ext        # same, plus symlink local extensions/ into the dev profile
cd src-tauri && cargo check && cargo clippy && cargo test
```

CI runs exactly those. It does **not** run `pnpm format:check`, which already
fails on files nobody touched, so format only your own paths
(`pnpm exec prettier --write <files>`) and never repo-wide `pnpm format`.

## Architecture rules

Load-bearing. Breaking one is a bug, not a style question.

- **Two processes.** The webview reaches the OS only through
  `invoke("cmd", args)`; streaming comes back over a Tauri `Channel`. Every
  command is registered in `src-tauri/src/lib.rs` `invoke_handler` - that list is
  the whole backend API surface, so read it there rather than trusting any doc.
- **Import through the `@/*` alias only**, never a relative path that leaves your
  own module. Enforced by `pnpm lint:imports`. A module's `index.ts` is a
  convenience re-export, not a required door.
- **Tabs never unmount.** Inactive tabs hide with `invisible pointer-events-none`
  so PTYs and dev servers keep streaming. `visibility:hidden` KEEPS the layout
  box, so a size check reports "visible" for a pane nobody is showing and an
  `IntersectionObserver` never fires.
- **Secrets live only in the OS keychain** (`secrets_*`, service `tedi`). Never on
  disk, in the settings store, or in `localStorage`.
- **`App.tsx` coordinates, it does not implement.** Feature logic belongs in
  `src/modules/<area>/`.
- **Tauri commands must be async.** A sync one runs on the WebView2 UI thread and
  blocking there freezes the app. A test pins the allowed-sync list.
- **The budget is RAM and idle CPU, not bundle size.** The old ~10 MB download cap
  is retired: ship what the feature needs. Resident cost is what still matters, so
  no per-tick process spawn, watch instead of poll, and gate pollers on visibility.

## Conventions that differ from the default

- **Send `\r` (CR) for Enter to a terminal, never `\n`.** PowerShell needs CR.
- **Paths**: split with `.split(/[\\/]/)`. Canonical frontend form is
  forward-slash; convert `homeDir()` backslashes at the boundary.
- **Cross-platform**: resolve HOME and cache via the `dirs` crate, never raw env
  vars. `#[cfg(not(windows))]` code never compiles on Windows, so CI is the first
  thing that sees it.
- **shadcn/ui and AI Elements are OWNED, not generated.** Add a NEW component with
  the CLI; re-running it over an existing one silently reverts TEDI's tokens.
- **Prose and docs: no em-dashes.** Use commas, colons or parentheses.
- Commit messages carry **no AI attribution**, matching every commit on `main`.

## Gotchas that have cost real time

- **There is no `ssh` pane kind.** `LeafState` has six: `terminal`, `editor`,
  `extension-panel`, `board`, `scm`, `ai`. SSH is a TERMINAL leaf carrying
  `sshConnectionId`. Reading `tab.title` instead of `leafLabel(leaf, sshHosts)`
  renders a bare "ssh" for every remote pane.
- **A terminal holds a WebGL context only while visible, and Chromium caps live
  contexts near 16.** An evicted context paints BLANK, which is why offscreen
  canvas panes are culled.
- **Windows PTY**: `SPAWN_LOCK` gates ConPTY lifecycle so `ClosePseudoConsole`
  cannot race a sibling's openpty; each child joins a Job with
  `KILL_ON_JOB_CLOSE` because `killer.kill()` only kills the immediate child; and
  cwd must be backslashes before ConPTY.
- **pwsh never emits OSC 133 C**, so nothing may assume a command-start marker
  arrived; the frontend synthesises it from the keystroke.
- **Zod strips unknown keys**, which is why MCP tool schemas are raw JSON Schema.
  The extension manifest schema must stay LOOSER than Rust: Rust decides what
  installs, Zod only what renders, and a field Rust accepts but Zod rejects
  installs with a success toast and then never appears.
- **`serde_json` re-sorts object keys**, so never round-trip a user's JSON.
- Radix: a `Popover` inside a `Dialog` must not be `modal`, and `*SubContent` is
  not self-portaling. `@layer components` loses to utilities. A controlled `open`
  never fires `onOpenChange`. React bubbles up the REACT tree, not the DOM tree.
- **The dev profile shares the PTY daemon with the installed app** unless you use
  `pnpm tauri:dev`. The daemon outlives the dev GUI; set `TEDI_PTYD_IDLE_SECS=60`
  while iterating on it.
- When a shipped feature is reported broken, check the INSTALLED exe's
  FileVersion before debugging anything.

## Testing

`pnpm verify` discovers every `scripts/**/*-verify.ts`. Two things about it:

- **Run it through pnpm.** Bare `node scripts/verify-all.mjs` cannot find the
  `tsx` shim and reports every check as failed.
- **Most checks assert on SOURCE TEXT**, not behaviour. Renaming a symbol they
  cover fails them by design: re-point the assertion at the new name, never
  delete it.

New checks are plain `tsx` scripts, no framework. Put one in the folder for its
subsystem and the runner picks it up.

## Releasing

Version lives in **three** files: `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`. This file deliberately carries no version, because a
number that changes every release is the first thing to go stale in a doc the
agent reads every turn. After bumping, run `cargo check` (not `--locked`) to
write the lock, then text-diff it: git treats that lock as binary, so a byte
count hides a stray dependency edge.

`git fetch` and compare BOTH directions before starting. Push `main` and wait for
CI green **before** pushing the tag, because a tag starts a ~19 minute signed
build. A core release comes out a DRAFT and ships only when published, which
auto-updates every client irreversibly, so confirm first - and list drafts before
and after, because a release has silently stayed a draft while `releases/latest`
kept serving the previous version. An EXTENSION tag auto-publishes, so there the
tag push is the ship.

## Project memory

This file and `AGENTS.md` are both preloaded into the agent's system prompt from
the workspace root, sharing one 12 KB budget (`ai/lib/projectMemory.ts`). Keep it
under 200 lines and universally applicable: anything only some tasks need belongs
in the docs below, which the agent reads on demand. Never name an unreleased
feature or extension here.

## Where to read more

- **Architecture, module by module**: [ARCHITECTURE.md](ARCHITECTURE.md) - the
  two-process model, the backend and frontend module tables, the AI subsystem,
  data-flow traces, and the core/extension contract.
- **Build, PR and review rules**: [CONTRIBUTING.md](CONTRIBUTING.md).
- **Writing an extension**: [extensions/README.md](extensions/README.md) - the
  manifest schema, the permission-gated `ctx` API, and the reference extensions.
- **The self-check suite**: [scripts/README.md](scripts/README.md).
- **The MCP surface**: `scripts/mcp/tools.mjs` is the one tool table both the
  stdio server and TEDI's in-process server read.
- **What changed and when**: [CHANGELOG.md](CHANGELOG.md).
