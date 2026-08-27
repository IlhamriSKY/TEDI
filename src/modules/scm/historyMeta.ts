/**
 * Pure presentation helpers for the history graph. Kept out of
 * `GitGraphView.tsx` for the same reason `statusMeta.ts` exists: a component
 * file that also exports plain functions is harder to reason about, and
 * `scripts/scm/scm-ops-verify.ts` can import these without pulling React in.
 */

/** Local-day bucket. `toDateString` is already local and stable, so it groups
 *  the way the user's calendar does rather than by UTC. */
export function dayKey(unix: number): string {
  return new Date(unix * 1000).toDateString();
}

/**
 * Heading for a day separator. Replaces the per-row "7d ago", which repeated
 * itself down the whole list and said less: the date lives here once, and each
 * row is then free to show its exact clock time.
 */
export function dayLabel(unix: number, now = new Date()): string {
  const d = new Date(unix * 1000);
  const key = d.toDateString();
  if (key === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    // The year only when it is not the current one: "2026" on every row of a
    // repo whose history is a few months long is pure noise.
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * "3d ago". Only the hover peek uses it now: on the rows themselves it
 * repeated the same string a dozen times in a row, which is exactly what the
 * day separators replaced.
 */
export function formatRelTime(unix: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - unix);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)}d ago`;
  if (diff < 86_400 * 365) return `${Math.floor(diff / (86_400 * 30))}mo ago`;
  return `${Math.floor(diff / (86_400 * 365))}y ago`;
}

/** Clock time for a row. Unambiguous because the day is in the separator above. */
export function formatClock(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The exact stamp the row has no width for; the row only shows the clock. */
export function formatAbsTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Up to two letters for the author dot. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] ?? "") + (parts[parts.length - 1][0] ?? "")).toUpperCase();
}

/**
 * Stable hue for an author, so the same person keeps the same dot colour in
 * every repo and across restarts. Replaces the author NAME column, which was
 * the same string repeated on every row in a single-author repo while eating
 * the width the commit subject needed.
 */
export function authorHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/**
 * Profile picture for a commit author, or null when the email doesn't name a
 * public account. Derived from the GitHub noreply address alone - both the
 * bare `user@` and the newer `1234+user@` form - so it costs no API call, no
 * hashing, and never sends a real email address anywhere. Anything else falls
 * back to the coloured initials dot, which is what the row already drew.
 */
export function githubAvatar(email: string, size = 32): string | null {
  const m = /^(?:(\d+)\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  if (!m) return null;
  // The numeric id survives a username change, so prefer it when present.
  return m[1]
    ? `https://avatars.githubusercontent.com/u/${m[1]}?s=${size}`
    : `https://avatars.githubusercontent.com/${m[2]}?s=${size}`;
}

export type RefChip = { label: string; kind: "head" | "branch" | "remote" | "tag" };

/**
 * Map git's raw `%D` entries into displayable chips. "HEAD -> main" becomes
 * a "HEAD" chip plus a "main" branch chip so both render distinctly.
 */
export function parseRefs(refs: string[]): RefChip[] {
  const out: RefChip[] = [];
  for (const r of refs) {
    // `origin/HEAD` is a symref pointing at the remote's default branch, so it
    // is always a duplicate of the `origin/<default>` chip sitting next to it.
    // Dropping it removes a whole badge from the busiest row in the history.
    if (r.endsWith("/HEAD")) continue;
    if (r.startsWith("HEAD -> ")) {
      out.push({ label: "HEAD", kind: "head" });
      out.push({ label: r.slice("HEAD -> ".length), kind: "branch" });
    } else if (r === "HEAD") {
      out.push({ label: "HEAD", kind: "head" });
    } else if (r.startsWith("tag: ")) {
      out.push({ label: r.slice("tag: ".length), kind: "tag" });
    } else if (r.includes("/")) {
      out.push({ label: r, kind: "remote" });
    } else {
      out.push({ label: r, kind: "branch" });
    }
  }
  // A remote ref sitting on the same commit as its local branch says nothing
  // the branch chip doesn't - they are in sync by definition, or git would
  // have listed them on different commits. Same reasoning as the `*/HEAD` drop
  // above, and it's what made the row overflow: `origin/feat/x` beside
  // `feat/x` is one long label twice.
  const branches = new Set(out.filter((c) => c.kind === "branch").map((c) => c.label));
  return out.filter((c) => !(c.kind === "remote" && branches.has(c.label.replace(/^[^/]+\//, ""))));
}
