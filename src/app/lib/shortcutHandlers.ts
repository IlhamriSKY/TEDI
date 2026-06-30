import { type RefObject } from "react";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setContentZoom,
  setLineWrap,
  CONTENT_ZOOM_DEFAULT,
  CONTENT_ZOOM_MAX,
  CONTENT_ZOOM_MIN,
  CONTENT_ZOOM_STEP,
} from "@/modules/settings/store";
import { previewEmbedDispatch, focusBrowserAddressBar } from "@/modules/browser";
import { type ShortcutHandlers } from "@/modules/shortcuts";
import { leaves, type TerminalPaneHandle } from "@/modules/terminal";
import { type EditorPaneHandle } from "@/modules/editor";
import { type SearchInlineHandle } from "@/modules/header";
import { type Tab } from "@/modules/tabs";

/**
 * Component-local identifiers from App that the keyboard-shortcut handler
 * map closes over. Module-level dependencies (stores, constants, `leaves`,
 * openSettingsWindow) are imported directly above and are NOT threaded
 * through here. See App.tsx for the call site and its memo dep array.
 */
export interface ShortcutHandlerDeps {
  openNewTab: () => void;
  openNewPrivateTab: () => void;
  openPreviewTab: (url: string) => number | null;
  handleCloseTabOrPane: () => void;
  cycleTab: (delta: 1 | -1) => void;
  selectByIndex: (idx: number) => void;
  splitActivePaneInActiveTab: (
    dir: "row" | "col",
    kind?: "terminal" | "editor" | "browser",
  ) => void;
  focusNextPaneInTab: (tabId: number, delta: 1 | -1) => void;
  togglePanelAndFocus: () => void;
  askFromSelection: () => void;
  openScmTab: () => number;
  toggleSidebar: () => void;
  requestCloseLeaf: (leafId: number) => void;
  setNewEditorOpen: (open: boolean) => void;
  searchInlineRef: RefObject<SearchInlineHandle | null>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  tabsRef: RefObject<Tab[]>;
  activeId: number;
  activeLeafIdInTab: number | null;
  activeLeafKindCurrent: "terminal" | "editor" | "browser" | null;
}

