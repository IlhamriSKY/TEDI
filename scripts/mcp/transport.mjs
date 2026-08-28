/**
 * Picks how a tool reaches TEDI, per call.
 *
 * There are two ways in and they are good at different things:
 *
 *   * **The local socket** (`socket.mjs` -> `mcp_bridge.rs`) calls a capability
 *     by name in the app's own realm. Works on every platform, accepts many
 *     clients, is authenticated, and needs no restart to become usable.
 *   * **CDP** (`driver.mjs`) drives the window over the WebView2 DevTools
 *     Protocol. Windows only, one client at a time, no authentication, and only
 *     when the user opened a debug port. What it can do that the socket cannot
 *     is dispatch a TRUSTED input event and capture the window - a synthetic DOM
 *     event is genuinely not the same thing, and no amount of in-realm code
 *     makes it one.
 *
 * So: the socket is the default, and CDP is pulled up lazily, only for the calls
 * that actually need it. A session that never touches `keys`, `click`, `drag`,
 * `type_text`, `screenshot`, `eval_js`, `state` or `read source:"dom"` never
 * opens a DevTools connection at all - which on macOS and Linux is the
 * difference between working and not, because the port is never opened there
 * (`apply_webview2_browser_args_env` is `#[cfg(windows)]`).
 *
 * The handlers in `server.mjs` are unchanged and unaware. They call `d.method()`
 * exactly as before; this decides where that lands.
 */

import { connect } from "./driver.mjs";
import { connectBridge } from "./socket.mjs";

/**
 * Driver method -> capability name, for everything the socket can answer.
 *
 * Derived from the fact that each of these is a one-line `this.#tedi(name, ...)`
 * in `driver.mjs` - i.e. it was ALREADY just a named call into the app's realm,
 * wrapped in a DevTools round trip for no reason other than that the socket did
 * not exist. Anything not listed here reads the DOM, dispatches input, or
 * captures the window, and stays on CDP.
 *
 * `driver-verify` asserts both halves of this: every name here must be a real
 * `Driver` method, and every method here must still be a pure `#tedi` call.
 */
export const BRIDGED = {
  panes: "panes",
  termWrite: "termWrite",
  editors: "editors",
  editorSave: "editorSave",
  openFile: "openFile",
  extensions: "extensions",
  extCommand: "runExtensionCommand",
  extControl: "extControl",
  settings: "settings",
  setSetting: "setSetting",
  sshConnections: "sshConnections",
  sshConnect: "sshConnect",
  ai: "ai",
  aiMessages: "aiMessages",
  aiSend: "aiSend",
  browserOpen: "browserOpen",
  browserNav: "browserNav",
  browserRead: "browserRead",
  browserList: "browserList",
};

/**
 * DELIBERATELY NOT BRIDGED, and why - each of these looks bridgeable and is not.
 * The verify above enforces the rule mechanically; this records the reasoning so
 * nobody "completes" the map without doing the work each one needs.
 *
 *   `focusPane`  calls `focusLeaf` and then VERIFIES with `focusedLeaf()`, a DOM
 *                read. The handle exists for panes in background tabs too, and
 *                `focus()` on a hidden element does nothing, so bridging it would
 *                return "the handle answered" as if it meant "the next keystroke
 *                lands there".
 *   `cmd`        throws when `runCommand` returns false. Bridged, the raw boolean
 *                would come back and `run_command`'s handler would answer
 *                `ran <id>` for a command that never ran - a fake success.
 *   `commands`   swallows a missing surface with `?? []` rather than throwing,
 *                which `#tedi` does not. Same list, different failure semantics.
 *   `terminals`  reduces IN THE PAGE (tail / hash / substring), which is what
 *                keeps `sh`'s poll loop from shipping ~20KB of scrollback per
 *                pane per tick. `sh` and `wait_for_terminal` share that path.
 *   `state`, `text`, `focusedLeaf`, `box`, `metrics` read the DOM.
 *   `keys`, `type`, `click`, `drag`, `screenshot`, `eval_js` need a trusted
 *                input event or the compositor.
 *
 * Bridging the first four needs a matching capability registered in the app -
 * one that verifies focus in-realm, preserves the throw, and does the terminal
 * reduction there. Worth doing; not worth guessing at.
 */

/**
 * Argument coercion, mirroring what `driver.mjs` applies before injecting.
 *
 * It matters: the capabilities are ordinary JS functions, and an agent that
 * sends `"3"` where a leaf id belongs would otherwise reach `terminalRefs.get("3")`
 * and miss. Keeping the coercion here means both transports hand the SAME
 * function the same types.
 */
