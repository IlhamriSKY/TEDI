/**
 * Self-check for "which terminal panes may hold a WebGL context"
 * (`shouldUseWebgl`). Run: `npx tsx scripts/terminal-webgl-visibility-verify.ts`.
 *
 * An inactive tab keeps its terminal pane MOUNTED under `display: none` (see the
 * style block in `TerminalPane`), so a pane that is off screen is still a live
 * session with a live xterm. Without a visibility gate, every pane that had ever
 * been shown kept its GL context and glyph atlas charged to the WebView2 GPU
 * process for as long as the app ran.
 *
 * The memory is the lesser half. Chromium caps live WebGL contexts at ~16, so
 * enough panes start evicting each other's contexts; an evicted pane fires
 * `webglcontextlost` and, after `MAX_CONTEXT_LOSS_RELOADS` retries, settles on
 * the DOM renderer permanently. That is the "TEDI got sluggish and stayed
 * sluggish" failure, and it is silent.
 *
 * Five call sites can turn the renderer on (first attach, wallpaper sync,
 * font-size, font-family, the WebGL pref). A guard living at the call sites
 * would have to be correct five times and stay correct as sites are added, so
 * the decision is one predicate they all route through. This asserts that
 * predicate over its whole input matrix, and asserts the sync actually hands a
 * hidden pane's context BACK rather than merely declining to take a new one -
 * those are different bugs and only the second one is caught by the load path.
 */

export {};

// The module graph reaches the settings store, which resolves the current
// webview window at import time. Same stand-in as `clipboard-read-verify`.
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: async () => undefined,
  },
};

const { shouldUseWebgl, syncRendererForWallpaper, disposeWebglRenderer, nextContextLossState } =
  await import("../src/modules/terminal/lib/webgl");
type Session = Parameters<typeof shouldUseWebgl>[0];

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

/** A session with everything the renderer decision reads, all knobs open. */
function session(over: Partial<Record<"webglEnabled" | "visible" | "attached", boolean>> = {}) {
  const { webglEnabled = true, visible = true, attached = true } = over;
  return {
    webglEnabled,
    visible,
    term: { element: attached ? {} : null },
    webglAddon: null,
  } as unknown as Session;
}

/** Stand-in for a live addon so the dispose direction is observable. */
function fakeAddon(disposed: { yes: boolean }) {
  return {
    dispose() {
      disposed.yes = true;
    },
  };
}

console.log("\nthe visibility gate itself");
assert(shouldUseWebgl(session()) === true, "a visible, attached, enabled pane may hold a context");
assert(
  shouldUseWebgl(session({ visible: false })) === false,
  "a pane in an INACTIVE TAB may not - this is the whole point",
);

console.log("\nthe other inputs still veto");
assert(
  shouldUseWebgl(session({ webglEnabled: false })) === false,
  "the WebGL pref off vetoes a visible pane",
);
assert(
  shouldUseWebgl(session({ attached: false })) === false,
  "a not-yet-attached pane (no term.element) vetoes, so an early sync cannot throw",
);

console.log("\nany single veto is enough (no input can be overridden by the others)");
for (const key of ["webglEnabled", "visible", "attached"] as const) {
  assert(shouldUseWebgl(session({ [key]: false })) === false, `${key}=false alone vetoes`);
}

console.log("\nwallpaper still vetoes, and does not eat the visibility gate");
// `wallpaperActive` reads `document.documentElement.dataset.tediGlass`, and
// short-circuits to false when there is no document at all (as here).
(globalThis as { document?: unknown }).document = {
  documentElement: { dataset: { tediGlass: "on" } },
};
assert(shouldUseWebgl(session()) === false, "glass wallpaper on vetoes a visible pane");
(globalThis as { document?: unknown }).document = {
  documentElement: { dataset: { tediGlass: "off" } },
};
assert(shouldUseWebgl(session()) === true, "glass wallpaper off lets it back");
assert(
  shouldUseWebgl(session({ visible: false })) === false,
  "wallpaper off does NOT re-enable a hidden pane",
);

console.log("\nsync HANDS BACK a hidden pane's context (not just declines a new one)");
{
  const disposed = { yes: false };
  const s = session({ visible: false });
  (s as { webglAddon: unknown }).webglAddon = fakeAddon(disposed);
  syncRendererForWallpaper(s);
  assert(disposed.yes, "going hidden disposes the addon that was already loaded");
  assert(s.webglAddon === null, "and clears the slot so a later show reloads cleanly");
}
{
  const disposed = { yes: false };
  const s = session();
  (s as { webglAddon: unknown }).webglAddon = fakeAddon(disposed);
  syncRendererForWallpaper(s);
  assert(!disposed.yes, "a still-visible pane keeps the context it already has");
  assert(s.webglAddon !== null, "and keeps the slot filled");
}

console.log("\ndispose is idempotent (a second hide must not throw)");
{
  const s = session({ visible: false });
  disposeWebglRenderer(s);
  disposeWebglRenderer(s);
  assert(s.webglAddon === null, "disposing an already-disposed session is a no-op");
}

console.log("\nthe reload budget is per STORM, not per session (lock/unlock spends one each)");
{
  const MINUTE = 60_000;
  // A real storm: contexts evicting each other, losses a second apart.
  let st = { reloads: 0, lastLossAt: 0, mayReload: false };
  for (const at of [10_000, 11_000, 12_000]) {
    st = nextContextLossState(st.reloads, st.lastLossAt, at);
    assert(st.mayReload, `loss at ${at}ms inside one storm still reloads`);
  }
  st = nextContextLossState(st.reloads, st.lastLossAt, 13_000);
  assert(!st.mayReload, "a fourth loss in the same storm settles on the DOM renderer");

  // Three locks of the machine, hours apart. Each is its own event.
  let lock = { reloads: 0, lastLossAt: 0, mayReload: false };
  for (let hour = 1; hour <= 5; hour++) {
    lock = nextContextLossState(lock.reloads, lock.lastLossAt, hour * 60 * MINUTE);
    assert(lock.mayReload, `lock #${hour} of a long-lived window still recovers WebGL`);
    assert(lock.reloads === 1, `lock #${hour} starts a fresh budget rather than spending the old`);
  }
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`terminal-webgl-visibility-verify: ${failed} check(s) failed`);
console.log("\nterminal-webgl-visibility-verify: all checks passed");
