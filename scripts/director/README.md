# Director

Lets an agent operate a running TEDI: run commands in the user's real terminal,
open and read files in their editor, click through the UI, and read the result
back.

Two front ends over one driver:

| | for | how |
|---|---|---|
| **`mcp.mjs`** | Claude Code | MCP tools over stdio, registered in `.mcp.json` |
| **`cli.mjs`** | you | `pnpm director <verb>` |

Both are the same `Director` class, so a verb proven in one works in the other.
No dependencies: it speaks the WebView2 DevTools Protocol over one WebSocket, and
Node 22+ ships both `fetch` and a WebSocket client.

**This does not record video.** It used to, and that half is gone: the owner
records with an external tool, which also sees the browser preview panes and
floated windows that a CDP screencast structurally cannot. `shot` still captures
a still, because an agent needs to be able to look.

## 1. Start TEDI with the debug port

The port is off unless asked for, so an ordinary launch keeps no listening socket
and no automation surface.

```powershell
$env:TEDI_DEBUG_PORT = "9222"
pnpm tauri:dev                      # or the installed binary, see below
```

`TEDI_DEBUG_PORT` does two things, and both ride that one switch:

- appends `--remote-debugging-port` to the process-wide WebView2 browser
  arguments (`preview::apply_webview2_browser_args_env`), and
- registers a plugin whose init script sets `window.__TEDI_AUTOMATION__`, which
  is what `window.__tedi` keys off.

**Not limited to dev builds.** Neither half is gated on the build profile, so a
release build started with the env var is drivable the same way:

```powershell
$env:TEDI_DEBUG_PORT = "9222"
& "$env:LOCALAPPDATA\TEDI\TEDIApp.exe"
```

Both must be set **before launch**. WebView2 fixes its browser arguments when it
creates its environment, which happens before the first webview exists, and the
init script runs ahead of the page's own scripts. Setting the variable in an
already-running session does nothing, and the symptom is a missing property on
`window.__tedi` several minutes later.

Check it is up:

```powershell
pnpm director targets
```

**The driver and the app ship together.** Most of what is below reads and writes
through `window.__tedi`, which the frontend registers, so an older TEDI simply
does not have the newer half of it: `sh`, `panes`, `extensions`, `read_editors`
and `open_file` all report `window.__tedi.<name> is missing ... this build
predates <name>`. That message means the port is open and the app is old, not
that anything is broken. Drive a build from this commit. Nothing falls back to a
worse path silently, which is the point: a driver that quietly degrades is a
driver you cannot trust the output of.

## 2. Claude Code

`.mcp.json` in the repo root registers this server, so a Claude Code session
started here picks it up with no setup. Eighteen tools:

| tool | what it is for |
|---|---|
| `state` | one snapshot: **every pane in every tab**, tabs + labels, focus, dialogs, toasts, clickable labels, splitter index. **Start here.** |
| `commands` / `run_command` | list and run any command id, TEDI's own or an extension's |
| `extensions` | what is installed, enabled, and what each one contributes |
| `sh` | run a shell command in the user's terminal and return its output |
| `wait_for_terminal` | block until a pane is done, instead of polling it |
| `read_terminal` | a pane's scrollback |
| `read_editors` | every open editor: path + live buffer, unsaved edits included |
| `open_file` / `save_editor` | open a path in the editor; save a pane |
| `keys` / `type_text` | real key chords; real typing |
| `click` / `drag` / `focus_pane` | real mouse input; focus without clicking |
| `read_dom` | text of a selector (dialogs, tree, AI reply) |
| `screenshot` | a PNG to actually look at |
| `eval_js` | the escape hatch for anything not modelled above |

Why a server rather than shelling out to the CLI:

- **One connection for the session.** Every `pnpm director <verb>` pays a fresh
  `/json/list`, a WebSocket attach, `Page.enable`, `Runtime.enable` and a
  two-frame settle before doing any work. A page target also accepts exactly one
  DevTools client, so each attach/detach cycle is another chance to wedge it.
- **Typed arguments**, so no shell quoting. On PowerShell that is where a
  `sh "git log --format=%H"` goes to die.
- **The schema is the documentation.** An agent discovers the surface instead of
  being told about it.

The server starts fine with TEDI closed - it has to, since Claude Code launches
it at session start. Tools called before TEDI is up return the reason and the
fix, and the connection is rebuilt on the next call once it is.

## 3. By hand

