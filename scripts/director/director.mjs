/**
 * Director: drives a running TEDI window over the WebView2 DevTools Protocol and
 * captures it, so screen recordings for demo / build-in-public videos are
 * scripted and repeatable instead of hand-performed.
 *
 * Requires TEDI to have been started with `TEDI_DEBUG_PORT=<port>` (see
 * `preview::apply_webview2_browser_args_env`). Zero dependencies: Node 22+ ships
 * both `fetch` and a WebSocket client, and CDP is just JSON over one socket.
 *
 * Windows only for now, because the port is a WebView2 flag. WebKitGTK has an
 * equivalent (`WEBKIT_INSPECTOR_SERVER`) and WKWebView has none, so macOS would
 * need OS-level capture instead.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** CDP's modifier bitmask. `mod` follows TEDI's own Mod = Cmd on mac, Ctrl elsewhere. */
const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  super: 4,
  shift: 8,
  mod: process.platform === "darwin" ? 4 : 2,
};

/** Keys that are not a single printable character. `text` is what a terminal wants. */
const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};
for (let n = 1; n <= 12; n++) NAMED_KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n };

/**
 * US-layout `code` + Windows virtual-key for the printable characters that are
 * neither a letter nor a digit, with the shifted character that shares the key.
 * Synthesised keystrokes need a real virtual-key code: an event carrying only
 * `text` is not a keystroke any renderer takes seriously.
 */
const PUNCTUATION = [
  [" ", " ", "Space", 32],
  ["-", "_", "Minus", 189],
  ["=", "+", "Equal", 187],
  ["[", "{", "BracketLeft", 219],
  ["]", "}", "BracketRight", 221],
  ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 186],
  ["'", '"', "Quote", 222],
  ["`", "~", "Backquote", 192],
  [",", "<", "Comma", 188],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
];
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** CDP key-event fields for one printable character, as a real keyboard sends it. */
function charEvent(ch) {
  const upper = ch.toUpperCase();
  if (ch >= "a" && ch <= "z") return { code: `Key${upper}`, vk: upper.charCodeAt(0), shift: false };
  if (ch >= "A" && ch <= "Z") return { code: `Key${upper}`, vk: upper.charCodeAt(0), shift: true };
  if (ch >= "0" && ch <= "9") return { code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false };
  const shiftedDigit = SHIFTED_DIGITS.indexOf(ch);
  if (shiftedDigit !== -1) {
    return { code: `Digit${shiftedDigit}`, vk: 48 + shiftedDigit, shift: true };
  }
  for (const [plain, shifted, code, vk] of PUNCTUATION) {
    if (ch === plain) return { code, vk, shift: false };
    if (ch === shifted) return { code, vk, shift: true };
  }
  // Anything else (accents, CJK, emoji) has no US-layout key. Fall back to a
  // text-only event; it is not a keystroke, but it beats dropping the character.
  return { code: undefined, vk: 0, shift: false };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `Ctrl+Shift+P` -> the CDP key event fields for one press. Exported for the
 *  sweep's chord check, which is the only guard on the virtual-key mapping: the
 *  `Ctrl+/` check passes either way, because CodeMirror reads `event.key`. */
export function parseChord(chord) {
  const parts = String(chord).split("+").filter(Boolean);
  const last = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const bit = MODIFIER_BITS[p.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${p}" in "${chord}"`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[String(last).toLowerCase()];
  if (named) return { ...named, modifiers };
  if (last.length !== 1) throw new Error(`Unknown key "${last}" in "${chord}"`);
  const upper = last.toUpperCase();
  // Through `charEvent`, not a second hand-rolled lookup: deriving the virtual
  // key from the character itself gave `Ctrl+/` vk 47 instead of 191, which
  // survived only because CodeMirror reads `event.key`. Anything reading the
  // virtual key saw a different key entirely.
  const { code, vk } = charEvent(last);
  return {
    key: modifiers & MODIFIER_BITS.shift ? upper : last,
    code,
    vk: vk || upper.charCodeAt(0),
    // A char event only fires without Ctrl/Meta held; sending `text` alongside
    // them makes the page see a literal character on top of the shortcut.
    text: modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta) ? undefined : last,
    modifiers,
  };
}

/** Minimal CDP client over one target's socket. */
class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const slot = this.#pending.get(msg.id);
        if (!slot) return;
        this.#pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else slot.resolve(msg.result);
        return;
      }
      for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
    });
    ws.addEventListener("close", () => {
      for (const slot of this.#pending.values()) slot.reject(new Error("DevTools socket closed"));
      this.#pending.clear();
    });
  }

  static async attach(wsUrl, timeoutMs = 8000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      // A page target accepts ONE DevTools client. A previous driver that died
      // without closing its socket leaves the target occupied and the connect
      // hangs forever with no error, so fail loudly with the actual fix.
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out attaching to ${wsUrl}. Another DevTools client probably still holds ` +
                `this target - close it, or kill leftover \`node scripts/director\` processes.`,
            ),
          ),
        timeoutMs,
      );
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`Cannot open ${wsUrl}`)); }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.#listeners.get(method);
    if (list) list.push(fn);
    else this.#listeners.set(method, [fn]);
  }

  /**
   * Wait for the close handshake. Exiting the process with the socket still open
   * leaves the page target occupied on the WebView2 side, and the NEXT run then
   * hangs on connect, so every exit path must come through here.
   */
  close() {
    if (this.#ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.#ws.addEventListener("close", resolve, { once: true });
      this.#ws.close();
      setTimeout(resolve, 1000);
    });
  }
}

