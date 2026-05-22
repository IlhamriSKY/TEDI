/**
 * Pub/sub bridge that pushes workspace state (cwd, active file, terminal count)
 * to extensions. Plain JS so React and the host factory can both import it.
 */

import type { AppContextSnapshot } from "./host";

let snapshot: AppContextSnapshot = {
  workspaceCwd: null,
  activeFileName: null,
  terminalCount: 0,
  activeTabKind: null,
};

const listeners = new Set<(ctx: AppContextSnapshot) => void>();

export function getAppContext(): AppContextSnapshot {
  return snapshot;
}

export function setAppContext(next: AppContextSnapshot): void {
  // Shallow equality check. The caller runs on every App render.
  if (
    next.workspaceCwd === snapshot.workspaceCwd &&
    next.activeFileName === snapshot.activeFileName &&
    next.terminalCount === snapshot.terminalCount &&
    next.activeTabKind === snapshot.activeTabKind
  ) {
    return;
  }
  snapshot = next;
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch (err) {
      console.error("[extensions] app context listener threw", err);
    }
  }
}

export function subscribeAppContext(cb: (ctx: AppContextSnapshot) => void): () => void {
  listeners.add(cb);
  // Fire once on subscribe so callers see the current state.
  try {
    cb(snapshot);
  } catch (err) {
    console.error("[extensions] app context initial fire threw", err);
  }
  return () => {
    listeners.delete(cb);
  };
}
