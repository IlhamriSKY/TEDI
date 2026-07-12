import { createPathChangeBus } from "./pathChangeBus";

// Memory-related paths are the root `tedi.md` file or anything under `.tedi/memory/`.
const bus = createPathChangeBus(
  "tedi:ai-memory-related-path-changed",
  (p) => p.endsWith("/tedi.md") || p.includes("/.tedi/memory/"),
);

export const isMemoryRelatedPath = bus.isRelated;
export const notifyMemoryPathChanged = bus.notify;
export const subscribeMemoryPathChanges = bus.subscribe;
