/**
 * Driver: drives a running TEDI window over the WebView2 DevTools Protocol, so
 * an agent (Claude Code, via `server.mjs`) or a human (via `cli.mjs`) can operate
 * every part of the app and read the result back.
 *
 * Requires TEDI to have been started with `TEDI_DEBUG_PORT=<port>` (see
 * `preview::apply_webview2_browser_args_env`). Zero dependencies: Node 22+ ships
 * both `fetch` and a WebSocket client, and CDP is just JSON over one socket.
 *
 * Two halves, and the second one is the half that took the longest to get right:
 *
 *   HANDS - `keys` / `type` / `click` / `drag` / `cmd` dispatch REAL input, so
 *   the app cannot tell a driver from a user and nothing needs a test-only code
 *   path.
 *
 *   EYES - `state` / `terminals` / `editors` / `text` / `shot`. A terminal draws
 *   to a WebGL canvas and an editor virtualises its lines, so neither can be
 *   read from the DOM; both are read through `window.__tedi`, which hangs off
 *   the handles the app already keeps (`usePaneHandles`).
 *
 * Windows only for now, because the port is a WebView2 flag. WebKitGTK has an
 * equivalent (`WEBKIT_INSPECTOR_SERVER`) and WKWebView has none.
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

// SH_PROBE, PANE_HANDLE_EXPR and TAIL_FN are gone. Every one of them was an
// injected-JS fragment, and injection is CDP, and CDP is Windows-only - which is
// why `state`, `sh`, `wait_for_terminal` and `read` could not run on macOS or
// Linux at all. The same reductions now live in the app
// (`modules/automation/domState.ts` and the `termTails` / `termProbe`
// capabilities) and are reached by name over whichever transport is available.

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

/** How many console entries to keep. See `Cdp#logs`. */
const LOG_RING = 200;

/**
 * One CDP event -> a log entry, or null for the events we do not keep.
 *
 * Three sources, because they carry different failures and no single one covers
 * the others: `Runtime.consoleAPICalled` is what the app itself logged,
 * `Runtime.exceptionThrown` is an uncaught error (which the app never logs -
 * that is the point), and `Log.entryAdded` is the browser's own channel, where a
 * blocked network request or a CSP violation shows up and nothing in JS ever
 * sees it.
 *
 * Arguments are read from `preview` (the CDP object mirror) rather than
 * requested by id: a `getProperties` round trip per argument, for output nobody
 * may ever ask for, is exactly the kind of cost this driver should not pay.
 */
function describeLogEvent(msg) {
  const p = msg.params ?? {};
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (p.args ?? [])
      .map(
        (a) =>
          a.value ??
          a.description ??
          a.unserializableValue ??
          (a.preview ? `${a.preview.description ?? a.type}` : a.type),
      )
      .join(" ");
    return { level: p.type === "warning" ? "warn" : p.type, text: text.slice(0, 2000) };
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const e = p.exceptionDetails ?? {};
    return {
      level: "error",
      text: (e.exception?.description ?? e.text ?? "uncaught exception").slice(0, 2000),
    };
  }
  if (msg.method === "Log.entryAdded") {
    const e = p.entry ?? {};
    return {
      level: e.level === "warning" ? "warn" : e.level,
      text: `[${e.source}] ${e.text}`.slice(0, 2000),
    };
  }
  return null;
}

/** Minimal CDP client over one target's socket. Exported for the transport
 *  check in `scripts/mcp/driver-verify.ts`; nothing else constructs one. */