/** Ask the debug port what pages exist. Also the liveness check. */
export async function listTargets(port) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/list`);
  } catch (err) {
    throw new Error(
      `No DevTools endpoint on 127.0.0.1:${port}. Start TEDI with TEDI_DEBUG_PORT=${port} ` +
        `(e.g. \`$env:TEDI_DEBUG_PORT=${port}; pnpm tauri:dev\`). Cause: ${err.message}`,
    );
  }
  return res.json();
}

/**
 * The main TEDI window, not the Settings or float windows, which are separate
 * webviews on their own HTML entries.
 */
function pickTarget(targets, match) {
  const pages = targets.filter((t) => t.type === "page" || t.type === "webview");
  if (match) {
    const needle = match.toLowerCase();
    const hit = pages.find(
      (t) => t.url.toLowerCase().includes(needle) || (t.title ?? "").toLowerCase().includes(needle),
    );
    if (!hit) throw new Error(`No target matching "${match}". Have: ${pages.map((t) => t.url).join(", ")}`);
    return hit;
  }
  const main = pages.find((t) => {
    const file = t.url.split("?")[0].split("#")[0].split("/").pop() ?? "";
    return file === "" || file === "index.html";
  });
  if (!main) throw new Error(`No main window target. Have: ${pages.map((t) => t.url).join(", ")}`);
  return main;
}

export async function connect({ port = Number(process.env.TEDI_DEBUG_PORT) || 9222, target } = {}) {
  const chosen = pickTarget(await listTargets(port), target);
  const cdp = await Cdp.attach(chosen.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const d = new Director(cdp, chosen);
  // A freshly attached session drops its FIRST synthetic input event when the
  // renderer is not through a paint yet (typing "echo x" arrived as "cho x",
  // reliably so while the window was busy). Waiting on two animation frames
  // gates on the renderer actually running rather than on a guessed delay, and
  // it belongs here, on the path every verb shares, not sprinkled through
  // `type` and `keys`.
  await d.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))");
  return d;
}

/** Everything a take script gets. */
export class Director {
  #recording = null;
  /** Clock for `caption`/`mark` when nothing is being screencast, so the cue
   *  list is still usable against footage captured by an external recorder. */
  #startedAt = Date.now();

  constructor(cdp, target) {
    this.cdp = cdp;
    this.target = target;
  }

  /** Await this before the process exits, or the next run cannot attach. */
  close() {
    return this.cdp.close();
  }

  wait(ms) {
    return sleep(ms);
  }

