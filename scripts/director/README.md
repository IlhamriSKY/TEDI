# Director

Drives a running TEDI window, so demo / build-in-public footage is scripted and
repeatable instead of hand-performed.

**Recording is optional and not the point.** Capture the screen with whatever you
already use (Camtasia, OBS, Game Bar) and let the director do the driving. That
is also the better picture: an external recorder sees browser preview panes and
floated windows, which are separate native webviews that the built-in screencast
(`rec`, below) cannot capture at all. `d.caption()` and `d.mark()` print
`[mm:ss.d]` to the console either way, so the cue list survives without the
built-in capture: start your recorder, start the take, and subtract the one
offset between them.

No dependencies: it speaks the WebView2 DevTools Protocol over one WebSocket,
and Node 22+ ships both `fetch` and a WebSocket client.

## 1. Start TEDI with the debug port

The port is off unless asked for, so an ordinary launch keeps no listening
socket and no automation surface.

```powershell
$env:TEDI_DEBUG_PORT = "9222"
pnpm tauri:dev                      # or the installed binary, see below
```

`TEDI_DEBUG_PORT` does two things, and both are on that one switch:

- appends `--remote-debugging-port` to the process-wide WebView2 browser
  arguments (`preview::apply_webview2_browser_args_env`), and
- registers a plugin whose init script sets `window.__TEDI_AUTOMATION__`, which
  is what `window.__tedi` (command registry, terminal buffer reads) keys off.

**Not limited to dev builds.** Neither half is gated on the build profile, so a
release build started with the env var is drivable the same way:

```powershell
$env:TEDI_DEBUG_PORT = "9222"
& "$env:LOCALAPPDATA\TEDI\TEDIApp.exe"
```

Both have to be set **before launch**. WebView2 fixes its browser arguments when
it creates its environment, which happens before the first webview exists, and
the init script runs ahead of the page's own scripts. Setting the variable in an
already-running session does nothing.

One thing about a release build is still unproven rather than assumed: whether
the DevTools endpoint answers there. The mechanism that was expected to block it
does not - `tauri-runtime-wry` passes `with_devtools(attrs.devtools.unwrap_or(true))`
and wry's `SetAreDevToolsEnabled` is not behind the `devtools` Cargo feature, so
the inspector setting is on regardless of profile, and that feature only gates
Rust's `open_devtools()` API. `pnpm director targets` against a release build
settles it in one command.

Check it is up:

```powershell
pnpm director targets
```

## 2. Drive it

```powershell
pnpm director state                          # what is on screen right now
pnpm director commands                       # every command id this build registered
pnpm director cmd pane.splitRight            # run one, no palette, no fuzzy match
pnpm director keys Ctrl+Shift+P Escape       # real key events
pnpm director sh "git status"                # run it, wait for the prompt, print the output
pnpm director term                           # read the focused terminal's buffer
pnpm director type "git status"              # typed a character at a time, no Enter
pnpm director click "[data-testid=x]"        # real mouse click at a selector
pnpm director drag "[data-slot=resizable-handle]" -260 0 --nth 1   # resize a pane
                                             # (take the nth from state.paneHandle, never a guess)
pnpm director text ".cm-content"             # read a pane back
pnpm director eval "document.title"
pnpm director shot out.png
```

### Seeing, not just clicking

`state` is one round trip for everything needed to choose the next move, so a
script never has to re-derive it:

```jsonc
{
  "window": { "w": 1920, "h": 1080 },
  "sidebar": 240,
  "tabs": 1,
  "leaves":  [{ "id": 3, "kind": "terminal" }, { "id": 4, "kind": "editor" }],
  "focusLeaf": 3,
  "focus": "TEXTAREA",
  "paneHandle": 1,          // index among ALL handles; never hard-code this
  "dialog": null,           // "alertdialog: Close workspace?" when one is up
  "toasts": 0,              // anything > 0 will swallow a click in the top-right
  "buttons": ["Close pane", "New file", "New workspace", …],   // discovery list
  "terminals": [{ "leafId": 3, "atPrompt": true, "running": false, "tail": "…" }]
}
```

**Terminals are the one thing with no DOM fallback.** xterm draws to a WebGL
canvas, so `text()` returns nothing for a terminal pane and a driver that cannot
call `terminals()` is running commands blind. It reads through
`window.__tedi.terminals()`, which exists only when the app was started with
`TEDI_DEBUG_PORT`, like the rest of that object.

`atPrompt` / `running` are why `d.command()` no longer needs a guessed sleep
after it: it waits for the prompt to come back, the way a person does. Pass
`{ awaitPrompt: false }` for something not meant to return (a TUI, a dev server);
the wait times out on its own after 20s regardless, so a take never dies on it.

