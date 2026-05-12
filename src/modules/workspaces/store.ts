import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";

const STORE_PATH = "terax-ai-workspaces.json";
const KEY_LIST = "workspaces";
const KEY_ACTIVE = "activeId";

// ---- Saved (on-disk) shape ----
//
// We only persist what's needed to reconstruct tabs on next launch. Live
// runtime state (dirty buffers, PTY ids, focus state) is not saved — terminal
// panes are respawned at their saved cwd; editor panes reopen the file path.

export type SavedTerminalLeaf = {
  kind: "leaf";
  leafKind: "terminal";
  cwd?: string;
};

export type SavedEditorLeaf = {
  kind: "leaf";
  leafKind: "editor";
  path: string;
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
// ai-diff tabs are session-only — never persisted.

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
  /**
   * Create a fresh empty workspace. The caller is expected to call setActiveId
   * to switch to it after preserving the prior workspace's tabs.
   */
  createWorkspace: (name: string) => Workspace;
  renameWorkspace: (id: string, name: string) => void;
  removeWorkspace: (id: string) => void;
  /** Replace a workspace's saved tabs (used to snapshot before switching). */
  saveWorkspaceTabs: (
    id: string,
    tabs: SavedTab[],
    activeTabIndex: number,
  ) => void;
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
      // Seed a default workspace if none — keeps first-run sane.
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
        workspaces: get().workspaces.map((w) =>
          w.id === id ? { ...w, name } : w,
        ),
      });
      void persist();
    },

    removeWorkspace(id) {
      const before = get();
      const next = before.workspaces.filter((w) => w.id !== id);
      // Always keep at least one workspace around — collapse-to-default if
      // the user deletes the last one.
      if (next.length === 0) {
        const ws: Workspace = {
          id: newWorkspaceId(),
          name: "Workspace 1",
          tabs: [],
          activeTabIndex: 0,
        };
        set({ workspaces: [ws], activeId: ws.id });
      } else {
        const newActive =
          before.activeId === id ? next[0].id : before.activeId;
        set({ workspaces: next, activeId: newActive });
      }
      void persist();
    },

    saveWorkspaceTabs(id, tabs, activeTabIndex) {
      set({
        workspaces: get().workspaces.map((w) =>
          w.id === id ? { ...w, tabs, activeTabIndex } : w,
        ),
      });
      void persist();
    },
  };
});

export function newWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