```powershell
pnpm director state                          # everything, in one round trip
pnpm director panes                          # every pane in every tab
pnpm director wait --leaf 7 --text "ready"   # block instead of polling
pnpm director extensions                     # installed + what they contribute
pnpm director ext tedi.sql-explorer sql.open # run an extension's command
pnpm director commands                       # every command id this build registered
pnpm director cmd pane.splitRight            # run one, no palette, no fuzzy match
pnpm director sh "git status"                # run it, wait, print the output
pnpm director term                           # read the focused terminal's buffer
pnpm director editors                        # every open editor's live buffer
pnpm director open src/app/App.tsx           # open a file in the editor
pnpm director keys Ctrl+Shift+P Escape       # real key events
pnpm director type "git status"              # typed a character at a time, no Enter
pnpm director click "[data-testid=sidebar]"  # real mouse click at a selector
pnpm director drag "[data-slot=resizable-handle]" -260 0 --nth 1   # resize a pane
                                             # (take the nth from state.paneHandle, never a guess)
pnpm director text ".cm-content"             # read the DOM back
pnpm director shot out.png
pnpm director sweep                          # walk the whole surface, assert a change per area
```

## Seeing, not just clicking

The gap that mattered was never the driver's hands - it was its senses. `state`
is one round trip for everything needed to choose the next move:

```jsonc
{
  "window": { "w": 1920, "h": 1080 },
  "sidebar": 240,
  "tabs":   [{ "id": 3, "label": "TEDI - terax-ai" }, { "id": 9, "label": "api" }],
  "leaves": [{ "id": 3, "kind": "terminal" }],   // what the DOM has RENDERED
  "focusLeaf": 3,
  "focus": "TEXTAREA",
  "paneHandle": 1,          // index among ALL handles; never hard-code this
  "dialog": null,           // "alertdialog: Close workspace?" when one is up
  "toasts": 0,              // anything > 0 will swallow a click in the top-right
  "buttons": ["Close pane", "New file", "Stage <path>", …],   // discovery list

  // The model view: every pane in EVERY tab, background ones included.
  "panes": [
    { "tabId": 3, "tabTitle": "TEDI - terax-ai", "leafId": 3, "kind": "terminal",
      "active": true, "ordinal": 1, "cwd": "D:/…/TEDI", "agent": "claude",
      "atPrompt": false, "running": true, "tail": "…" },
    { "tabId": 9, "tabTitle": "api", "leafId": 7, "kind": "terminal",
      "ordinal": 2, "cwd": "D:/…/api", "atPrompt": true, "running": false, "tail": "…" },
    { "tabId": 9, "tabTitle": "api", "leafId": 8, "kind": "editor",
      "path": "D:/…/main.rs", "dirty": true },
    { "tabId": 9, "tabTitle": "api", "leafId": 9, "kind": "extension-panel",
      "extensionId": "tedi.sql-explorer", "panelId": "db" }
  ]
}
```

`buttons` folds the per-file controls: with Source Control open it was 130
entries, 120 of them one `Stage`/`Discard` pair per changed file, which buried
every control anyone was actually looking for.

### The other panes, and waiting on them

`leaves` is the DOM: what is rendered right now. `panes` is the model, read from
TEDI's tab tree, and it is the one that answers the questions a driver actually
has. A background tab's panes are just as real as the focused one's, and only the
model knows a pane's cwd, ssh host, running AI CLI, open file or owning
extension. So "run this in the pane sitting in the api folder", "is the build in
tab 2 finished", and "which pane already has a Claude in it" are all one `state`
call away, with no tab switching to look.

Every pane-taking tool accepts that `leafId`: `sh`, `read_terminal`,
`wait_for_terminal`, `focus_pane`, `save_editor`.

**Wait, do not poll.** `wait_for_terminal` blocks inside the driver and answers
once. Re-reading a buffer every second to watch a build costs a round trip and a
tool result per second, and reads worse. Two conditions, because a prompt is not
always the finish line:

```jsonc
{ "leafId": 7 }                        // until the shell prompt comes back
{ "leafId": 7, "text": "Listening on" }  // until the buffer says so
```

The second is the only workable signal for something that never returns: a dev
server printing its port, a TUI reaching a screen, another AI CLI asking a
question. A timeout comes back as `done: false` with the tail rather than as an
error, because "still going" is an answer.