export class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  /**
   * Ring buffer of console output and page errors, newest last.
   *
   * The one thing about TEDI a driving agent could not see AT ALL. A change that
   * throws in the webview leaves the DOM half-rendered and every other tool
   * reports the half-rendered result as the truth - the screenshot looks wrong,
   * `read_dom` comes back short, and nothing anywhere says "an exception was
   * thrown". Console events are pushed by the renderer whether anyone asked or
   * not, so capturing them costs one listener and no round trips.
   *
   * Bounded, because it is fed by a page we do not control: a render loop
   * logging every frame must not grow this without limit.
   */
  #logs = [];

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
      const entry = describeLogEvent(msg);
      if (!entry) return;
      this.#logs.push(entry);
      if (this.#logs.length > LOG_RING) this.#logs.splice(0, this.#logs.length - LOG_RING);
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
                `this target - close it, or kill leftover \`node scripts/mcp\` processes.`,
            ),
          ),
        timeoutMs,
      );
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Cannot open ${wsUrl}`));
        },
        { once: true },
      );
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    // `WebSocket.send()` on a CLOSING or CLOSED socket is a SILENT NO-OP - only
    // CONNECTING throws. Without this guard the promise below is registered and
    // nothing ever settles it, so the first call after TEDI quits hangs forever
    // with no error, and so does every call after that: the `close` handler only
    // rejects what happened to be in flight at the moment it fired, and
    // `server.mjs` caches this connection for the whole session. The message text
    // matters - `dropIfDisconnected` matches on it to rebuild the connection.
    if (this.#ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("DevTools socket closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Captured console output and page errors, oldest first. See `#logs`. */
  logs(level = null) {
    return level ? this.#logs.filter((l) => l.level === level) : [...this.#logs];
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
    if (!hit)
      throw new Error(`No target matching "${match}". Have: ${pages.map((t) => t.url).join(", ")}`);
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
  // `Runtime.enable` already delivers console calls and uncaught exceptions;
  // `Log` adds the browser's own channel (blocked requests, CSP violations),
  // which no JS in the page ever sees. Both feed `Cdp#logs`. Tolerated rather
  // than required: an older WebView2 that does not know the domain must not
  // cost the session every other tool.
  await cdp.send("Log.enable").catch(() => {});
  const d = new Driver(cdp, chosen);
  // A freshly attached session drops its FIRST synthetic input event when the
  // renderer is not through a paint yet (typing "echo x" arrived as "cho x",
  // reliably so while the window was busy). Waiting on two animation frames
  // gates on the renderer actually running rather than on a guessed delay, and
  // it belongs here, on the path every verb shares, not sprinkled through
  // `type` and `keys`.
  await d.eval(
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
  );
  return d;
}

