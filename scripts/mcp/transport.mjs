/**
 * How a Node process reaches TEDI: the authenticated local socket, and nothing else.
 *
 * `socket.mjs` -> `mcp_bridge.rs` calls a capability by name in the app's own realm. Every
 * platform, many clients, a per-run token, no restart to enable.
 *
 * Real input, window capture and `eval_js` need the DevTools Protocol, and that comes through
 * the same socket: TEDI answers a `devtools` capability by speaking it to its own webview
 * in-process (`mcp_devtools.rs`). WKWebView and WebKitGTK do not implement the protocol, so
 * those tools are Windows only, and the bridge says so.
 *
 * NO FALLBACK TO THE DEBUG PORT, on purpose. It has no authentication, and with the bridge down
 * it answered "TEDI is not running" by driving whichever OTHER TEDI held that port: real
 * keystrokes into the wrong window, reported as success. This code ships with the app it
 * talks to, so a build too old for the socket cannot be on the other end. `pnpm mcp targets` and
 * `sweep` still drive a port, explicitly, through `driver.mjs`.
 */

import { connectBridge } from "./socket.mjs";

/** `{ call, logs, devtools, close }`. Each connection is made once, on demand. */
export function makeTransport() {
  let bridge = null;
  let driver = null;
  let driverBridge = null;

  async function getBridge() {
    if (bridge && !bridge.closed) return bridge;
    // Re-read every time: the token rotates per app run, so a TEDI restart mid-session has to be
    // picked up rather than remembered as broken.
    bridge = null;
    bridge = await connectBridge();
    return bridge;
  }

  return {
    async call(name, ...args) {
      return (await getBridge()).call(name, args);
    },

    /** Console output and page errors since this connection began capturing. */
    async logs(level = null) {
      // Loaded only here and below: a call that needs neither pays nothing for the driver.
      const { BridgeCdp } = await import("./driver.mjs");
      return new BridgeCdp(await getBridge()).logs(level);
    },

    /** A `Driver` over the bridge, for what needs a trusted event or the compositor. */
    async devtools() {
      const b = await getBridge();
      if (!driver || driverBridge !== b) {
        const { bridgeDevtoolsDriver } = await import("./driver.mjs");
        driver = await bridgeDevtoolsDriver(b);
        driverBridge = b;
      }
      return driver;
    },

    close() {
      bridge?.close();
      bridge = null;
      driver = null;
    },
  };
}
