import { LazyStore } from "@tauri-apps/plugin-store";
import { registerBridge } from "@/modules/automation/bridge";
import { sortPinnedFirst } from "@/lib/pinned";
import type { AiCliKind } from "@/modules/terminal/lib/aiCliStatus";
import { create } from "zustand";

const STORE_PATH = "tedi-workspaces.json";
const KEY_LIST = "workspaces";
const KEY_ACTIVE = "activeId";

// Saved on-disk shape. Persists only what's needed to reconstruct tabs on
// next launch. Terminals respawn at their saved cwd; editors reopen the path.

export type SavedTerminalLeaf = {
  kind: "leaf";
  leafKind: "terminal";
  cwd?: string;
  /** SSH connection id for SSH-bound leaves. */
  sshConnectionId?: string;
  /** FIFO chip number. Persisted so "Terminal 3" stays the same after restart. Backfilled by `useTabs.ts` for older state. */
  terminalOrdinal?: number;
  /** Per-leaf privacy flag. AI subsystem ignores private leaves. */
  private?: boolean;
  /** Per-pane terminal theme override (a `TERMINAL_PRESETS` id). Persisted so a
   *  pane keeps its chosen palette across restart. Absent = follow global. */
  terminalThemeId?: string;
  /**
   * Daemon-owned PTY UUID. When present on next launch the restore path
   * calls `pty_attach` to resume the shell with its scrollback; on attach
   * failure (daemon was killed, system rebooted) the leaf falls back to a
   * fresh `pty_open`. Absent on SSH leaves and on builds where the daemon
   * backend is unavailable.
   */
  ptyId?: string;
  /**
   * Last program-set window title (OSC 0/2) captured from the live xterm -
   * e.g. a running agent's task or a TUI's filename. Persisted so the
   * Workspaces panel can show it next to the folder name for INACTIVE
   * workspaces too; live titles only exist for the active workspace's
   * terminals. Omitted for private leaves. May be stale after a restart
   * until the workspace is reopened and its terminals go live again.
   */
  title?: string;
  /**
   * AI CLI kind that was running in this terminal at snapshot time (only
   * persisted for reattachable local leaves, i.e. alongside `ptyId`). On
   * restore it pre-activates the detector so a still-running agent shows its
   * working/blocking badge immediately after reattach instead of going dark.
   */
  activeTool?: AiCliKind;
  /**
   * User-chosen tab name from the tab's right-click "Rename". Distinct from
   * `title` above, which is the program-set OSC title and is derived, not
   * chosen: this one is the user's and must survive a restart, so it is
   * persisted for private leaves too (it holds no shell or path information -
   * only what the user decided to call the tab).
   */
  customTitle?: string;
};

export type SavedEditorLeaf = {
  kind: "leaf";
  leafKind: "editor";
  path: string;
  /**
   * Saved SSH connection id when this file lives on a remote host. `path` is
   * then a path on THAT host, never on the local disk. The live russh session
   * number is deliberately not persisted (it is dead after a restart, and the
   * counter restarts from 1, so it would point at whichever host connected
   * first); the pane re-resolves this id to a live session instead.
   * Absent = local file, which is every leaf written before this field existed.
   */
  sshConnectionId?: string;
  /** Display label for the remote host, shown while the leaf waits to rebind. */
  sshHostLabel?: string;
  /** Per-leaf privacy flag. AI inline autocomplete refuses on private leaves. */
  private?: boolean;
  /** User-chosen tab name from the tab's right-click "Rename". */
  customTitle?: string;
};

export type SavedBrowserLeaf = {
  kind: "leaf";
  leafKind: "browser";
  /** Last URL the embedded browser showed. Reopened on restore. */
  url: string;
  /** FIFO chip number ("Browser 3"). Persisted so it stays stable after restart. */
  browserOrdinal?: number;
  private?: boolean;
  /** User-chosen tab name from the tab's right-click "Rename". */
  customTitle?: string;
};

/**
 * The workspace Board pane. Holds nothing: its columns are rebuilt from the
 * live tab tree, so existence is the whole of its saved state. That is what
 * lets a pane tab containing one be persisted normally, unlike an
 * extension-panel leaf (which needs a live host and takes its whole tab down
 * with it).
 */
export type SavedBoardLeaf = {
  kind: "leaf";
  leafKind: "board";
  private?: boolean;
  /** User-chosen tab name from the tab's right-click "Rename". */
  customTitle?: string;
};

/**
 * Source Control as a pane leaf. Stateless like the board: the panel reads the
 * live workspace root, so existence is the whole of its saved state.
 */
