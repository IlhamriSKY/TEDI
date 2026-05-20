/**
 * App context bridge: a tiny pub/sub that lets the main App push live
 * workspace state (cwd, active file, terminal count) into the extension
 * subsystem, so presence / status-style extensions don't need to reach
 * into core stores. The bridge is plain-vanilla so it can be imported
 * from both React code and the host factory without React state coupling.
 */

import type { AppContextSnapshot } from "./host";

let snapshot: AppContextSnapshot = {
  workspaceCwd: null,
  activeFileName: null,
  terminalCount: 0,
};

const listeners = new Set<(ctx: AppContextSnapshot) => void>();

export function getAppContext(): AppContextSnapshot {
  return snapshot;
}

export function setAppContext(next: AppContextSnapshot): void {
  // Cheap shallow-equality check - the App effect that calls this runs on
  // every render, so we'd otherwise wake every extension on unrelated
  // re-renders.
  if (
    next.workspaceCwd === snapshot.workspaceCwd &&
    next.activeFileName === snapshot.activeFileName &&
    next.terminalCount === snapshot.terminalCount
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
  // Fire once on subscribe so callers see the current state without an
  // extra `getContext()` round-trip.
  try {
    cb(snapshot);
  } catch (err) {
    console.error("[extensions] app context initial fire threw", err);
  }
  return () => {
    listeners.delete(cb);
  };
}
