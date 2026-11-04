import { type RefObject } from "react";
import { toast } from "@/components/ui/toast";
import { readClipboardText } from "@/lib/clipboard";
import { stop as stopAi, useChatStore } from "@/modules/ai/store/chatStore";
import { useNotesStore } from "@/modules/notes";
import { reopenLeft, useSidebarPlacementStore } from "@/modules/extensions/sidebarPlacementStore";
import { useSshRightPanelStore } from "@/modules/ssh/sshRightPanelStore";
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
import { isUserEvent, type ShortcutHandlers } from "@/modules/shortcuts";
import { cycleFocusRegion, focusPaneGutter } from "@/modules/shortcuts/lib/focusRegions";
import {
  FLOAT_LEAF_EVENT,
  OPEN_SSH_MENU_EVENT,
  RENAME_LEAF_EVENT,
} from "@/modules/shortcuts/shortcuts";
import {
  disconnectSsh,
  findLeaf,
  focusedTerminalLeafId,
  lastCommandOutput,
  leaves,
  reconnectSsh,
  scrollTerminalToCommand,
  scrollTerminalToEdge,
  selectAllInTerminal,
  clearTerminalScrollback,
  type TerminalPaneHandle,
} from "@/modules/terminal";
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
  swapLeafWithNeighbor: (leafId: number, delta: 1 | -1) => void;
  togglePanelAndFocus: () => void;
  askFromSelection: () => void;
  openScmTab: () => number;
  toggleSidebar: () => void;
  toggleRightSlot: () => void;
  requestCloseLeaf: (leafId: number) => void;
  setNewEditorOpen: (open: boolean) => void;
  /** Retargets an editor leaf onto another file. Used by Save As so the pane
   *  follows the file it just wrote. */
  setEditorLeafPath: (leafId: number, path: string) => void;
  setAgentDialogOpen: (open: boolean) => void;
  searchInlineRef: RefObject<SearchInlineHandle | null>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  tabsRef: RefObject<Tab[]>;
  activeId: number;
  activeLeafIdInTab: number | null;
  activeLeafKindCurrent: "terminal" | "editor" | "browser" | null;
  commandPaletteOpen: () => void;
  switchToWorkspace: (workspaceId: string) => void;
  createNewWorkspace: () => void;
  reorderTabs: (fromTabId: number, beforeTabId: number | null) => void;
  setTabPinned: (tabId: number, pinned: boolean) => void;
  toggleMdPreviewForLeaf: (leafId: number) => void;
  hasComposer: boolean;
  /** Expand the column the AI panel lives in; open is not the same as on screen. */
  revealAiColumn: () => void;
}

/**
 * Save an editor leaf by id. `saveAs` picks a path in the native dialog and
 * retargets the leaf onto it, so the tab title, the language mode and the next
 * Ctrl+S all follow the new file (VSCode behaviour).
 *
 * Takes a leaf id rather than reading the active one, because the tab context
 * menu acts on the tab you right-clicked, which is not necessarily the focused
 * one. Silent when that leaf is not an editor - same fall-through as Format
 * Document.
 */