/** Everything a driver gets: one connected window, hands and eyes. */
export class Driver {
  constructor(cdp, target) {
    this.cdp = cdp;
    this.target = target;
    /** Set by `bridgeOnlyDriver`. See `#tedi`. */
    this.bridgeCall = null;
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

  /**
   * Call a Tauri command in the app's own realm.
   *
   * `__TAURI_INTERNALS__` is injected into every TEDI webview, so every Rust
   * command is one hop away without registering anything new on `window.__tedi`.
   * That is what reaches capabilities with no frontend function to expose: a
   * Rust command that nothing on `window.__tedi` wraps is still one hop away.
   *
   * Arguments go through `JSON.stringify`, so a URL with quotes or a Windows
   * path full of backslashes cannot end the injected string early.
   */
  async invoke(command, args = {}) {
    // Caught IN THE PAGE and rethrown with a message. A Tauri command rejects
    // with a plain STRING, not an Error, and CDP renders that as
    // "Uncaught (in promise)" with no description at all - so the one thing you
    // need (which argument was wrong) is exactly what gets dropped.
    const out = await this.eval(`(async () => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(String(command))}, ${JSON.stringify(args)}) };
      } catch (e) {
        return { ok: false, error: typeof e === "string" ? e : (e && e.message) || JSON.stringify(e) };
      }
    })()`);
    if (!out?.ok) throw new Error(`${command}: ${out?.error ?? "rejected with no reason"}`);
    return out.value;
  }

  /** Run a TEDI command by shortcut id (see `commands()`), bypassing the palette. */
  async cmd(id) {
    // `runCommandStrict`, not `runCommand`: an unregistered command must THROW,
    // or `run_command` answers "ran <id>" for something that never ran. The
    // check used to live here, which is exactly why this could not be bridged.
    return this.#tedi("runCommandStrict", String(id));
  }

  commands() {
    return this.#tedi("listCommands");
  }

  /**
   * Read every terminal: its buffer, whether it is sitting at a prompt, and
   * whether a command is still running.
   *
   * This is the driver's only way to see a terminal at all. xterm renders to a
   * WebGL canvas, so there is no DOM text for `text()` to read, and without this
   * a script can type `git status` but never find out what it printed.
   */
  /**
   * Read every terminal: its buffer, whether it is sitting at a prompt, and
   * whether a command is still running.
   *
   * `lines` is how many lines you get BACK, never how many rows xterm is asked
   * for - the capability always reads wide and trims after. The
   * distinction used to be the caller's problem and it was the source of a real
   * bug: a small `lines` reached `getBuffer` as a small ROW count and came back
   * empty on any pane that had not scrolled. Passing 1 here is now honest.
   */
  terminals(lines = 200) {
    return this.#tedi("termTails", Number(lines));
  }

  /** Boolean form of `waitTerminal`'s prompt case, for `command()`. `running`
   *  comes from OSC 133 / alt-screen and `atPrompt` from the PS1 heuristic;
   *  requiring both keeps a custom prompt (starship, oh-my-posh) from reading as
   *  "done" mid-command. */
  async waitForPrompt({ leafId = null, timeout = 20000, settle = 250 } = {}) {
    return (await this.waitTerminal({ leafId, timeout, settle })).done;
  }
  /**
   * Leaf id holding keyboard focus, or null. xterm keeps focus in a hidden
   * textarea inside the leaf, so this identifies the pane a script just typed
   * into without inferring it from "the newest one", which is wrong the moment a
   * take focuses back to an older pane.
   */
  focusedLeaf() {
    return this.#tedi("focusedLeaf");
  }

  /**
   * Call one `window.__tedi` function, with the same missing-surface error every
   * caller used to spell out for itself.
   *
   * The surface only exists when TEDI was STARTED with `TEDI_DEBUG_PORT` (Rust
   * injects the flag the frontend keys off), so setting it afterwards is too
   * late - a distinction worth naming, because the symptom is an undefined
   * property and the cause is three minutes back in the launch command.
   */
  async #tedi(fn, ...args) {
    // A bridge-backed driver calls the capability directly. That is what lets
    // the COMPOSITE methods below - `sh`, `waitTerminal` - run over the local
    // socket without a second copy of their poll loops: every primitive they use
    // is a capability, so redirecting this one method redirects all of them.
    if (this.bridgeCall) return await this.bridgeCall(fn, args);
    // Wrapped as `{ v }`, not returned bare. A capability that legitimately
    // answers NULL - `focusedLeaf` when focus is outside any pane, `text` when
    // the selector matches nothing or lands in a private one - is not the same
    // thing as a capability that is not there, and the old `?? null` could not
    // tell them apart: an empty selector reported "start TEDI with
    // TEDI_DEBUG_PORT set", which is both wrong and unactionable.
    // `Promise.resolve` covers the async capabilities (`state`); CDP is asked to
    // await the result, so both shapes arrive resolved.
    const call = `(() => { const f = window.__tedi?.${fn}; return f ? Promise.resolve(f(${args
      .map((a) => JSON.stringify(a))
      .join(", ")})).then((v) => ({ v })) : null; })()`;
    const out = await this.eval(call);
    if (out === null) {
      throw new Error(
        `window.__tedi.${fn} is missing. Start TEDI with TEDI_DEBUG_PORT set (a dev or a ` +
          `release build alike); setting it after launch is too late. If the port IS open, ` +
          `this build predates ${fn}.`,
      );
    }
    return out.v;
  }

  /**
   * Every pane in EVERY tab: which tab it belongs to, what kind it is, and what
   * distinguishes it - a terminal's cwd, ssh host, running agent and whether it
   * is at a prompt; an editor's path and dirty flag; a browser's url; an
   * extension panel's owner.
   *
   * Read from TEDI's tab tree, not the DOM. A background tab's panes are just as
   * real as the focused one's, and the DOM knows none of that identity anyway.
   * This is what lets a driver find the pane a build is running in, wait on it,
   * or run something in a sibling, without switching tabs to look.
   *
   * PRIVATE PANES ARE ABSENT, and not merely unreadable: marking a pane private
   * means the AI never learns it exists. Same rule TEDI's own agent follows.
   */
  panes() {
    return this.#tedi("panes");
  }

