/**
 * The capability bridge: one registry of everything an agent can reach in-realm.
 *
 * WHAT THIS REPLACES. `window.__tedi` was assembled by SEVEN files, each doing
 * `w.__tedi = { ...w.__tedi, ... }` inside a module body or a `useEffect`. That
 * had three costs and no benefits:
 *
 *   1. Nothing owned the surface. Evaluation order is undefined, so the merge
 *      spread was load-bearing, and a comment in one contributor still said
 *      "FOUR files" long after there were seven.
 *   2. Availability depended on mount history. Three contributors run in effects,
 *      so a capability existed or not according to which panel the user had
 *      opened - the browser helpers famously answered with a sentence explaining
 *      the AI panel had not mounted yet.
 *   3. There was no way to call a capability except through the DevTools socket,
 *      because the object only existed on `window` and only when the automation
 *      flag was set. A second transport had nothing to call.
 *
 * Now each contributor registers into this map, and the map is the surface.
 * `window.__tedi` is still published for the CDP driver (`scripts/mcp/driver.mjs`
 * evaluates `window.__tedi.foo(...)` in the page and cannot import anything), but
 * it is now a VIEW of the registry rather than the thing itself.
 *
 * WHY REGISTRATION IS NOT GATED. The old object was hidden behind
 * `__TEDI_AUTOMATION__` because being on `window` IS the exposure: any script in
 * the page could read it. A registry in a module has no such reach - it is
 * reachable only by code that imports it. So the gate moved to where it belongs:
 * `publishToWindow` (below) still refuses without the flag, and each transport
 * authenticates for itself. That is what lets the local-socket bridge answer
 * while the DevTools port stays shut.
 */

/** A capability: takes whatever its caller sends, answers with anything. */
export type BridgeFn = (...args: never[]) => unknown;

const registry = new Map<string, BridgeFn>();

/**
 * Add capabilities to the bridge. Idempotent per name - a re-registration wins,
 * which is what a React effect re-running after a dependency change needs.
 */
export function registerBridge(fns: Record<string, BridgeFn>): void {
  for (const [name, fn] of Object.entries(fns)) registry.set(name, fn);
  syncWindow();
}

/** Names currently registered, sorted. For diagnostics and the bridge verify. */
export function bridgeNames(): string[] {
  return [...registry.keys()].sort();
}

/** True when `name` is registered and callable right now. */
export function hasBridge(name: string): boolean {
  return registry.has(name);
}

/**
 * Call a capability by name.
 *
 * Throws a NAMED error rather than returning undefined: a transport has to be
 * able to tell "no such capability" from "the capability answered undefined",
 * and the old `window.__tedi.foo?.()` shape could not. `driver.mjs` reads a bare
 * `null` as "this build has no automation surface at all", which is a different
 * and much more alarming answer than "that one function is not wired yet".
 */
export async function callBridge(name: string, args: unknown[] = []): Promise<unknown> {
  const fn = registry.get(name);
  if (!fn) {
    throw new Error(
      `No capability "${name}" is registered. Available: ${bridgeNames().join(", ") || "(none yet - the window is still starting up)"}`,
    );
  }
  return await (fn as (...a: unknown[]) => unknown)(...args);
}

/**
 * Mirror the registry onto `window.__tedi`, for the CDP driver only.
 *
 * Gated on `__TEDI_AUTOMATION__` (set by a Tauri init script when an automation
 * port is configured) because anything on `window` is readable by every script
 * in the page, including a previewed third-party page in a browser pane.
 */
function syncWindow(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    __TEDI_AUTOMATION__?: boolean;
    __tedi?: Record<string, unknown>;
  };
  if (!w.__TEDI_AUTOMATION__) return;
  const out: Record<string, unknown> = {};
  for (const [name, fn] of registry) out[name] = fn;
  w.__tedi = out;
}
