import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Index of the last element matching `pred`, or -1. Hand-rolled because the
 *  native `Array.prototype.findLastIndex` needs ES2023 and the lib target is
 *  ES2022. */
export function findLastIndex<T>(arr: readonly T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

/** Case-insensitive substring match of `q` across an item's id/label/hint.
 *  Shared by the model + prompt search pickers. */
export function matchesQuery(m: { id: string; label: string; hint: string }, q: string): boolean {
  if (!q) return true;
  const t = q.toLowerCase();
  return (
    m.id.toLowerCase().includes(t) ||
    m.label.toLowerCase().includes(t) ||
    m.hint.toLowerCase().includes(t)
  );
}

/** Mask a secret for display: dots-only when <= 8 chars, else first 4 + 8 dots + last 4. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(8)}${key.slice(-4)}`;
}

/** Lowercase, hyphenate runs of non-alphanumerics, trim leading/trailing
 *  hyphens. Returns `fallback` (default "") when the result is empty. */
export function slugify(name: string, fallback = ""): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

/** Escapes user input so it matches as a literal substring, not a regex. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
