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
| `ai/`        | The built-in agent: prompts, tool catalogue, providers, sub-agents, context compaction, egress.                                                                                                                                                                                                  |
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
| `server.mjs`    | The stdio JSON-RPC MCP server an outside CLI (Claude Code, Codex, …) spawns. Handlers only; every description and schema comes from `tools.mjs`.                                               |
| `transport.mjs` | Decides, per call, whether it goes over the local socket or CDP. `BRIDGED` is the map; everything else falls through to the driver.                                                            |
| `socket.mjs`    | Client for the local-socket bridge: reads the handshake file, presents the token, calls capabilities by name.                                                                                  |
| `driver.mjs`    | Drives a running TEDI window over the WebView2 DevTools Protocol. Class `Driver`. Still the only way to send trusted input or capture the window.                                              |
| `cli.mjs`       | `pnpm mcp <verb>` — the same driver, by hand, one connection per invocation.                                                                                                                   |
| `sweep.mjs`     | Live smoke test against a running TEDI. Needs the app open.                                                                                                                                    |

### Two ways in

`server.mjs` prefers the **local socket** (a named pipe on Windows, a unix socket
elsewhere) served by `src-tauri/src/modules/mcp_bridge.rs`. It works on every
platform, takes many clients at once, is authenticated with a per-run token, and
needs no restart to become usable.

**CDP** is pulled up lazily, only for calls that genuinely need it: real keyboard
and mouse input, window capture, and DOM reads. A session that never touches
`keys`, `type_text`, `click`, `drag`, `screenshot`, `eval_js`, `state` or
`read source:"dom"` opens no DevTools connection at all.

`transport.mjs` documents, per method, why anything bridgeable-looking is not
bridged — `focusPane` verifies through the DOM, `cmd` throws where the capability
returns false, `terminals` reduces in-page to keep `sh`'s poll loop cheap.

The app's own in-process MCP server is not here — it is
`src/modules/ai/lib/tediMcpServer.ts`, and it imports `tools.mjs` through the
`@mcp/` alias so both transports serve the identical contract.
