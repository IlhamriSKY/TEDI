import { useEffect, useRef, useState } from "react";
import { native } from "../lib/native";
import { useChatStore, type OpenEditorFile } from "../store/chatStore";
import type { MentionItem } from "../components/MentionPicker";

export type { MentionItem };

const MAX_FILES = 40;
const MAX_FOLDERS = 8;
const SEARCH_DEBOUNCE_MS = 150;
/** Hard cap on candidate count before client-side fuzzy ranking. The Rust
 *  `glob` walker is cheap, but pulling thousands of paths over IPC for each
 *  keystroke adds up. 300 keeps ranking quality high while halving the
 *  per-keystroke IPC payload vs. the older 600. */
const GLOB_CAP = 300;

type State = {
  items: MentionItem[];
  loading: boolean;
};

function basename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i === -1 ? norm : norm.slice(i + 1);
}

function relativize(abs: string, root: string | null): string {
  if (!root) return abs;
  const a = abs.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (!r) return a;
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : a;
}

/** Tiny fuzzy score: prefix-of-basename wins, then substring-of-basename,
 *  then substring-of-rel-path. Lower score == better. -1 means no match. */
function fuzzyScore(query: string, name: string, rel: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  const r = rel.toLowerCase();
  if (n.startsWith(q)) return 0;
  const nIdx = n.indexOf(q);
  if (nIdx !== -1) return 10 + nIdx;
  const rIdx = r.indexOf(q);
  if (rIdx !== -1) return 100 + rIdx;
  return -1;
}

export function useMentionSearch(opts: {
  active: boolean;
  query: string;
  openFiles: OpenEditorFile[];
}): State {
  const [state, setState] = useState<State>({ items: [], loading: false });
  const reqRef = useRef(0);

  // Stabilize the openFiles dependency: the parent recreates the array on
  // every render even when the underlying paths haven't changed, which used
  // to re-fire the effect (and re-issue two workspace-wide globs) on every
  // unrelated re-render. A primitive string dep makes React's Object.is
  // comparison cheap and content-accurate.
  const openFilesKey = opts.openFiles.map((f) => `${f.path}${f.name}`).join("\n");
  const openFilesRef = useRef(opts.openFiles);
  openFilesRef.current = opts.openFiles;

  useEffect(() => {
    if (!opts.active) {
      setState({ items: [], loading: false });
      return;
    }
    const reqId = ++reqRef.current;
    const workspaceRoot = useChatStore.getState().live.getWorkspaceRoot();
    const q = opts.query.trim();
    const openFiles = openFilesRef.current;

    // Open editor tabs render instantly on first frame so the picker has
    // something to show while the workspace glob is in flight.
    const openItems: MentionItem[] = openFiles
      .filter((f) => !q || fuzzyScore(q, f.name, relativize(f.path, workspaceRoot)) !== -1)
      .map((f) => ({
        kind: "file",
        path: f.path,
        rel: relativize(f.path, workspaceRoot),
        name: f.name,
        open: true,
      }));

    setState({ items: openItems, loading: !!workspaceRoot });

    if (!workspaceRoot) return;

    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const [filesRes, foldersRes] = await Promise.all([
          native.glob({ pattern: "**/*", root: workspaceRoot, maxResults: GLOB_CAP }),
          native.glob({ pattern: "**/", root: workspaceRoot, maxResults: GLOB_CAP }),
        ]);
        if (cancelled || reqRef.current !== reqId) return;

        const seenOpen = new Set(openFiles.map((f) => f.path));

        const ranked: { item: MentionItem; score: number }[] = [];
        for (const hit of filesRes.hits) {
          if (seenOpen.has(hit.path)) continue;
          const name = basename(hit.path);
          const score = fuzzyScore(q, name, hit.rel);
          if (score === -1) continue;
          ranked.push({
            item: { kind: "file", path: hit.path, rel: hit.rel, name, open: false },
            score,
          });
        }
        ranked.sort((a, b) => a.score - b.score);
        const fileItems = ranked.slice(0, MAX_FILES).map((r) => r.item);

        const folderRanked: { item: MentionItem; score: number }[] = [];
        for (const hit of foldersRes.hits) {
          const name = basename(hit.path);
          const score = fuzzyScore(q, name, hit.rel);
          if (score === -1) continue;
          folderRanked.push({
            item: { kind: "folder", path: hit.path, rel: hit.rel, name },
            score,
          });
        }
        folderRanked.sort((a, b) => a.score - b.score);
        const folderItems = folderRanked.slice(0, MAX_FOLDERS).map((r) => r.item);

        if (cancelled || reqRef.current !== reqId) return;
        setState({
          items: [...openItems, ...fileItems, ...folderItems],
          loading: false,
        });
      } catch {
        if (cancelled || reqRef.current !== reqId) return;
        setState({ items: openItems, loading: false });
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // openFilesKey is a content-stable string derived from opts.openFiles so
    // unrelated parent re-renders don't fire the workspace glob. The effect
    // still reads the latest list via openFilesRef inside the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.active, opts.query, openFilesKey]);

  return state;
}