  /** Evaluate JS in the window and return its value. Awaits promises. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  /** Run a TEDI command by shortcut id (see `commands()`), bypassing the palette. */
  async cmd(id) {
    const ok = await this.eval(`window.__tedi?.runCommand(${JSON.stringify(id)}) ?? null`);
    if (ok === null) throw new Error("window.__tedi missing: is this TEDI, and is the build current?");
    if (!ok) throw new Error(`No handler registered for command "${id}" right now`);
    return ok;
  }

  commands() {
    return this.eval("window.__tedi?.listCommands() ?? []");
  }

  /**
   * Read every terminal: its buffer, whether it is sitting at a prompt, and
   * whether a command is still running.
   *
   * This is the driver's only way to see a terminal at all. xterm renders to a
   * WebGL canvas, so there is no DOM text for `text()` to read, and without this
   * a script can type `git status` but never find out what it printed.
   */
  async terminals(maxLines = 200) {
    const out = await this.eval(`window.__tedi?.terminals?.(${Number(maxLines)}) ?? null`);
    if (out === null) {
      throw new Error(
        "window.__tedi.terminals missing. The automation surface only exists when TEDI was STARTED " +
          "with TEDI_DEBUG_PORT set (Rust injects the flag the frontend keys off), so setting it " +
          "after launch is too late. Restart with it, in a dev or a release build alike.",
      );
    }
    return out;
  }

  /**
   * Wait until a terminal is back at its prompt, which is what a human does
   * instead of guessing a sleep long enough for the slowest run.
   *
   * Returns false on timeout rather than throwing: a TUI (vim, lazygit, an AI
   * CLI) legitimately never returns to a prompt, and a take that opens one on
   * purpose must not die for it. `running` comes from OSC 133 / alt-screen and
   * `atPrompt` from the PS1 heuristic; requiring both keeps a custom prompt
   * (starship, oh-my-posh) from reading as "done" mid-command.
   */
  async waitForPrompt({ leafId = null, timeout = 20000, settle = 250 } = {}) {
    const target = leafId ?? (await this.focusedLeaf());
    const deadline = Date.now() + timeout;
    for (;;) {
      const list = await this.terminals(1);
      // No terminals at all means nothing will ever come back; stalling the full
      // timeout would just hide the mistake (`command()` into an editor pane).
      if (!list.length) return false;
      const t = list.find((x) => x.leafId === target) ?? list[list.length - 1];
      if (t?.atPrompt && !t.running) {
        await sleep(settle);
        return true;
      }
      if (Date.now() > deadline) return false;
      await sleep(200);
    }
  }

  /**
   * Leaf id holding keyboard focus, or null. xterm keeps focus in a hidden
   * textarea inside the leaf, so this identifies the pane a script just typed
   * into without inferring it from "the newest one", which is wrong the moment a
   * take focuses back to an older pane.
   */
  focusedLeaf() {
    return this.eval(
      `(() => { const el = document.activeElement?.closest('[data-pane-leaf]');
        return el ? Number(el.getAttribute('data-pane-leaf')) : null; })()`,
    );
  }

  /** Press one or more chords, e.g. `keys("Ctrl+Shift+P", "Escape")`. */
  async keys(...chords) {
    for (const chord of chords) {
      const k = parseChord(chord);
      const base = {
        modifiers: k.modifiers,
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.vk,
        nativeVirtualKeyCode: k.vk,
      };
      await this.cdp.send("Input.dispatchKeyEvent", {
        ...base,
        type: k.text ? "keyDown" : "rawKeyDown",
        text: k.text,
        unmodifiedText: k.text,
      });
      await this.cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      await sleep(12);
    }
  }

