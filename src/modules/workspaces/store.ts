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
  /**
   * Daemon-owned PTY UUID. When present on next launch the restore path
   * calls `pty_attach` to resume the shell with its scrollback; on attach
   * failure (daemon was killed, system rebooted) the leaf falls back to a
   * fresh `pty_open`. Absent on SSH leaves and on builds where the daemon
   * backend is unavailable.
   */
  ptyId?: string;
};

export type SavedEditorLeaf = {
  kind: "leaf";
  leafKind: "editor";
  path: string;
  /** Per-leaf privacy flag. AI inline autocomplete refuses on private leaves. */
  private?: boolean;
};

export type SavedPaneNode =
  | SavedTerminalLeaf
  | SavedEditorLeaf
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
};

export const useWorkspacesStore = create<State & Actions>((set, get) => {
  const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

  const persist = async () => {
    const { workspaces, activeId } = get();
    await store.set(KEY_LIST, workspaces);
    await store.set(KEY_ACTIVE, activeId);
    await store.save();
  };

  return {
    hydrated: false,
    workspaces: [],
    activeId: null,

    async hydrate() {
      const list = (await store.get<Workspace[]>(KEY_LIST)) ?? [];
      const active = (await store.get<string | null>(KEY_ACTIVE)) ?? null;
      // Seed a default workspace on first run.
      if (list.length === 0) {
        const ws: Workspace = {
          id: newWorkspaceId(),
          name: "Workspace 1",
          tabs: [],
          activeTabIndex: 0,
        };
        set({ workspaces: [ws], activeId: ws.id, hydrated: true });
        await persist();
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
  };
});

export function newWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
