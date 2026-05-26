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
  /** Bump to force re-read of HEAD and working-tree content. */
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

/** True when the entry isn't plain text. */
function isNonText(r: FileReadResult): boolean {
  return r.kind !== "text";
}

// Match AiDiffPane's diff coloring. MergeView scroll wiring lives in
// `globals.css` (.cm-mergeView); EditorView.theme can't reach the outer wrapper.
// Inline added-text highlight reads from the themable `--tedi-diff-added`
// token so Solarized/Monokai/etc. get their canonical green tint.
const DIFF_THEME = EditorView.theme({
  ".cm-changedText": {
    background: "color-mix(in srgb, var(--tedi-diff-added) 18%, transparent) !important",
  },
});

// One tick on the overview ruler. `total` is the owning pane's line count,
// used to position the mark by percentage. `jumpTo` scrolls that pane to startLine.
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

  // Overview ruler state. Marks derive from the diff after MergeView mounts;
  // pane refs and ruler widths drive the portal target and ruler width.
  const [marksA, setMarksA] = useState<RulerMark[]>([]);
  const [marksB, setMarksB] = useState<RulerMark[]>([]);
  const [paneAEl, setPaneAEl] = useState<HTMLElement | null>(null);
  const [paneBEl, setPaneBEl] = useState<HTMLElement | null>(null);
  const [rulerWidthA, setRulerWidthA] = useState(0);
  const [rulerWidthB, setRulerWidthB] = useState(0);

  // Load HEAD and working-tree content on target or reloadKey change.
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

  // Refresh the MergeView on content or theme change, only for text on both
  // sides. Image and binary blobs go to <NonTextDiff/>.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !content || nonText) return;
    const origText = content.orig.kind === "text" ? content.orig.content : "";
    const currText = content.curr.kind === "text" ? content.curr.content : "";

    // Tear down any previous instance.
    mergeRef.current?.destroy();
    mergeRef.current = null;
    host.innerHTML = "";

    // No minimap (both panes already scroll). Full file rendered so unchanged
    // context is always visible. `lineNumbers()` before `...shared` puts the
    // fold-gutter chevron to the right of line numbers, matching EditorPane.
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

    // globals.css uses per-pane scrolling, so the panes no longer share scrollTop.
    // Reattach a 1:1 vertical sync. Since both panes render the full document,
    // equal pixel offsets keep matching lines side-by-side.
    const scrollA = view.a.scrollDOM;
    const scrollB = view.b.scrollDOM;
    let syncing = false;
    const sync = (from: HTMLElement, to: HTMLElement) => () => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      // rAF clears the guard without dropping legitimate scroll events.
      requestAnimationFrame(() => {
        syncing = false;
      });
    };
    const syncAB = sync(scrollA, scrollB);
    const syncBA = sync(scrollB, scrollA);
    scrollA.addEventListener("scroll", syncAB, { passive: true });
    scrollB.addEventListener("scroll", syncBA, { passive: true });

    // Compute mark ranges once per content load. Rendered via React/portal
    // below so each mark can use the styled <Tooltip/>.
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

    // Portal mount points sit on .cm-mergeViewEditor wrappers (position:relative
    // in globals.css) so the ruler lines up with the scrollbar.
    const wrapperA = view.a.dom.parentElement as HTMLElement | null;
    const wrapperB = view.b.dom.parentElement as HTMLElement | null;
    setPaneAEl(wrapperA);
    setPaneBEl(wrapperB);

    // Ruler width follows the native scrollbar width so ticks sit inside the
    // scrollbar track. ResizeObserver keeps it synced.
    const syncRulerWidth = () => {
      setRulerWidthA(scrollA.offsetWidth - scrollA.clientWidth);
      setRulerWidthB(scrollB.offsetWidth - scrollB.clientWidth);
    };
    syncRulerWidth();
    const ro = new ResizeObserver(syncRulerWidth);
    ro.observe(scrollA);
    ro.observe(scrollB);

    // Resolve language and reconfigure both sides.
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

/** Overview ruler. Marks use the styled <Tooltip/>; the ruler sits absolute against `.cm-mergeViewEditor` with width matching the scrollbar. */
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

/** Side-by-side pane for images and binary blobs. Empty text (size 0) means "absent on this side". */
function NonTextDiff({ orig, curr }: { orig: FileReadResult; curr: FileReadResult }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 divide-x">
      <NonTextSide side={orig} emptyLabel="No HEAD version" />
      <NonTextSide side={curr} emptyLabel="No working-tree file" />
    </div>
  );
}

function NonTextSide({ side, emptyLabel }: { side: FileReadResult; emptyLabel: string }) {
  // Empty text means "this side doesn't exist" (added/deleted entries).
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
  // Either this side is binary (typically paired with an image), or it's
  // non-empty text paired with a binary on the other side.
  const label = side.kind === "binary" ? "Binary file" : "Text (paired with binary)";
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-[11px]">
      <span>{label} - diff not shown</span>
      <span className="text-[10px] tabular-nums">{formatBytes(side.size)}</span>
    </div>
  );
}

