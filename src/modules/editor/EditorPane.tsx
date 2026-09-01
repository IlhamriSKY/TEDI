import {
  findNext,
  findPrevious,
  getSearchQuery,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { usePreferencesStore } from "@/modules/settings/preferences";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Streamdown } from "streamdown";
import { readClipboardText } from "@/lib/clipboard";
import { formatBytes } from "@/lib/format";
import { safeUrlTransform } from "@/lib/markdownSafety";
import { markdownComponents } from "@/components/ai-elements/markdown-code";
import { useEditorTheme } from "./lib/themes";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Prec } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import {
  minimapExtension,
  buildSharedExtensions,
  minimapCompartment,
  languageCompartment,
  vimCompartment,
  wrapCompartment,
} from "./lib/extensions";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";
import { isNotePath, notesReady, registerNoteFlush } from "./lib/notes";

initVimGlobals();
import { resolveLanguage } from "./lib/languageResolver";
import { detectLanguageId, languageLabel, resolveLanguageById } from "./lib/languages";
import { LanguagePickerDialog } from "./LanguagePickerDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useDocument } from "./lib/useDocument";
import { inlineCompletion } from "./lib/autocomplete/inlineExtension";
import { providerNeedsKey, type ProviderId } from "@/modules/ai/config";
import { getKey } from "@/modules/ai/lib/keyring";
import { onKeysChanged } from "@/modules/settings/store";
import {
  EditorFindReplace,
  matchState,
  type EditorFindReplaceHandle,
  type MatchPos,
} from "./EditorFindReplace";
import { MarkdownFindBar, type MarkdownFindBarHandle } from "./MarkdownFindBar";
import {
  formatDocument,
  FormatterUnavailableError,
  NoFormatterError,
  shouldFormatOnSave,
} from "./lib/formatters";
import { onReveal, takeReveal, type RevealTarget } from "./lib/reveal";
import { toast } from "@/components/ui/toast";
import { escapeRegex } from "@/lib/utils";
import { COMPACT_ITEM } from "@/modules/explorer/lib/menuItemClass";
import { subscribeFileChange } from "@/modules/explorer/lib/fsRefresh";

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  /** Register a listener for "{current}/{total}" match updates, so an outside
   *  search box (the header field) can show the same position VS Code does.
   *  Pass `null` to unsubscribe. One listener at a time — only the header uses it. */
  setMatchListener: (cb: ((pos: MatchPos) => void) | null) => void;
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
  /** Persist the current buffer to disk (plain save, no format-on-save). Used by
   *  the float window to save before floating and on dock-back, so an editor can
   *  hand off between the main pane and its float without losing edits. */
  save: () => Promise<void>;
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

/** Locate the search match within a line so the editor can select the exact
 *  hit (VSCode-style) rather than the whole line. Falls back to null on a bad
 *  regex or no match, in which case the caller selects the whole line. */
function matchColumn(lineText: string, t: RevealTarget): [number, number] | null {
  const needle = t.needle?.trim();
  if (!needle) return null;
  try {
    const src = t.useRegex ? needle : escapeRegex(needle);
    const m = new RegExp(src, t.caseInsensitive ? "i" : "").exec(lineText);
    if (m && m[0].length > 0) return [m.index, m.index + m[0].length];
  } catch {
    /* invalid regex — fall through to whole-line select */
  }
  return null;
}

/** Select + center the target line (or the exact match within it) and focus
 *  the view. Clamps the line number to the document so a stale hit can't throw. */
