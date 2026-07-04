import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { AiDiffStatus } from "@/modules/tabs";
import { presentableDiff, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { buildSharedExtensions, languageCompartment } from "./lib/extensions";
import { resolveLanguage } from "./lib/languageResolver";
import { loadEditorTheme, tryEditorTheme } from "./lib/themes";
import { Check, X } from "lucide-react";

type Props = {
  path: string;
  originalContent: string;
  proposedContent: string;
  status: AiDiffStatus;
  isNewFile: boolean;
  onAccept: () => void;
  onReject: () => void;
};

// Override default merge styles: replace the default 2px linear-gradient
// underline with proper block backgrounds. Reads cleaner - especially for
// pure insertions, where the underline-style marker looked decorative.
const DIFF_THEME = EditorView.theme({
  // ".cm-changedLine": {
  //   backgroundColor:
  //     "color-mix(in srgb, #22c55e 10%, transparent) !important",
  // },
  // ".cm-merge-b .cm-changedText, .cm-merge-b ins.cm-insertedLine": {
  //   background:
  //     "color-mix(in srgb, #22c55e 28%, transparent) !important",
  //   textDecoration: "none !important",
  //   borderRadius: "2px",
  // },
  // ".cm-deletedChunk": {
  //   backgroundColor:
  //     "color-mix(in srgb, #ef4444 8%, transparent)",
  //   paddingLeft: "6px",
  //   paddingTop: "1px",
  //   paddingBottom: "1px",
  // },
  // ".cm-deletedChunk .cm-deletedText, .cm-deletedLine del": {
  //   background:
  //     "color-mix(in srgb, #ef4444 26%, transparent) !important",
  //   textDecoration: "none !important",
  //   borderRadius: "2px",
  // },
  // ".cm-changeGutter": {
  //   width: "3px",
  // },
  // ".cm-changedLineGutter": {
  //   backgroundColor: "#22c55e",
  // },
  // ".cm-deletedLineGutter": {
  //   backgroundColor: "#ef4444",
  // },
  // Inline added-text highlight inside merge view. Reads the EDITOR-owned
  // `--tedi-editor-diff-added` token so the diff tint follows the code-editor
  // theme (set by `applyEditorDiffColors`), not the app theme.
  ".cm-changedText": {
    background: "color-mix(in srgb, var(--tedi-editor-diff-added) 18%, transparent) !important",
  },
});

const STATUS_LABEL: Record<AiDiffStatus, string> = {
  pending: "Pending review",
  approved: "Applied",
  rejected: "Rejected",
};

const STATUS_BADGE: Record<AiDiffStatus, "outline" | "secondary" | "destructive"> = {
  pending: "outline",
  approved: "secondary",
  rejected: "destructive",
};

export function AiDiffPane({
  path,
  originalContent,
  proposedContent,
  status,
  isNewFile,
  onAccept,
  onReject,
}: Props) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
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

  // The merge extension diffs the current document against `original`.
  // We bake originalContent into the extension once on mount; if the AI
  // updates its proposal, the surrounding bridge re-creates the tab.
  const extensions = useMemo(
    () => [
      ...buildSharedExtensions(),
      languageCompartment.of([]),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      unifiedMergeView({
        original: originalContent,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      }),
      DIFF_THEME,
    ],
    [originalContent],
  );

  // Resolve language by path (same approach as EditorPane).
  useEffect(() => {
    let cancelled = false;
    resolveLanguage(path).then((ext) => {
      if (cancelled) return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: languageCompartment.reconfigure(ext ?? []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const stats = useMemo(
    () => computeLineStats(originalContent, proposedContent),
    [originalContent, proposedContent],
  );

  return (
    <div className="border-border/60 bg-background flex h-full min-h-0 flex-col rounded-md border">
      <div className="border-border/60 flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge className="p-2.5 text-[11px]" variant={STATUS_BADGE[status]}>
            {STATUS_LABEL[status]}
          </Badge>
          {isNewFile ? (
            <span className="border-border/60 bg-accent/40 text-muted-foreground shrink-0 border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
              New file
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground truncate font-mono text-[11px]">{path}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{path}</TooltipContent>
          </Tooltip>
          <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
            <span className="text-diff-added">+{stats.added}</span>
            <span className="text-diff-removed">−{stats.removed}</span>
          </span>
        </div>
        {status === "pending" ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="default" onClick={onAccept} className="h-7 gap-1.5">
              <Check size={13} strokeWidth={2} />
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onReject}
              className="hover:bg-destructive/10 hover:text-destructive h-7 gap-1.5"
            >
              <X size={13} strokeWidth={2} />
              Reject
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          ref={cmRef}
          value={proposedContent}
          theme={themeExt ?? undefined}
          extensions={extensions}
          editable={false}
          height="100%"
          className="h-full"
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            searchKeymap: true,
          }}
        />
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