export type SavedScmLeaf = {
  kind: "leaf";
  leafKind: "scm";
  private?: boolean;
  /** User-chosen tab name from the tab's right-click "Rename". */
  customTitle?: string;
};

/**
 * An extension panel mounted as a pane (SQL Explorer, API Client). Restorable
 * from its ids alone: `ExtensionPanelMount` subscribes to the renderer registry
 * and shows a placeholder until the owning extension finishes activating, so a
 * restored leaf lights up on its own. Before this existed the whole pane TAB
 * was dropped from the snapshot, which meant a canvas holding a database or API
 * window vanished on restart along with the terminals beside it.
 */
export type SavedExtensionPanelLeaf = {
  kind: "leaf";
  leafKind: "extension-panel";
  extensionId: string;
  panelId: string;
  /** Which instance of a per-key panel this is. */
  reuseKey?: string;
  /** Cached chrome (label + icon hint) so the strip reads right before the
   *  extension activates and refreshes them. */
  title?: string;
  icon?: string;
  private?: boolean;
  customTitle?: string;
};

/**
 * An AI chat pane. Only the session id: the conversation lives in the global
 * chat store, so a restored pane rebinds to the same chat, and a session the
 * user has since deleted restores as an empty shell rather than a dead pane.
 */
export type SavedAiLeaf = {
  kind: "leaf";
  leafKind: "ai";
  sessionId: string;
  private?: boolean;
  customTitle?: string;
};

/** One canvas window's geometry, percentages of the canvas box. Saved on the
 *  LEAF (see `CanvasRect`), so it travels with the pane and needs no positional
 *  side-table keyed by ids a saved tree does not carry. */
export type SavedCanvasRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Per-pane content zoom. Absent = 1. */
  zoom?: number;
};

/** Shared by every saved leaf kind: the pane's rectangle in the workspace's
 *  canvas view. Absent = never placed there. */
type SavedLeafCommon = { canvasRect?: SavedCanvasRect };

export type SavedPaneNode =
  | ((
      | SavedTerminalLeaf
      | SavedEditorLeaf
      | SavedBrowserLeaf
      | SavedBoardLeaf
      | SavedScmLeaf
      | SavedExtensionPanelLeaf
      | SavedAiLeaf
    ) &
      SavedLeafCommon)
  | {
      kind: "split";
      dir: "row" | "col";
      children: SavedPaneNode[];
      /** Per-child size percentages (0..100), so restore keeps divider positions. */
      sizes?: number[];
    };

export type SavedPaneTab = {
  kind: "pane";
  title?: string;
  paneTree: SavedPaneNode;
  /** Index of the active leaf when reading from `leaves(paneTree)`. */
  activeLeafIndex: number;
  /** Pinned tabs sort ahead of the rest and render compact. Persisted because
   *  a pin the user has to redo on every launch is not a pin. Absent on state
   *  written before pinning existed, which reads as unpinned. */
  pinned?: boolean;
  /**
   * Canvas mode: one rectangle per SAVED leaf, in `leaves(paneTree)` order.
   * Present = this tab restores as a canvas. Positional rather than keyed by
   * leaf id for the same reason `activeLeafIndex` is an index: a saved tree
   * carries no ids, restore mints fresh ones.
   */
  canvas?: SavedCanvasRect[];
};

/**
 * Legacy standalone browser ("preview") tab format from before browsers became
 * pane leaves. The on-disk discriminator stays `"preview"` for back-compat;
 * `savedToTab` migrates it into a pane tab with a single browser leaf.
 */
export type SavedPreviewTab = {
  kind: "preview";
  url: string;
  title?: string;
};

export type SavedTab = SavedPaneTab | SavedPreviewTab;
// ai-diff tabs are session-only. Never persisted.

/**
 * How a workspace's panes are presented. `tabs` is the classic strip of tabs and
 * splits; `kanban` charts its terminals by what their AI CLI is doing; `canvas`
 * floats every pane of the workspace as a draggable, resizable window on one
 * surface. Per WORKSPACE, not per tab: the tab strip is hidden in the other two,
 * because both of them already show the whole workspace at once.
 */
export type WorkspaceView = "tabs" | "kanban" | "canvas";

export type Workspace = {
  id: string;
  name: string;
  tabs: SavedTab[];
  activeTabIndex: number;
  /** Absent on state written before views existed, which reads as "tabs". */
  view?: WorkspaceView;
  /**
   * Pinned workspaces sort to the top of the panel and show a pin instead of
   * the close button.
   *
   * A SEPARATE AXIS from a pinned TAB, and worth keeping straight: pinning a
   * workspace says "keep this project at the top of my list", while pinning a
   * tab inside it says "keep this tab at the front of that workspace's strip".
   * A workspace can be unpinned and still contain pinned tabs, and vice versa;
   * neither implies the other. The two surfaces are far apart on screen and
   * each names its own subject in the menu ("Pin Workspace" vs "Pin Tab"), so
   * the only real hazard is documentation, which this comment is.
   */
  pinned?: boolean;
};

