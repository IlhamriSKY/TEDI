import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useDebugStore, type DebugCapture } from "./debugStore";

// Live mirror between the MAIN window (host: owns the in-memory capture store,
// filled by the agent loop) and the popped-out Debug window (client: a separate
// webview with its own empty store). The store is deliberately not persisted, so
// this event feed is the only way the child window ever sees captures.
const SYNC = "tedi://debug-sync"; // host -> client: full captures array
const HELLO = "tedi://debug-hello"; // client -> host: window opened, send a snapshot
const BYE = "tedi://debug-bye"; // client -> host: window closing, stop sending
const CLEAR = "tedi://debug-clear"; // client -> host: clear the store

let hostStarted = false;
// Whether a Debug window is currently listening. The host only serializes and
// broadcasts the (potentially large) captures array while one is open, so a
// closed window costs nothing on each agent step.
let clientActive = false;

/**
 * Run in the MAIN window. Mirrors the in-memory debug store to an open Debug
 * window: pushes the full captures array on every store change and on request,
 * and applies a remote Clear. Idempotent; started lazily the first time the
 * Debug window is opened.
 */
function startDebugHost(): void {
  if (hostStarted) return;
  hostStarted = true;
  const snapshot = () => void emit(SYNC, useDebugStore.getState().captures);
  // Push on every store change, but only while a window is actually listening.
  useDebugStore.subscribe(() => {
    if (clientActive) snapshot();
  });
  void listen(HELLO, () => {
    clientActive = true;
    snapshot();
  });
  void listen(BYE, () => {
    clientActive = false;
  });
  void listen(CLEAR, () => useDebugStore.getState().clear());
}

/**
 * Run in the DEBUG window. Pulls a snapshot, then keeps the local store in sync
 * with the host, and tells the host to stop sending once this window goes away.
 * Returns an unlisten cleanup.
 */
export function startDebugClient(): () => void {
  const unlistenPromise = listen<DebugCapture[]>(SYNC, (e) => {
    useDebugStore.setState({ captures: Array.isArray(e.payload) ? e.payload : [] });
  });
  // Emit HELLO twice to cover the rare race where the host's HELLO listener
  // isn't registered yet when this window mounts. The host answers idempotently.
  void emit(HELLO);
  const retry = setTimeout(() => void emit(HELLO), 250);
  // `pagehide` fires when the webview is torn down (window close) - more
  // reliable than a React unmount - so the host stops broadcasting to a window
  // that no longer exists.
  const bye = () => void emit(BYE);
  window.addEventListener("pagehide", bye);
  return () => {
    clearTimeout(retry);
    window.removeEventListener("pagehide", bye);
    void emit(BYE);
    void unlistenPromise.then((un) => un());
  };
}

/** Clear captures from the Debug window: tell the host (source of truth) and
 *  clear the local mirror optimistically. */
export function clearDebugRemote(): void {
  useDebugStore.getState().clear();
  void emit(CLEAR);
}

/** Open (or focus) the native Debug window. Starts the host mirror first so the
 *  new window's snapshot request is answered. */
export async function openDebugWindow(): Promise<void> {
  startDebugHost();
  await invoke("open_debug_window");
}
