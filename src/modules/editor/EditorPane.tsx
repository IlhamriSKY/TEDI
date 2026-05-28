import { findNext, findPrevious, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { usePreferencesStore } from "@/modules/settings/preferences";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Streamdown } from "streamdown";
import { loadEditorTheme, tryEditorTheme } from "./lib/themes";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import {
  buildMinimapExtension,
  buildSharedExtensions,
  minimapCompartment,
  languageCompartment,
  vimCompartment,
  wrapCompartment,
} from "./lib/extensions";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();
import { resolveLanguage } from "./lib/languageResolver";
import { useDocument } from "./lib/useDocument";
import { inlineCompletion } from "./lib/autocomplete/inlineExtension";
import { getKey } from "@/modules/ai/lib/keyring";
import { onKeysChanged } from "@/modules/settings/store";
import { EditorFindReplace, type EditorFindReplaceHandle } from "./EditorFindReplace";
import { formatDocument, NoFormatterError, shouldFormatOnSave } from "./lib/formatters";
import { toast } from "@/components/ui/toast";

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Returns the live (possibly dirty) editor buffer. `null` when the
   *  underlying CodeMirror view isn't mounted (loading / binary / etc.). */
  getContent: () => string | null;
  /** Replaces the entire editor buffer via a single CodeMirror transaction.
   *  Returns `true` when applied. The user sees the change as dirty until
   *  Ctrl+S. */
  setContent: (content: string) => boolean;
  /** Re-reads the file from disk. No-op if the buffer is dirty. */
  reload: () => boolean;
  /** Open the find/replace overlay. Both find and replace rows are always
   *  rendered together — there is no accordion. */
  openFindReplace: () => void;
  /** Run the configured formatter against the current buffer and apply the
   *  result. Surfaces failures as a toast. Does not save. */
  formatDocument: () => Promise<void>;
};

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
  /** Render markdown as preview instead of CodeMirror. Ignored for non-md. */
  mdPreview?: boolean;
  /** Edits a remote file over SFTP on the matching russh session id.
   *  Forwarded to `useDocument` so reads/writes hit the SSH backend. */
  sshSessionId?: number;
  /** When true the inline AI autocomplete is force-disabled regardless of
   *  user preferences. Set by PaneStack on editor leaves inside a private
   *  tab so file content never reaches a model provider. */
  aiDisabled?: boolean;
  ref?: Ref<EditorPaneHandle>;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Returns the y-coordinate of `pos` in the scroller's scrollable content
 *  space (same axis as `scrollTop`). Falls back to a geometric estimate
 *  when `coordsAtPos` returns null. */
function scrollYFor(view: EditorView, pos: number, edge: "top" | "bottom"): number {
  const scroller = view.scrollDOM;
  const coords = view.coordsAtPos(pos);
  if (coords) {
    const sr = scroller.getBoundingClientRect();
    const y = edge === "top" ? coords.top : coords.bottom;
    return y - sr.top + scroller.scrollTop;
  }
  const block = view.lineBlockAt(pos);
  const contentTop = view.contentDOM.offsetTop;
  return contentTop + (edge === "top" ? block.top : block.bottom);
}

/** Marker overlay geometry: bar top/height relative to the outer container,
 *  plus cursor tick y and selection band. Returns null before layout. */
function computeMarkers(
  view: EditorView,
  outer: HTMLElement | null,
): {
  barTop: number;
  barHeight: number;
  cursorY: number;
  selection: { top: number; height: number } | null;
} | null {
  if (!outer) return null;
  const scroller = view.scrollDOM;
  const sr = scroller.getBoundingClientRect();
  const or = outer.getBoundingClientRect();
  const clientH = scroller.clientHeight;
  if (clientH <= 0) return null;

  const scrollH = scroller.scrollHeight;
  // If the doc fits, markers track 1:1; otherwise they compress proportionally.
  const denom = Math.max(scrollH, clientH, 1);

  const sel = view.state.selection.main;
  const cursorScrollY = scrollYFor(view, sel.head, "top");
  // Center the 2px tick on y; using the top edge drifts the marker 1px low.
  const cursorY = Math.min(
    Math.max(0, (cursorScrollY / denom) * clientH - 1),
    Math.max(0, clientH - 2),
  );

  let selection: { top: number; height: number } | null = null;
  if (sel.from !== sel.to) {
    const fromY = (scrollYFor(view, sel.from, "top") / denom) * clientH;
    const toY = (scrollYFor(view, sel.to, "bottom") / denom) * clientH;
    selection = { top: Math.max(0, fromY), height: Math.max(2, toY - fromY) };
  }

  return {
    barTop: sr.top - or.top,
    barHeight: clientH,
    cursorY,
    selection,
  };
}

