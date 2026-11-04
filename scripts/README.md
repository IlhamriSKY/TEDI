# `scripts/`

Build tooling and the self-check suite, grouped by the part of TEDI they cover.

This used to be one flat directory of ~70 files where `ssh-transfer-verify.ts`
sat between `sql-explorer-verify.ts` and `stream-idle-timeout-verify.ts` and
nothing told you which subsystem any of them belonged to. The folders are the
only change; every check is the same file it was.

## Layout

| Folder       | What lives there                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp/`       | **The MCP surface.** The stdio server an outside AI CLI connects to, the shared tool table both servers read, the CDP driver, the hand CLI, and their checks.                                                                                                                                    |
| `ai/`        | The built-in agent: prompts, tool catalogue, providers, sub-agents, context compaction, project memory, egress.                                                                                                                                                                                  |
| `terminal/`  | PTY and xterm: clipboard, resize, URL detection, WebGL, the write meter.                                                                                                                                                                                                                         |
| `ssh/`       | Connections, host keys, SFTP transfers, port forwards, remote OS detection.                                                                                                                                                                                                                      |
| `preview/`   | The preview pill and project-URL detection.                                                                                                                                                                                                                                                      |
| `scm/`       | Git operations, hunk staging, stacked PRs.                                                                                                                                                                                                                                                       |
| `ext/`       | The extension host: manifest schema, permissions, hot reload, typed `invoke`, plus the dev-link and toolkit-adoption tools. Named `ext/` rather than `extensions/` so a relative path here cannot be confused with the repo's top-level `extensions/`, which holds the actual extension sources. |
| `editor/`    | CodeMirror: reload-on-change, language grammars.                                                                                                                                                                                                                                                 |
| `workspace/` | Tabs, panes, pinning, panel sizing, docking, serialization.                                                                                                                                                                                                                                      |
| `ui/`        | App chrome: theme, toasts, focus restore, scrollbars, keybinding collisions, the quit guard.                                                                                                                                                                                                     |
| `release/`   | Release-notes generation and old-release pruning. Run by CI, not by `verify`.                                                                                                                                                                                                                    |

Two files stay at the root because they are about the repo as a whole rather
than a feature: `verify-all.mjs` (the runner) and `check-imports.mjs`.

## Running the checks

```sh
pnpm verify              # all of them, every failure reported
pnpm verify ssh          # only paths containing "ssh"
pnpm verify mcp/         # a whole folder
pnpm verify tool-picker  # one check, ~0.4s
```

The runner discovers `*-verify.ts` recursively, so a new check is picked up by
existing — put it in the folder for its subsystem and nothing else needs editing.
The filter matches the whole relative path, which is why a folder name works.

## Writing a check

They are plain `tsx` scripts: no test framework, no fixtures. Print `ok:` lines,
call `fail()` for a problem, and throw at the end if anything failed. Two habits
worth keeping:

- **Paths are resolved from the repo root.** `pnpm verify` sets the working
  directory there, so `readFile("src/...")` works. If you instead resolve from
  `import.meta.url`, remember you are two levels deep now (`../../`).
- **Prefer a check that can fail.** A structural assertion over source text is
  fine — several here are, because the real module cannot be imported outside
  the app — but make sure you have watched it go red before trusting it green.

## `mcp/` in more detail

| File            | Role                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.mjs`     | **The tool table**: name → pack, description, JSON Schema. The one definition, imported by both servers. Zero imports, because it ships as a bundle resource with no `node_modules` beside it. |
| `tools.d.mts`   | Types for the above, since it must stay plain JS.                                                                                                                                              |
| `handlers.mjs`  | **What each tool does.** One implementation over named capabilities, run by `tedi <verb>`, the stdio server and TEDI's own agent. Imports only `input.mjs`, so the app bundles it. |
| `input.mjs`     | Real keys, typing and mouse over one DevTools `send`. No Node API, because TEDI's own agent runs it too. |
| `render.mjs`    | What a person sees from `tedi <verb>`: tables and plain text in place of JSON. Pure, so `cli-verify` reads the output with no app. |
| `targets.mjs`   | Which AI agents can be pointed at TEDI and how to edit each config file (JSON, TOML, YAML). Text in, text out, shared by the Install MCP dialog and `tedi mcp install`. |
| `server.mjs`    | The stdio MCP server an outside agent spawns. Advertises ONE gateway tool that points at `tedi <verb>`; holds `callTool` and the handlers that need Node or DevTools. |
| `transport.mjs` | How a Node process reaches TEDI: the authenticated local socket, and DevTools through it. No fallback to the debug port. |
| `socket.mjs`    | Client for the local-socket bridge: reads the handshake file, presents the token, calls capabilities by name. |
| `driver.mjs`    | Drives a window over the DevTools Protocol. Class `Driver`, used through the bridge for trusted input and window capture, and over a port by `sweep`. |
| `cli.mjs`       | `tedi <verb>`: one tool, then exit, through the same `callTool` the server uses. Tables on a terminal, JSON when piped. `tedi mcp` connects an agent. Also `pnpm mcp <verb>`, plus the dev verbs `targets` and `sweep`. |
| `sweep.mjs`     | Live smoke test against a running TEDI. Needs the app open.                                                                                                                                    |

### One way in

Everything goes through the **local socket** (a named pipe on Windows, a unix socket
elsewhere) served by `src-tauri/src/modules/mcp_bridge.rs`. It works on every platform,
takes many clients at once, is authenticated with a per-run token, and needs no restart.

**DevTools** comes through the same socket, only for calls that genuinely need it: real
keyboard and mouse input, window capture and `eval_js`. TEDI answers them in-process
(`mcp_devtools.rs`), so no tool opens a debug port. Only `pnpm mcp targets` and `sweep`
drive a port, explicitly.

### Two readers

On a terminal `tedi <verb>` prints for a person. Piped, or with `--json`, it prints one
compact JSON value for a program or an AI agent. `--human` and `TEDI_OUTPUT=json|human`
force either. Stdout holds the answer, stderr says why there is none, and the exit status
is 0 answered, 1 refused or unfinished, 2 a bad command line.

TEDI's own agent is not here: it is one tool, `src/modules/ai/tools/tedi.ts`. It imports `tools.mjs` and
`handlers.mjs` through the `@mcp/` alias, and adds only that agent's own policy: the shell guard,
the tool picker, and which verbs need a card.