  /**
   * Installed extensions: id, version, enabled, and what each one contributes -
   * commands, panels, AI tools.
   *
   * Needed because an extension command lives in a registry of its own, which
   * `commands()` does not see and `cmd()` cannot reach. Without this list a
   * missing button is indistinguishable from a disabled extension.
   */
  extensions() {
    return this.#tedi("extensions");
  }

  /**
   * Run something an extension declared: a COMMAND, or one of its AI TOOLS.
   *
   * Both live in registries of their own that `commands()` never sees. The
   * difference that matters to a caller is the return: a command is a button
   * press and answers `{kind:"command"}`, an AI tool takes `args` and answers
   * `{kind:"aiTool", result}` with real data. That is what makes "send this
   * request and tell me the response" reachable at all - the extension's panel
   * could always be opened, but composing the request meant synthetic clicks.
   *
   * False when nothing answers (never given a runtime handler, or its extension
   * is disabled).
   */
  extCommand(extensionId, id, args) {
    return this.#tedi("runExtensionCommand", String(extensionId), String(id), args ?? {});
  }

  /**
   * Turn an extension on, off, reload, update or remove it.
   *
   * INSTALL IS NOT HERE, on purpose. Installing runs third-party code in TEDI's
   * own realm under a permission set the user has to have seen, and that review
   * dialog lives in the Settings webview. A driver may send the user to it; it
   * may not skip it. Everything this does do is reversible and introduces no new
   * code - `update` is bounded by the grant already approved, and Rust rejects a
   * release that asks for more.
   *
   * Resolves to `true`, or to a sentence saying why not.
   */
  extControl(action, extensionId) {
    return this.#tedi("extControl", String(action), String(extensionId));
  }

  /** What TEDI's OWN agent is doing: status, step, pending approvals, usage,
   *  and its sessions. The one part of the app an outside CLI was blind to. */
  ai() {
    return this.#tedi("ai");
  }

  /** The built-in agent's live conversation (not the persisted file, which lags
   *  a turn). Text parts only; tool names without their payloads. */
  aiMessages(sessionId = null, maxChars = 8000) {
    return this.#tedi("aiMessages", sessionId, Number(maxChars));
  }

  /** Queue a prompt for the built-in agent, exactly as the composer would.
   *  Does NOT bypass approval - what the agent then does still raises cards. */
  aiSend(text) {
    return this.#tedi("aiSend", String(text));
  }

  /**
   * Pane layout, through the app's own live context.
   *
   * These are the mutators the Command Palette cannot reach: `runCommand(id)`
   * takes no arguments (it fires a synthetic KeyboardEvent), so "split into tab
   * 3", "close leaf 7" and "group 4 and 9" have no command id and never could.
   * The alternative for those is `drag` against a splitter's nth, which is both
   * fragile and blind to which pane it lands on.
   */
  paneOpen(opts = {}) {
    return this.#tedi("paneOpen", opts);
  }
  paneClose(leafId) {
    return this.#tedi("paneClose", Number(leafId));
  }
  paneGroup(leafIds, tabId) {
    return this.#tedi("paneGroup", leafIds.map(Number), tabId);
  }
  paneRotate(leafId, dir) {
    return this.#tedi("paneRotate", Number(leafId), dir);
  }
  paneConsolidate(tabId) {
    return this.#tedi("paneConsolidate", Number(tabId));
  }
  termList() {
    return this.#tedi("termList");
  }

  /** Run a command on the host behind an SSH pane, off-screen. The remote twin
   *  of a hidden shell: exact bytes, no scrollback, no wrapping. */
  sshExec(leafId, command) {
    return this.#tedi("sshExec", Number(leafId), String(command));
  }

  /** Saved SSH connections. Never their keys or passphrases: those stay in the
   *  keyring, and nothing here reads them. */
  sshConnections() {
    return this.#tedi("sshConnections");
  }

