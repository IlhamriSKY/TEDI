import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MergeView, presentableDiff } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildSharedExtensions } from "@/modules/editor/lib/extensions";
import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import { loadEditorTheme, tryEditorTheme } from "@/modules/editor/lib/themes";
import type { GitChangeStatusTab } from "@/modules/tabs";
import { gitFileHead } from "./api";

type Props = {
  path: string;
  relative: string;
  repoPath: string;
  changeStatus: GitChangeStatusTab;
  /** Bumps to force re-read of HEAD and working-tree content. */
  reloadKey: number;
};

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

async function readFileText(path: string): Promise<string> {
  try {
    const r = await invoke<ReadResult>("fs_read_file", { path });
    if (r.kind === "text") return r.content;
    return "";
  } catch {
    return "";
  }
}

// Match AiDiffPane's coloring so diff highlighting reads the same across the
// app. MergeView height/scroll wiring lives in `globals.css` (.cm-mergeView):
// EditorView.theme selectors are scoped to .cm-editor and can't reach the
// outer .cm-mergeView wrapper, so it has to be a plain stylesheet rule.
const DIFF_THEME = EditorView.theme({
  ".cm-changedText": {
    background: "#88ff881a !important",
  },
});

const STATUS_VARIANT: Record<
  GitChangeStatusTab,
  "default" | "secondary" | "destructive" | "outline"
> = {
  modified: "secondary",
  added: "default",
  deleted: "destructive",
  renamed: "secondary",
  copied: "outline",
  untracked: "outline",
  conflicted: "destructive",
  ignored: "outline",
};

export function GitDiffPane({ path, relative, repoPath, changeStatus, reloadKey }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const langA = useRef(new Compartment()).current;
  const langB = useRef(new Compartment()).current;

  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const [themeExt, setThemeExt] = useState<Extension | null>(() => tryEditorTheme(editorThemeId));
  useEffect(() => {
    let cancelled = false;
    const cached = tryEditorTheme(editorThemeId);
    if (cached) {
      setThemeExt(cached);
      return () => {
        cancelled = true;
      };
    }
    void loadEditorTheme(editorThemeId).then((ext) => {
      if (!cancelled) setThemeExt(ext);
    });
    return () => {
      cancelled = true;
    };
  }, [editorThemeId]);

  const [content, setContent] = useState<{
    orig: string;
    curr: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load HEAD + working-tree content whenever the target or reloadKey changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadOriginal =
      changeStatus === "untracked" || changeStatus === "added"
        ? Promise.resolve("")
        : gitFileHead(repoPath, relative).catch(() => "");

    const loadCurrent = changeStatus === "deleted" ? Promise.resolve("") : readFileText(path);

    Promise.all([loadOriginal, loadCurrent])
      .then(([orig, curr]) => {
        if (cancelled) return;
        setContent({ orig, curr });
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, relative, path, changeStatus, reloadKey]);

  // Construct/refresh the MergeView when content or theme changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !content) return;

    // Tear down any previous instance — MergeView is imperative.
    mergeRef.current?.destroy();
    mergeRef.current = null;
    host.innerHTML = "";

    // Diff view has its own scrollbars on both sides -- the minimap would only
    // crowd the lane and never get clicked. Full file is rendered (no
    // `collapseUnchanged`) so unchanged context is always visible.
    // `lineNumbers()` goes before `...shared` so the fold-gutter chevron
    // lands to the RIGHT of the line-number column, matching EditorPane.
    const shared = buildSharedExtensions({ showMinimap: false });
    const view = new MergeView({
      a: {
        doc: content.orig,
        extensions: [
          lineNumbers(),
          ...shared,
          themeExt ?? [],
          DIFF_THEME,
          langA.of([]),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: content.curr,
        extensions: [
          lineNumbers(),
          ...shared,
          themeExt ?? [],
          DIFF_THEME,
          langB.of([]),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      parent: host,
      orientation: "a-b",
      highlightChanges: true,
      gutter: true,
      revertControls: undefined,
    });
    mergeRef.current = view;

    // Resolve language asynchronously and reconfigure both sides.
    let cancelled = false;
    resolveLanguage(path).then((ext) => {
      if (cancelled) return;
      view.a.dispatch({ effects: langA.reconfigure(ext ?? []) });
      view.b.dispatch({ effects: langB.reconfigure(ext ?? []) });
    });

    return () => {
      cancelled = true;
      view.destroy();
      if (mergeRef.current === view) mergeRef.current = null;
    };
  }, [content, themeExt, path, langA, langB]);

  const stats = useMemo(() => {
    if (!content) return { added: 0, removed: 0 };
    return computeLineStats(content.orig, content.curr);
  }, [content]);

  const isNewFile = changeStatus === "added" || changeStatus === "untracked";
  const isDeleted = changeStatus === "deleted";

  return (
    <div className="border-border/60 bg-background flex h-full min-h-0 flex-col rounded-md border">
      <div className="border-border/60 flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant={STATUS_VARIANT[changeStatus]}
            className="px-2.5 py-2.5 text-[11px] capitalize"
          >
            {changeStatus}
          </Badge>
          {isNewFile ? (
            <span className="border-border/60 bg-accent/40 text-muted-foreground shrink-0 border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
              New file
            </span>
          ) : null}
          {isDeleted ? (
            <span className="border-border/60 bg-accent/40 text-muted-foreground shrink-0 border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
              Removed
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground truncate font-mono text-[11px]">
                {relative}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{relative}</TooltipContent>
          </Tooltip>
          {!loading && !error ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
              <span className="text-rose-600 dark:text-rose-400">−{stats.removed}</span>
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground/70 flex shrink-0 items-center gap-3 text-[10px] tracking-wide uppercase">
          <span>HEAD</span>
          <span className="text-muted-foreground/30">→</span>
          <span>Working tree</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
            Loading diff…
          </div>
        ) : error ? (
          <div className="text-destructive flex h-full items-center justify-center text-xs">
            {error}
          </div>
        ) : (
          <div ref={hostRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}

function computeLineStats(original: string, proposed: string): { added: number; removed: number } {
  const changes = presentableDiff(original, proposed);
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    removed += countLines(original, c.fromA, c.toA);
    added += countLines(proposed, c.fromB, c.toB);
  }
  return { added, removed };
}

function countLines(doc: string, from: number, to: number): number {
  if (from === to) return 0;
  const slice = doc.slice(from, to);
  // A change spanning N newlines touches N+1 lines, but a trailing newline
  // means the final segment is empty - don't count that as a touched line.
  let n = 1;
  for (let i = 0; i < slice.length; i++) {
    if (slice.charCodeAt(i) === 10) n++;
  }
  if (slice.endsWith("\n")) n--;
  return Math.max(n, 1);
}
