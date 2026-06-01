import { setExtensionWorkspaceBridge } from "@/modules/extensions/workspaceBridge";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import { useCallback, useEffect } from "react";
import { type TabsApi } from "./tabsApi";

type Params = {
  tabs: Tab[];
  disposeTab: (id: number) => void;
} & Pick<TabsApi, "openFileTab" | "setEditorLeafPath">;

/**
 * File-open / rename / delete wiring shared by the local explorer, the SSH
 * tree, and the extension workspace bridge. Moved verbatim from App with
 * identical dependency arrays. `disposeTab` is threaded in (it stays in App).
 */
export function useFileActions({ tabs, disposeTab, openFileTab, setEditorLeafPath }: Params): {
  handleOpenFile: (path: string, pin?: boolean) => void;
  handleOpenRemoteFile: (path: string, sessionId: number, hostLabel: string | null) => void;
  handlePathRenamed: (from: string, to: string) => void;
  handlePathDeleted: (path: string) => void;
} {
  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      openFileTab(path, pin ?? false);
    },
    [openFileTab],
  );

  // Wire the extension workspace bridge to the live file-open handler.
  // Extensions mounting `ctx.ui.mountFolderTree` route click-to-open
  // through this bridge so they get the same behavior as the left
  // explorer.
  useEffect(() => {
    setExtensionWorkspaceBridge({
      openFile: (path, opts) => handleOpenFile(path, opts?.pin ?? false),
    });
    return () => setExtensionWorkspaceBridge(null);
  }, [handleOpenFile]);

  // SSH tree calls this when the user clicks a remote file. Pin the tab
  // because preview-mode shares one slot with local previews and would
  // silently replace whichever local file is in preview.
  const handleOpenRemoteFile = useCallback(
    (path: string, sessionId: number, hostLabel: string | null) => {
      openFileTab(path, true, {
        sshSessionId: sessionId,
        sshHostLabel: hostLabel ?? "remote",
      });
    },
    [openFileTab],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "pane") continue;
        for (const leaf of leaves(t.paneTree)) {
          if (leaf.leafKind !== "editor") continue;
          if (leaf.path === from) {
            setEditorLeafPath(leaf.id, to);
          } else if (leaf.path.startsWith(`${from}/`)) {
            const suffix = leaf.path.slice(from.length);
            setEditorLeafPath(leaf.id, `${to}${suffix}`);
          }
        }
      }
    },
    [tabs, setEditorLeafPath],
  );

  const handlePathDeleted = useCallback(
    (path: string) => {
      for (const t of tabs) {
        if (t.kind !== "pane") continue;
        // If any editor leaf in this tab references the deleted path, drop
        // the whole tab. Matches the prior single-leaf behavior.
        const affected = leaves(t.paneTree).some(
          (l) => l.leafKind === "editor" && (l.path === path || l.path.startsWith(`${path}/`)),
        );
        if (affected) disposeTab(t.id);
      }
    },
    [tabs, disposeTab],
  );

  return { handleOpenFile, handleOpenRemoteFile, handlePathRenamed, handlePathDeleted };
}
