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
  workspaceCount: 1,
  terminalCountAll: 0,
  terminals: [],
};

// Stable signature of the terminals map for the equality check below. Includes
// `state` (so an AI-CLI status flip idle<->working propagates), `title` (so a
// window-title change reaches the mirror instead of the tab keeping a stale one)
// and the workspace fields (so a switch / rename / new-workspace propagates)
// instead of being swallowed as "unchanged".
function terminalsSig(t: AppContextSnapshot["terminals"]): string {
  return t
    .map(
      (x) =>
        `${x.ptyId}:${x.ordinal}:${x.state ?? ""}:${x.title ?? ""}:${x.wsId ?? ""}:${x.wsName ?? ""}:${x.wsActive ? 1 : 0}`,
    )
    .join(",");
}

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
    next.activeTabKind === snapshot.activeTabKind &&
    next.workspaceCount === snapshot.workspaceCount &&
    next.terminalCountAll === snapshot.terminalCountAll &&
    terminalsSig(next.terminals) === terminalsSig(snapshot.terminals)
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