export function saveEditorLeaf(
  deps: Pick<ShortcutHandlerDeps, "editorRefs" | "setEditorLeafPath">,
  leafId: number,
  mode: "save" | "saveAs",
): void {
  const handle = deps.editorRefs.current.get(leafId);
  if (!handle) return;
  if (mode === "save") {
    void handle.save();
    return;
  }
  void handle.saveAs().then((saved) => {
    if (saved) deps.setEditorLeafPath(leafId, saved);
  });
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
    swapLeafWithNeighbor,
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
    switchToWorkspace,
    createNewWorkspace,
    reorderTabs,
    setTabPinned,
    toggleMdPreviewForLeaf,
    hasComposer,
    revealAiColumn,
  } = deps;

  // The terminal a command acts on: the focused one, else the active leaf, since
  // the Command Palette holds focus itself while it runs a command.
  const terminalLeaf = (): number | null =>
    focusedTerminalLeafId() ?? (activeLeafKindCurrent === "terminal" ? activeLeafIdInTab : null);

  // `run_command` runs registered commands with a synthetic event, so an agent
  // could otherwise select-all or copy a private pane, whose text must never reach
  // it, and read it back. A real keypress or the palette is the user asking.
  const readableBy = (e: KeyboardEvent, leafId: number): boolean => {
    if (isUserEvent(e)) return true;
    for (const t of tabsRef.current) {
      const leaf = t.kind === "pane" ? findLeaf(t.paneTree, leafId) : null;
      if (leaf) return !leaf.private;
    }
    return false;
  };

  // Tabs in the order the strip draws them; a snoozed one is not on it.
  const moveActiveTab = (delta: 1 | -1) => {
    const shown = tabsRef.current.filter((t) => !t.snoozed);
    const i = shown.findIndex((t) => t.id === activeId);
    if (i < 0) return;
    if (delta < 0 && i > 0) reorderTabs(activeId, shown[i - 1].id);
    if (delta > 0 && i < shown.length - 1) reorderTabs(activeId, shown[i + 2]?.id ?? null);
  };

  const cycleWorkspace = (delta: 1 | -1) => {
    const { workspaces, activeId: current } = useWorkspacesStore.getState();
    if (workspaces.length < 2) return;
    const i = workspaces.findIndex((w) => w.id === current);
    switchToWorkspace(workspaces[(i + delta + workspaces.length) % workspaces.length].id);
  };

  const focusActivePane = (): boolean => {
    if (activeLeafIdInTab === null) return false;
    const handle =
      terminalRefs.current.get(activeLeafIdInTab) ?? editorRefs.current.get(activeLeafIdInTab);
    handle?.focus();
    return !!handle;
  };

  // Terminal copy/paste act on the pane holding KEYBOARD focus (see
  // `focusedTerminalLeafId` for why the active leaf is the wrong anchor for a
  // bare Ctrl+C / Ctrl+V), falling back to the active leaf for the Command
  // Palette - it takes focus itself, and it bypasses the keyboard gate anyway.
  const copyPasteTarget = (): TerminalPaneHandle | undefined => {
    const leafId = terminalLeaf();
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
    // `e.code`, like the match: on AZERTY the digit row's `e.key` is "&" and so on.
    "tab.selectByIndex": (e) => selectByIndex(Number(e.code.slice(-1)) - 1),
    "tab.rename": () => {
      if (activeLeafIdInTab === null) return;
      const ask = new CustomEvent(RENAME_LEAF_EVENT, {
        detail: activeLeafIdInTab,
        cancelable: true,
      });
      // Uncancelled means no strip heard it: the kanban and canvas views have none.
      if (window.dispatchEvent(ask)) toast("Switch to the tabs view to rename a tab");
    },
    "tab.pin": () => {
      const tab = tabsRef.current.find((t) => t.id === activeId);
      if (tab) setTabPinned(tab.id, !tab.pinned);
    },
    "tab.moveLeft": () => moveActiveTab(-1),
    "tab.moveRight": () => moveActiveTab(1),
    "focus.nextRegion": () => cycleFocusRegion(1, focusActivePane),
    "focus.prevRegion": () => cycleFocusRegion(-1, focusActivePane),
    "workspace.new": createNewWorkspace,
    "workspace.next": () => cycleWorkspace(1),
    "workspace.prev": () => cycleWorkspace(-1),
    "workspace.selectByIndex": (e) => {
      const target = useWorkspacesStore.getState().workspaces[Number(e.code.slice(-1)) - 1];
      if (target) switchToWorkspace(target.id);
    },
    "ssh.menu": () => window.dispatchEvent(new Event(OPEN_SSH_MENU_EVENT)),
    // The Remote tree is a sidebar section by default, and only a right-panel
    // surface once docked there. With no SSH pane there is no tree to show.
    "ssh.files": () => {
      const hasSsh = tabsRef.current.some(
        (t) =>
          t.kind === "pane" &&
          leaves(t.paneTree).some(
            (l) => l.leafKind === "terminal" && l.sshConnectionId !== undefined,
          ),
      );
      if (!hasSsh) return;
      if (usePreferencesStore.getState().sshInRightPanel) useSshRightPanelStore.getState().toggle();
      else if (useSidebarPlacementStore.getState().leftClosed.ssh) reopenLeft("ssh");
      else toggleSidebar();
    },
    "ssh.reconnect": () => {
      const leafId = terminalLeaf();
      if (leafId !== null) void reconnectSsh(leafId);
    },
    "ssh.disconnect": () => {
      const leafId = terminalLeaf();
      if (leafId !== null) void disconnectSsh(leafId);
    },
    // With no provider key there is no composer to host either of these, and
    // `togglePanelAndFocus` already sends the user to add one.
    "ai.newChat": () => {
      if (!hasComposer) return togglePanelAndFocus();
      const chat = useChatStore.getState();
      chat.newSession();
      chat.openPanel();
      revealAiColumn();
      chat.focusInput();
    },
    "ai.history": () => {
      if (!hasComposer) return togglePanelAndFocus();
      const chat = useChatStore.getState();
      chat.openPanel();
      revealAiColumn();
      chat.setShowHistoryPicker(true);
    },
    "ai.stop": stopAi,
    // Ctrl+D: horizontal split (new pane beside focus), Alt+Shift+D inside a
    // terminal, which keeps Ctrl+D as EOF.
    // Ctrl+Shift+D: vertical split (new pane below focus).
    "pane.splitRight": () => splitActivePaneInActiveTab("row"),
    "pane.float": () => {
      if (activeLeafIdInTab === null) return;
      window.dispatchEvent(new CustomEvent(FLOAT_LEAF_EVENT, { detail: activeLeafIdInTab }));
    },
    "pane.resize": () => {
      if (activeLeafIdInTab !== null) focusPaneGutter(activeLeafIdInTab, focusActivePane);
    },
    "pane.splitDown": () => splitActivePaneInActiveTab("col"),
    "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
    "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
    "pane.swapNext": () => {
      if (activeLeafIdInTab !== null) swapLeafWithNeighbor(activeLeafIdInTab, 1);
    },
    "pane.swapPrev": () => {
      if (activeLeafIdInTab !== null) swapLeafWithNeighbor(activeLeafIdInTab, -1);
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
    // Reads the store directly rather than threading a dep through App: the
    // header button toggles the same flag, and nothing else in App needs it.
    "notes.toggle": () => useNotesStore.getState().toggleOpen(),
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
    "editor.markdownPreview": () => {
      if (activeLeafKindCurrent === "editor" && activeLeafIdInTab !== null) {
        toggleMdPreviewForLeaf(activeLeafIdInTab);
      }
    },
    "editor.saveAs": () => {
      if (activeLeafKindCurrent !== "editor" || activeLeafIdInTab === null) return;
      saveEditorLeaf(deps, activeLeafIdInTab, "saveAs");
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
      const leafId = terminalLeaf();
      if (leafId === null || !readableBy(e, leafId)) return;
      const term = terminalRefs.current.get(leafId);
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
    // App's `isDisabled` only lets these keys through while a terminal has focus.
    "terminal.prevCommand": () => {
      const leafId = terminalLeaf();
      if (leafId !== null) scrollTerminalToCommand(leafId, -1);
    },
    "terminal.nextCommand": () => {
      const leafId = terminalLeaf();
      if (leafId !== null) scrollTerminalToCommand(leafId, 1);
    },
    "terminal.clear": () => {
      const leafId = terminalLeaf();
      if (leafId !== null) clearTerminalScrollback(leafId);
    },
    "terminal.selectAll": (e) => {
      const leafId = terminalLeaf();
      if (leafId !== null && readableBy(e, leafId)) selectAllInTerminal(leafId);
    },
    "terminal.copyLastOutput": (e) => {
      const leafId = terminalLeaf();
      if (leafId === null || !readableBy(e, leafId)) return;
      const output = lastCommandOutput(leafId);
      // Empty too: a cleared screen disposes the markers, and copying "" would wipe
      // the clipboard while reporting success.
      if (!output) {
        toast("No finished command to copy yet", { variant: "error" });
        return;
      }
      void navigator.clipboard.writeText(output).then(
        () => toast("Copied last command output"),
        (err) => console.warn("terminal.copyLastOutput: clipboard write failed:", err),
      );
    },
    "terminal.scrollTop": () => {
      const leafId = terminalLeaf();
      if (leafId !== null) scrollTerminalToEdge(leafId, "top");
    },
    "terminal.scrollBottom": () => {
      const leafId = terminalLeaf();
      if (leafId !== null) scrollTerminalToEdge(leafId, "bottom");
    },
  };
}