  /** Open a saved SSH connection in a new tab. `true`, or a sentence. */
  sshConnect(id, isPrivate = false) {
    return this.#tedi("sshConnect", String(id), Boolean(isPrivate));
  }

  /**
   * Every setting the app is actually running on, read from the live store.
   *
   * The Settings page is a SEPARATE webview, so nothing driving the main window
   * could read a preference or change one, and "set the theme" was undrivable
   * through the whole surface. This goes to the store instead of that window, so
   * it works whether Settings is open or not.
   *
   * No API keys pass through: those live in the OS keyring behind `secrets_*`,
   * never in this store.
   */
  settings() {
    return this.#tedi("settings");
  }

  /**
   * Every workspace: id, name, which one is ACTIVE, its view, tab count, pinned.
   *
   * The one thing `state` cannot tell you. `panes()` reads the ACTIVE
   * workspace's tab tree, so every pane in every other workspace is absent with
   * nothing saying so - and `view` decides whether the panes are laid out as
   * tabs, a kanban board, or a free canvas, which changes what a drag means.
   * Names and counts only: the saved tab tree is the largest object in the store
   * and nobody asking "which workspace am I in" wants it.
   */
  workspaces() {
    return this.#tedi("workspaces");
  }

  /**
   * Write one preference. `true`, or a sentence naming the problem.
   *
   * The write broadcasts on `tedi://prefs-changed`, so the app and an open
   * Settings window both follow it live - no reload, no restart.
   */
  setSetting(key, value) {
    return this.#tedi("setSetting", String(key), value);
  }

  /**
   * Console output and page errors captured since this connection opened.
   *
   * Not a `window.__tedi` call: these arrive as CDP events, already buffered by
   * the transport (`Cdp#logs`), so reading them costs no round trip at all.
   */
  logs(level = null) {
    return this.cdp.logs(level);
  }

  /**
   * Block until a terminal pane is done, then report why it returned.
   *
   * The point is that ONE call replaces a polling loop. A driver that watches a
   * build by re-reading the buffer every second pays a round trip and a tool
   * result for every one of those seconds; this waits inside the driver and
   * answers once.
   *
   * Two conditions, because a prompt is not always the finish line. With no
   * `text`, it waits for the prompt to come back - the right answer for a
   * command. With `text`, it waits for that string to appear in the buffer,
   * which is the only workable signal for something that never returns: a dev
   * server printing its port, a TUI reaching a screen, an AI CLI asking a
   * question.
   *
   * Never throws on a timeout. Returns `{ done: false, reason: "timeout" }` with
   * the tail, because "it is still going" is an answer, not a failure.
   */
  async waitTerminal({
    leafId = null,
    text = null,
    timeout = 60000,
    settle = 250,
    // How much tail to report when it returns. NOT how much to poll: waiting for
    // a prompt reads two booleans, so the poll asks for one row and the tail is
    // fetched once at the end; waiting for TEXT has to search the buffer, and
    // that read must be a full-width one or it can come back empty (see the
    // constant).
    lines = 8,
  } = {}) {
    const target = leafId ?? (await this.focusedLeaf());
    const deadline = Date.now() + timeout;
    /** The tail is only needed when this returns, so it costs one read, not one per poll. */
    const finish = async (leaf, done, reason) => {
      const t = (await this.terminals(lines)).find((x) => x.leafId === leaf);
      return { leafId: leaf, done, reason, tail: t?.text ?? "" };
    };
    // The needle is tested IN THE APP (`termProbe`), which ships one boolean
    // per pane instead of every pane's whole buffer three times a second.
    for (;;) {
      // `wantHash: false` - this loop reads two booleans and a substring test,
      // never the hash, so there is no reason for the app to build a buffer for
      // the prompt case at all.
      const list = await this.#tedi("termProbe", text ?? null, false, target);
      // Nothing will ever come back, so stalling the full timeout would only
      // hide the mistake (waiting on an editor pane, or on a private one).
      if (!list.length)
        return { leafId: target, done: false, reason: "no terminal panes", tail: "" };
      // Same rule `sh` states above, and for a sharper reason: waiting is a
      // claim about ONE pane. Falling back to the last terminal answered "done,
      // prompt returned" from a pane the caller never named - so an agent
      // waiting on its build was told it had finished by an idle shell sitting
      // next to it. Only the no-leaf case may fall back, and only because
      // `focusedLeaf` legitimately points at something that is not a terminal.
      const t =
        list.find((x) => x.leafId === target) ?? (leafId === null ? list[list.length - 1] : null);
      if (!t) {
        throw new Error(
          `Leaf ${leafId} is not a terminal. Terminals: ${list.map((x) => x.leafId).join(", ")}`,
        );
      }
      if (text ? t.hit : t.atPrompt && !t.running) {
        await sleep(settle);
        return await finish(t.leafId, true, text ? "text appeared" : "prompt returned");
      }
      if (Date.now() > deadline) return await finish(t.leafId, false, "timeout");
      await sleep(300);
    }
  }

