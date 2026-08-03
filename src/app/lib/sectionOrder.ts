/**
 * Persisted drag order for a sidebar column's sections.
 *
 * Both columns stack a set of sections that changes under them: a section
 * disappears when its extension is disabled or it is docked to the other side,
 * and appears when it is opened. The persisted order is therefore never
 * authoritative on its own - it is reconciled against whatever exists right now.
 */

/** Read the persisted order verbatim. Anything unexpected reads as "no order",
 *  which reconciliation then fills in from the caller's list. */
export function readSectionOrder(storageKey: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (Array.isArray(raw)) return raw.filter((k): k is string => typeof k === "string");
  } catch {
    // Corrupt value (or no localStorage): fall through to the caller's order.
  }
  return [];
}

export function writeSectionOrder(storageKey: string, order: string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(order));
  } catch {
    // localStorage may be unavailable; order is non-critical, ignore.
  }
}

/**
 * Keep persisted positions for the keys that still exist, then append any new
 * ones in the order the caller listed them.
 *
 * Dropping unknown keys rather than rendering them is what stops a disabled
 * extension's section from leaving a hole, and appending rather than resetting
 * is what stops a newly-opened panel from shuffling everything the user
 * arranged.
 */
export function reconcileSectionOrder(persisted: readonly string[], allKeys: readonly string[]) {
  const exists = new Set(allKeys);
  const out: string[] = [];
  const seen = new Set<string>();
  // Deduped, not just filtered: a repeated key in a hand-edited or
  // half-written localStorage value would otherwise render the same section
  // twice, which is a duplicate React key, two dnd-kit items sharing an id, and
  // two resizable panels sharing an id.
  for (const k of persisted) {
    if (!exists.has(k) || seen.has(k)) continue;
    out.push(k);
    seen.add(k);
  }
  for (const k of allKeys) {
    if (seen.has(k)) continue;
    out.push(k);
    seen.add(k);
  }
  return out;
}
