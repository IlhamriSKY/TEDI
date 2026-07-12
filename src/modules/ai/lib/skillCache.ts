import { createPathChangeBus } from "./pathChangeBus";

// Skill-related paths live under a `.tedi/skills/` directory anywhere in the tree.
const bus = createPathChangeBus("tedi:ai-skill-path-changed", (p) => p.includes("/.tedi/skills/"));

export const isSkillRelatedPath = bus.isRelated;
export const notifySkillPathChanged = bus.notify;
export const subscribeSkillPathChanges = bus.subscribe;
