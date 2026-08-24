/**
 * The pinned-first ordering invariant, shared by the tab strip and the
 * Workspaces panel.
 *
 * Both surfaces make the same promise - pinned things sit at the front and stay
 * there - and both are reordered by drag. Keeping one implementation means the
 * two cannot drift into behaving differently, and there is a single place to
 * reason about the edge cases.
 */

/** Anything that can be pinned. Absent means not pinned. */
export type Pinnable = { pinned?: boolean };

/**
 * Pinned items first, the rest after, both halves keeping their relative order.
 *
 * A STABLE PARTITION, deliberately, and applied AFTER a move rather than
 * instead of one. A drag that drops an unpinned item into the middle of the
 * pinned run is not rejected: the move happens, then this pulls it back to the
 * boundary, so the item visibly settles at the nearest legal slot instead of
 * the gesture silently doing nothing. That is what Chrome does, and it lets
 * every caller reorder naively and delegate the invariant here.
 *
 * Returns the SAME array reference when nothing needs to move, so React state
 * setters bail out instead of re-rendering the whole strip on every drag frame.
 */
export function sortPinnedFirst<T extends Pinnable>(items: T[]): T[] {
  let seenUnpinned = false;
  for (const item of items) {
    if (item.pinned) {
      // A pinned item after an unpinned one is the only thing that can be
      // wrong; everything else is already in order.
      if (seenUnpinned) {
        return [...items.filter((i) => i.pinned), ...items.filter((i) => !i.pinned)];
      }
    } else {
      seenUnpinned = true;
    }
  }
  return items;
}

/**
 * Index of the first unpinned item, i.e. where the pinned run ends. `length`
 * when everything is pinned. Callers use it to insert a newly pinned item at
 * the end of the pinned run rather than at either extreme.
 */
export function pinnedBoundary(items: readonly Pinnable[]): number {
  const idx = items.findIndex((i) => !i.pinned);
  return idx < 0 ? items.length : idx;
}
