import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
// app. MergeView height/scroll wiring (per-pane scroll, both axes) lives in
// `globals.css` (.cm-mergeView). EditorView.theme selectors are scoped to
// .cm-editor and can't reach the outer .cm-mergeView wrapper, so it has to
// be plain stylesheet rules.
const DIFF_THEME = EditorView.theme({
  ".cm-changedText": {
    background: "#88ff881a !important",
  },
});

// One tick on the overview ruler. `total` is the doc's total line count for
// the pane that owns this mark — used to map the line range to a top% /
// height% inside the ruler container. `jumpTo` scrolls the owning pane to
// the start line (the merge view's scroll sync drags the other pane along).
type RulerMark = {
  key: string;
  startLine: number;
  endLine: number;
  total: number;
  kind: "added" | "removed";
  jumpTo: () => void;
};

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

  // Overview-ruler state. The marks are derived from the diff once the
  // MergeView mounts; the pane refs + ruler widths drive the portal target
  // and the absolute width matching the native scrollbar. All set together
  // inside the MergeView effect and cleared on teardown.
  const [marksA, setMarksA] = useState<RulerMark[]>([]);
  const [marksB, setMarksB] = useState<RulerMark[]>([]);
  const [paneAEl, setPaneAEl] = useState<HTMLElement | null>(null);
  const [paneBEl, setPaneBEl] = useState<HTMLElement | null>(null);
  const [rulerWidthA, setRulerWidthA] = useState(0);
  const [rulerWidthB, setRulerWidthB] = useState(0);

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

  // Construct/refresh the MergeView when content or theme changes - but only
  // when both sides are plain text. Image / binary blobs are rendered by
  // <NonTextDiff/> instead and must NOT initialize the MergeView (CodeMirror
  // would otherwise try to render a base64 blob as code).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !content || nonText) return;
    const origText = content.orig.kind === "text" ? content.orig.content : "";
    const currText = content.curr.kind === "text" ? content.curr.content : "";

    // Tear down any previous instance - MergeView is imperative.
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

    // The merge package's default layout (outer .cm-mergeView scrolls; each
    // pane has height: auto) hides the horizontal scrollbar below the viewport
    // for any non-trivial file. globals.css flips this to per-pane scrolling,
    // which means the two panes no longer share a scrollTop automatically.
    // Reattach a 1:1 vertical sync here — we mirror scroll position rather
    // than chunk-aligned positions because both editors render the full
    // document (no `collapseUnchanged`), so equal pixel offsets keep matching
    // lines side-by-side.
    const scrollA = view.a.scrollDOM;
    const scrollB = view.b.scrollDOM;
    let syncing = false;
    const sync = (from: HTMLElement, to: HTMLElement) => () => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      // requestAnimationFrame avoids the recursive event ping-pong without
      // dropping legitimate user scrolls on either pane.
      requestAnimationFrame(() => {
        syncing = false;
      });
    };
    const syncAB = sync(scrollA, scrollB);
    const syncBA = sync(scrollB, scrollA);
    scrollA.addEventListener("scroll", syncAB, { passive: true });
    scrollB.addEventListener("scroll", syncBA, { passive: true });

    // Overview ruler data: compute mark ranges once per content load. We
    // render them via React/portal below (not imperatively here) so each
    // mark can use the styled <Tooltip/> component instead of the native
    // browser `title=` popover.
    const docA = view.a.state.doc;
    const docB = view.b.state.doc;
    const totalA = Math.max(docA.lines, 1);
    const totalB = Math.max(docB.lines, 1);
    const chunks = presentableDiff(docA.toString(), docB.toString());
    const newMarksA: RulerMark[] = [];
    const newMarksB: RulerMark[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.toA > c.fromA) {
        const startLine = docA.lineAt(c.fromA).number;
        const endLine = docA.lineAt(Math.max(c.fromA, c.toA - 1)).number;
        newMarksA.push({
          key: `a-${i}-${startLine}-${endLine}`,
          startLine,
          endLine,
          total: totalA,
          kind: "removed",
          jumpTo: () => {
            const pos = view.a.state.doc.line(startLine).from;
            view.a.dispatch({
              effects: EditorView.scrollIntoView(pos, { y: "center" }),
            });
          },
        });
      }
      if (c.toB > c.fromB) {
        const startLine = docB.lineAt(c.fromB).number;
        const endLine = docB.lineAt(Math.max(c.fromB, c.toB - 1)).number;
        newMarksB.push({
          key: `b-${i}-${startLine}-${endLine}`,
          startLine,
          endLine,
          total: totalB,
          kind: "added",
          jumpTo: () => {
            const pos = view.b.state.doc.line(startLine).from;
            view.b.dispatch({
              effects: EditorView.scrollIntoView(pos, { y: "center" }),
            });
          },
        });
      }
    }
    setMarksA(newMarksA);
    setMarksB(newMarksB);

    // Mount points for the React-rendered ruler portals. They sit on the
    // .cm-mergeViewEditor wrappers (anchored via position:relative in
    // globals.css) so the absolute ruler lines up with the scrollbar.
    const wrapperA = view.a.dom.parentElement as HTMLElement | null;
    const wrapperB = view.b.dom.parentElement as HTMLElement | null;
    setPaneAEl(wrapperA);
    setPaneBEl(wrapperB);

    // Track each pane's native scrollbar width. The ruler width follows it
    // exactly (so the ticks live inside the scrollbar track like VSCode's
    // overview ruler); width: 0 hides the ruler when there's no scrollbar.
    // ResizeObserver keeps this synced as content grows/shrinks or chrome
    // mode toggles between borderless (10px) and native (~14px).
    const syncRulerWidth = () => {
      setRulerWidthA(scrollA.offsetWidth - scrollA.clientWidth);
      setRulerWidthB(scrollB.offsetWidth - scrollB.clientWidth);
    };
    syncRulerWidth();
    const ro = new ResizeObserver(syncRulerWidth);
    ro.observe(scrollA);
    ro.observe(scrollB);

    // Resolve language asynchronously and reconfigure both sides.
    let cancelled = false;
    resolveLanguage(path).then((ext) => {
      if (cancelled) return;
      view.a.dispatch({ effects: langA.reconfigure(ext ?? []) });
      view.b.dispatch({ effects: langB.reconfigure(ext ?? []) });
    });

    return () => {
      cancelled = true;
      scrollA.removeEventListener("scroll", syncAB);
      scrollB.removeEventListener("scroll", syncBA);
      ro.disconnect();
      setPaneAEl(null);
      setPaneBEl(null);
      setMarksA([]);
      setMarksB([]);
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
      {paneAEl
        ? createPortal(<DiffRuler width={rulerWidthA} marks={marksA} />, paneAEl)
        : null}
      {paneBEl
        ? createPortal(<DiffRuler width={rulerWidthB} marks={marksB} />, paneBEl)
        : null}
    </div>
  );
}