function revealInView(view: EditorView, t: RevealTarget): void {
  const lineNo = Math.min(Math.max(1, Math.floor(t.line)), view.state.doc.lines);
  const line = view.state.doc.line(lineNo);
  const col = matchColumn(line.text, t);
  const from = col ? line.from + col[0] : line.from;
  const to = col ? line.from + col[1] : line.to;
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });
  view.focus();
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
  // Markdown-preview find: the preview renders to the DOM (Streamdown), so its
  // search runs over rendered text rather than CodeMirror. `mdScrollRef` is the
  // scroller searched; the find bar lives outside it so its own UI isn't matched.
  const mdScrollRef = useRef<HTMLDivElement>(null);
  const mdFindRef = useRef<MarkdownFindBarHandle>(null);
  const getMdContainer = useCallback(() => mdScrollRef.current, []);
  // Header search box's match-position listener. Fed by CodeMirror after every
  // find op, and by <MarkdownFindBar> (which computes its own ranges) in preview.
  const matchCbRef = useRef<((pos: MatchPos) => void) | null>(null);
  const emitMatches = useCallback(() => {
    const cb = matchCbRef.current;
    if (!cb) return;
    const view = cmRef.current?.view;
    if (!view) return cb({ current: 0, total: 0 });
    cb(matchState(view, getSearchQuery(view.state)));
  }, []);
  const emitMdMatches = useCallback((pos: MatchPos) => matchCbRef.current?.(pos), []);
  // Stable identity so EditorFindReplace's effect (which lists getView in its
  // deps) doesn't re-run on every scroll/selection while the find bar is open.
  // cmRef is itself stable, so the closure never needs to change.
  const getView = useCallback(() => cmRef.current?.view ?? null, []);
  const [markerState, setMarkerState] = useState<{
    barTop: number;
    barHeight: number;
    cursorY: number;
    selection: { top: number; height: number } | null;
  } | null>(null);
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const lineWrap = usePreferencesStore((s) => s.lineWrap);
  const showMinimap = usePreferencesStore((s) => s.showMinimap);
  const languageRef = useRef<string | null>(null);
  // The key is fetched asynchronously but the provider is read synchronously from
  // the store, so the ref MUST carry which provider it belongs to. Without that,
  // switching provider left the previous provider's key in the ref and the next
  // keystroke shipped it to the new provider's endpoint: a real credential leak,
  // not a narrow race.
  const apiKeyRef = useRef<{ provider: ProviderId; key: string | null } | null>(null);

  // Manual "Change Language Mode" override (right-click). `null` follows path
  // detection. Reset whenever the open file changes so a forced mode never
  // leaks onto the next file shown in this pane.
  const [langOverride, setLangOverride] = useState<string | null>(null);
  const [langPickerOpen, setLangPickerOpen] = useState(false);
  const [detectedLangId, setDetectedLangId] = useState<string | null>(null);
  // Selection presence sampled when the context menu opens, so Copy/Cut can be
  // disabled without re-rendering the pane on every cursor move.
  const [menuHasSelection, setMenuHasSelection] = useState(false);
  useEffect(() => {
    setLangOverride(null);
  }, [path]);
  const activeLangId = langOverride ?? detectedLangId;
  // Stable identity so the memoized picker stays idle across cursor-move
  // re-renders (which fire constantly via the marker overlay).
  const handlePickLanguage = useCallback((id: string | null) => setLangOverride(id), []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const provider = usePreferencesStore.getState().autocompleteProvider;
      if (!providerNeedsKey(provider)) {
        apiKeyRef.current = { provider, key: null };
        return;
      }
      // Clear first: until the fetch lands there is no valid key for this
      // provider, and a stale one must never be offered in its place.
      apiKeyRef.current = null;
      const k = await getKey(provider);
      if (cancelled) return;
      // Two rapid switches race; only the fetch matching the CURRENT provider
      // may publish, so the loser cannot land last.
      if (usePreferencesStore.getState().autocompleteProvider !== provider) return;
      apiKeyRef.current = { provider, key: k };
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
  const themeExt = useEditorTheme();

  // Stable refs so the extensions array keeps its identity; a new identity
  // makes @uiw/react-codemirror reconfigure and wipes the language compartment.
  const saveRef = useRef(save);
  saveRef.current = save;

  /**
   * Quick notes (scratch files in the app data dir) save themselves: they
   * exist so a throwaway thought survives quitting TEDI, and nobody presses
   * Ctrl+S on a throwaway thought. Plain `save`, never the format-on-save
   * wrapper - reformatting under the cursor mid-typing is not a save.
   */
  const autosaveRef = useRef(false);
  useEffect(() => {
    void notesReady.then(() => (autosaveRef.current = isNotePath(path)));
  }, [path]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback(
    (next: string) => {
      onChange(next);
      if (!autosaveRef.current) return;
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = setTimeout(() => {
        autosaveTimer.current = null;
        void saveRef.current();
      }, 600);
    },
    [onChange],
  );
  /** Write a debounced autosave out now. No-op when none is pending. */
  const flushAutosave = useCallback(async () => {
    if (!autosaveTimer.current) return;
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    await saveRef.current();
  }, []);
  // Two ways the last few keystrokes could be dropped: the pane going away (tab
  // closed, workspace switched), and the window closing - which never unmounts
  // React, hence the registry the quit guard drains.
  useEffect(() => {
    const off = registerNoteFlush(flushAutosave);
    return () => {
      off();
      void flushAutosave();
    };
  }, [flushAutosave]);
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
        // The user may have typed (or the view remounted) during the await.
        // Applying a stale format result would silently clobber those edits,
        // so bail and fall through to a plain save of the current buffer.
        const live = cmRef.current?.view;
        if (live === view && live.state.doc.toString() === current && formatted !== current) {
          applyFormattedToView(formatted);
          await saveRef.current(formatted);
          onSavedRef.current?.();
          return;
        }
      } catch (err) {
        // NoFormatterError (no formatter for this language) and
        // FormatterUnavailableError (the external tool isn't installed) are
        // both expected with format-on-save on: fall through to a plain save
        // without nagging. Only real formatter failures toast.
        if (!(err instanceof NoFormatterError) && !(err instanceof FormatterUnavailableError)) {
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
  // Whether the markdown preview (not CodeMirror) is the active surface. Read
  // by the imperative handle so find/search routes to <MarkdownFindBar> in
  // preview mode. Mirrored into a ref so the handle's deps stay [path].
  const mdPreviewActiveRef = useRef(false);
  mdPreviewActiveRef.current = !!mdPreview && /\.(md|markdown|mdx)$/i.test(path);
  // Mirror `aiDisabled` into a ref so the (memoised) extensions array can
  // read the latest value without reconfiguring CodeMirror on every prop
  // change.
  const aiDisabledRef = useRef(aiDisabled === true);
  aiDisabledRef.current = aiDisabled === true;

  const extensions = useMemo(
    () => [
      // basicSetup loads before user extensions, so vim needs Prec.highest
      // to win the keymap. `status` shows the mode line - without it normal
      // mode is invisible and reads as "typing and backspace are broken".
      vimCompartment.of(
        usePreferencesStore.getState().vimMode ? Prec.highest(vim({ status: true })) : [],
      ),
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
            // Only hand over a key that was fetched FOR this provider.
            apiKey:
              apiKeyRef.current?.provider === s.autocompleteProvider ? apiKeyRef.current.key : null,
            lmstudioBaseURL: s.lmstudioBaseURL,
            openaiCompatibleBaseURL: s.openaiCompatibleBaseURL,
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
                // Skip if the user typed (or the view remounted) during the
                // await, so a stale result never clobbers fresh edits.
                const live = cmRef.current?.view;
                if (live === view && live.state.doc.toString() === current) {
                  applyFormattedToView(formatted);
                }
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
      effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim({ status: true })) : []),
    });
  }, [vimMode]);

  // The AI's file tools (and any other mutator that dispatches an fs refresh)
  // write straight to disk, so an open editor sat on stale text until it was
  // closed and reopened. Reload in place instead. `reload()` is a silent no-op
  // while dirty, so unsaved edits are never clobbered. Remote leaves opt out:
  // the AI's file tools are local-only, so a remote file that happens to share
  // the path is a different file entirely.
  useEffect(() => {
    if (sshSessionId !== undefined) return;
    return subscribeFileChange(
      () => pathRef.current,
      () => reloadRef.current(),
    );
  }, [sshSessionId]);

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
      effects: minimapCompartment.reconfigure(showMinimap ? minimapExtension() : []),
    });
  }, [showMinimap]);

  useEffect(() => {
    let cancelled = false;
    const detected = detectLanguageId(path);
    setDetectedLangId(detected);
    const activeId = langOverride ?? detected;
    // Autocomplete language hint: prefer the resolved language id, fall back to
    // the bare extension so unknown file types still pass something useful.
    languageRef.current = activeId ?? path.split(".").pop()?.toLowerCase() ?? null;
    // A manual override resolves by language id; otherwise follow the path.
    const loader = langOverride ? resolveLanguageById(langOverride) : resolveLanguage(path);
    loader.then((ext) => {
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
  }, [path, doc.status, langOverride]);

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

  // Escape the horizontal-scroll trap: with line wrap off, drag-selecting past
  // the right edge auto-scrolls the view sideways and strands it there. On a
  // doc that fits vertically (a note/config with one long line) the plain
  // vertical wheel has nothing to scroll, so a mouse user can't get back to the
  // left without knowing Shift+wheel or hunting the far-right scrollbar thumb,
  // and ends up reopening the file. Redirect a plain vertical wheel to the only
  // scrollable axis in that case. Same pattern as the tab strip's wheel handler.
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const sc = view.scrollDOM;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0 || e.deltaY === 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const hasH = sc.scrollWidth > sc.clientWidth + 1;
      // Use the real text height, not scrollDOM.scrollHeight (the minimap
      // inflates the latter to the viewport height, so a short doc would
      // otherwise read as vertically scrollable and this handler never fires).
      const hasV = view.contentHeight > sc.clientHeight + 1;
      if (hasH && !hasV) {
        sc.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [doc.status]);

  // Reveal-on-open: when find-in-files (or anything) requests a jump to a line
  // in THIS file, select + center it like VSCode. Two paths feed the same
  // action: the `doc.status` effect handles "file was just opened" (consume the
  // pending target once the view is mounted and the doc is ready); the bus
  // listener handles "file already open" (reveal immediately on request).
  useEffect(() => {
    if (doc.status !== "ready") return;
    const id = requestAnimationFrame(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      const target = takeReveal(pathRef.current);
      if (target) revealInView(view, target);
    });
    return () => cancelAnimationFrame(id);
  }, [doc.status, path]);

  useEffect(() => {
    return onReveal((p) => {
      if (p !== pathRef.current) return;
      requestAnimationFrame(() => {
        const view = cmRef.current?.view;
        if (!view) return;
        const target = takeReveal(pathRef.current);
        if (target) revealInView(view, target);
      });
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      setQuery: (q: string) => {
        if (mdPreviewActiveRef.current) {
          mdFindRef.current?.setQuery(q);
          return;
        }
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({ search: q, caseSensitive: false })),
        });
        if (q) findNext(view);
        emitMatches();
      },
      findNext: () => {
        if (mdPreviewActiveRef.current) {
          mdFindRef.current?.findNext();
          return;
        }
        const view = cmRef.current?.view;
        if (view) findNext(view);
        emitMatches();
      },
      findPrevious: () => {
        if (mdPreviewActiveRef.current) {
          mdFindRef.current?.findPrevious();
          return;
        }
        const view = cmRef.current?.view;
        if (view) findPrevious(view);
        emitMatches();
      },
      clearQuery: () => {
        if (mdPreviewActiveRef.current) {
          mdFindRef.current?.clearQuery();
          return;
        }
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({ search: "" })),
        });
        emitMatches();
      },
      setMatchListener: (cb) => {
        matchCbRef.current = cb;
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
        if (mdPreviewActiveRef.current) {
          mdFindRef.current?.open();
          return;
        }
        findReplaceRef.current?.open();
      },
      formatDocument: async () => {
        const view = cmRef.current?.view;
        if (!view) return;
        try {
          const current = view.state.doc.toString();
          const formatted = await formatDocument({ path: pathRef.current, content: current });
          // Skip if the user typed (or the view remounted) during the await,
          // so a stale result never clobbers fresh edits.
          const live = cmRef.current?.view;
          if (live === view && live.state.doc.toString() === current) {
            applyFormattedToView(formatted);
          }
        } catch (err) {
          toast(`Format failed: ${(err as Error).message}`, { variant: "error" });
        }
      },
      save: async () => {
        await saveRef.current();
        onSavedRef.current?.();
      },
    }),
    [path, emitMatches],
  );

  // ── Context-menu editor commands ──────────────────────────────────────────
  // Copy/cut write through the WebView clipboard (same as the explorer's
  // copyToClipboard); paste READS through the host process, see
  // `readClipboardText`. All are best-effort and refocus the editor afterward.
  const focusView = () => cmRef.current?.view?.focus();
  const handleCopy = () => {
    const view = cmRef.current?.view;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    void navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to)).catch(() => {});
    focusView();
  };
  const handleCut = () => {
    const view = cmRef.current?.view;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    void navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to)).catch(() => {});
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "" },
      selection: { anchor: sel.from },
    });
    focusView();
  };
  const handlePaste = () => {
    void readClipboardText().then((text) => {
      const v = cmRef.current?.view;
      if (!v || !text) return;
      const sel = v.state.selection.main;
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
      v.focus();
    });
  };
  const handleSelectAll = () => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    focusView();
  };
  const handleFormat = () => {
    const view = cmRef.current?.view;
    if (!view) return;
    void (async () => {
      try {
        const current = view.state.doc.toString();
        const formatted = await formatDocument({ path: pathRef.current, content: current });
        const live = cmRef.current?.view;
        if (live === view && live.state.doc.toString() === current) {
          applyFormattedToView(formatted);
        }
      } catch (err) {
        toast(`Format failed: ${(err as Error).message}`, { variant: "error" });
      }
    })();
  };

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
      <ContextMenu
        onOpenChange={(open) =>
          open && setMenuHasSelection(!cmRef.current?.view?.state.selection.main.empty)
        }
      >
        <ContextMenuTrigger asChild>
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
              onChange={handleChange}
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
            <EditorFindReplace ref={findReplaceRef} getView={getView} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52 rounded-2xl p-1">
          <ContextMenuItem
            className={COMPACT_ITEM}
            disabled={!menuHasSelection}
            onSelect={handleCopy}
          >
            Copy
            <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            className={COMPACT_ITEM}
            disabled={!menuHasSelection}
            onSelect={handleCut}
          >
            Cut
            <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem className={COMPACT_ITEM} onSelect={handlePaste}>
            Paste
            <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem className={COMPACT_ITEM} onSelect={handleSelectAll}>
            Select All
            <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className={COMPACT_ITEM} onSelect={handleFormat}>
            Format Document
            <ContextMenuShortcut>Shift+Alt+F</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className={COMPACT_ITEM}
            // Defer past the menu's close/focus-restore so the dialog opens cleanly.
            onSelect={() => requestAnimationFrame(() => setLangPickerOpen(true))}
          >
            Change Language Mode
            <span className="text-muted-foreground ml-auto pl-3 text-[11px]">
              {activeLangId ? languageLabel(activeLangId) : "Plain Text"}
            </span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <LanguagePickerDialog
        open={langPickerOpen}
        onOpenChange={setLangPickerOpen}
        currentId={activeLangId}
        detectedId={detectedLangId}
        isOverridden={langOverride !== null}
        onPick={handlePickLanguage}
      />
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
        <div className="absolute inset-0">
          <div ref={mdScrollRef} className="bg-background h-full w-full overflow-auto p-6">
            <Streamdown
              className="prose prose-sm dark:prose-invert max-w-3xl [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              urlTransform={safeUrlTransform}
              components={markdownComponents}
              controls={{ table: false }}
            >
              {liveContent}
            </Streamdown>
          </div>
          {/* Find bar lives OUTSIDE the scroller so its own text isn't searched. */}
          <MarkdownFindBar
            ref={mdFindRef}
            getContainer={getMdContainer}
            content={liveContent}
            onMatches={emitMdMatches}
          />
        </div>
      )}
    </div>
  );
}
