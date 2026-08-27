/**
 * Answers capability calls arriving from the local socket.
 *
 * The Rust side (`src-tauri/src/modules/mcp_bridge.rs`) owns the socket and the
 * request/response correlation; this is the half that actually runs the work,
 * because the capabilities live here. One event in, one `invoke` back out:
 *
 *   socket --(tedi://bridge-call)--> this --(mcp_bridge_reply)--> socket
 *
 * EVERY call answers, including the ones that throw. A capability that raises is
 * an ordinary outcome an agent should read and act on - "no browser pane with
 * that leafId", "that command has no handler" - and dropping the reply would
 * instead park the client until Rust's timeout fired, turning a useful sentence
 * into a two-minute silence. That was the CDP path's failure mode and it is not
 * worth reproducing.
 *
 * MAIN WINDOW ONLY. Rust emits to the "main" webview label, and the capabilities
 * are registered by the main window's React tree; the settings, debug and float
 * entries have their own empty registries. Starting this anywhere else would
 * answer with "no capability registered" for everything.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { callBridge } from "./bridge";

type BridgeCall = { callId: string; name: string; args?: unknown[] };

/** Serialize the answer, refusing what cannot cross the IPC boundary.
 *
 *  `JSON.stringify` throws on a cycle, and a capability that returned a React
 *  element or a live handle would take the whole reply down with it. Catching
 *  here turns that into a message naming the capability, which is debuggable;
 *  letting it escape would look like a hang. */
function toJson(value: unknown, name: string): { result: unknown } | { error: string } {
  try {
    // A round trip, not a bare pass-through: `invoke` serializes anyway, so this
    // surfaces the failure HERE, where the capability's name is still in hand.
    return { result: JSON.parse(JSON.stringify(value ?? null)) };
  } catch {
    return { error: `"${name}" returned something that cannot be serialized to JSON.` };
  }
}

let started = false;

/**
 * Begin answering bridge calls. Idempotent; returns an unsubscribe.
 *
 * Not awaited by the caller: `listen` resolves after the event channel is
 * registered, and a call cannot arrive before a client has connected and
 * authenticated, which is far later than app start.
 */
export function startBridgeHost(): () => void {
  if (started) return () => {};
  started = true;

  const stop = listen<BridgeCall>("tedi://bridge-call", async (event) => {
    const { callId, name, args } = event.payload;
    let reply: { ok: boolean; result?: unknown; error?: string };
    try {
      const value = await callBridge(name, Array.isArray(args) ? args : []);
      const encoded = toJson(value, name);
      reply = "error" in encoded ? { ok: false, error: encoded.error } : { ok: true, ...encoded };
    } catch (e) {
      reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      await invoke("mcp_bridge_reply", { callId, reply });
    } catch (e) {
      // The socket client went away mid-call, or the id already timed out. The
      // work is done either way; there is nobody left to tell.
      console.debug("[mcp bridge] reply dropped:", e);
    }
  });

  return () => {
    started = false;
    void stop.then((off) => off());
  };
}