/** React-rendered overview ruler. Each mark is wrapped in the project's
 *  styled <Tooltip/> so hover labels look the same as every other tooltip
 *  in the app, instead of the native browser `title=` popover. The ruler
 *  itself sits absolute against `.cm-mergeViewEditor` (the portal target)
 *  with its width tracking the live scrollbar width. */
function DiffRuler({ width, marks }: { width: number; marks: RulerMark[] }) {
  if (width <= 0 || marks.length === 0) return null;
  return (
    <div className="diff-ruler" style={{ width: `${width}px`, right: `${width}px` }}>
      {marks.map((m) => {
        const topPct = ((m.startLine - 1) / m.total) * 100;
        const heightPct = ((m.endLine - m.startLine + 1) / m.total) * 100;
        const label =
          m.startLine === m.endLine
            ? `Line ${m.startLine} (${m.kind})`
            : `Lines ${m.startLine}–${m.endLine} (${m.kind})`;
        return (
          <Tooltip key={m.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={m.jumpTo}
                aria-label={label}
                className={`diff-ruler-mark diff-ruler-${m.kind}`}
                style={{
                  top: `${topPct}%`,
                  height: `max(2px, ${heightPct}%)`,
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="left">{label}</TooltipContent>
          </Tooltip>
        );
      })}
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
 *  on this side" - we render a muted placeholder instead of a blank square. */
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
  // deleted entries - show the placeholder instead of a blank pane.
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
  //   - this side is binary (most common - paired with an image on the other)
  //   - this side is non-empty text paired with a binary on the other side
  //     (rare: a file flipped between text and binary across HEAD/working-tree)
  const label = side.kind === "binary" ? "Binary file" : "Text (paired with binary)";
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-[11px]">
      <span>{label} - diff not shown</span>
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
