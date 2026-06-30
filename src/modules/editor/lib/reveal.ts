// Reveal bus: the find-in-files panel (or anything else) asks the editor to
// jump to and highlight a specific line of a file. Kept separate from the
// tab/leaf plumbing so we don't thread a line number through every open-file
// signature. Keyed by absolute path; the matching EditorPane consumes its
// target once its CodeMirror view is mounted (file just opened) or immediately
// via the listener (file already open).

export type RevealTarget = {
  /** 1-indexed line, as grep/ripgrep reports it. */
  line: number;
  /** Search term used to find the hit, so the editor can select the exact
   *  match within the line instead of the whole line. Optional. */
  needle?: string;
  useRegex?: boolean;
  caseInsensitive?: boolean;
};

const pending = new Map<string, RevealTarget>();
const listeners = new Set<(path: string) => void>();

export function requestReveal(path: string, target: RevealTarget): void {
  pending.set(path, target);
  for (const fn of listeners) fn(path);
}

/** Pull and clear the pending target for `path` (if any). */
export function takeReveal(path: string): RevealTarget | null {
  const t = pending.get(path);
  if (t) pending.delete(path);
  return t ?? null;
}

export function onReveal(fn: (path: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