const COERCE = {
  termWrite: (leafId, data) => [Number(leafId), String(data)],
  editors: (maxChars = 20000) => [Number(maxChars)],
  editorSave: (leafId) => [Number(leafId)],
  openFile: (file) => [String(file)],
  extCommand: (extensionId, id, args) => [String(extensionId), String(id), args ?? {}],
  extControl: (action, extensionId) => [String(action), String(extensionId)],
  setSetting: (key, value) => [String(key), value],
  sshConnect: (id, isPrivate = false) => [String(id), Boolean(isPrivate)],
  aiMessages: (sessionId = null, maxChars = 8000) => [sessionId, Number(maxChars)],
  aiSend: (text) => [String(text)],
  browserOpen: (url) => [String(url)],
  browserNav: (leafId, url) => [Number(leafId), String(url)],
  browserRead: (leafId, fields = false) => [Number(leafId), Boolean(fields)],
};

/**
 * A driver that answers from whichever transport can.
 *
 * Both connections are made at most once and only on demand. A bridged call
 * never triggers a CDP connect; a CDP-only call reports the real reason when the
 * port is shut, rather than the socket's unrelated error.
 */
export function makeTransport({ port } = {}) {
  let bridge = null;
  let bridgeErr = null;
  let cdp = null;
  let cdpPromise = null;

  async function getBridge() {
    if (bridge && !bridge.closed) return bridge;
    // Re-resolve on every attempt: the token rotates per app run, so a TEDI
    // restart mid-session must be picked up rather than remembered as broken.
    try {
      bridge = await connectBridge();
      bridgeErr = null;
      return bridge;
    } catch (e) {
      bridge = null;
      bridgeErr = e;
      return null;
    }
  }

  async function getCdp() {
    if (cdp) return cdp;
    // No port means the profile this server was pointed at has its automation
    // channel switched OFF. Say that, rather than falling back to the usual
    // 9222 and driving whichever OTHER TEDI happens to be listening there -
    // real keystrokes into the wrong window is not a fallback, it is a bug.
    if (!port) {
      throw new Error(
        "TEDI's automation channel is off for this profile, so real input, screenshots and " +
          "eval_js have no way in. Turn it on in TEDI: header, Install MCP, Automation channel " +
          "(it takes effect on the next restart). Everything else works without it.",
      );
    }
    cdpPromise ??= connect({ port }).then(
      (d) => {
        cdp = d;
        cdpPromise = null;
        return d;
      },
      (err) => {
        cdpPromise = null;
        throw err;
      },
    );
    return cdpPromise;
  }

  const handler = {
    get(_t, method) {
      /**
       * A CATCH-ALL `get` MAKES THIS PROXY LOOK LIKE A PROMISE, AND THAT KILLED
       * THE SERVER ON THE FIRST TOOL CALL.
       *
       * `await x` and `Promise.resolve(x)` decide whether `x` is a promise by
       * READING `x.then` and checking it is callable. Every property here
       * answered with a function, so the proxy passed that test, and the
       * language then adopted it as a thenable: it called `then(resolve,
       * reject)` and waited for one of them. `then` is not in `BRIDGED`, so the
       * call fell through to CDP, found no `then` on the real driver, and threw
       * - inside a promise nothing was holding. So `await tedi()` waited on a
       * resolve that could never come (every tool hung), while the stray
       * rejection took the whole process down with it (`Connection closed` on
       * the client). One line each way.
       *
       * Symbols go the same way, and for the same reason: `util.inspect`,
       * `JSON.stringify` and iteration all probe well-known symbols, and a
       * function answering `Symbol.iterator` turns any of them into a throw.
       *
       * The rule is general - a proxy that answers everything must still say NO
       * to the protocol the language itself uses to ask questions about it.
       */
      if (method === "then" || typeof method === "symbol") return undefined;
      if (method === "close") {
        return async () => {
          bridge?.close();
          await cdp?.close?.().catch(() => {});
          bridge = null;
          cdp = null;
        };
      }
      // `logs` is CDP's console ring buffer, kept in this process. It has no
      // in-realm twin, so it is CDP-only by nature rather than by omission.
      const capability = BRIDGED[method];
      return async (...args) => {
        if (capability) {
          const b = await getBridge();
          if (b) {
            const coerced = COERCE[method] ? COERCE[method](...args) : args;
            return await b.call(capability, coerced);
          }
          // No bridge: fall through to CDP, which may still be available on a
          // Windows session with the debug port open. If neither works the CDP
          // error is the one worth showing, with the bridge's reason appended.
          try {
            const d = await getCdp();
            return await d[method](...args);
          } catch (e) {
            throw new Error(
              `${e.message}${bridgeErr ? ` (and the local bridge: ${bridgeErr.message})` : ""}`,
            );
          }
        }
        const d = await getCdp();
        const fn = d[method];
        if (typeof fn !== "function") {
          throw new Error(`the driver has no "${String(method)}" method`);
        }
        return await fn.apply(d, args);
      };
    },
  };

  return new Proxy({}, handler);
}