### Files and the editor

The whole loop a human does works, and `takes/edit-file.mjs` runs it end to end:

```powershell
pnpm director click "button[aria-label='New file']"       # explorer's new-file button
pnpm director type "notes.md"; pnpm director keys Enter    # inline rename input
pnpm director click 'button[data-fs-path$="notes.md"]'     # open it from the tree
pnpm director click ".cm-content"                          # focus the editor
pnpm director type "# Hello"                               # type into CodeMirror
pnpm director keys Ctrl+S                                  # save to disk
pnpm director text ".cm-content"                           # read back what is shown
```

TEDI's own controls carry `aria-label`, not `title`, and file-tree rows are
buttons carrying `data-fs-path` / `data-fs-kind`, so both are addressable without
guessing at class names. `text()` reads CodeMirror's lines directly, so it works
on an inactive tab too (TEDI hides those with `visibility: hidden`, which makes
`innerText` return nothing).

Two things to know before scripting an edit. A tab left open by an earlier run
still holds its buffer even after the file is deleted from disk, and clicking the
tree entry re-focuses that tab rather than opening a fresh one, so start with
`Ctrl+A` `Delete`. And markdown auto-continues lists, so typing `- ` on the line
after a bullet gives you `- - `; type the text only.

`cmd` goes through `window.__tedi.runCommand`, which is the same shared registry
the Command Palette runs, so anything in `pnpm director commands` is reachable.
Anything that is not a registered command is still reachable through `click`,
`drag` and `keys`.

### The AI panel and the Settings window

The built-in AI agent is ordinary React UI, so it is driven the same way:
`cmd ai.toggle` opens it, the composer is the `textarea` whose placeholder starts
with `Ask`, and the model and agent pickers are buttons labelled `Model: …` and
`Agent: …`. Two things are not obvious:

- **`ai.send` registers no handler.** It is a documentation-only shortcut; the
  composer owns Enter itself. Send with `keys Enter`, newline with `Shift+Enter`.
- **Menus are toggles and every CLI call is a fresh DevTools session**, so a menu
  left open by the previous call flips shut on the next one's click. In a take,
  press `Escape` first and open the menu yourself rather than inferring state.

Settings is a **separate webview**, so it needs `--target`:

```powershell
pnpm director cmd settings.open
pnpm director targets                       # now lists two pages
pnpm director --target settings eval "document.title"
```

Float windows are separate webviews too, and reachable the same way.

## 3. Record (optional)

Reach for this only when an external recorder is not an option. It captures the
main webview and nothing else, and it writes ~9MB per second of footage.

```powershell
pnpm director rec intro --seconds 20 --size 1920x1080
pnpm director run scripts/director/takes/showcase.mjs --rec showcase --size 1920x1080
```

`takes/showcase.mjs` is the full tour, about 44 seconds: terminal, split panes,
dragging the divider, `@`-jump to a file and scroll through real code, then a
second workspace and switching back. `takes/demo.mjs` is a shorter one and
`takes/edit-file.mjs` covers creating and editing a file.

Pass `--size 1920x1080` unless you have a reason not to. Without it the capture
is whatever shape the window is, and an editor at 2560x1032 letterboxes into
black bars once anyone cuts it to 16:9.

### What a recording is

Output goes to `recordings/<name>/` (override with `--out`):

```
recordings/demo/
  frame-000001.jpg      capture-order frames, jpeg quality 90
  frame-000002.jpg
  …
  take.json
```

`take.json` is the whole timeline on one clock, in seconds from the first frame:

```jsonc
{
  "name": "demo",
  "width": 1920, "height": 1080,
  "durationSec": 22.6,
  "frames":   [{ "file": "frame-000001.jpg", "t": 0.0 }, …],
  "captions": [{ "t": 2.5, "text": "Split a pane", "seconds": 2.5 }, …],
  "marks":    [{ "t": 8.3, "label": "palette" }, …]
}
```

**Capture is variable-rate, not fixed-fps.** WebView2 emits a frame when the page
paints, so an idle editor costs almost nothing and a busy stretch lands ~45 fps.
That is why every frame carries its own `t`: whatever edits this later must
resample by timestamp, not assume a constant interval. For a given output time,
show the last frame whose `t` is at or before it.

`captions` and `marks` come from `d.caption()` and `d.mark()` inside a take and
share that same clock, so subtitles and chapter cuts need no hand-syncing.

