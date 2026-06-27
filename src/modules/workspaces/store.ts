import { LazyStore } from "@tauri-apps/plugin-store";
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
};

export type SavedEditorLeaf = {
  kind: "leaf";
  leafKind: "editor";
  path: string;
  /** Per-leaf privacy flag. AI inline autocomplete refuses on private leaves. */
  private?: boolean;
};

export type SavedBrowserLeaf = {
  kind: "leaf";
  leafKind: "browser";
  /** Last URL the embedded browser showed. Reopened on restore. */
  url: string;
  /** FIFO chip number ("Browser 3"). Persisted so it stays stable after restart. */
  browserOrdinal?: number;
  private?: boolean;
};

export type SavedPaneNode =
  | SavedTerminalLeaf
  | SavedEditorLeaf
  | SavedBrowserLeaf
  | {
      kind: "split";
      dir: "row" | "col";
      children: SavedPaneNode[];
    };

export type SavedPaneTab = {
  kind: "pane";
  title?: string;
  paneTree: SavedPaneNode;
  /** Index of the active leaf when reading from `leaves(paneTree)`. */
  activeLeafIndex: number;
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

export type Workspace = {
  id: string;
  name: string;
  tabs: SavedTab[];
  activeTabIndex: number;
};

type State = {
  hydrated: boolean;
  workspaces: Workspace[];
  activeId: string | null;
};

type Actions = {
  hydrate: () => Promise<void>;
  setWorkspaces: (workspaces: Workspace[]) => void;
  setActiveId: (id: string | null) => void;
  /** Create an empty workspace. Caller must save prior tabs and call setActiveId to switch. */
  createWorkspace: (name: string) => Workspace;
  renameWorkspace: (id: string, name: string) => void;
  removeWorkspace: (id: string) => void;
  /** Replace a workspace's saved tabs. Used before a switch. */
  saveWorkspaceTabs: (id: string, tabs: SavedTab[], activeTabIndex: number) => void;
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

    async hydrate() {
      let list: Workspace[] = [];
      let active: string | null = null;
      try {
        list = (await store.get<Workspace[]>(KEY_LIST)) ?? [];
        active = (await store.get<string | null>(KEY_ACTIVE)) ?? null;
      } catch {
        // Corrupt / unreadable store: fall through to seeding a default below.
        // `hydrated` MUST still flip true - the `tedi .` CLI drain now waits on
        // it (see useWorkspaceRoot), and other consumers gate on it too, so a
        // read failure that left it false would strand both, not just lose the
        // saved workspaces.
        list = [];
        active = null;
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
        try {
          await persist();
        } catch {
          // Best-effort persist; the in-memory default is enough to boot.
        }
        return;
      }
      set({
        workspaces: list,
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

    saveWorkspaceTabs(id, tabs, activeTabIndex) {
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, tabs, activeTabIndex } : w)),
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
      set({ workspaces: next });
      void persist();
    },
  };
});

export function newWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
