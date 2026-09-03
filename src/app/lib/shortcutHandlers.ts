import { type RefObject } from "react";
import { readClipboardText } from "@/lib/clipboard";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useWorkspacesStore } from "@/modules/workspaces";
import type { WorkspaceView } from "@/modules/workspaces/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setContentZoom,
  setLineWrap,
  CONTENT_ZOOM_DEFAULT,
  CONTENT_ZOOM_MAX,
  CONTENT_ZOOM_MIN,
  CONTENT_ZOOM_STEP,
} from "@/modules/settings/store";
import { type ShortcutHandlers } from "@/modules/shortcuts";
import { focusedTerminalLeafId, leaves, type TerminalPaneHandle } from "@/modules/terminal";
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
  handleCloseTabOrPane: () => void;
  cycleTab: (delta: 1 | -1) => void;
  selectByIndex: (idx: number) => void;
  splitActivePaneInActiveTab: (dir: "row" | "col", kind?: "terminal" | "editor") => void;
  focusNextPaneInTab: (tabId: number, delta: 1 | -1) => void;
  togglePanelAndFocus: () => void;
  askFromSelection: () => void;
  openScmTab: () => number;
  toggleSidebar: () => void;
  toggleRightSlot: () => void;
  requestCloseLeaf: (leafId: number) => void;
  setNewEditorOpen: (open: boolean) => void;
  setAgentDialogOpen: (open: boolean) => void;
  searchInlineRef: RefObject<SearchInlineHandle | null>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  tabsRef: RefObject<Tab[]>;
  activeId: number;
  activeLeafIdInTab: number | null;
  activeLeafKindCurrent: "terminal" | "editor" | "browser" | null;
  commandPaletteOpen: () => void;
}

export function buildShortcutHandlers(deps: ShortcutHandlerDeps): ShortcutHandlers {
  const {
    openNewTab,
    openNewPrivateTab,
    handleCloseTabOrPane,
    cycleTab,
    selectByIndex,
    splitActivePaneInActiveTab,
    focusNextPaneInTab,
    togglePanelAndFocus,
    askFromSelection,
    openScmTab,
    toggleSidebar,
    toggleRightSlot,
    requestCloseLeaf,
    setNewEditorOpen,
    setAgentDialogOpen,
    searchInlineRef,
    editorRefs,
    terminalRefs,
    tabsRef,
    activeId,
    activeLeafIdInTab,
    activeLeafKindCurrent,
    commandPaletteOpen,
  } = deps;

  // Terminal copy/paste act on the pane holding KEYBOARD focus (see
  // `focusedTerminalLeafId` for why the active leaf is the wrong anchor for a
  // bare Ctrl+C / Ctrl+V), falling back to the active leaf for the Command
  // Palette - it takes focus itself, and it bypasses the keyboard gate anyway.
  const copyPasteTarget = (): TerminalPaneHandle | undefined => {
    const leafId =
      focusedTerminalLeafId() ?? (activeLeafKindCurrent === "terminal" ? activeLeafIdInTab : null);
    return leafId === null ? undefined : terminalRefs.current.get(leafId);
  };

  return {
    "commandPalette.open": commandPaletteOpen,
    "tab.new": openNewTab,
    "tab.newPrivate": openNewPrivateTab,
    "tab.newEditor": () => setNewEditorOpen(true),
    "tab.newAgent": () => setAgentDialogOpen(true),
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
    "rightPanel.toggle": toggleRightSlot,
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
    "view.cycleWorkspaceView": () => {
      // Reads the store directly, like the zoom handlers above: the value lives
      // in one place and this needs no dependency threaded through App.
      const { workspaces, activeId, setWorkspaceView } = useWorkspacesStore.getState();
      if (!activeId) return;
      const order: WorkspaceView[] = ["tabs", "kanban", "canvas"];
      const current = workspaces.find((w) => w.id === activeId)?.view ?? "tabs";
      setWorkspaceView(activeId, order[(order.indexOf(current) + 1) % order.length]);
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
    // Copy terminal selection. Defaults: Cmd+C on macOS, Ctrl+Shift+C and bare
    // Ctrl+C elsewhere (see shortcuts.ts). No-op when nothing is selected.
    // useGlobalShortcuts preventDefaults the event so xterm never sees it, and
    // App's isDisabled only routes BARE Ctrl+C here when the focused terminal
    // has a selection - with none it falls through to xterm as SIGINT.
    "terminal.copy": (e) => {
      const term = copyPasteTarget();
      const sel = term?.getSelection();
      if (!sel) return;
      // Clipboard WRITES work through the webview API on every OS (they ride
      // the keystroke's user gesture); only reads need the host process, see
      // `readClipboardText`. Fire-and-forget; the usual failure is the document
      // not yet focused (window-switch race) and the user can retry.
      void navigator.clipboard.writeText(sel).catch((e) => {
        console.warn("terminal.copy: clipboard write failed:", e);
      });
      // Bare Ctrl+C only: drop the highlight so the next press is SIGINT again
      // (Windows Terminal / Termius). Ctrl+Shift+C, Cmd+C and the Command
      // Palette keep the selection, since none of them can strand the user.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) term?.clearSelection();
    },
    // Paste clipboard via term.paste so the shell gets a bracketed
    // paste (multi-line snippets don't auto-execute line by line under
    // bash/zsh). Defaults: Cmd+V on macOS, Ctrl+Shift+V, bare Ctrl+V or
    // Shift+Insert elsewhere (see shortcuts.ts). Identical for local and SSH
    // panes - the SSH channel is written through the same `session.pty.write`.
    "terminal.paste": () => {
      const term = copyPasteTarget();
      if (!term) return;
      void readClipboardText().then((text) => {
        if (text) term.paste(text);
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