Nothing here encodes video. There is no ffmpeg dependency and no renderer; the
frame sequence plus `take.json` is the deliverable, and the editing step is
deliberately somebody else's job.

## 4. Write a take

A take is a plain module that default-exports one async function, plus an
optional `setup` that runs **before** recording starts, so staging the scene is
not in the shot.

```js
export async function setup(d) {
  await d.command("cd 'D:\\path\\to\\project'", { delay: 8 });
  await d.wait(1200);
  await d.command("clear", { delay: 8 });
}

/** @param {import("../director.mjs").Director} d */
export default async function take(d) {
  d.caption("Split a pane", { seconds: 2.5 });   // subtitle, stamped on the recording clock
  await d.cmd("pane.splitRight");
  await d.wait(2000);

  d.mark("terminal");                            // chapter marker for later cutting
  await d.command("cargo test");                 // types it, then Enter
  await d.wait(4000);
}
```

**Run shell commands with `d.command()`, not `d.type()`.** A terminal that has
just taken focus swallows the first keystroke it is sent, so `d.type("echo x")`
into a freshly split pane arrives as `cho x` however long the take waits first.
`d.command()` absorbs that with a leading Backspace, which does nothing at an
empty prompt, and then waits for the prompt to come back instead of guessing how
long the command needs. Use plain `type()` for editors, the palette and text
fields, where a Backspace would delete.

The `d.wait()` calls in the takes are for **pacing**, not for correctness: a
viewer needs a beat to see what changed. Do not add one just to let a command
finish, that part is handled.

Always stage a working folder. A shell starts in `$HOME`, which puts the
operator's private dotfiles in the file tree on camera, and if `$HOME` happens to
be a git repo the app spends its main thread on git decorations and the capture
rate collapses (a jammed renderer is also what makes a synthetic keystroke go
missing). Cd into a real project and the tree, tab title and breadcrumb all
follow.

`d.caption()` and `d.mark()` stamp the recording's own clock, so subtitles stay
glued to the footage with nothing to hand-sync afterwards.

A take may also export `teardown`, which runs **after** the recording stops, so
putting the app back is not in the shot either.

A take that throws still closes out its recording (and exits 1), so a failure at
second 40 of 44 keeps `take.json` with every caption and mark in it.

Full surface: `state`, `terminals`, `waitForPrompt`, `focusedLeaf`,
`paneHandleIndex`, `wait`, `eval`, `cmd`, `command`, `commands`, `keys`, `type`,
`text`, `box`, `waitFor`, `hover`, `click`, `drag`, `dismissToasts`,
`setViewport`, `clearViewport`, `metrics`, `shot`, `record`, `caption`, `mark`,
`stop`.

**Never hard-code the `nth` of a pane splitter.** The handle list is
`[sidebar, panes…, right column]`, so its indices move with the pane count; ask
`d.paneHandleIndex()` (or read `state().paneHandle`). It returns -1 when only one
pane is open, which is the honest answer, and the reason it exists: a single leaf
renders no panel group at all, so the obvious lookup walks up to the app layout
and hands back the **sidebar's** handle. Dragging that collapses the sidebar and
takes every later explorer and editor step with it.

### Three ways a click silently does nothing

All three cost hours before `click()` started refusing to fire and naming the
blocker instead.

1. **A toast is over it.** Toasts stack in the top-right, which is exactly where
   the header icons and the Workspaces panel keep their buttons. Call
   `d.dismissToasts()` first, and turn off any extension that re-toasts on a
   timer before recording (a missing sidecar toasts every 15 seconds).
2. **A modal is open.** Radix sets `pointer-events: none` on `document.body`
   while a dialog is up, so every button behind it ignores clicks while still
   reporting a perfectly good bounding box. Watch for
   `role="alertdialog"` as well as `role="dialog"`: closing a workspace asks for
   confirmation through the former, and leaving that confirm unanswered freezes
   input everywhere.
3. **The control only exists on hover.** A workspace row shows a tab-count badge
   until the pointer is over it, with Rename and Close underneath. `d.hover()`
   the row first.

### Workspaces

```js
await d.dismissToasts();
await d.click("button[aria-label='New workspace']");        // creates and switches
await d.click("button[aria-label='Rename workspace']");
await d.hover(rowSelector);                                  // reveal the row controls
await d.click("button[aria-label='Close workspace']");       // then confirm:
await d.click("[role=alertdialog][data-state=open] button", { nth: confirmIdx });
```

**A new workspace opens a shell in `$HOME`**, so for the second or two before it
is sent somewhere real, the tree, the tab label and the prompt all show the
operator's home directory. `takes/showcase.mjs` collapses the sidebar first, cds
with no per-character delay, and only captions once it has settled.

