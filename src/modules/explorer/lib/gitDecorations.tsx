import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { gitIgnored, gitStatus } from "@/modules/scm/api";
import type { GitChangeStatus, GitStatus } from "@/modules/scm/types";
import { FS_REFRESH_EVENT } from "./useFileTree";
import { coalesceResume } from "@/lib/windowResume";

/** Poll cadence for git status while the window is focused. Mirrors the
 *  Source Control panel so explorer decorations stay in step with that view. */
const GIT_STATUS_POLL_MS = 2500;

/** Single letter shown at the right edge of a changed file row (VSCode-style).
 *  Keep in sync with scm/components/ChangeRow.tsx. */
const STATUS_LETTER: Record<GitChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  conflicted: "!",
  ignored: "I",
};

/** Theme-token text color per status. Keep in sync with scm ChangeRow so the
 *  explorer badge color matches the Source Control panel exactly. */
const STATUS_TONE: Record<GitChangeStatus, string> = {
  modified: "text-icon-working",
  added: "text-diff-added",
  deleted: "text-diff-removed",
  renamed: "text-info",
  copied: "text-info",
  untracked: "text-diff-added",
  conflicted: "text-destructive",
  ignored: "text-muted-foreground",
};

/** Lower rank wins when a file (or a folder rolling up its descendants) carries
 *  several statuses - conflicts and modifications outrank fresh/untracked. */
const STATUS_RANK: Record<GitChangeStatus, number> = {
  conflicted: 0,
  modified: 1,
  renamed: 2,
  copied: 3,
  deleted: 4,
  added: 5,
  untracked: 6,
  ignored: 7,
};

export type GitDeco = { status: GitChangeStatus; letter: string; tone: string };

/** Decoration for a single row: a tracked-change badge and/or an ignored flag.
 *  The two are mutually exclusive in practice (git never lists an ignored file
 *  as a change), but kept separate so the renderer stays simple. */
export type RowDeco = { deco: GitDeco | null; ignored: boolean };

/** What the poller produces and the provider consumes. */
export type GitDecorationData = { status: GitStatus | null; ignored: string[] };

const EMPTY_DATA: GitDecorationData = { status: null, ignored: [] };

type Decorations = {
  file: (absPath: string) => GitDeco | null;
  folder: (absPath: string) => GitDeco | null;
  isIgnored: (absPath: string) => boolean;
};

const EMPTY_DECORATIONS: Decorations = {
  file: () => null,
  folder: () => null,
  isIgnored: () => false,
};

const GitDecorationsContext = createContext<Decorations>(EMPTY_DECORATIONS);

/** Lowercase so git's `--show-toplevel` casing (used to build change paths)
 *  matches the explorer's frontend root casing on Windows. Forward-slash form
 *  is already canonical on both sides. */
function norm(p: string): string {
  return p.toLowerCase();
}

function higher(
  current: GitChangeStatus | undefined,
  next: GitChangeStatus,
): GitChangeStatus {
  if (!current) return next;
  return STATUS_RANK[next] < STATUS_RANK[current] ? next : current;
}

/** Build O(1)-ish file/folder/ignored lookups from a git decoration payload.
 *  Folder status rolls up from changed descendants and stops at `rootPath`;
 *  ignored matching treats each entry as a prefix so a collapsed ignored
 *  directory (e.g. `node_modules`) also dims its contents when expanded. */
export function buildDecorations(
  data: GitDecorationData,
  rootPath: string | null,
): Decorations {
  if (!rootPath) return EMPTY_DECORATIONS;
  const rootNorm = norm(rootPath).replace(/\/+$/, "");
  const files = new Map<string, GitChangeStatus>();
  const folders = new Map<string, GitChangeStatus>();

  const { status, ignored } = data;
  if (status?.isRepo) {
    for (const c of status.changes) {
      // Ignored entries are handled below; don't badge them as a change.
      if (c.status === "ignored") continue;
      const abs = norm(c.path);
      // Only decorate entries inside this explorer root: the repo root may sit
      // above it and carry changes in sibling trees we never render.
      if (abs !== rootNorm && !abs.startsWith(rootNorm + "/")) continue;
      files.set(abs, higher(files.get(abs), c.status));
      // Roll the status up through every ancestor folder that is an actual row
      // (strictly under the explorer root).
      let slash = abs.lastIndexOf("/");
      while (slash > rootNorm.length) {
        const dir = abs.slice(0, slash);
        folders.set(dir, higher(folders.get(dir), c.status));
        slash = dir.lastIndexOf("/");
      }
    }
  }

  // Ignored set: keep only entries under this explorer root. Each entry doubles
  // as a prefix so descendants of an ignored directory dim too.
  const ignoredExact = new Set<string>();
  const ignoredPrefixes: string[] = [];
  for (const raw of ignored) {
    const e = norm(raw).replace(/\/+$/, "");
    if (e !== rootNorm && !e.startsWith(rootNorm + "/")) continue;
    ignoredExact.add(e);
    ignoredPrefixes.push(e + "/");
  }
  const isIgnored = (p: string): boolean => {
    const q = norm(p);
    if (ignoredExact.has(q)) return true;
    for (const prefix of ignoredPrefixes) {
      if (q.startsWith(prefix)) return true;
    }
    return false;
  };

  const toDeco = (s: GitChangeStatus | undefined): GitDeco | null =>
    s ? { status: s, letter: STATUS_LETTER[s], tone: STATUS_TONE[s] } : null;

  return {
    file: (p) => toDeco(files.get(norm(p))),
    folder: (p) => toDeco(folders.get(norm(p))),
    isIgnored,
  };
}

