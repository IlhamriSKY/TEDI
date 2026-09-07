/**
 * Status-bar zones: which item sits where, what a drag does to that, and what
 * survives compact mode.
 *
 * The bar reads left to right as three answers to three different questions:
 *
 *   0 kept       what I want to keep seeing when the bar folds
 *   1 folding    what I am happy to lose when the bar folds
 *   2 AI         TEDI's own agent, locked
 *
 * Zones 0 and 1 are yours: every item declares a home there and you may drag
 * any of them into the other, and only the moved ones are persisted (see
 * `Preferences.statusBarLayout`). So the split is not a taxonomy you have to
 * agree with, it is one question - keep it or fold it - answered by dragging.
 *
 * Zone 2 is not yours. It holds TEDI's own AI and nothing else: it is the one
 * control the bar exists to keep reachable, so it cannot be dragged out, folded
 * away, or have anything dropped on top of it.
 *
 * Pure on purpose - no React, no store - because the ordering rules and the
 * compact rule are the part worth checking, and `scripts/ui/statusbar-zones-verify.ts`
 * checks them here rather than through a rendered bar.
 */

/** Zone index. Ordered left to right, and that order is the whole model. */
export type StatusZone = 0 | 1 | 2;

export const STATUS_ZONES: StatusZone[] = [0, 1, 2];

/**
 * The zone the user cannot touch. Membership is declared by `defaultZone`
 * alone - there is no separate flag, because a second way to say "locked"
 * is a second way for it to disagree with itself.
 */
export const LOCKED_ZONE: StatusZone = 2;

/** Labels used by the drop hints while dragging, and as each zone's aria-label. */
export const ZONE_LABELS: Record<StatusZone, string> = {
  0: "Kept when folded",
  1: "Folds away",
  2: "AI",
};

/** One thing the status bar can draw, as the layout sees it. */
export type ZoneItem = {
  /** Stable across restarts and across extension reloads; it is the key the
   *  saved layout is written against. */
  id: string;
  /** Where it goes until someone drags it. `LOCKED_ZONE` means it never moves. */
  defaultZone: StatusZone;
};

/** Whether this item lives in the locked zone, i.e. is TEDI's own AI. */
export function isLocked(item: ZoneItem): boolean {
  return item.defaultZone === LOCKED_ZONE;
}

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
 *  - an id in the layout that no longer exists is dropped silently;
 *  - the locked zone ignores the layout entirely, in BOTH directions: a locked
 *    item cannot be placed elsewhere and nothing else can be placed in it. That
 *    is also the migration - a bar arranged before the zone was locked has its
 *    old zone-2 placements ignored, and those items fall back to their defaults.
 */
export function resolveZones<T extends ZoneItem>(
  items: readonly T[],
  layout: readonly string[][],
): T[][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set<string>();
  const zones: T[][] = [[], [], []];

  for (const z of STATUS_ZONES) {
    if (z === LOCKED_ZONE) continue;
    for (const id of layout[z] ?? []) {
      const item = byId.get(id);
      // `placed` also guards a duplicate id across two zones, which a
      // hand-edited settings file can carry.
      if (!item || placed.has(id) || isLocked(item)) continue;
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
 * A move that involves the locked zone at either end is refused and the layout
 * comes back untouched, so a drag that should not have started cannot persist
 * anything either.
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
  const moving = items.find((i) => i.id === id);
  if (zone === LOCKED_ZONE || !moving || isLocked(moving)) {
    return STATUS_ZONES.map((z) => [...(layout[z] ?? [])]);
  }

  const resolved = resolveZones(items, layout);
  const next: string[][] = resolved.map((list) => list.map((i) => i.id).filter((x) => x !== id));
  // The locked zone is never read back, so writing it out would only preserve
  // ids nobody can reach - including the stale zone-2 slots of a bar arranged
  // before the zone was locked.
  next[LOCKED_ZONE] = [];

  // Ids that are saved but not live (a disabled extension) would vanish from a
  // dense rewrite, so carry them at the end of the zone they were saved in.
  const live = new Set(items.map((i) => i.id));
  for (const z of STATUS_ZONES) {
    if (z === LOCKED_ZONE) continue;
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
 * Zone 1 is the only thing that folds. Zone 0 is what you fold the bar down TO,
 * and the locked AI zone is never foldable. So "drag it out of the middle" is
 * how you say "keep this one when I fold the bar", which is the only rule a
 * user has to learn here.
 */
export function visibleInCompact(_item: ZoneItem, zone: StatusZone): boolean {
  return zone !== 1;
}
