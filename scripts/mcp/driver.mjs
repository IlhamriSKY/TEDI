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
import { HANDLERS } from "./handlers.mjs";
import { parseChord, sleep, WindowInput } from "./input.mjs";

export { parseChord, sleep };

// SH_PROBE, PANE_HANDLE_EXPR and TAIL_FN are gone. Every one of them was an
// injected-JS fragment, and injection is CDP, and CDP is Windows-only - which is
// why `state`, `sh`, `wait_for_terminal` and `read` could not run on macOS or
// Linux at all. The same reductions now live in the app
// (`modules/automation/domState.ts` and the `termTails` / `termProbe`
// capabilities) and are reached by name over whichever transport is available.

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
   * a DOM `read` comes back short, and nothing anywhere says "an exception was
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

/**
 * The same CDP client surface as `Cdp`, carried by TEDI's local bridge instead
 * of a DevTools socket.
 *
 * TEDI answers the `devtools` capability in Rust by calling the protocol on its
 * own main webview in-process (`mcp_devtools.rs`), so the six tools that need
 * real input or the compositor no longer need the automation port - which was a
 * restart to turn on and brought renderer flags that cost memory and CPU the
 * whole time TEDI ran. Console events are buffered on that side too, as raw
 * `{ method, params }`, and described here with the same function the socket
 * client uses, so `inspect logs` reads identically either way.
 */
export class BridgeCdp {
  #bridge;

  constructor(bridge) {
    this.#bridge = bridge;
  }

  send(method, params = {}) {
    return this.#bridge.call("devtools", [method, params]);
  }

  /**
   * @param {string | null} [level]
   * @returns {Promise<{ level: string, text: string }[]>}
   */
  async logs(level = null) {
    const events = await this.#bridge.call("devtoolsLogs", []);
    const list = (Array.isArray(events) ? events : []).map(describeLogEvent).filter(Boolean);
    return level ? list.filter((l) => l.level === level) : list;
  }

  /** The bridge session belongs to the transport, which closes it. */
  close() {
    return Promise.resolve();
  }
}

/**
 * The settle `connect` waits for, BOUNDED. With no port there are no occlusion
 * flags either, so a window that Chromium decides is hidden runs no animation
 * frames at all, and the unbounded two-frame wait would park the first input
 * call until the bridge gave up on it. Exported for `devtools-bridge-verify`,
 * which parses it.
 */
export const BRIDGE_SETTLE =
  "Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))), new Promise((r) => setTimeout(r, 150, 0))])";

/**
 * A `Driver` whose DevTools calls go through the bridge and whose capability
 * calls go straight to it. Rejects with the bridge's own message when this TEDI
 * cannot do it (an older build without `devtools`, macOS or Linux, the misc pack
 * switched off), which is how the transport decides what to do next.
 */