  /**
   * Type text a character at a time. The per-character delay is the point: an
   * instant paste reads as a cut in the footage, a human cadence does not.
   * A trailing "\r" or "\n" is sent as Enter, which is what a PTY wants.
   */
  /**
   * Type text a character at a time, as real key events.
   *
   * NOT `Input.insertText`: Chromium delivers that as an IME commit, and xterm's
   * composition handling swallows the first one into a freshly focused terminal,
   * so every `echo` typed into a just-split pane arrived as `cho` no matter how
   * long the take waited first. Full key events (with a genuine `code` and
   * virtual-key, which an earlier text-only version was missing) go down the
   * ordinary keydown path and land intact.
   */
  async type(text, { delay = 45 } = {}) {
    for (const ch of String(text)) {
      if (ch === "\n" || ch === "\r") {
        await this.keys("Enter");
      } else {
        const { code, vk, shift } = charEvent(ch);
        const base = {
          modifiers: shift ? MODIFIER_BITS.shift : 0,
          key: ch,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        };
        await this.cdp.send("Input.dispatchKeyEvent", {
          ...base,
          type: "keyDown",
          text: ch,
          unmodifiedText: ch,
        });
        await this.cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      }
      if (delay) await sleep(delay);
    }
  }

  /**
   * Dismiss every toast, and report how many went.
   *
   * Not cosmetic. Toasts stack in the top-right corner, which is exactly where
   * the header icons and the Workspaces panel's own buttons live, so a click
   * aimed at "New workspace" lands on the toast instead and reports success
   * while doing nothing. An extension whose sidecar is missing re-toasts every
   * 15 seconds, so call this right before clicking up there, and turn the
   * offending extension off before recording anything.
   */
  async dismissToasts() {
    const find = `[...document.querySelectorAll('button')].findIndex((b) =>
      /^dismiss$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()))`;
    let gone = 0;
    for (let i = 0; i < 12; i++) {
      const idx = await this.eval(find);
      if (idx < 0) break;
      await this.click("button", { nth: idx });
      await sleep(250);
      gone++;
    }
    return gone;
  }

  /**
   * Type a shell command into the focused terminal and run it.
   *
   * The leading Backspace is sacrificial. A terminal that has just taken focus
   * (right after `pane.splitRight`, say) swallows the first keystroke it is
   * sent, so `echo x` arrives as `cho x` no matter how long the take waits
   * first, and it happens with synthesised key events and IME commits alike.
   * Backspace at an empty prompt does nothing, so absorbing the loss with one
   * costs nothing and the command lands whole.
   *
   * Terminals only. In an editor or a text field a Backspace deletes, so type
   * into those with `type()`.
   *
   * Waits for the prompt to come back by default, so a take reads like the thing
   * it is filming: run a command, wait for it to finish, run the next. Pass
   * `{ awaitPrompt: false }` for something that is not meant to return (opening
   * a TUI, starting a dev server); the wait gives up on its own timeout anyway.
   */
  async command(text, { awaitPrompt = true, timeout = 20000, leafId = null, ...opts } = {}) {
    await this.keys("Backspace");
    await this.type(text, opts);
    await this.keys("Enter");
    if (awaitPrompt) await this.waitForPrompt({ timeout, leafId });
  }

