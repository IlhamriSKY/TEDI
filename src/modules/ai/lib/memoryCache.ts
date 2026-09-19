import { createPathChangeBus } from "./pathChangeBus";
import { projectMemoryRootOf } from "./projectMemory";

// Memory-related paths are the workspace-root memory docs (`PROJECT_MEMORY_FILES`,
// so this cannot fall out of step with what is actually preloaded) or anything
// under `.tedi/memory/`.
const bus = createPathChangeBus(
  "tedi:ai-memory-related-path-changed",
  (p) => projectMemoryRootOf(p) !== null || p.includes("/.tedi/memory/"),
);

export const notifyMemoryPathChanged = bus.notify;
export const subscribeMemoryPathChanges = bus.subscribe;
