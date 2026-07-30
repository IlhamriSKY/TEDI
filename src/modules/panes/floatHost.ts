/**
 * Main-window side of the pane-float feature. Opens a native Tauri window for a
 * leaf and, for terminal leaves, mirrors the live shell into it over Tauri
 * events: forwards output, replays a scrollback snapshot on the float's HELLO,
 * pushes size changes, and injects the float's input back into the PTY. The
 * main pane is never touched - the float is an independent read/write view.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { browserEmbedHide } from "@/modules/browser";
import { useFloatStore } from "./floatStore";
import {
  serializeTerminal,
  subscribeTerminalOutput,
  terminalSize,
  writeTerminalInput,
} from "@/modules/terminal";
import { bytesToB64, encodeFloatParams, floatEv, type FloatLeafParams } from "./floatProtocol";

const hosts = new Map<number, () => void>();

// Rust emits this (window `Destroyed` event) with the closed window's label -
// the authoritative "float closed / docked back" signal. Registered once; it
// drives the matching leaf's teardown so the main pane reliably comes back.
let destroyedListenerStarted = false;
function ensureDestroyedListener(): void {
  if (destroyedListenerStarted) return;
  destroyedListenerStarted = true;
  void listen<string>("tedi://float-destroyed", (e) => {
    const m = /^float-(\d+)$/.exec(e.payload);
    if (m) hosts.get(Number(m[1]))?.();
  });
}

/** Start (idempotently) mirroring a terminal leaf to its float window. */
function startTerminalHost(leafId: number): void {
  if (hosts.has(leafId)) return;
  const unlisteners: UnlistenFn[] = [];
  let active = false;
  let lastCols = 0;
  let lastRows = 0;
  let poll = 0;
  let torn = false;

  const unsubOut = subscribeTerminalOutput(leafId, (bytes) => {
    if (active) void emit(floatEv.out(leafId), bytesToB64(bytes));
  });

  const teardown = () => {
    if (torn) return;
    torn = true;
    unsubOut();
    window.clearInterval(poll);
    for (const u of unlisteners) u();
    hosts.delete(leafId);
    // Float window gone: main pane drops the indicator + re-renders its terminal.
    useFloatStore.getState().setFloating(leafId, false);
  };

  const sendSnap = () => {
    const size = terminalSize(leafId) ?? { cols: 80, rows: 24 };
    lastCols = size.cols;
    lastRows = size.rows;
    void emit(floatEv.snap(leafId), {
      text: serializeTerminal(leafId) ?? "",
      cols: size.cols,
      rows: size.rows,
    });
  };

  // Forward size changes so the float resizes with the main pane. Close
  // detection is the Rust `Destroyed` event (see ensureDestroyedListener), not
  // this poll.
  poll = window.setInterval(() => {
    if (!active) return;
    const size = terminalSize(leafId);
    if (size && (size.cols !== lastCols || size.rows !== lastRows)) {
      lastCols = size.cols;
      lastRows = size.rows;
      void emit(floatEv.size(leafId), size);
    }
  }, 500);

  // Snap only on the FIRST hello. The client sends hello twice (initial + a
  // 250ms retry for the host-not-ready race); a second snap would term.reset()
  // the float and wipe live output received in between.
  void listen(floatEv.hello(leafId), () => {
    if (active) return;
    active = true;
    sendSnap();
    // Float window is up: main pane shows the indicator + stops rendering the
    // now-redundant terminal to lighten the load.
    useFloatStore.getState().setFloating(leafId, true);
  }).then((u) => unlisteners.push(u));
  void listen<string>(floatEv.in(leafId), (e) => writeTerminalInput(leafId, e.payload)).then((u) =>
    unlisteners.push(u),
  );
  // Fast path when the float DID manage to emit BYE before closing; the poll
  // above is the guaranteed fallback when it didn't.
  void listen(floatEv.bye(leafId), teardown).then((u) => unlisteners.push(u));

  hosts.set(leafId, teardown);
}

/** Register a minimal host for a leaf kind that has NO live mirror (editor): it
 *  just flips the floating flag on so the main pane unmounts its now-handed-off
 *  view, and registers the teardown that `ensureDestroyedListener` runs when the
 *  window closes so the main pane comes back. No output/input bridge. */
function startPassiveHost(leafId: number, onUrl?: (url: string) => void): void {
  if (hosts.has(leafId)) return;
  let torn = false;
  const unlisteners: UnlistenFn[] = [];
  const teardown = () => {
    if (torn) return;
    torn = true;
    for (const u of unlisteners) u();
    hosts.delete(leafId);
    useFloatStore.getState().setFloating(leafId, false);
  };
  // Browser leaves report navigation back: the leaf's url drives its tab title
  // and the browser list the AI reads, and the float owns the page while it is
  // popped out, so without this both go stale the moment the user clicks a link.
  if (onUrl) {
    void listen<string>(floatEv.url(leafId), (e) => {
      if (!torn && e.payload) onUrl(e.payload);
    }).then((u) => {
      if (torn) u();
      else unlisteners.push(u);
    });
  }
  hosts.set(leafId, teardown);
  useFloatStore.getState().setFloating(leafId, true);
}

/**
 * Float a pane into its own always-on-top window. For terminals this also wires
 * the live mirror; editors hand off (main pane unmounts while floating). Safe to
 * call again for an already-floated leaf (the Rust side reveals the window).
 */
export async function floatPane(
  params: FloatLeafParams,
  size: { w: number; h: number },
  /** Browser leaves only: applied when the float reports the page navigated, so
   *  the leaf's url (its tab title, and the browser list the AI reads) tracks the
   *  page while it is popped out. */
  onBrowserUrl?: (url: string) => void,
): Promise<void> {
  ensureDestroyedListener();
  // If not currently floating but a host is still registered, it's stale (the
  // window closed and the poll/Destroyed hasn't caught it yet) - tear it down so
  // a fresh window gets a clean host. When already floating, this is a "focus the
  // window" click: keep the host (start*Host is a no-op).
  if (params.kind === "terminal") {
    if (!useFloatStore.getState().floating.has(params.leafId)) hosts.get(params.leafId)?.();
    startTerminalHost(params.leafId);
  } else if (params.kind === "editor" || params.kind === "browser") {
    // Both hand off rather than mirror, so they need no output bridge. A browser
    // hands off by MOVING its native webview into the float window (see
    // FloatBrowser), which is why the page survives the trip without reloading.
    const alreadyFloating = useFloatStore.getState().floating.has(params.leafId);
    if (!alreadyFloating) hosts.get(params.leafId)?.();
    // A browser pane's webview composites ABOVE the DOM and nothing hides it
    // between the main pane unmounting and the float window taking ownership, so
    // it would sit over the "this pane is floating" placeholder for as long as the
    // window takes to open. Hide it for that gap; the float's own bounds loop
    // shows it again the moment it owns it. Skipped when this is a "focus the
    // existing window" click, which must not blink the page.
    if (params.kind === "browser" && !alreadyFloating) {
      await browserEmbedHide(params.leafId).catch(() => {});
    }
    startPassiveHost(params.leafId, params.kind === "browser" ? onBrowserUrl : undefined);
  }
  await invoke("open_float_window", {
    leafId: params.leafId,
    params: encodeFloatParams(params),
    title: params.title,
    width: Math.max(360, Math.round(size.w)),
    height: Math.max(220, Math.round(size.h)),
  });
}

/** Ask a leaf's float window to close itself (dock back). It closes on receipt,
 *  which fires BYE and clears the floating state. */
export function closeFloat(leafId: number): void {
  void emit(floatEv.close(leafId));
}