**Panes the user marked private are absent**, not merely unreadable. That flag
means "the AI never learns this pane exists" (see `terminal/lib/panes.ts`), which
TEDI's own agent already honours through `app/lib/terminalSnapshot.ts`. An agent
driving from outside is no different, so the whole surface filters on it: no
listing, no buffer, no write, no focus.

**Neither a terminal nor an editor can be read from the DOM.** xterm draws to a
WebGL canvas, so `text()` returns nothing at all for a terminal. CodeMirror
virtualises, so `text('.cm-content')` returns only the lines currently scrolled
into view - which is worse than nothing, because a 900-line file comes back as 30
lines and looks complete. Both are read through `window.__tedi`, which hangs off
the handles the app already keeps (`usePaneHandles`), and which exists only when
TEDI was started with `TEDI_DEBUG_PORT`.

### Running a shell command

`sh` writes the command straight to the PTY and waits for the prompt to come
back. That is not only faster than synthesising ~45ms per keystroke:

- A terminal that has **just taken focus swallows the first keystroke** it is
  sent. `echo x` into a freshly split pane arrives as `cho x`, and no wait fixes
  it - 6s, 200ms per character, `Input.insertText` and full synthesised key
  events all lose it. A PTY write cannot, because it never goes near the keyboard.
- Completion is **"the buffer changed AND the prompt is back"**, not just "the
  prompt is back". A PTY write returns before the shell has echoed anything, so a
  bare prompt check passes instantly against the *previous* prompt and the output
  is read before it exists - which looks exactly like a command that printed
  nothing.

It also refuses to guess which pane. `data-pane-leaf` is on every leaf, so the
focused one is often an editor or a browser, and the earlier version then fell
back to "the last terminal in mount order" - a background pane in another tab,
possibly an SSH session on another host, silently. Now: focus is in a terminal,
or exactly one is open, or you name a `leafId`. The pane actually used is
reported back either way.

The one thing it gives up: xterm's `onData` never sees it, so TEDI's AI-CLI
detector does not fire. Launch an AI CLI with `type_text` + `keys` (or
`d.command()`, which types it as real keys) instead.

**Reads of a terminal are deliberately wide.** `getBuffer(n)` hands back the last
n ROWS and then strips the trailing blank ones, and `buffer.active.length` counts
the empty rows below the cursor - so on a pane that has not scrolled, asking for
fewer rows than the viewport is tall returns `""`. Not an error, an empty string,
which a change-detector reads as "nothing has happened yet". Every read that
cares about text uses `BUFFER_ROWS` (200) and trims in JS afterwards. A narrower
read looks like an easy saving and turns `sh("echo hi")` on a fresh pane into a
20-second timeout reporting "still running".

A TUI (vim, lazygit, an AI CLI) never returns to a prompt. That reports
`timedOut: true` with the buffer, rather than throwing: opening one on purpose is
legitimate.

### Files and the editor

`open_file` takes an absolute path and routes through the same handler the
explorer does, so a PDF still lands in a browser pane. It exists because clicking
the tree only reaches a path already expanded into view, which for anything deep
it is not.

TEDI's controls carry **`aria-label`, not `title`**, and file-tree rows are
buttons carrying **`data-fs-path` / `data-fs-kind`**, so both are addressable
without guessing at class names.

Two things to know before scripting an edit. A tab left open by an earlier run
still holds its buffer even after the file is deleted from disk, and clicking the
tree entry re-focuses that tab rather than opening a fresh one, so start with
`Ctrl+A` `Delete`. And markdown auto-continues lists, so typing `- ` on the line
after a bullet gives you `- - `; type the text only.

### Extensions

Extension UI clicks like any other UI, and an extension pane shows up in `panes`
with its `extensionId` / `panelId`. Two things did not work until they were wired
up:

