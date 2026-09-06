/**
 * Status-bar zones: which item sits where, what a drag does to that, and what
 * survives compact mode.
 *
 * The bar reads left to right as three answers to three different questions:
 *
 *   0 readouts   what is this costing me            (AI usage, memory, zoom, an update)
 *   1 indicators what is going on over there        (Discord, Remote Access, the scheduler)
 *   2 actions    what can I press                   (panel toggles, Source Control, AI)
 *
 * Every item declares a default zone, and the user may drag any of them into
 * any zone; only the moved ones are persisted (see `Preferences.statusBarLayout`).
 *
 * Pure on purpose - no React, no store - because the ordering rules and the
 * compact rule are the part worth checking, and `scripts/ui/statusbar-zones-verify.ts`
 * checks them here rather than through a rendered bar.
 */

/** Zone index. Ordered left to right, and that order is the whole model. */
export type StatusZone = 0 | 1 | 2;

export const STATUS_ZONES: StatusZone[] = [0, 1, 2];

/** Labels used by the drop hints while dragging. */
export const ZONE_LABELS: Record<StatusZone, string> = {
  0: "Readouts",
  1: "Indicators",
  2: "Actions",
};

/** One thing the status bar can draw, as the layout sees it. */
export type ZoneItem = {
  /** Stable across restarts and across extension reloads; it is the key the
   *  saved layout is written against. */
  id: string;
  /** Where it goes until someone drags it. */
  defaultZone: StatusZone;
  /**
   * Survives compact mode wherever it sits. Only TEDI's own AI carries this:
   * it is the one control the bar exists to keep reachable, and folding it away
   * would leave no way back to the agent that is running.
   */
  pinned?: boolean;
};

/**
 * Resolve the saved layout against the items that actually exist right now.
 *
 * The saved layout is sparse and the live set changes under it - an extension
 * is installed, a meter goes quiet, a panel toggle appears - so this is a merge,
 * not a lookup:
 *
 *  - an id the user placed keeps that zone and that position;
 *  - an id nobody placed follows its own `defaultZone`, in the order the items
 *    were declared, appended after the placed ones;
 *  - an id in the layout that no longer exists is dropped silently.
 *
 * @returns one array of items per zone, left to right.
 */
export function resolveZones<T extends ZoneItem>(
  items: readonly T[],
  layout: readonly string[][],
): T[][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set<string>();
  const zones: T[][] = [[], [], []];

  for (const z of STATUS_ZONES) {
    for (const id of layout[z] ?? []) {
      const item = byId.get(id);
      // `placed` also guards a duplicate id across two zones, which a
      // hand-edited settings file can carry.
      if (!item || placed.has(id)) continue;
      placed.add(id);
      zones[z].push(item);
    }
  }
  for (const item of items) {
    if (placed.has(item.id)) continue;
    zones[item.defaultZone].push(item);
  }
  return zones;
}

/**
 * Move `id` into `zone` at `index`, returning the layout to persist.
 *
 * The result is DENSE - every currently known item is written out, not just the
 * moved one - because a drag is the moment the user takes ownership of the
 * order, and leaving the rest implicit would let a later default change reshuffle
 * a bar somebody had already arranged. Items that exist but are not in `items`
 * (an extension that is disabled right now) keep their saved slots.
 *
 * @param items every item currently known, in declaration order
 * @param layout the saved layout
 * @param id the item being dropped
 * @param zone the zone it was dropped into
 * @param index where in that zone, clamped; `-1` or past the end means last
 */
export function moveItem(
  items: readonly ZoneItem[],
  layout: readonly string[][],
  id: string,
  zone: StatusZone,
  index: number,
): string[][] {
  const resolved = resolveZones(items, layout);
  const next: string[][] = resolved.map((list) => list.map((i) => i.id).filter((x) => x !== id));

  // Ids that are saved but not live (a disabled extension) would vanish from a
  // dense rewrite, so carry them at the end of the zone they were saved in.
  const live = new Set(items.map((i) => i.id));
  for (const z of STATUS_ZONES) {
    for (const savedId of layout[z] ?? []) {
      if (savedId !== id && !live.has(savedId) && !next[z].includes(savedId)) next[z].push(savedId);
    }
  }

  const at = index < 0 || index > next[zone].length ? next[zone].length : index;
  next[zone].splice(at, 0, id);
  return next;
}

/**
 * What compact mode keeps.
 *
 * Zone 0 stays whole - it is the one you fold the bar down TO, the numbers you
 * wanted at a glance - and the pinned item (TEDI's own AI) stays wherever it
 * was dragged. Everything else folds away. So "drag it into the readouts" is
 * also how you say "keep this one when I fold the bar", which is the only rule
 * a user has to learn here.
 */
export function visibleInCompact(item: ZoneItem, zone: StatusZone): boolean {
  return zone === 0 || item.pinned === true;
}
