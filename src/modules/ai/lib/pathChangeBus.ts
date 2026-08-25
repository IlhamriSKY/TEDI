import { toForwardSlash } from "@/lib/path";

/** Canonical form for path comparison: forward slashes, no trailing slash, lowercase. */
function normalizePath(path: string): string {
  return toForwardSlash(path).replace(/\/$/, "").toLowerCase();
}

export type PathChangeBus = {
  /** Broadcast a normalized path change to subscribers, if the path is related. */
  notify: (path: string) => void;
  /** Subscribe to normalized path changes. Returns an unsubscribe. */
  subscribe: (onChange: (path: string) => void) => () => void;
};

/**
 * A window-event bus that fans out normalized path-change notifications for
 * paths matching `isRelated`. One instance per event name; the AI memory and
 * skill caches each build one so the event-bus mechanics live in a single place.
 */
export function createPathChangeBus(
  eventName: string,
  isRelated: (normalized: string) => boolean,
): PathChangeBus {
  const related = (path: string) => isRelated(normalizePath(path));
  return {
    notify(path: string): void {
      if (!related(path) || typeof window === "undefined") return;
      window.dispatchEvent(new CustomEvent<string>(eventName, { detail: normalizePath(path) }));
    },
    subscribe(onChange: (path: string) => void): () => void {
      if (typeof window === "undefined") return () => {};
      const handler = (event: Event) => {
        const detail = (event as CustomEvent<string>).detail;
        if (typeof detail === "string" && detail.length > 0) onChange(detail);
      };
      window.addEventListener(eventName, handler);
      return () => window.removeEventListener(eventName, handler);
    },
  };
}