  /**
   * Give a pane keyboard focus without clicking it, which is what every later
   * `keys` / `type` targets. Clicking works too, but lands a real mouse press
   * inside the pane - in an editor that moves the caret to wherever the pane's
   * centre happened to be.
   */
  async focusPane(leafId) {
    // Verified in-realm by `focusPaneVerified`, not assumed. The handle exists
    // for panes in BACKGROUND tabs too, and `focus()` on a hidden element does
    // nothing, so "the handle answered" is not "the next keystroke lands there".
    // The verify used to be a second round trip from here, which is why this
    // could not be bridged.
    return this.#tedi("focusPaneVerified", Number(leafId));
  }

  /** Write straight to a terminal's PTY. See `sh`, which is the safe half. */
  termWrite(leafId, data) {
    return this.#tedi("termWrite", Number(leafId), String(data));
  }

  /**
   * Run a shell command in a terminal pane and return what it printed.
   *
   * The text goes to the PTY in one write rather than as synthesised keystrokes.
   * That is not only ~45ms/char faster: a terminal that has just taken focus
   * swallows the FIRST synthetic keystroke it is sent (`echo x` arrives as
   * `cho x`, with full key events and IME commits alike), and a PTY write cannot
   * lose a character because it never goes near the keyboard path at all.
   *
   * The cost of that shortcut is that xterm's `onData` never sees it, so the
   * AI-CLI detector does not fire. Launching an AI CLI is the one case that
   * wants real keys - use `command()` for that.
   *
   * Completion is "the buffer changed AND the prompt is back", not just "the
   * prompt is back". A PTY write returns before the shell has echoed anything,
   * so a bare prompt check passes instantly against the PREVIOUS prompt and the
   * output gets read before it exists. Waiting for the echo first closes that.
   *
   * Returns `{ leafId, text, timedOut }`. A TUI (vim, lazygit, an AI CLI) never
   * comes back to a prompt, so a timeout is reported rather than thrown:
   * opening one on purpose is legitimate, and the buffer is still the answer.
   */
  async sh(text, { leafId = null, timeout = 20000, lines = 60, settle = 150 } = {}) {
    const list = await this.#tedi("termProbe", null);
    if (!list.length) throw new Error("No terminal pane is open. Run `cmd tab.new` first.");
    // Which pane, decided explicitly. The focused leaf is often NOT a terminal -
    // `data-pane-leaf` is on every leaf, so an editor or extension pane answers
    // here too - and the earlier version then fell back to "the last terminal in
    // mount order", which is a background pane in some other tab, possibly an
    // SSH session on another host, silently. One terminal open is unambiguous;
    // more than one is a question only the caller can answer.
    const focused = leafId ?? (await this.focusedLeaf());
    // The one-terminal shortcut applies ONLY when no leaf was named. An explicit
    // leafId that is not a terminal must never be quietly redirected somewhere
    // else - that is the caller being wrong about the world, not a convenience.
    const before =
      list.find((t) => t.leafId === focused) ??
      (leafId === null && list.length === 1 ? list[0] : null);
    if (!before) {
      throw new Error(
        leafId === null
          ? `Focus is not in a terminal, and ${list.length} are open - name one. ` +
              `Terminals: ${list.map((t) => t.leafId).join(", ")}`
          : `Leaf ${leafId} is not a terminal. Terminals: ${list.map((t) => t.leafId).join(", ")}`,
      );
    }
    const target = before.leafId;
    if (!(await this.termWrite(target, `${text}\r`))) {
      throw new Error(`Terminal ${target} went away before the write landed`);
    }
    const deadline = Date.now() + timeout;
    for (;;) {
      await sleep(settle);
      const now = (await this.#tedi("termProbe", null, true, target)).find(
        (t) => t.leafId === target,
      );
      if (!now) throw new Error(`Terminal ${target} disappeared mid-command`);
      // Hashes, not the text itself. "Has the buffer changed" is one bit, and
      // shipping ~20KB across the socket every 150ms to answer it is the whole
      // cost of running a command through here. A collision only costs one more
      // poll (the next read will differ), so 32 bits is plenty.
      const done = now.hash !== before.hash && now.atPrompt && !now.running;
      if (done || Date.now() > deadline) {
        // The full text is fetched ONCE, at the end, already trimmed in-page.
        const out = (await this.terminals(lines)).find((t) => t.leafId === target);
        return { leafId: target, text: out?.text ?? "", timedOut: !done };
      }
    }
  }

