import {
  findNext,
  findPrevious,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { usePreferencesStore } from "@/modules/settings/preferences";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Streamdown } from "streamdown";
import { loadEditorTheme, tryEditorTheme } from "./lib/themes";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import {
  buildSharedExtensions,
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

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
};

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
  /** When true and the file is markdown, render a rendered MD view instead
   *  of the CodeMirror editor. Ignored for non-markdown files. */
  mdPreview?: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Resolve a document position to a y-coordinate in the scroller's scrollable
 * content space (same coordinate as `scrollTop`). Falls back to a geometric
 * estimate when `coordsAtPos` returns null (position outside viewport). */
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

/** Compute the marker overlay's geometry: the bar's top/height relative to
 * the outer container, plus where to paint the cursor tick and (optionally)
 * the selection band. Returns null if the editor hasn't laid out yet. */
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
  // Two regimes unified by Math.max: if the doc fits the viewport, markers
  // track 1:1 with on-screen y; if it overflows, they compress proportionally.
  const denom = Math.max(scrollH, clientH, 1);

  const sel = view.state.selection.main;
  const cursorScrollY = scrollYFor(view, sel.head, "top");
  // Center the 2px tick on the resolved y rather than using its top edge —
  // otherwise the marker drifts ~1px below where the caret visually sits.
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

export const EditorPane = forwardRef<EditorPaneHandle, Props>(
  function EditorPane(
    { path, onDirtyChange, onSaved, onClose, mdPreview },
    ref,
  ) {
    const { doc, liveContent, onChange, save, reload } = useDocument({
      path,
      onDirtyChange,
    });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const outerRef = useRef<HTMLDivElement>(null);
    const [markerState, setMarkerState] = useState<{
      barTop: number;
      barHeight: number;
      cursorY: number;
      selection: { top: number; height: number } | null;
    } | null>(null);
    const editorThemeId = usePreferencesStore((s) => s.editorTheme);
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const lineWrap = usePreferencesStore((s) => s.lineWrap);
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
    // Themes are dynamically imported (~10–25 KB each). Show the cached
     // extension immediately if loaded; otherwise unstyled until ready.
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

    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity - a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const pathRef = useRef(path);
    pathRef.current = path;

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void (async () => {
              await saveRef.current();
              onSavedRef.current?.();
            })();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        wrapCompartment.of(
          usePreferencesStore.getState().lineWrap ? EditorView.lineWrapping : [],
        ),
        languageCompartment.of([]),
        inlineCompletion({
          getPrefs: () => {
            const s = usePreferencesStore.getState();
            return {
              enabled: s.autocompleteEnabled,
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
              void (async () => {
                await saveRef.current();
                onSavedRef.current?.();
              })();
              return true;
            },
          },
        ]),
        // Update the scrollbar marker overlay state whenever selection,
        // document, viewport, or geometry changes. Closes over `setMarkerState`
        // and `outerRef` — both have stable identities so capturing once via
        // the empty-deps useMemo above is fine.
        EditorView.updateListener.of((u) => {
          if (
            u.selectionSet ||
            u.docChanged ||
            u.geometryChanged ||
            u.viewportChanged
          ) {
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
        effects: vimCompartment.reconfigure(
          vimMode ? Prec.highest(vim()) : [],
        ),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          lineWrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [lineWrap]);

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

    // Marker overlay positioning — refresh on scroll + size changes. The
    // `EditorView.updateListener` in the extensions array covers selection /
    // doc / viewport changes; this effect handles scroll-without-edit and
    // pane resizes where CodeMirror itself doesn't fire an update.
    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      const update = () => {
        const v = cmRef.current?.view;
        if (!v) return;
        setMarkerState(computeMarkers(v, outerRef.current));
      };
      // Initial paint after the view has laid out.
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
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
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
        reload: () => reloadRef.current(),
      }),
      [path],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "image") {
      return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-auto bg-muted/20 p-4">
          <img
            src={doc.dataUrl}
            alt={path}
            className="max-h-full max-w-full object-contain"
          />
          <div className="text-xs text-muted-foreground">
            {doc.mime} · {formatBytes(doc.size)}
          </div>
        </div>
      );
    }
    if (doc.status === "binary") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">Binary file</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} · preview not supported
          </div>
        </div>
      );
    }
    if (doc.status === "toolarge") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">File too large</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} exceeds the {formatBytes(doc.limit)} limit.
          </div>
        </div>
      );
    }

    const isMd = /\.(md|markdown|mdx)$/i.test(path);
    const showMdPreview = !!mdPreview && isMd;

    // Keep CodeMirror mounted even while previewing markdown - unmounting
    // discards the language compartment, so flipping back to source would
    // lose syntax highlighting until the path changed.
    return (
      <div ref={outerRef} className="relative flex h-full min-h-0 flex-col">
        <div
          className={
            showMdPreview
              ? "invisible pointer-events-none flex flex-1 min-h-0 flex-col"
              : "flex flex-1 min-h-0 flex-col"
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
            className="flex-1 min-h-0 overflow-hidden"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              foldGutter: false,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              searchKeymap: true,
            }}
          />
        </div>
        {/* Scrollbar marker overlay — paints the caret position and selection
            range over the native vertical scrollbar. Lives outside CodeMirror
            so it doesn't depend on CodeMirror's ViewPlugin lifecycle; state is
            kept fresh by the `EditorView.updateListener` in `extensions` plus
            a scroll/resize-watching useEffect. */}
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
                  backgroundColor: "rgba(56, 139, 253, 0.5)",
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
                backgroundColor: "rgb(56, 139, 253)",
              }}
            />
          </div>
        )}
        {showMdPreview && (
          <div className="absolute inset-0 overflow-auto bg-background p-6">
            <Streamdown className="prose prose-sm dark:prose-invert max-w-3xl [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              {liveContent}
            </Streamdown>
          </div>
        )}
      </div>
    );
  },
);