- **An extension's commands live in a registry of their own** (`extensions/
  registries.ts`), not the shortcut registry, so `commands` never listed them and
  `run_command` could never reach them. Pass `extensionId` alongside `id` and it
  routes to the right one. `false` comes back when nothing answers: a command
  declared in a manifest but never given a runtime handler, or one whose
  extension is disabled, are the same answer and both ordinary.
- **`extensions` lists what is installed**, enabled or not, with the commands,
  panels and AI tools each one contributes. Check it before concluding a feature
  is missing: from the UI, a disabled extension and an absent one look identical.

Installing, enabling and uninstalling are deliberately NOT exposed. They mutate
the user's profile, and a driver that can enable an extension can install one.

### The AI panel and the Settings window

The built-in AI agent is ordinary React UI, so it is driven the same way:
`cmd ai.toggle` opens it, the composer is the `textarea` whose placeholder starts
with `Ask`, and the model and agent pickers are buttons labelled `Model: …` and
`Agent: …`. Two things are not obvious:

- **`ai.send` registers no handler.** It is a documentation-only shortcut; the
  composer owns Enter itself. Send with `keys Enter`, newline with `Shift+Enter`.
- **Menus are toggles**, and through the CLI every call is a fresh DevTools
  session, so a menu left open by the previous call flips shut on the next one's
  click. Press `Escape` first and open the menu yourself rather than inferring
  state. (Over MCP the connection is held, but the app's own state still is not
  yours to assume - `state` reports any open dialog.)

Settings is a **separate webview**, so it needs `--target`:

```powershell
pnpm director cmd settings.open
pnpm director targets                       # now lists two pages
pnpm director --target settings eval "document.title"
```

Float windows are separate webviews too, and reachable the same way. Radix
`TabsTrigger` renders no `value` attribute, so `[role="tab"][value="x"]` never
matches - use `[id$="trigger-x"]`.

## Traps

**Never hard-code the `nth` of a pane splitter.** The handle list is
`[sidebar, panes…, right column]`, so its indices move with the pane count; read
`state.paneHandle`. It returns -1 when only one pane is open, which is the honest
answer, and the reason it exists: a single leaf renders no panel group at all, so
the obvious lookup walks up to the app layout and hands back the **sidebar's**
handle. Dragging that collapses the sidebar and takes every later explorer and
editor step with it.

### Three ways a click silently does nothing

All three cost hours before `click()` started refusing to fire and naming the
blocker instead.

1. **A toast is over it.** Toasts stack in the top-right, which is exactly where
   the header icons and the Workspaces panel keep their buttons. Dismiss them
   first, and unlink any extension that re-toasts on a timer (a missing sidecar
   toasts every 15 seconds).
2. **A modal is open.** Radix sets `pointer-events: none` on `document.body`
   while a dialog is up, so every button behind it ignores clicks while still
   reporting a perfectly good bounding box. Watch for `role="alertdialog"` as
   well as `role="dialog"`: closing a workspace confirms through the former, and
   leaving that confirm unanswered freezes input everywhere.
3. **The control only exists on hover.** A workspace row shows a tab-count badge
   until the pointer is over it, with Rename and Close underneath.

### Workspaces

```js
await d.click("button[aria-label='New workspace']");        // creates and switches
await d.hover(rowSelector);                                  // reveal the row controls
await d.click("button[aria-label='Close workspace']");       // then confirm:
await d.click("[role=alertdialog][data-state=open] button", { nth: confirmIdx });
```

**A new workspace opens a shell in `$HOME`**, so collapse the sidebar first if
anyone is watching: the tree, the tab label and the prompt all show the
operator's home directory until it is sent somewhere real.

### Do not run `tedi.exe <path>` to point a dev build at a folder

`tauri-plugin-single-instance` forwards it to whichever TEDI already owns the
lock, and that is the user's installed `%LOCALAPPDATA%\TEDI\TEDIApp.exe`, not the
dev build. The dev instance dies, the folder never changes, and a tab opens in
the user's real app. Start `pnpm dev` separately, then launch
`src-tauri\target\debug\TEDIApp.exe "<path>"` yourself with `TEDI_DEBUG_PORT` and
`TAURI_DEV_SERVER_URL=http://localhost:1420/`.

## Checks

Two layers, split by whether a running app is needed.

**`scripts/director-verify.ts`** needs none, and runs inside `pnpm verify` (the
suite globs `scripts/*-verify.ts`, so it needed no wiring). It covers the five
things nothing else can see:

- **The JS injected through `eval` lives inside template literals**, invisible to
  `node --check`, `tsc` and the linter alike, surfacing only as a CDP exception
  mid-task against the user's real window. Every expression is parsed here, and
  arguments are checked to survive interpolation intact - a Windows path whose
  backslashes get eaten parses fine and opens the wrong file.
- **Chord virtual keys**, which the sweep's `Ctrl+/` check cannot guard because
  CodeMirror reads `event.key` and never looks at the vk.
- **The MCP tool table**, which is what Claude Code reads instead of this file. A
  tool with a malformed schema, or a handler calling a `Director` method that has
  been renamed, is a dead tool an agent will still choose.