export async function bridgeDevtoolsDriver(bridge) {
  const d = new Driver(new BridgeCdp(bridge), { url: "tedi-bridge://main", type: "page" });
  d.bridgeCall = (name, args) => bridge.call(name, args);
  await d.eval(BRIDGE_SETTLE);
  return d;
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
export class Driver extends WindowInput {
  constructor(cdp, target) {
    super(cdp);
    this.target = target;
    /** Set by `bridgeDevtoolsDriver`. See `#tedi`. */
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

  async waitForPrompt({ leafId = null, timeout = 20000 } = {}) {
    return (await this.waitTerminal({ leafId, timeout })).done;
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
    // A bridge-backed driver calls the capability directly.
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
  aiNew() {
    return this.#tedi("aiNew");
  }
  aiSwitch(sessionId) {
    return this.#tedi("aiSwitch", String(sessionId));
  }
  aiStop() {
    return this.#tedi("aiStop");
  }

  /** What each extension shows in the status bar: meters, states and tooltips. */
  statusItems() {
    return this.#tedi("statusItems");
  }

  /** Saved Claude Code and Codex sessions, newest first. */
  agentSessions(filter = null) {
    return this.#tedi("agentSessions", filter);
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
  /** Worktrees. One capability, so every action is one round trip. */
  worktree(args = {}) {
    return this.#tedi("worktree", args);
  }

  /** The user's own notes and todos (the toolbar panel). One capability, TEXT. */
  notes(args = {}) {
    return this.#tedi("notes", args);
  }

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
  paneRename(leafId, name) {
    return this.#tedi("paneRename", Number(leafId), String(name ?? ""));
  }
  panePin(leafId, pinned = true) {
    return this.#tedi("panePin", Number(leafId), Boolean(pinned));
  }
  panePlace(leafId, rect) {
    return this.#tedi("panePlace", Number(leafId), rect);
  }
  panelOpen(extensionId, panelId = null) {
    return this.#tedi("panelOpen", String(extensionId), panelId);
  }
  termList() {
    return this.#tedi("termList");
  }

  /** Run a command on the host behind an SSH pane, off-screen. The remote twin
   *  of a hidden shell: exact bytes, no scrollback, no wrapping. */
  sshExec(leafId, command) {
    return this.#tedi("sshExec", Number(leafId), String(command));
  }

  /** Workspaces: the read is `inspect workspaces`, these are the four writes.
   *  Each answers `{ok}` or `{ok:false, error}`. */
  workspaceSwitch(wsId) {
    return this.#tedi("workspaceSwitch", String(wsId));
  }
  workspaceCreate(name) {
    return this.#tedi("workspaceCreate", String(name ?? ""));
  }
  workspaceRename(wsId, name) {
    return this.#tedi("workspaceRename", String(wsId), String(name ?? ""));
  }
  workspaceRemove(wsId) {
    return this.#tedi("workspaceRemove", String(wsId));
  }
  workspaceView(wsId, view) {
    return this.#tedi("workspaceView", String(wsId), String(view));
  }

  /** A local port forwarded through a connected SSH pane's session. */
  sshForward(leafId, localPort, remoteHost, remotePort) {
    return this.#tedi(
      "sshForward",
      Number(leafId),
      Number(localPort),
      String(remoteHost),
      Number(remotePort),
    );
  }

  /** A connected SSH pane's files. */
  sftp(leafId, args = {}) {
    return this.#tedi("sftp", Number(leafId), args);
  }

  /** Rename or delete a saved Claude Code or Codex session. */
  agentSession(args = {}) {
    return this.#tedi("agentSession", args);
  }

  /** Saved SSH connections. Never their keys or passphrases: those stay in the
   *  keyring, and nothing here reads them. */
  sshConnections() {
    return this.#tedi("sshConnections");
  }

  /** Open a saved SSH connection in a new tab. The new pane's leafId, `true`
   *  for a private one (whose id the app withholds on purpose), or a sentence.
   *  The id comes back from the opener, so nothing has to poll `termList` for a
   *  pane it just asked for. */
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

  /** Every schedule, pending and recently finished, with ISO times. */
  schedules() {
    return this.#tedi("schedules");
  }

  /**
   * Queue a command for later. Answers with the new schedule, or a SENTENCE
   * naming why it was refused - the command goes through the same guard and
   * shell-transformer chain a command run now does, because it will run
   * unattended and the approval raised here is the only human in the loop.
   */
  scheduleCreate(opts) {
    return this.#tedi("scheduleCreate", opts);
  }

  /** Cancel a pending schedule. `{cancelled:true}`, or a sentence. */
  scheduleCancel(id) {
    return this.#tedi("scheduleCancel", String(id));
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

  /** `wait_for_terminal`, over this connection. `sweep` waits on panes it just drove. */
  waitTerminal({ leafId, text, timeout, lines } = {}) {
    return HANDLERS.wait_for_terminal((name, ...args) => this.#tedi(name, ...args), {
      leafId: leafId ?? undefined,
      text,
      timeout,
      lines,
    });
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
   * `sh`, over this connection.
   *
   * Written to the PTY in one write, not as synthesised keystrokes, so xterm's `onData` never
   * sees it and the AI-CLI detector does not fire. Launching an AI CLI is the one case that
   * wants real keys: use `command()` for that.
   */
  sh(text, { leafId, timeout, lines } = {}) {
    return HANDLERS.sh((name, ...args) => this.#tedi(name, ...args), {
      command: text,
      leafId: leafId ?? undefined,
      timeout,
      lines,
    });
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
    const data = await this.capture();
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }
}
