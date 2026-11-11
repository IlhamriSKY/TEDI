/**
 * Unsaved editor text that outlives its component. A split, an unsplit, a
 * workspace switch or a canvas/tabs flip REMOUNTS the editor while its leaf is
 * still open; terminals survive that through their module-level session map, and
 * this is the editor's equivalent. `useDocument` stashes a dirty buffer on
 * unmount and takes it back on mount; the pane-tree reconciler
 * (`useSessionDisposal`) drops the entries of leaves that really closed.
 */
type Kept = { path: string; saved: string; buffer: string };

const kept = new Map<number, Kept>();

export function stashUnsavedBuffer(leafId: number, entry: Kept): void {
  kept.set(leafId, entry);
}

/** The buffer stashed for this leaf, if it was for this same file. One-shot. */
export function takeUnsavedBuffer(leafId: number, path: string): Kept | null {
  const entry = kept.get(leafId);
  kept.delete(leafId);
  return entry && entry.path === path ? entry : null;
}

/** Forget every leaf that is no longer in any pane tree. */
export function dropUnsavedBuffersExcept(live: ReadonlySet<number>): void {
  for (const id of kept.keys()) if (!live.has(id)) kept.delete(id);
}
