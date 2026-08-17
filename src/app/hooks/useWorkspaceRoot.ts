import { toast } from "@/components/ui/toast";
import { IPC_EVENTS } from "@/lib/ipc";
import { runCommand, type ShortcutId } from "@/modules/shortcuts";
import { activeLeaf, type PaneTab, type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import { useWorkspacesStore } from "@/modules/workspaces";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { type TabsApi } from "./tabsApi";

type CliTarget = { kind: "folder"; path: string } | { kind: "file"; path: string; parent: string };

type Params = {
  tabs: Tab[];
  activePaneTab: PaneTab | null;
} & Pick<TabsApi, "newTab" | "openFileTab">;

/**
 * Owns the workspace root: `home` (resolved once from $HOME) and `pickedRoot`
 * (the user-chosen folder, persisted to localStorage). Bundles the "Open
 * Folder" picker plus the `tedi .` / `tedi <path>` CLI-target handling - the
 * one-shot startup drain and the live `single-instance` forward. Moved verbatim
 * from App with identical dependency arrays. The root values are read widely
 * (explorer, AI context, inherited cwd), so they are returned for App to thread
 * onward.
 */
export function useWorkspaceRoot({ tabs, activePaneTab, newTab, openFileTab }: Params): {
  home: string | null;
  pickedRoot: string | null;
  setPickedRoot: Dispatch<SetStateAction<string | null>>;
  openWorkspaceFolder: () => Promise<void>;
} {
  const [home, setHome] = useState<string | null>(null);
  const [pickedRoot, setPickedRoot] = useState<string | null>(() => {
    try {
      return localStorage.getItem("tedi.workspaceRoot");
    } catch {
      return null;
    }
  });

  const openWorkspaceFolder = useCallback(async () => {
    const fallbackTerminalCwd = (() => {
      for (const t of tabs) {
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind === "terminal" && l.cwd) return l.cwd;
        }
      }
      return undefined;
    })();
    const activeTermCwd = (() => {
      if (!activePaneTab) return undefined;
      const leaf = activeLeaf(activePaneTab);
      return leaf?.leafKind === "terminal" ? leaf.cwd : undefined;
    })();
    const defaultPath = pickedRoot ?? activeTermCwd ?? fallbackTerminalCwd ?? home ?? undefined;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath,
      title: "Open Folder",
    });
    if (typeof selected !== "string") return;
    const normalized = selected.replace(/\\/g, "/");
    setPickedRoot(normalized);
    try {
      localStorage.setItem("tedi.workspaceRoot", normalized);
    } catch {
      // Storage unavailable (private mode etc.). Skip persistence.
    }
    // Open a terminal tab rooted at the picked folder.
    newTab(normalized);
  }, [pickedRoot, activePaneTab, tabs, home, newTab]);

  useEffect(() => {
    // Forward slashes so explorerRoot matches across home and OSC 7.
    homeDir()
      .then((p) => setHome(p.replace(/\\/g, "/")))
      .catch(() => setHome(null));
  }, []);

  // Handles `tedi .` / `tedi <path>`. Drained from Rust on boot and pushed
  // live by the single-instance plugin when a second `tedi` invocation
  // forwards its argv. Folder: adopt as root and open a terminal there.
  // File: adopt parent as root and open the file in an editor tab.
  const openCliTarget = useCallback(
    (target: CliTarget) => {
      const root = target.kind === "folder" ? target.path : target.parent;
      setPickedRoot(root);
      try {
        localStorage.setItem("tedi.workspaceRoot", root);
      } catch {
        // Storage unavailable. Skip persistence.
      }
      if (target.kind === "folder") {
        newTab(target.path);
      } else {
        // No `newTab(target.parent)` here: `setPickedRoot` above already
        // adopts the parent as the workspace root, which is what the explorer
        // reads, and `openFileTab` appends its own pane tab when no editor
        // leaf matches - it does not need a terminal to attach to. Spawning
        // one anyway meant "Open with TEDI" on a file produced an unasked-for
        // shell next to the editor, unlike every other file-open path
        // (explorer click, drag-drop, OSC 8889, New File dialog).
        openFileTab(target.path);
      }
    },
    [newTab, openFileTab],
  );

  // Drain the captured startup target once. Rust clears its slot on read,
  // so a webview reload won't replay it.
  //
  // Gate on workspace hydration: `useWorkspacePersistence` restores the saved
  // workspace by calling `replaceAllTabs` once `wsHydrated` flips true. That
  // disk-backed restore lands later than this fast in-memory IPC, so an
  // ungated drain would open the `tedi .` tab first and then have it wiped by
  // the restore - leaving the previously saved folder on screen. Waiting for
  // hydration flips the order: the restore runs synchronously inside the same
  // commit while this drain's tab mutation happens in the async `then`, so the
  // CLI tab is appended on top of the restored workspace and stays focused.
  const wsHydrated = useWorkspacesStore((s) => s.hydrated);
  const cliStartupRunRef = useRef(false);
  useEffect(() => {
    if (!wsHydrated) return;
    if (cliStartupRunRef.current) return;
    cliStartupRunRef.current = true;
    void invoke<CliTarget | null>("cli_initial_target").then((target) => {
      if (target) openCliTarget(target);
    });
  }, [openCliTarget, wsHydrated]);

  // Live forwarding from `tauri-plugin-single-instance` when `tedi <path>`
  // runs while this window is already up.
  useEffect(() => {
    const unlistenP = listen<CliTarget>(IPC_EVENTS.OPEN_CLI_TARGET, (e) => {
      if (e.payload) openCliTarget(e.payload);
    });
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, [openCliTarget]);

  // `tedi cmd <id>` arrives down the same forward. It is the only automation
  // channel that works on a session already running: `TEDI_DEBUG_PORT` has to
  // be set before launch, so reaching a window that is already open otherwise
  // means restarting it. No new capability - a local process can already
  // synthesise the keystroke this runs - and no listening socket.
  //
  // Toast on a miss because the caller's shell cannot see the result: the
  // forwarding process exits the moment it hands over argv, so a typo'd id
  // would otherwise be a silent no-op on both ends.
  useEffect(() => {
    const unlistenP = listen<string>(IPC_EVENTS.RUN_COMMAND, (e) => {
      const id = e.payload;
      if (!id) return;
      if (!runCommand(id as ShortcutId)) {
        toast(`tedi cmd: no command registered for "${id}"`, { variant: "error" });
      }
    });
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, []);

  return { home, pickedRoot, setPickedRoot, openWorkspaceFolder };
}
