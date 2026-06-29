import { toForwardSlash } from "@/lib/path";

const MEMORY_RELATED_EVENT = "tedi:ai-memory-related-path-changed";

function normalize(path: string): string {
  return toForwardSlash(path).replace(/\/$/, "").toLowerCase();
}

export function isMemoryRelatedPath(path: string): boolean {
  const normalized = normalize(path);
  return normalized.endsWith("/tedi.md") || normalized.includes("/.tedi/memory/");
}

export function notifyMemoryPathChanged(path: string): void {
  if (!isMemoryRelatedPath(path) || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string>(MEMORY_RELATED_EVENT, {
      detail: normalize(path),
    }),
  );
}

export function subscribeMemoryPathChanges(onChange: (path: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === "string" && detail.length > 0) onChange(detail);
  };
  window.addEventListener(MEMORY_RELATED_EVENT, handler);
  return () => window.removeEventListener(MEMORY_RELATED_EVENT, handler);
}