export function EditorPane({
  path,
  onDirtyChange,
  onSaved,
  onClose,
  mdPreview,
  sshSessionId,
  aiDisabled,
  ref,
}: Props) {
  const { doc, liveContent, onChange, save, reload } = useDocument({
    path,
    onDirtyChange,
    sshSessionId,
  });
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const findReplaceRef = useRef<EditorFindReplaceHandle>(null);
  const [markerState, setMarkerState] = useState<{
    barTop: number;
    barHeight: number;
    cursorY: number;
    selection: { top: number; height: number } | null;
  } | null>(null);
  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const lineWrap = usePreferencesStore((s) => s.lineWrap);
  const showMinimap = usePreferencesStore((s) => s.showMinimap);
  const languageRef = useRef<string | null>(null);
  const apiKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const provider = usePreferencesStore.getState().autocompleteProvider;
      if (provider === "lmstudio") {
        apiKeyRef.current = null;
        return;
      }
      const k = await getKey(provider);
      if (!cancelled) apiKeyRef.current = k;
    };
    void refresh();
    let unlistenKeys: (() => void) | undefined;
    void onKeysChanged(() => void refresh()).then((un) => {
      unlistenKeys = un;
    });
    const unsubPrefs = usePreferencesStore.subscribe((state, prev) => {
      if (state.autocompleteProvider !== prev.autocompleteProvider) {
        void refresh();
      }
    });
    return () => {
      cancelled = true;
      unlistenKeys?.();
      unsubPrefs();
    };
  }, []);
  // Themes are dynamic imports (~10-25 KB). Show cached immediately;
  // otherwise unstyled until ready.
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

  // Stable refs so the extensions array keeps its identity; a new identity
  // makes @uiw/react-codemirror reconfigure and wipes the language compartment.
  const saveRef = useRef(save);
  saveRef.current = save;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * Replace the buffer in a single CM transaction, preserving cursor +
   * scroll best-effort. Clamps the selection to the new length because
   * formatting can shrink the document below the prior anchor.
   */
  const applyFormattedToView = (formatted: string): void => {
    const view = cmRef.current?.view;
    if (!view) return;
    const current = view.state.doc.toString();
    if (formatted === current) return;
    const sel = view.state.selection.main;
    const len = formatted.length;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
      selection: {
        anchor: Math.min(sel.anchor, len),
        head: Math.min(sel.head, len),
      },
      scrollIntoView: false,
    });
  };

  /**
   * Wraps the save flow with optional format-on-save. Always calls
   * `saveRef.current()` at the end so a formatter failure never blocks the
   * write — the user keeps their unsaved work persisted.
   */
  const formatAndSaveRef = useRef<() => Promise<void>>(async () => {});
  formatAndSaveRef.current = async () => {
    const view = cmRef.current?.view;
    if (view && shouldFormatOnSave(pathRef.current)) {
      try {
        const current = view.state.doc.toString();
        const formatted = await formatDocument({ path: pathRef.current, content: current });
        if (formatted !== current) {
          applyFormattedToView(formatted);
          await saveRef.current(formatted);
          onSavedRef.current?.();
          return;
        }
      } catch (err) {
        // NoFormatterError means the user has format-on-save on but no
        // formatter for this language — that's expected, fall through to
        // a plain save without nagging.
        if (!(err instanceof NoFormatterError)) {
          toast(`Format on save failed: ${(err as Error).message}`, {
            variant: "error",
          });
        }
      }
    }
    await saveRef.current();
    onSavedRef.current?.();
  };

  const pathRef = useRef(path);
  pathRef.current = path;
  // Mirror `aiDisabled` into a ref so the (memoised) extensions array can
  // read the latest value without reconfiguring CodeMirror on every prop
  // change.
  const aiDisabledRef = useRef(aiDisabled === true);
  aiDisabledRef.current = aiDisabled === true;

  const extensions = useMemo(
    () => [
      // basicSetup loads before user extensions, so vim needs Prec.highest
      // to win the keymap.
      vimCompartment.of(usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : []),
      vimHandlersExtension(() => ({
        save: () => {
          void formatAndSaveRef.current();
        },
        close: () => onCloseRef.current?.(),
      })),
      ...buildSharedExtensions({
        showMinimap: usePreferencesStore.getState().showMinimap,
      }),
      wrapCompartment.of(usePreferencesStore.getState().lineWrap ? EditorView.lineWrapping : []),
      languageCompartment.of([]),
      inlineCompletion({
        getPrefs: () => {
          const s = usePreferencesStore.getState();
          return {
            // Private tabs force-disable AI autocomplete so file content
            // never reaches the model provider.
            enabled: s.autocompleteEnabled && !aiDisabledRef.current,
            provider: s.autocompleteProvider,
            modelId: s.autocompleteModelId,
            apiKey: apiKeyRef.current,
            lmstudioBaseURL: s.lmstudioBaseURL,
          };
        },
        getPath: () => pathRef.current,
        getLanguage: () => languageRef.current,
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void formatAndSaveRef.current();
            return true;
          },
        },
        {
          // VSCode's Format Document.
          key: "Shift-Alt-f",
          preventDefault: true,
          run: () => {
            const view = cmRef.current?.view;
            if (!view) return false;
            void (async () => {
              try {
                const current = view.state.doc.toString();
                const formatted = await formatDocument({
                  path: pathRef.current,
                  content: current,
                });
                applyFormattedToView(formatted);
              } catch (err) {
                toast(`Format failed: ${(err as Error).message}`, { variant: "error" });
              }
            })();
            return true;
          },
        },
      ]),
      // Refresh marker overlay on selection/doc/viewport/geometry changes.
      // `setMarkerState` and `outerRef` are stable; captured once.
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged || u.geometryChanged || u.viewportChanged) {
          setMarkerState(computeMarkers(u.view, outerRef.current));
        }
      }),
    ],
    [],
  );

  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim()) : []),
    });
  }, [vimMode]);

  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(lineWrap ? EditorView.lineWrapping : []),
    });
  }, [lineWrap]);

  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: minimapCompartment.reconfigure(showMinimap ? buildMinimapExtension() : []),
    });
  }, [showMinimap]);

  useEffect(() => {
    let cancelled = false;
    const ext = path.split(".").pop()?.toLowerCase() ?? null;
    languageRef.current = ext;
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
  }, [path, doc.status]);

  // Marker overlay: refresh on scroll + resize. The updateListener handles
  // selection/doc/viewport; this effect handles scroll-without-edit and
  // pane resizes where CodeMirror doesn't fire an update.
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const update = () => {
      const v = cmRef.current?.view;
      if (!v) return;
      setMarkerState(computeMarkers(v, outerRef.current));
    };
    // Initial paint after layout.
    update();
    const onScroll = () => update();
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(view.scrollDOM);
    ro.observe(view.dom);
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [doc.status]);

  useImperativeHandle(
    ref,
    () => ({
      setQuery: (q: string) => {
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({ search: q, caseSensitive: false })),
        });
        if (q) findNext(view);
      },
      findNext: () => {
        const view = cmRef.current?.view;
        if (view) findNext(view);
      },
      findPrevious: () => {
        const view = cmRef.current?.view;
        if (view) findPrevious(view);
      },
      clearQuery: () => {
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({ search: "" })),
        });
      },
      focus: () => {
        cmRef.current?.view?.focus();
      },
      getSelection: () => {
        const view = cmRef.current?.view;
        if (!view) return null;
        const { from, to } = view.state.selection.main;
        if (from === to) return null;
        return view.state.sliceDoc(from, to);
      },
      getPath: () => path,
      getContent: () => {
        const view = cmRef.current?.view;
        if (!view) return null;
        return view.state.doc.toString();
      },
      setContent: (content: string) => {
        const view = cmRef.current?.view;
        if (!view) return false;
        // Reuse the same buffer-swap helper the built-in formatter uses so
        // the cursor and scroll position survive the replacement.
        applyFormattedToView(content);
        return true;
      },
      reload: () => reloadRef.current(),
      openFindReplace: () => {
        findReplaceRef.current?.open();
      },
      formatDocument: async () => {
        const view = cmRef.current?.view;
        if (!view) return;
        try {
          const current = view.state.doc.toString();
          const formatted = await formatDocument({ path: pathRef.current, content: current });
          applyFormattedToView(formatted);
        } catch (err) {
          toast(`Format failed: ${(err as Error).message}`, { variant: "error" });
        }
      },
    }),
    [path],
  );

  if (doc.status === "loading") {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading…
      </div>
    );
  }
  if (doc.status === "error") {
    return (
      <div className="text-destructive flex h-full items-center justify-center px-6 text-center text-xs">
        {doc.message}
      </div>
    );
  }
  if (doc.status === "image") {
    return (
      <div className="bg-muted/20 flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-auto p-4">
        <img src={doc.dataUrl} alt={path} className="max-h-full max-w-full object-contain" />
        <div className="text-muted-foreground text-xs">
          {doc.mime} · {formatBytes(doc.size)}
        </div>
      </div>
    );
  }
  if (doc.status === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <div className="text-foreground text-sm">Binary file</div>
        <div className="text-muted-foreground text-xs">
          {formatBytes(doc.size)} · preview not supported
        </div>
      </div>
    );
  }
  if (doc.status === "toolarge") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <div className="text-foreground text-sm">File too large</div>
        <div className="text-muted-foreground text-xs">
          {formatBytes(doc.size)} exceeds the {formatBytes(doc.limit)} limit.
        </div>
      </div>
    );
  }

  const isMd = /\.(md|markdown|mdx)$/i.test(path);
  const showMdPreview = !!mdPreview && isMd;

  // Keep CodeMirror mounted during markdown preview; unmounting drops the
  // language compartment and loses highlighting until path changes.
  return (
    <div ref={outerRef} className="relative flex h-full min-h-0 flex-col">
      <div
        className={
          showMdPreview
            ? "pointer-events-none invisible flex min-h-0 flex-1 flex-col"
            : "flex min-h-0 flex-1 flex-col"
        }
        aria-hidden={showMdPreview ? "true" : "false"}
      >
        <CodeMirror
          ref={cmRef}
          value={doc.content}
          onChange={onChange}
          theme={themeExt ?? undefined}
          extensions={extensions}
          height="100%"
          className="min-h-0 flex-1 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: false,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            // Custom Ctrl+F / Ctrl+H bar lives in <EditorFindReplace>; the
            // built-in CM panel would compete with it and stack at the top.
            searchKeymap: false,
          }}
        />
        <EditorFindReplace ref={findReplaceRef} getView={() => cmRef.current?.view ?? null} />
      </div>
      {/* Scrollbar marker overlay: paints caret + selection over the native
          scrollbar. Outside CodeMirror's ViewPlugin lifecycle; refreshed by
          the updateListener plus the scroll/resize effect above. */}
      {!showMdPreview && markerState && (
        <div
          className="pointer-events-none absolute"
          style={{
            top: markerState.barTop,
            right: 0,
            width: 10,
            height: markerState.barHeight,
            zIndex: 10,
          }}
        >
          {markerState.selection && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: markerState.selection.top,
                height: markerState.selection.height,
                backgroundColor: "color-mix(in srgb, var(--primary) 50%, transparent)",
              }}
            />
          )}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: markerState.cursorY,
              height: 2,
              backgroundColor: "var(--primary)",
            }}
          />
        </div>
      )}
      {showMdPreview && (
        <div className="bg-background absolute inset-0 overflow-auto p-6">
          <Streamdown className="prose prose-sm dark:prose-invert max-w-3xl [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {liveContent}
          </Streamdown>
        </div>
      )}
    </div>
  );
}