function sameStatus(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.isRepo !== b.isRepo || a.root !== b.root) return false;
  if (a.changes.length !== b.changes.length) return false;
  for (let i = 0; i < a.changes.length; i++) {
    const x = a.changes[i];
    const y = b.changes[i];
    if (x.path !== y.path || x.status !== y.status || x.staged !== y.staged) {
      return false;
    }
  }
  return true;
}

function sameData(a: GitDecorationData, b: GitDecorationData): boolean {
  if (a === b) return true;
  if (!sameStatus(a.status, b.status)) return false;
  if (a.ignored.length !== b.ignored.length) return false;
  for (let i = 0; i < a.ignored.length; i++) {
    if (a.ignored[i] !== b.ignored[i]) return false;
  }
  return true;
}

/** Polls `git status` + the ignored-file list for `rootPath` (or empty data
 *  outside a repo). Mirrors the Source Control panel's focus/visibility/idle
 *  polling and also refreshes immediately on the explorer's FS-refresh event,
 *  so decorations update right after edits, saves, or AI writes. Returns a
 *  referentially-stable object while nothing changed so the memoized tree
 *  doesn't repaint on every poll tick. */
export function useGitStatusPoll(rootPath: string | null): GitDecorationData {
  const [data, setData] = useState<GitDecorationData>(EMPTY_DATA);
  const rootRef = useRef(rootPath);
  rootRef.current = rootPath;
  const inFlight = useRef(false);

  useEffect(() => {
    if (!rootPath) {
      setData(EMPTY_DATA);
      return;
    }
    // New root: drop stale decorations until the first fetch lands.
    setData(EMPTY_DATA);

    let cancelled = false;
    const fetchNow = async () => {
      const cur = rootRef.current;
      if (!cur || inFlight.current) return;
      inFlight.current = true;
      try {
        const [status, ignored] = await Promise.all([gitStatus(cur), gitIgnored(cur)]);
        if (cancelled || rootRef.current !== cur) return;
        const next: GitDecorationData = { status, ignored };
        setData((prev) => (sameData(prev, next) ? prev : next));
      } catch {
        // Not a repo / git missing: leave decorations empty, keep polling.
      } finally {
        inFlight.current = false;
      }
    };

    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        if (document.visibilityState === "visible") void fetchNow();
      }, GIT_STATUS_POLL_MS);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    // Both events fire on a return from lock; one coalescer between them
    // stops the panel doing its whole refresh twice.
    const refreshOnResume = coalesceResume(() => void fetchNow());
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshOnResume();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => {
      refreshOnResume();
      start();
    };
    const onBlur = () => stop();
    const onFsRefresh = () => void fetchNow();

    void fetchNow();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener(FS_REFRESH_EVENT, onFsRefresh as EventListener);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener(FS_REFRESH_EVENT, onFsRefresh as EventListener);
    };
  }, [rootPath]);

  return data;
}

export function GitDecorationsProvider({
  data,
  rootPath,
  children,
}: {
  data: GitDecorationData;
  rootPath: string | null;
  children: React.ReactNode;
}) {
  const value = useMemo(() => buildDecorations(data, rootPath), [data, rootPath]);
  return (
    <GitDecorationsContext.Provider value={value}>{children}</GitDecorationsContext.Provider>
  );
}

/** Git decoration for a single tree row: a tracked-change badge (`deco`) and/or
 *  an `ignored` flag. Reads the nearest provider. */
export function useGitDecoration(absPath: string, isDir: boolean): RowDeco {
  const ctx = useContext(GitDecorationsContext);
  return {
    deco: isDir ? ctx.folder(absPath) : ctx.file(absPath),
    ignored: ctx.isIgnored(absPath),
  };
}
