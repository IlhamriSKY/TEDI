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
import { gitFileHead, type FileReadResult } from "./api";

type Props = {
  path: string;
  relative: string;
  repoPath: string;
  changeStatus: GitChangeStatusTab;
  /** Bumps to force re-read of HEAD and working-tree content. */
  reloadKey: number;
};

const EMPTY_TEXT: FileReadResult = { kind: "text", content: "", size: 0 };

async function readFileFull(path: string): Promise<FileReadResult> {
  try {
    return await invoke<FileReadResult>("fs_read_file", { path });
  } catch {
    return EMPTY_TEXT;
  }
}

/** True when the entry can't be rendered as a text MergeView. */
function isNonText(r: FileReadResult): boolean {
  return r.kind !== "text";
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
    orig: FileReadResult;
    curr: FileReadResult;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load HEAD + working-tree content whenever the target or reloadKey changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadOriginal: Promise<FileReadResult> =
      changeStatus === "untracked" || changeStatus === "added"
        ? Promise.resolve(EMPTY_TEXT)
        : gitFileHead(repoPath, relative).catch(() => EMPTY_TEXT);

    const loadCurrent: Promise<FileReadResult> =
      changeStatus === "deleted" ? Promise.resolve(EMPTY_TEXT) : readFileFull(path);

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

  const nonText = useMemo(() => {
    if (!content) return false;
    return isNonText(content.orig) || isNonText(content.curr);
  }, [content]);

  // Construct/refresh the MergeView when content or theme changes — but only
  // when both sides are plain text. Image / binary blobs are rendered by
  // <NonTextDiff/> instead and must NOT initialize the MergeView (CodeMirror
  // would otherwise try to render a base64 blob as code).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !content || nonText) return;
    const origText = content.orig.kind === "text" ? content.orig.content : "";
    const currText = content.curr.kind === "text" ? content.curr.content : "";

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
        doc: origText,
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
        doc: currText,
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
  }, [content, nonText, themeExt, path, langA, langB]);

  const stats = useMemo(() => {
    if (!content || nonText) return { added: 0, removed: 0 };
    const a = content.orig.kind === "text" ? content.orig.content : "";
    const b = content.curr.kind === "text" ? content.curr.content : "";
    return computeLineStats(a, b);
  }, [content, nonText]);

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
          {!loading && !error && !nonText ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
              <span className="text-rose-600 dark:text-rose-400">−{stats.removed}</span>
            </span>
          ) : null}
          {!loading && !error && nonText ? (
            <span className="text-muted-foreground shrink-0 text-[10.5px]">
              {content?.orig.kind === "image" || content?.curr.kind === "image"
                ? "image"
                : "binary"}
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
        ) : nonText && content ? (
          <NonTextDiff orig={content.orig} curr={content.curr} />
        ) : (
          <div ref={hostRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Side-by-side pane for files the MergeView can't render: images and binary
 *  blobs. Each half mirrors the HEAD/Working-tree split of the text diff so
 *  the layout reads the same. An empty `Text` blob (size 0) means "absent
 *  on this side" — we render a muted placeholder instead of a blank square. */
function NonTextDiff({ orig, curr }: { orig: FileReadResult; curr: FileReadResult }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 divide-x">
      <NonTextSide side={orig} emptyLabel="No HEAD version" />
      <NonTextSide side={curr} emptyLabel="No working-tree file" />
    </div>
  );
}

function NonTextSide({ side, emptyLabel }: { side: FileReadResult; emptyLabel: string }) {
  // Empty `Text` is how we signal "this side doesn't exist" for added /
  // deleted entries — show the placeholder instead of a blank pane.
  if (side.kind === "text" && side.size === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-[11px]">
        {emptyLabel}
      </div>
    );
  }
  if (side.kind === "image") {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-3">
        <div className="border-border/60 bg-accent/20 flex max-h-full max-w-full items-center justify-center overflow-auto rounded border p-2">
          <img
            src={side.dataUrl}
            alt=""
            className="max-h-full max-w-full object-contain"
            style={{ imageRendering: "pixelated" }}
          />
        </div>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {side.mime} · {formatBytes(side.size)}
        </span>
      </div>
    );
  }
  if (side.kind === "toolarge") {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-[11px]">
        <span>File too large to preview</span>
        <span className="text-[10px] tabular-nums">
          {formatBytes(side.size)} (limit {formatBytes(side.limit)})
        </span>
      </div>
    );
  }
  // Two cases land here:
  //   - this side is binary (most common — paired with an image on the other)
  //   - this side is non-empty text paired with a binary on the other side
  //     (rare: a file flipped between text and binary across HEAD/working-tree)
  const label = side.kind === "binary" ? "Binary file" : "Text (paired with binary)";
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-[11px]">
      <span>{label} — diff not shown</span>
      <span className="text-[10px] tabular-nums">{formatBytes(side.size)}</span>
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
