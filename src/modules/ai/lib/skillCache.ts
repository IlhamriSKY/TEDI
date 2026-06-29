import { toForwardSlash } from "@/lib/path";

const SKILL_RELATED_EVENT = "tedi:ai-skill-path-changed";

function normalize(path: string): string {
  return toForwardSlash(path).replace(/\/$/, "").toLowerCase();
}

export function isSkillRelatedPath(path: string): boolean {
  const normalized = normalize(path);
  return normalized.includes("/.tedi/skills/");
}

export function notifySkillPathChanged(path: string): void {
  if (!isSkillRelatedPath(path) || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string>(SKILL_RELATED_EVENT, {
      detail: normalize(path),
    }),
  );
}

export function subscribeSkillPathChanges(onChange: (path: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === "string" && detail.length > 0) onChange(detail);
  };
  window.addEventListener(SKILL_RELATED_EVENT, handler);
  return () => window.removeEventListener(SKILL_RELATED_EVENT, handler);
}