type State = {
  hydrated: boolean;
  workspaces: Workspace[];
  activeId: string | null;
};

type Actions = {
  hydrate: () => Promise<void>;
  /** Force a synchronous-as-possible write of the current state to disk.
   *  Called on window close so a just-closed pane / latest layout is durable
   *  before the app quits (the per-change save is fire-and-forget). */
  flush: () => Promise<void>;
  setWorkspaces: (workspaces: Workspace[]) => void;
  setActiveId: (id: string | null) => void;
  /** Create an empty workspace. Caller must save prior tabs and call setActiveId to switch. */
  createWorkspace: (name: string) => Workspace;
  renameWorkspace: (id: string, name: string) => void;
  /** Switch a workspace between the tabs / kanban / canvas presentations. */
  setWorkspaceView: (id: string, view: WorkspaceView) => void;
  /** Pin or unpin a workspace, re-sorting so pinned ones stay on top. */
  setWorkspacePinned: (id: string, pinned: boolean) => void;
  removeWorkspace: (id: string) => void;
  /** Replace a workspace's saved tabs. Used before a switch. `liveTabCount` is
   *  the number of LIVE tabs the snapshot came from (before serialization drops
   *  session-only kinds); it lets the anti-wipe guard tell a legitimate
   *  all-session-only emptying (liveTabCount > 0) from a transient truly-empty
   *  state (liveTabCount 0). */
  saveWorkspaceTabs: (
    id: string,
    tabs: SavedTab[],
    activeTabIndex: number,
    liveTabCount?: number,
  ) => void;
  /** Reorder via drag-and-drop: move `activeId` into `overId`'s slot. */
  reorderWorkspaces: (activeId: string, overId: string) => void;
};