export function buildShortcutHandlers(deps: ShortcutHandlerDeps): ShortcutHandlers {
  const {
    openNewTab,
    openNewPrivateTab,
    openPreviewTab,
    handleCloseTabOrPane,
    cycleTab,
    selectByIndex,
    splitActivePaneInActiveTab,
    focusNextPaneInTab,
    togglePanelAndFocus,
    askFromSelection,
    openScmTab,
    toggleSidebar,
    requestCloseLeaf,
    setNewEditorOpen,
    searchInlineRef,
    editorRefs,
    terminalRefs,
    tabsRef,
    activeId,
    activeLeafIdInTab,
    activeLeafKindCurrent,
  } = deps;
  return {
    "tab.new": openNewTab,
    "tab.newPrivate": openNewPrivateTab,
    "tab.newPreview": () => openPreviewTab(""),
    "tab.newEditor": () => setNewEditorOpen(true),
    "tab.close": handleCloseTabOrPane,
    "tab.next": () => cycleTab(1),
    "tab.prev": () => cycleTab(-1),
    "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
    // Ctrl+D: horizontal split (new pane beside focus).
    // Ctrl+Shift+D: vertical split (new pane below focus).
    "pane.splitRight": () => splitActivePaneInActiveTab("row"),
    "pane.splitDown": () => splitActivePaneInActiveTab("col"),
    "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
    "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
    // Split the active pane to the right with a browser instead of a terminal.
    "pane.splitBrowser": () => splitActivePaneInActiveTab("row", "browser"),
    // Browser-pane actions. App's isDisabled gates these to a focused browser
    // pane, so the guards below are belt-and-suspenders. previewEmbedDispatch
    // drives the native webview's own history/reload by leaf id (the same path
    // the AI uses), so no browser-handle registry is needed; address-bar focus
    // goes through a leaf-id window event for the same reason.
    "browser.reload": () => {
      if (activeLeafKindCurrent !== "browser" || activeLeafIdInTab === null) return;
      void previewEmbedDispatch(activeLeafIdInTab, "reload").catch(() => {});
    },
    "browser.back": () => {
      if (activeLeafKindCurrent !== "browser" || activeLeafIdInTab === null) return;
      void previewEmbedDispatch(activeLeafIdInTab, "back").catch(() => {});
    },
    "browser.forward": () => {
      if (activeLeafKindCurrent !== "browser" || activeLeafIdInTab === null) return;
      void previewEmbedDispatch(activeLeafIdInTab, "forward").catch(() => {});
    },
    "browser.focusAddressBar": () => {
      if (activeLeafKindCurrent !== "browser" || activeLeafIdInTab === null) return;
      focusBrowserAddressBar(activeLeafIdInTab);
    },
    "search.focus": () => searchInlineRef.current?.focus(),
    "editor.findReplace": () => {
      // VSCode-style Ctrl+H opens the find/replace overlay inside the
      // active editor. Falls through silently when the focused leaf isn't
      // an editor; the global shortcut still consumes the key to match
      // VSCode's behavior of preventing the browser's history palette.
      if (activeLeafKindCurrent !== "editor" || activeLeafIdInTab === null) return;
      const handle = editorRefs.current.get(activeLeafIdInTab);
      handle?.openFindReplace();
    },
    "ai.toggle": togglePanelAndFocus,
    "ai.askSelection": askFromSelection,
    "scm.open": () => {
      openScmTab();
    },
    "shortcuts.open": () => void openSettingsWindow("shortcuts"),
    "settings.open": () => void openSettingsWindow(),
    "sidebar.toggle": toggleSidebar,
    "view.zoomIn": () => {
      const current = usePreferencesStore.getState().contentZoom;
      const next = Math.min(
        CONTENT_ZOOM_MAX,
        Math.round((current + CONTENT_ZOOM_STEP) * 100) / 100,
      );
      if (next !== current) void setContentZoom(next);
    },
    "view.zoomOut": () => {
      const current = usePreferencesStore.getState().contentZoom;
      const next = Math.max(
        CONTENT_ZOOM_MIN,
        Math.round((current - CONTENT_ZOOM_STEP) * 100) / 100,
      );
      if (next !== current) void setContentZoom(next);
    },
    "view.zoomReset": () => {
      if (usePreferencesStore.getState().contentZoom !== CONTENT_ZOOM_DEFAULT) {
        void setContentZoom(CONTENT_ZOOM_DEFAULT);
      }
    },
    "editor.toggleWordWrap": () => {
      void setLineWrap(!usePreferencesStore.getState().lineWrap);
    },
    "editor.formatDocument": () => {
      // Falls through silently when the focused leaf isn't an editor —
      // matches VSCode's behaviour of consuming the chord regardless so
      // the OS / browser default never fires.
      if (activeLeafKindCurrent !== "editor" || activeLeafIdInTab === null) return;
      void editorRefs.current.get(activeLeafIdInTab)?.formatDocument();
    },
    // Copy terminal selection. Defaults: Cmd+C on macOS, Ctrl+Shift+C
    // elsewhere (see shortcuts.ts). No-op when nothing is selected.
    // useGlobalShortcuts preventDefaults the event so xterm never sees
    // it. Bare Ctrl+C falls through to xterm and sends SIGINT.
    "terminal.copy": () => {
      if (activeLeafIdInTab === null || activeLeafKindCurrent !== "terminal") return;
      const term = terminalRefs.current.get(activeLeafIdInTab);
      const sel = term?.getSelection();
      if (!sel) return;
      // navigator.clipboard works in Tauri 2's webview without prompting.
      // Fire-and-forget; the usual failure is the document not yet
      // focused (window-switch race) and the user can retry.
      void navigator.clipboard.writeText(sel).catch((e) => {
        console.warn("terminal.copy: clipboard write failed:", e);
      });
    },
    // Paste clipboard via term.paste so the shell gets a bracketed
    // paste (multi-line snippets don't auto-execute line by line under
    // bash/zsh). Defaults: Cmd+V on macOS, Ctrl+Shift+V or Shift+Insert
    // elsewhere (see shortcuts.ts).
    "terminal.paste": () => {
      if (activeLeafIdInTab === null || activeLeafKindCurrent !== "terminal") return;
      const term = terminalRefs.current.get(activeLeafIdInTab);
      if (!term) return;
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch((e) => {
          console.warn("terminal.paste: clipboard read failed:", e);
        });
    },
    // Ctrl+Shift+X: close the focused terminal pane. Blocked when it's
    // the last terminal in the workspace, mirroring the respawn rule in
    // handleLeafExit. Routes through `requestCloseLeaf` so a busy terminal
    // confirms before being killed.
    "terminal.close": () => {
      if (activeLeafIdInTab === null || activeLeafKindCurrent !== "terminal") return;
      let terminalLeafCount = 0;
      for (const t of tabsRef.current) {
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) if (l.leafKind === "terminal") terminalLeafCount++;
      }
      if (terminalLeafCount <= 1) return;
      requestCloseLeaf(activeLeafIdInTab);
    },
  };
}