  /**
   * Every open editor: leaf, path, and the LIVE buffer - unsaved edits included.
   *
   * Not `text('.cm-content')`. CodeMirror virtualises, so the DOM holds only the
   * lines currently scrolled into view and a long file reads back as a short
   * one, silently and plausibly. This asks the editor itself.
   */
  editors(maxChars = 20000) {
    return this.#tedi("editors", Number(maxChars));
  }

  /**
   * Open a file in the editor by absolute path, the way the explorer does (a PDF
   * still goes to the system browser). The one editor entry point a driver could
   * otherwise not reach: clicking the tree needs the path already expanded into
   * view, which for anything deep it is not.
   */
  openFile(file) {
    return this.#tedi("openFile", String(file));
  }

  /** Save one editor pane. `Ctrl+S` works too, but only on the focused one. */
  editorSave(leafId) {
    return this.#tedi("editorSave", Number(leafId));
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
   * offending extension off before driving that corner of the UI.
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
    return this.#tedi("text", String(selector), Number(nth));
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
    return this.#tedi("paneHandle");
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
  /**
   * Snapshot of the window: tabs, panes, focus, dialog, toasts, pane handle,
   * and each pane's last lines.
   *
   * The whole 68-line DOM read used to be INJECTED here as a template literal,
   * which made it CDP-only - and CDP is Windows-only, so `state` (the verb every
   * agent is told to call first) did not exist at all on macOS or Linux. It now
   * lives in the app as `modules/automation/domState.ts` and is reached by name,
   * so both transports run the SAME code and the socket path works everywhere.
   */
  state({ tail = 3, buttons = false } = {}) {
    return this.#tedi("state", { tail, buttons });
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

  /** Resize the page's viewport, independent of the real window size. */
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
}

/**
 * Driver methods that are pure COMPOSITIONS of bridged capabilities.
 *
 * Each is a loop over `#tedi` calls and nothing else - no `this.eval`, no
 * `this.cdp`, no trusted input - so a driver whose `#tedi` points at the local
 * socket runs them unchanged. That is what makes `sh` and `wait_for_terminal`
 * work on macOS and Linux, where the DevTools port does not exist, WITHOUT a
 * second copy of the poll loops (which would drift, and drift here is a silent
 * wrong answer rather than an error).
 *
 * They are not in `BRIDGED` because they are not single capability calls;
 * `driver-verify` checks that distinction from both sides.
 */
export const COMPOSITE = ["sh", "waitTerminal", "waitForPrompt"];

/**
 * A `Driver` with no DevTools connection at all, whose `#tedi` calls go straight
 * to a capability caller.
 *
 * Only the `#tedi`-only methods and the COMPOSITE ones above will work on it -
 * anything reaching for `this.cdp` throws, which is the honest answer for a
 * platform with no debug port.
 */
export function bridgeOnlyDriver(call) {
  const d = new Driver(null, null);
  d.bridgeCall = call;
  return d;
}