## Checks

Two layers, split by whether a running app is needed.

`scripts/director-verify.ts` needs none, and runs inside `pnpm verify` (the
suite globs `scripts/*-verify.ts`, so it was picked up without wiring). It covers
the two things nothing else can see: **the JS injected through `eval` lives
inside template literals**, invisible to `node --check`, `tsc` and the linter
alike, surfacing only as a CDP exception mid-take; and **chord virtual keys**,
which the sweep's `Ctrl+/` check cannot guard because CodeMirror reads
`event.key` and never looks at the vk.

`sweep.mjs` walks TEDI's surface and proves each area is drivable, asserting a
measurable change rather than "the command did not throw":

```powershell
pnpm director run scripts/director/sweep.mjs
```

It reloads the window, normalises to one tab and one pane, cds into the project,
then reports PASS/FAIL per area and lists what it deliberately did not touch
(git mutations, saved workspaces, SSH, extension installs, AI sends).

Two rules it exists to enforce, both learned the hard way:

- **A failing check must still put back what it changed.** One run left the
  sidebar collapsed and six later explorer and editor checks failed for that
  reason alone, reading as six broken features instead of one broken check.
- **Assert the preconditions first.** A shrunken or minimised window makes every
  layout check fail at once; the sweep now names that instead of emitting a
  dozen unrelated failures.

What it turned up about TEDI itself:

- `editor.toggleComment` and `ai.send` register **no handler** in the shared
  command registry. Their owners (CodeMirror's keymap, the AI composer) handle
  the key directly, so drive them with `keys` (`Ctrl+/`, `Enter`), not `cmd`.
- `terminal.close` only closes a **terminal** leaf. Use the pane header's
  `button[aria-label="Close pane"]` to close a browser or editor leaf.
- `pane.focusNext` moves both the highlight and the keyboard focus between
  terminals. Into a **browser** pane the highlight moves but focus cannot: that
  pane is a native child webview with nothing in the React tree to focus.
- **A floated pane's window renders no buttons of its own.** Dismiss it by
  closing the source pane back in the main window, never with `window.close()`
  from CDP.
- **Floating regressed mid-session and is excluded from the sweep by default**
  (`SWEEP_FLOAT=1` opts in). It passed twice, then stopped producing a window at
  all: no error in the log, and no window at the OS level either. Five
  explanations were tested and none held (a single-pane tab, stale float state
  cleared by a page reload, the same cleared by a full app restart, the CDP
  target simply not being exposed, a jammed renderer), and twice the app exited
  moments after the click.
- **The dev app exited three times during long automated runs, cause unknown.**
  What the Rust log actually shows before each exit is bursts of six
  `WebView2 error: HRESULT(0x8007139F)` ("the group or resource is not in the
  correct state"), **at exact five-minute intervals**, starting well before any
  window was closed. Three tempting explanations were each tested and do not
  hold: closing the Settings window, floating a pane, and closing an auxiliary
  window from CDP. The periodic cadence says the trigger is a timer, not an
  action. It only happened in sessions that created and destroyed many browser
  panes, which points at handles to gone child webviews still being poked, but
  that is a hypothesis, not a finding. Next step: a minidump on the next exit,
  and a look at whatever touches webviews on a five-minute cycle.

## Limits

- **Windows only.** The port is a WebView2 flag. WebKitGTK has an equivalent
  (`WEBKIT_INSPECTOR_SERVER`), WKWebView has none, so macOS would need OS-level
  capture instead.
- **The built-in capture sees the main webview only.** Browser preview panes are
  separate native child webviews docked over the pane, and floating panes are
  their own windows, so neither appears in it. Everything drawn by the React UI
  does. An external screen recorder has no such blind spot, which is the reason
  to prefer one. Both are still *drivable*, through `--target`.
- **Anything off screen is scrolled into view before a click or drag.** Without
  that, `getBoundingClientRect` reports coordinates outside the window and the
  synthetic mouse event lands somewhere else entirely, silently: the call
  succeeds and nothing happens.
- **One client per target.** A driver that dies without closing its socket leaves
  the page target occupied and the next run cannot attach; kill leftover
  `node scripts/director` processes if a connect times out.
- **Turn off noisy extensions before filming.** A failing extension (Discord Rich
  Presence has no sidecar in the dev profile) toasts an error into the corner of
  the shot.
- **Do not edit repo files mid-take.** The dev server would reload the window.
  `vite.config.ts` ignores `scripts/**` and `recordings/**` for that reason,
  but everything under `src/` still triggers a reload.