- **When `sh` and `waitTerminal` decide to stop**, driven against a scripted
  pane. The live sweep cannot stage the state that matters - a terminal ALREADY
  sitting at a prompt when the command is written to it - and a driver that
  returns the previous prompt and calls it the answer passes every other check in
  the repo. The scripted output carries a token that appears nowhere else, so
  "returned too early" cannot be mistaken for success.
- **The privacy gate**, structurally: every accessor in the `window.__tedi` block
  of `usePaneHandles.ts` must route through `publicLeaves()`/`isPublic()`. The
  regression that actually happens is not the filter breaking, it is a seventh
  accessor added next year without it.

All five were mutation-tested: the checks were re-run against deliberately broken
copies (the buffer-changed half of `sh` removed, `!running` dropped from the
wait, the private filter inverted, an ungated accessor added) and each mutation
was caught. The first version of the `sh` check was NOT caught, because it
asserted on a substring the echoed command already contained.

**`sweep.mjs`** walks TEDI's surface and proves each area is drivable, asserting a
measurable change rather than "the command did not throw":

```powershell
pnpm director sweep
```

It reloads the window, normalises to one tab and one pane, cds into the project,
then reports PASS/FAIL per area and lists what it deliberately did not touch (git
mutations, saved workspaces, SSH, extension installs, AI sends). Among the areas:
that `panes` sees a pane in a tab that is not focused, that a wait settles at the
prompt, and that `extensions` reports a well-formed contribution list (shape, not
count - a profile with no extensions installed is legitimate). Two rules it
exists to enforce, both learned the hard way:

- **A failing check must still put back what it changed.** One run left the
  sidebar collapsed and six later explorer and editor checks failed for that
  reason alone, reading as six broken features instead of one broken check.
- **Assert the preconditions first.** A shrunken or minimised window makes every
  layout check fail at once; the sweep names that instead of emitting a dozen
  unrelated failures.

What it turned up about TEDI itself:

- `editor.toggleComment` and `ai.send` register **no handler** in the shared
  command registry. Their owners (CodeMirror's keymap, the AI composer) handle
  the key directly, so drive them with `keys` (`Ctrl+/`, `Enter`), not `cmd`.
- `terminal.close` only closes a **terminal** leaf. Use the pane header's
  `button[aria-label="Close pane"]` for a browser or editor leaf.
- `pane.focusNext` moves both the highlight and the keyboard focus between
  terminals. Into a **browser** pane the highlight moves but focus cannot: that
  pane is a native child webview with nothing in the React tree to focus.
- **A floated pane's window renders no buttons of its own.** Dismiss it by
  closing the source pane back in the main window, never with `window.close()`
  from CDP.
- **Floating regressed mid-session and is excluded from the sweep by default**
  (`SWEEP_FLOAT=1` opts in). It passed twice, then stopped producing a window at
  all: no error in the log, and no window at the OS level either. Five
  explanations were tested and none held.
- **The dev app exited three times during long automated runs, cause unknown.**
  The Rust log shows bursts of six `WebView2 error: HRESULT(0x8007139F)` at exact
  five-minute intervals, starting well before any window was closed. A periodic
  cadence says a timer, not an action. It only happened in sessions that churned
  many browser panes. Next step is a minidump, not another guess.

## Limits

- **Windows only.** The port is a WebView2 flag. WebKitGTK has an equivalent
  (`WEBKIT_INSPECTOR_SERVER`), WKWebView has none.
- **Capture is the main webview only.** Browser preview panes are separate native
  child webviews docked over the pane, and floated panes are their own windows,
  so neither appears in a `shot`. Both are still *drivable*, through `--target`.
- **Anything off screen is scrolled into view before a click or drag.** Without
  that, `getBoundingClientRect` reports coordinates outside the window and the
  synthetic mouse event lands somewhere else entirely, silently: the call
  succeeds and nothing happens.
- **One client per target.** A driver that dies without closing its socket leaves
  the page target occupied and the next connect hangs forever with no error. Kill
  leftover `node scripts/director` processes. A hang on connect is more often a
  *jammed renderer* than an occupied target, though: `Page.enable` waits on the
  renderer's main thread, so if the socket opens in 40ms while `Runtime.evaluate`
  takes 6s, the app is busy, not stuck.
- **Do not edit repo files while driving.** The dev server would reload the
  window. `vite.config.ts` ignores `scripts/**` for that reason, but everything
  under `src/` still triggers a reload.