export const useWorkspacesStore = create<State & Actions>((set, get) => {
  const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

  const persist = async () => {
    const { workspaces, activeId } = get();
    await Promise.all([store.set(KEY_LIST, workspaces), store.set(KEY_ACTIVE, activeId)]);
    await store.save();
  };

  return {
    hydrated: false,
    workspaces: [],
    activeId: null,

    flush: () => persist(),

    async hydrate() {
      let list: Workspace[] = [];
      let active: string | null = null;
      let readFailed = false;
      // Retry a few times with a short backoff: a read can transiently fail on a
      // file lock during an auto-update handoff (the old instance hasn't
      // released the store yet). Letting it clear avoids falling through to a
      // default that then overwrites recoverable saved workspaces. A genuinely
      // corrupt/parse failure just exhausts the retries. `hydrated` MUST still
      // flip true regardless - the `tedi .` CLI drain and other consumers gate
      // on it, so a read failure that left it false would strand them, not just
      // lose the saved workspaces.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          list = (await store.get<Workspace[]>(KEY_LIST)) ?? [];
          active = (await store.get<string | null>(KEY_ACTIVE)) ?? null;
          readFailed = false;
          break;
        } catch {
          readFailed = true;
          list = [];
          active = null;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 150));
        }
      }
      // Seed a default workspace on first run (or after a read failure).
      if (list.length === 0) {
        const ws: Workspace = {
          id: newWorkspaceId(),
          name: "Workspace 1",
          tabs: [],
          activeTabIndex: 0,
        };
        set({ workspaces: [ws], activeId: ws.id, hydrated: true });
        // Only overwrite the on-disk store on a GENUINE first run (the read
        // succeeded and returned nothing). If the read THREW - a transient file
        // lock (an in-progress update handoff), a partial write, momentary
        // corruption - do NOT persist the empty default over it: that would
        // permanently blank a user's saved workspaces on a single bad read.
        // Leaving the file untouched lets the next healthy launch recover it;
        // the first real change re-persists.
        if (!readFailed) {
          try {
            await persist();
          } catch {
            // Best-effort persist; the in-memory default is enough to boot.
          }
        }
        return;
      }
      set({
        // Re-impose the invariant on read. The saved order is normally already
        // correct, but state written by an older build (or by hand) has never
        // been through it, and a pinned workspace sitting below unpinned ones
        // would stay stuck there until something happened to reorder the list.
        workspaces: sortPinnedFirst(list),
        activeId: active ?? list[0]?.id ?? null,
        hydrated: true,
      });
    },

    setWorkspaces(workspaces) {
      set({ workspaces });
      void persist();
    },

    setActiveId(activeId) {
      set({ activeId });
      void persist();
    },

    createWorkspace(name) {
      const ws: Workspace = {
        id: newWorkspaceId(),
        name,
        tabs: [],
        activeTabIndex: 0,
      };
      set({ workspaces: [...get().workspaces, ws] });
      void persist();
      return ws;
    },

    renameWorkspace(id, name) {
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
      });
      void persist();
    },

    setWorkspaceView(id, view) {
      if (get().workspaces.find((w) => w.id === id)?.view === view) return;
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, view } : w)),
      });
      void persist();
    },

    removeWorkspace(id) {
      const before = get();
      const removedIdx = before.workspaces.findIndex((w) => w.id === id);
      const next = before.workspaces.filter((w) => w.id !== id);
      // Always keep at least one workspace. Collapse to a default on last-delete.
      if (next.length === 0) {
        const ws: Workspace = {
          id: newWorkspaceId(),
          name: "Workspace 1",
          tabs: [],
          activeTabIndex: 0,
        };
        set({ workspaces: [ws], activeId: ws.id });
      } else {
        // Closing the active workspace hands focus to a neighbor (below if available, else above).
        const neighborIdx = removedIdx >= next.length ? next.length - 1 : removedIdx;
        const newActive = before.activeId === id ? next[neighborIdx].id : before.activeId;
        set({ workspaces: next, activeId: newActive });
      }
      void persist();
    },

    saveWorkspaceTabs(id, tabs, activeTabIndex, liveTabCount) {
      let changed = false;
      set({
        workspaces: get().workspaces.map((w) => {
          if (w.id !== id) return w;
          // Anti-wipe safety net: refuse an EMPTY snapshot over a workspace that
          // already has saved panes ONLY when the LIVE tabs were also empty
          // (liveTabCount 0) - a transient/error state (an exit cascade, a
          // mid-restore render, a switch flicker), never a real user action
          // since closeTab always keeps >=1 tab. When liveTabCount > 0 the
          // serialize is empty only because every remaining tab is session-only
          // (ai-diff/scm/ext) - a legitimate "closed all panes", so persist it
          // (else a deliberately closed pane revives on the next launch).
          if (tabs.length === 0 && w.tabs.length > 0 && (liveTabCount ?? 0) === 0) return w;
          changed = true;
          return { ...w, tabs, activeTabIndex };
        }),
      });
      if (changed) void persist();
    },

    setWorkspacePinned(id, pinned) {
      const list = get().workspaces;
      const target = list.find((w) => w.id === id);
      if (!target || (target.pinned ?? false) === pinned) return;
      set({
        workspaces: sortPinnedFirst(list.map((w) => (w.id === id ? { ...w, pinned } : w))),
      });
      void persist();
    },

    reorderWorkspaces(activeId, overId) {
      if (activeId === overId) return;
      const list = get().workspaces;
      const from = list.findIndex((w) => w.id === activeId);
      const to = list.findIndex((w) => w.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      // arrayMove: pull `from` out, splice it back in at `to`.
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      // Then re-impose the pinned split, so a drag across the boundary lands at
      // the nearest legal slot rather than being ignored.
      set({ workspaces: sortPinnedFirst(next) });
      void persist();
    },
  };
});

export function newWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Workspaces, for the automation bridge.
 *
 * The one part of TEDI's shape an agent could not see AT ALL. `panes()` reads
 * `tabsRef`, which is the ACTIVE workspace's tabs, so every pane in every other
 * workspace was invisible with nothing saying so - and since 0.4.39 a workspace
 * is also looked at three ways (tabs, kanban, canvas), which changes what
 * clicking and dragging even mean. An agent that cannot read `view` is guessing.
 *
 * Names and counts only, never `tabs`: the saved tab tree is the biggest object
 * in the store and an agent asking "which workspace am I in" does not want it.
 * Read-only on purpose - switching workspaces tears down and rebuilds every
 * pane, which is not something to hand over without a user asking for it.
 */
export function listWorkspacesForAgent(): Array<{
  id: string;
  name: string;
  active: boolean;
  view: WorkspaceView;
  tabCount: number;
  pinned: boolean;
}> {
  const { workspaces, activeId } = useWorkspacesStore.getState();
  return workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    active: w.id === activeId,
    view: w.view ?? "tabs",
    tabCount: w.tabs.length,
    pinned: w.pinned === true,
  }));
}

registerBridge({ workspaces: listWorkspacesForAgent });
