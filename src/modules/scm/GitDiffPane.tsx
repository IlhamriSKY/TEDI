import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildSharedExtensions } from "@/modules/editor/lib/extensions";
import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import {
  loadEditorTheme,
  tryEditorTheme,
} from "@/modules/editor/lib/themes";
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

// MergeView height/scroll wiring lives in `globals.css` (.cm-mergeView rule):
// EditorView.theme selectors are scoped to .cm-editor and can't reach the
// outer .cm-mergeView wrapper, so it has to be a plain stylesheet rule.

export function GitDiffPane({
  path,
  relative,
  repoPath,
  changeStatus,
  reloadKey,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const langA = useRef(new Compartment()).current;
  const langB = useRef(new Compartment()).current;

  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const [themeExt, setThemeExt] = useState<Extension | null>(() =>
    tryEditorTheme(editorThemeId),
  );
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

    const loadCurrent =
      changeStatus === "deleted" ? Promise.resolve("") : readFileText(path);

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

    // Diff view has its own scrollbars on both sides plus the unchanged-region
    // collapser -- the minimap would only crowd the lane and never get clicked.
    const shared = buildSharedExtensions({ showMinimap: false });
    const view = new MergeView({
      a: {
        doc: content.orig,
        extensions: [
          ...shared,
          lineNumbers(),
          themeExt ?? [],
          langA.of([]),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: content.curr,
        extensions: [
          ...shared,
          lineNumbers(),
          themeExt ?? [],
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
      collapseUnchanged: { margin: 3, minSize: 6 },
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

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border/60 bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Badge variant="outline" className="text-[10px] px-2 py-0.5 uppercase">
          {changeStatus}
        </Badge>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {relative}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{relative}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading diff…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-xs text-destructive">
            {error}
          </div>
        ) : (
          <div ref={hostRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