  /**
   * Viewport rect of a CSS selector, or null. `nth` picks among matches, which
   * is not optional in practice: a split window has one
   * `[data-slot=resizable-handle]` per divider and only the index tells them
   * apart.
   */
  box(selector, { nth = 0 } = {}) {
    return this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(nth)}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
  }

  /**
   * Text of a selector, which is how a take reads a pane back.
   *
   * CodeMirror's lines are read directly rather than through `innerText`:
   * TEDI hides an inactive tab with `visibility: hidden` so its PTYs keep
   * streaming, and `innerText` returns "" for anything hidden, which would make
   * a perfectly loaded editor look empty. `.cm-line` also gives real line
   * breaks, where `textContent` would run every line together.
   *
   * NOT for terminals: those render to a WebGL canvas and have no DOM text.
   * CodeMirror virtualises, so a long file returns only the rendered window.
   */
  text(selector, { nth = 0 } = {}) {
    return this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(nth)}];
      if (!el) return null;
      const lines = el.classList?.contains("cm-content") ? el.querySelectorAll(".cm-line") : [];
      if (lines.length) return [...lines].map((l) => l.textContent).join("\\n");
      return el.innerText || el.textContent || "";
    })()`);
  }

  /**
   * Index of a splitter BETWEEN TWO PANES, among all resize handles, or -1.
   * That index is what `drag()`'s `nth` wants, and it shifts with the pane count,
   * so it can never be hard-coded.
   *
   * The obvious version - "the first handle inside the leaf's closest panel
   * group" - is wrong in a way that only shows up with ONE pane open: a single
   * leaf renders no group at all (`PaneTreeView`), so `closest` walks up to the
   * app's outer layout and the answer comes back 0, which is the SIDEBAR's
   * handle. Dragging that collapses the sidebar and takes every later explorer
   * and editor step with it, silently. So identify the group by its own
   * children instead: only pane panels carry `id="pane-<leafId>"`, where the
   * outer layout's are `sidebar` / `workspace` / `right-slot`.
   */
  paneHandleIndex() {
    return this.eval(`(() => {
      const inPaneGroup = (h) => {
        const g = h.closest('[data-slot=resizable-panel-group]');
        if (!g) return false;
        // Panels belonging to THIS group, not to one nested inside it, and not
        // matched through a wrapper the panel library might add. A split inside
        // a split gives every level its own pane- panels, so ownership has to be
        // decided by the panel's own nearest group.
        const mine = [...g.querySelectorAll('[data-slot=resizable-panel][id^="pane-"]')]
          .filter((p) => p.closest('[data-slot=resizable-panel-group]') === g);
        return mine.length >= 2;
      };
      return [...document.querySelectorAll('[data-slot=resizable-handle]')].findIndex(inPaneGroup);
    })()`);
  }

  /**
   * One round trip for everything a driver needs to choose its next move.
   *
   * Every field here was being re-derived by hand in each take and again in the
   * sweep, and two of them are where the mistakes were: a hard-coded splitter
   * `nth` once dragged the sidebar shut and took six later checks with it, and a
   * blocked click cost hours before anything reported the open modal. `buttons`
   * is the discovery list, so a script can find a control by aria-label instead
   * of guessing at class names.
   */
  async state({ tail = 3 } = {}) {
    const dom = await this.eval(`(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const kind = (el) => el.querySelector('.xterm-screen') ? 'terminal'
        : el.querySelector('.cm-content') ? 'editor' : 'browser';
      const modal = document.querySelector('[role=dialog][data-state=open],[role=alertdialog][data-state=open]');
      const a = document.activeElement;
      const focusLeaf = a?.closest('[data-pane-leaf]');
      return {
        window: { w: innerWidth, h: innerHeight },
        sidebar: Math.round(document.querySelector('[data-testid=sidebar]')?.getBoundingClientRect().width ?? 0),
        tabs: [...new Set(q('[data-tab-id]').map((e) => e.getAttribute('data-tab-id')))].length,
        leaves: q('[data-pane-leaf]').map((e) => ({ id: Number(e.getAttribute('data-pane-leaf')), kind: kind(e) })),
        focusLeaf: focusLeaf ? Number(focusLeaf.getAttribute('data-pane-leaf')) : null,
        focus: a ? a.tagName + (a.placeholder ? ' "' + a.placeholder + '"' : '') : null,
        dialog: modal ? modal.getAttribute('role') + ': ' + (modal.textContent || '').trim().slice(0, 60) : null,
        toasts: q('button').filter((b) => /^dismiss$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())).length,
        buttons: [...new Set(q('button[aria-label]').map((b) => b.getAttribute('aria-label')))].sort(),
      };
    })()`);
    // -1 when only one pane is open, which is the honest answer: there is no
    // splitter between panes to drag yet.
    dom.paneHandle = await this.paneHandleIndex();
    // Tail only: a full 200-line buffer per pane buries the rest of the snapshot.
    // Read the whole thing with `terminals()` when a check actually needs it.
    // Degrades instead of throwing: this is the verb reached for when something
    // is already wrong, and the DOM half stays useful when the terminal half is
    // the thing that is missing.
    try {
      dom.terminals = (await this.terminals(200)).map(({ text, ...t }) => ({
        ...t,
        tail: text.trimEnd().split("\n").slice(-tail).join("\n"),
      }));
    } catch (err) {
      dom.terminals = [];
      dom.terminalsError = err.message;
    }
    return dom;
  }

  async waitFor(selector, { nth = 0, timeout = 10000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const box = await this.box(selector, { nth });
      // One dimension is enough. A collapsed sidebar's resize handle is 0 wide
      // and ~1000 tall, and demanding both made it unreachable, which is exactly
      // when you need to grab it: to drag the sidebar back open.
      if (box && (box.width > 0 || box.height > 0)) return box;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for "${selector}" [${nth}]`);
      await sleep(100);
    }
  }

  async #mouse(type, x, y, extra = {}) {
    await this.cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseMoved" ? (extra.held ? 1 : 0) : 1,
      clickCount: 1,
      ...extra,
    });
  }

  /**
   * Bring a target into view before pointing at it. `getBoundingClientRect` is
   * viewport-relative, so an element below the fold reports coordinates outside
   * the window and the synthetic mouse event lands on whatever is actually
   * there. That failure is silent: the call "succeeds" and nothing happens.
   */
  async #scrollIntoView(selector, nth) {
    await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(nth)}];
      el?.scrollIntoView({ block: "center", inline: "center" });
      return true;
    })()`);
    await sleep(250);
  }

  /**
   * Is something else on top of this element, or is input disabled on it?
   * Returns a description of the blocker, or null when the click can land.
   *
   * An open Radix modal sets `pointer-events: none` on `document.body`, so every
   * button behind it silently ignores clicks while still reporting a perfectly
   * good bounding box. A toast stacked over the header does the same locally.
   * Both cost hours before this check existed.
   */
  #blocker(selector, nth) {
    return this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(nth)}];
      if (!el) return "element is gone";
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      if (top === el || el.contains(top) || (top && top.contains(el))) return null;
      const modal = document.querySelector('[role=dialog][data-state=open],[role=alertdialog][data-state=open]');
      const label = modal ? (modal.textContent || "").trim().slice(0, 60) : null;
      return (modal ? 'a modal is open ("' + label + '") and its overlay swallows the click; ' : "") +
        "topmost element there is " + (top ? top.tagName + "." + String(top.className).slice(0, 30) : "nothing");
    })()`);
  }

  /**
   * Move the pointer over a selector and leave it there.
   *
   * Rows that reveal their controls on hover need this before the control can be
   * clicked at all: a workspace row shows a tab-count badge until you hover it,
   * and the Rename / Close buttons sit underneath that badge.
   */
  async hover(selector, { nth = 0 } = {}) {
    await this.#scrollIntoView(selector, nth);
    const box = await this.waitFor(selector, { nth });
    await this.#mouse("mouseMoved", box.x + box.width / 2, box.y + box.height / 2);
    await sleep(400);
    return box;
  }

  /** Real mouse click at the centre of a selector. */
  async click(selector, { nth = 0 } = {}) {
    await this.waitFor(selector, { nth });
    await this.#scrollIntoView(selector, nth);
    let blocked = await this.#blocker(selector, nth);
    if (blocked) {
      // Try hovering once before giving up. A lot of this UI only materialises
      // under the pointer: a workspace row and a pane header both show a count
      // badge until hovered, with Rename / Close sitting underneath it. Moving
      // the mouse onto the badge still hovers the row, which reveals them.
      await this.hover(selector, { nth });
      blocked = await this.#blocker(selector, nth);
    }
    if (blocked) throw new Error(`cannot click "${selector}" [${nth}]: ${blocked}`);
    const box = await this.waitFor(selector, { nth });
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.#mouse("mouseMoved", x, y);
    await this.#mouse("mousePressed", x, y);
    await this.#mouse("mouseReleased", x, y);
    await sleep(60);
  }

  /**
   * Drag from the centre of a selector by (dx, dy) in steps, so pane splitters
   * see the intermediate moves they need. This is how panes get resized: they
   * are `react-resizable-panels` handles, driven by pointer movement.
   */
  async drag(selector, dx, dy, { steps = 20, nth = 0 } = {}) {
    await this.waitFor(selector, { nth });
    await this.#scrollIntoView(selector, nth);
    const box = await this.waitFor(selector, { nth });
    const x0 = box.x + box.width / 2;
    const y0 = box.y + box.height / 2;
    await this.#mouse("mouseMoved", x0, y0);
    await this.#mouse("mousePressed", x0, y0);
    for (let i = 1; i <= steps; i++) {
      await this.#mouse("mouseMoved", x0 + (dx * i) / steps, y0 + (dy * i) / steps, { held: true });
      await sleep(16);
    }
    await this.#mouse("mouseReleased", x0 + dx, y0 + dy);
    await sleep(60);
  }

  /** Resize the whole recorded surface, independent of the real window size. */
  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
    await sleep(300);
  }

  clearViewport() {
    return this.cdp.send("Emulation.clearDeviceMetricsOverride");
  }

  metrics() {
    return this.eval("({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })");
  }

  /** Single still. `file` gets the PNG. */
  async shot(file) {
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  /**
   * Start a screencast into `dir`. Frames land as jpegs plus a `take.json`
   * timeline: frame timestamps, caption cues, and chapter marks all share one
   * clock, so whatever edits the footage later can place subtitles and cuts
   * without hand-syncing. Nothing here encodes video.
   */
  async record(dir, { quality = 90 } = {}) {
    if (this.#recording) throw new Error("Already recording");
    const outDir = path.resolve(dir);
    await mkdir(outDir, { recursive: true });
    const { width, height, dpr } = await this.metrics();
    const rec = {
      dir: outDir,
      startedAt: Date.now(),
      width: Math.round(width * dpr),
      height: Math.round(height * dpr),
      frames: [],
      captions: [],
      marks: [],
      writes: [],
    };
    this.#recording = rec;

    this.cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      // Ack first: the next frame is not sent until this one is acknowledged,
      // so any await before it throttles the capture rate.
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (this.#recording !== rec) return;
      const name = `frame-${String(rec.frames.length + 1).padStart(6, "0")}.jpg`;
      rec.frames.push({ file: name, t: (Date.now() - rec.startedAt) / 1000 });
      rec.writes.push(writeFile(path.join(outDir, name), Buffer.from(data, "base64")));
    });

    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality,
      maxWidth: rec.width,
      maxHeight: rec.height,
      everyNthFrame: 1,
    });
    return rec;
  }

  /**
   * Cue timestamp, printed as `[mm:ss.d]` and pushed into `take.json` when this
   * driver is also the one recording.
   *
   * It prints either way on purpose. When the screen is being captured by an
   * external recorder (Camtasia, OBS), the printed list IS the deliverable: start
   * the recorder, start the take, and the console gives a marker list offset only
   * by the gap between the two, which is one number to subtract instead of
   * scrubbing for every cut by eye.
   */
  #cue(kind, label, extra) {
    const rec = this.#recording;
    const t = (Date.now() - (rec ? rec.startedAt : this.#startedAt)) / 1000;
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = (t % 60).toFixed(1).padStart(4, "0");
    console.log(`[${mm}:${ss}] ${kind} ${label}`);
    if (rec) (kind === "mark" ? rec.marks : rec.captions).push({ t, ...extra });
  }

  /** Subtitle cue at the current moment. */
  caption(text, { seconds = 3 } = {}) {
    this.#cue("caption", text, { text: String(text), seconds });
  }

  /** Chapter marker, for cutting the take up later. */
  mark(label) {
    this.#cue("mark", label, { label: String(label) });
  }

  async stop() {
    const rec = this.#recording;
    if (!rec) return null;
    this.#recording = null;
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await Promise.all(rec.writes);
    const take = {
      name: path.basename(rec.dir),
      width: rec.width,
      height: rec.height,
      durationSec: rec.frames.length ? rec.frames[rec.frames.length - 1].t : 0,
      frames: rec.frames,
      captions: rec.captions,
      marks: rec.marks,
    };
    await writeFile(path.join(rec.dir, "take.json"), `${JSON.stringify(take, null, 2)}\n`);
    return take;
  }
}
