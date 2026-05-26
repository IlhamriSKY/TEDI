/**
 * Lazy access to the `@hugeicons/core-free-icons` barrel for runtime
 * name-based lookups (extension tab icons, contributed header items,
 * `ext.icon()`).
 *
 * Named imports in JSX (e.g. `import { BookOpenIcon } from
 * "@hugeicons/core-free-icons"`) keep their tree-shaken path and stay in
 * the eager main chunk. Only the dynamic-name paths route through here, so
 * the rest of the barrel becomes its own Rollup chunk that loads in
 * parallel with the main bundle.
 *
 * Lookups are sync with a null fallback: callers render a placeholder on
 * first paint (chunk in flight) and swap to the real icon once the chunk
 * lands. `useHugeIconsReady` / `onHugeIconsReady` give consumers a re-render
 * trigger.
 */
import { useEffect, useState } from "react";
import type { IconSvgElement } from "@hugeicons/react";

type Barrel = Record<string, IconSvgElement | undefined>;

let cache: Barrel | null = null;
let loadPromise: Promise<Barrel> | null = null;
const subscribers = new Set<() => void>();

function startLoad(): Promise<Barrel> {
  if (!loadPromise) {
    loadPromise = import("@hugeicons/core-free-icons")
      .then((m) => {
        const barrel = m as unknown as Barrel;
        cache = barrel;
        // Snapshot then clear so notify handlers that resubscribe (rare)
        // don't fire twice.
        const snapshot = Array.from(subscribers);
        subscribers.clear();
        for (const fn of snapshot) {
          try {
            fn();
          } catch (err) {
            console.error("hugeIconsBarrel: notify subscriber failed", err);
          }
        }
        return barrel;
      })
      .catch((err) => {
        // Reset so a future retry can attempt the import again. Unlikely
        // path; only triggers if the chunk fetch fails (corrupt asset, etc.).
        loadPromise = null;
        console.error("hugeIconsBarrel: failed to load barrel", err);
        throw err;
      });
  }
  return loadPromise;
}

/**
 * Sync lookup. Returns `null` until the chunk loads, kicking off the load
 * on the first call. Callers should render a fallback for the null case and
 * subscribe to `useHugeIconsReady` (in React) or `onHugeIconsReady` (in
 * non-React code) to re-render once the chunk arrives.
 */
export function tryGetHugeIcon(name: string): IconSvgElement | null {
  if (!cache) {
    void startLoad();
    return null;
  }
  return cache[name] ?? null;
}

/**
 * Subscribe to a one-shot ready signal that fires when the barrel finishes
 * loading. If the barrel is already loaded, fires synchronously and returns
 * a no-op unsubscriber. Otherwise queues the callback and triggers the load.
 */
export function onHugeIconsReady(fn: () => void): () => void {
  if (cache) {
    fn();
    return () => {};
  }
  subscribers.add(fn);
  void startLoad();
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * React hook returning `true` once the barrel has loaded. Components that
 * call `tryGetHugeIcon` should depend on this so their JSX re-renders with
 * the real icon when the chunk arrives.
 */
export function useHugeIconsReady(): boolean {
  const [ready, setReady] = useState<boolean>(() => cache !== null);
  useEffect(() => {
    if (ready) return;
    return onHugeIconsReady(() => setReady(true));
  }, [ready]);
  return ready;
}
