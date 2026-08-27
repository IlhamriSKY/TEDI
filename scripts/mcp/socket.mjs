/**
 * Client for TEDI's local-socket bridge.
 *
 * The way IN that is not the DevTools port. `src-tauri/src/modules/mcp_bridge.rs`
 * listens on a named pipe (Windows) or unix socket, and publishes its address
 * plus a per-run token next to `tedi-settings.json`. This connects, presents the
 * token, and then calls capabilities by name.
 *
 * WHY IT IS PREFERRED. The CDP path works only on Windows, accepts exactly one
 * client at a time, has no authentication whatsoever, and needs an app restart
 * to enable. None of that is true here. What CDP still owns is real keyboard and
 * mouse input plus window capture, because a synthetic DOM event is not a
 * trusted one - see `driver.mjs`.
 *
 * ZERO DEPENDENCIES, like everything else in this folder: it ships as a bundle
 * resource with no `node_modules` beside it.
 */

import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";

/** Same search order `readSurface` uses for `tedi-settings.json`, because the
 *  handshake file is written into the same directory. */
function handshakeCandidates() {
  const home = process.env.APPDATA || process.env.XDG_CONFIG_HOME || process.env.HOME || "";
  const id = process.env.TEDI_BUNDLE_ID || "id.ilhamrisky.tedi";
  const roots = [
    process.env.APPDATA,
    process.env.XDG_CONFIG_HOME,
    process.env.HOME && path.join(process.env.HOME, ".config"),
    process.env.HOME && path.join(process.env.HOME, ".local", "share"),
    home,
  ].filter(Boolean);
  return [...new Set(roots)].map((r) => path.join(r, id, "mcp-bridge.json"));
}

/** `{ socket, token }`, or null when TEDI is not running (or never wrote one). */
export function readHandshake() {
  for (const file of handshakeCandidates()) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (typeof j.socket === "string" && typeof j.token === "string") return j;
    } catch {
      // Missing, unreadable, or not JSON: try the next candidate.
    }
  }
  return null;
}

/**
 * A connected, authenticated bridge session.
 *
 * One socket, many concurrent calls: every request carries an id and replies are
 * matched by it, so a slow call never holds a fast one behind it. That is the
 * same reason `server.mjs` does not await its own dispatch.
 */
class BridgeSession {
  #socket;
  #pending = new Map();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  /** Resolved by the FIRST frame, which is the handshake reply. Kept in the same
   *  buffer as every other frame on purpose: reading the handshake with a
   *  separate `once("data")` loses whatever shared its chunk, and TCP gives no
   *  promise that a reply arrives alone. */
  #onHandshake = null;

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#die("TEDI closed the bridge connection"));
    socket.on("error", (e) => this.#die(`bridge socket error: ${e.message}`));
  }

  get closed() {
    return this.#closed;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let nl;
    while ((nl = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // A frame we cannot parse carries no id to answer on.
      }
      // The handshake reply has no id and comes exactly once, first.
      if (this.#onHandshake) {
        const settle = this.#onHandshake;
        this.#onHandshake = null;
        settle(msg);
        continue;
      }
      const entry = this.#pending.get(msg.id);
      if (!entry) continue;
      this.#pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result ?? null);
      else entry.reject(new Error(msg.error || "the bridge refused the call"));
    }
  }

  /** Send the token and resolve with the server's verdict. Called once. */
  authenticate(token) {
    return new Promise((resolve) => {
      this.#onHandshake = resolve;
      this.#socket.write(`${JSON.stringify({ token })}\n`);
    });
  }

  /** Call a capability by name. Rejects with the capability's own message. */
  call(name, args = []) {
    if (this.#closed) return Promise.reject(new Error("bridge connection is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify({ id, name, args })}\n`);
    });
  }

  /**
   * Mark the session dead and reject everything still waiting.
   *
   * A dead socket must reject in flight rather than leave the caller waiting on
   * a reply that can no longer arrive - the exact failure the CDP transport had,
   * where a pending promise had no deadline and a wedged renderer stranded it
   * along with every later call.
   *
   * `#closed` is set AFTER the sweep, not before. An earlier version set it in
   * `close()` and then let the socket's own `close` event do the rejecting; the
   * event handler saw the flag already set, returned early, and the pending
   * calls hung forever. `bridge-verify` catches that.
   */
  #die(reason) {
    if (this.#closed && this.#pending.size === 0) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) reject(new Error(reason));
    this.#pending.clear();
  }

  close() {
    this.#die("the bridge connection was closed locally");
    this.#socket.destroy();
  }
}

/**
 * Connect and authenticate. Rejects with a sentence a user can act on - "TEDI is
 * not running" is the common case and must not read as a crash.
 */
export function connectBridge({ timeoutMs = 5000 } = {}) {
  const hs = readHandshake();
  if (!hs) {
    return Promise.reject(
      new Error(
        "TEDI is not running, or this build predates the MCP bridge. Start TEDI and try again.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: hs.socket });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to TEDI's bridge at ${hs.socket}`));
    }, timeoutMs);

    socket.once("error", (e) => {
      clearTimeout(timer);
      // ENOENT here means the address is stale: TEDI wrote it and then exited
      // without cleaning up, or crashed.
      reject(
        new Error(
          e.code === "ENOENT" || e.code === "ECONNREFUSED"
            ? "TEDI is not running (its bridge socket is gone)."
            : `cannot reach TEDI's bridge: ${e.message}`,
        ),
      );
    });

    socket.once("connect", () => {
      // Build the session FIRST so one buffer owns every frame, handshake
      // included, then authenticate through it.
      const session = new BridgeSession(socket);
      session.authenticate(hs.token).then((reply) => {
        clearTimeout(timer);
        if (!reply?.ok) {
          session.close();
          reject(
            new Error(
              "TEDI rejected the bridge token. It rotates on every launch - the app was probably restarted, so re-reading the handshake file will pick up the new one.",
            ),
          );
          return;
        }
        resolve(session);
      });
    });
  });
}

export { BridgeSession };
