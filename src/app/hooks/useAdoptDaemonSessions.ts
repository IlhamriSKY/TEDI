import { useEffect, useRef } from "react";

import { leaves } from "@/modules/terminal";
import type { Tab } from "@/modules/tabs";
import { listDaemonSessions } from "@/modules/terminal/lib/pty-bridge";

const POLL_INTERVAL_MS = 2000;

type WorkspaceTabs = { tabs: Tab[]; activeId: number | null };

type Params = {
  /** Live (active-workspace) tabs ref. */
  tabsRef: { readonly current: Tab[] };
  /** All in-memory workspaces, so we don't adopt a session another workspace owns. */
  liveTabsByWorkspace: { readonly current: Map<string, WorkspaceTabs> };
  /** Creates a terminal tab; `savedPtyId` adopts an existing daemon session. */
  newTab: (cwd?: string, opts?: { private?: boolean; savedPtyId?: string }) => number;
  /** True once workspace restore has run (so we don't double-adopt restored leaves). */
  restoreDone: boolean;
};

function collectOwned(tabs: Tab[], into: Set<string>): void {
  for (const t of tabs) {
    if (t.kind !== "pane") continue;
    for (const l of leaves(t.paneTree)) {
      if (l.leafKind !== "terminal") continue;
      if (l.ptyId) into.add(l.ptyId);
      if (l.savedPtyId) into.add(l.savedPtyId);
    }
  }
}

/**
 * GUI poll-adopt. Every ~2s, ask the PTY daemon which sessions it owns and adopt
 * any alive session that has no terminal leaf yet AND was created after we
 * started watching - i.e. one created by ANOTHER daemon client (the
 * remote-access agent, when the browser hits "+"). Adoption reuses the
 * workspace-restore machinery: a new terminal tab whose `savedPtyId` makes
 * `openPtyForSession` call `reattachPty` instead of spawning a shell. Once the
 * GUI is attached, a daemon `Exit` (e.g. a browser-initiated close) tears the tab
 * down through the normal `handleLeafExit` path, so close-from-web also closes
 * the desktop tab.
 *
 * Guards (this is a shared, persistent daemon, so be conservative):
 *  - gated on `restoreDone` so restored leaves (already carrying `savedPtyId`)
 *    are owned before the first poll;
 *  - a creation-time watermark: only sessions created AFTER this GUI started
 *    watching are adopted, so pre-existing/retained daemon sessions and sessions
 *    belonging to not-yet-loaded workspaces (created in a previous run) are never
 *    pulled in;
 *  - owned set spans ALL in-memory workspaces (not just the active one), so a
 *    terminal opened in another workspace isn't adopted into this one;
 *  - "once owned, never re-adopt": a UUID the GUI has ever had a leaf for is
 *    remembered, so a terminal the user closes is not resurrected by the next
 *    poll (the daemon may briefly still list it);
 *  - in-process fallback returns `[]`; SSH leaves never appear in the daemon list.
 */
export function useAdoptDaemonSessions({
  tabsRef,
  liveTabsByWorkspace,
  newTab,
  restoreDone,
}: Params): void {
  // Lazily-initialised once (useRef has no lazy-init form; a `new Set()` literal
  // would allocate on every render and be discarded). Both live for the
  // process; the watermark is captured the first time the poll arms.
  const adoptingRef = useRef<Set<string> | null>(null);
  const everOwnedRef = useRef<Set<string> | null>(null);
  const watermarkRef = useRef<number | null>(null);

  useEffect(() => {
    if (!restoreDone) return;
    const adopting = (adoptingRef.current ??= new Set<string>());
    const everOwned = (everOwnedRef.current ??= new Set<string>());
    if (watermarkRef.current === null) watermarkRef.current = Date.now();
    const watermark = watermarkRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const ownedPtyIds = (): Set<string> => {
      const owned = new Set<string>();
      collectOwned(tabsRef.current, owned);
      for (const ws of liveTabsByWorkspace.current.values()) collectOwned(ws.tabs, owned);
      return owned;
    };

    const tick = async () => {
      try {
        const sessions = await listDaemonSessions();
        if (cancelled) return;
        const owned = ownedPtyIds();
        for (const id of owned) everOwned.add(id);
        const liveIds = new Set(sessions.map((s) => s.id));
        for (const id of [...adopting]) {
          if (!liveIds.has(id) || owned.has(id)) adopting.delete(id);
        }
        for (const s of sessions) {
          if (!s.alive) continue; // dead/retained shell: ignore
          if (s.created_at_ms <= watermark) continue; // pre-existing / other-run session
          if (owned.has(s.id)) continue; // already have a leaf (any workspace)
          if (everOwned.has(s.id)) continue; // previously owned -> closed by user
          if (adopting.has(s.id)) continue; // adoption in progress
          adopting.add(s.id);
          everOwned.add(s.id);
          newTab(s.cwd ?? undefined, { savedPtyId: s.id });
        }
      } catch {
        /* daemon transiently unreachable; next tick retries */
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [restoreDone, newTab, tabsRef, liveTabsByWorkspace]);
}
