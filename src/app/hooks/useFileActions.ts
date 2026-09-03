import { openUrl } from "@tauri-apps/plugin-opener";
import { registerBridge } from "@/modules/automation/bridge";
import { isPdfPath, pathToFileUrl } from "@/lib/path";
import { setExtensionWorkspaceBridge } from "@/modules/extensions/workspaceBridge";
import { type Tab } from "@/modules/tabs";
import type { SshConnectionBinding } from "@/modules/ssh/status";
import { leaves } from "@/modules/terminal";
import { useCallback, useEffect } from "react";
import { type TabsApi } from "./tabsApi";

type Params = {
  tabs: Tab[];
  disposeTab: (id: number) => void;
  /** Live session per saved SSH connection, from `useSshLeafState`. Lets a file
   *  opened from the remote tree record which PROFILE it came from, not just the
   *  session number, so the tab can be restored after a restart. */
  sshBindingByConnection: Map<string, SshConnectionBinding>;
  /** Opens a url in the browser. Used for file types the editor cannot render
   *  but a browser can - see `isPdfPath`. */
  openPreviewTab: (url: string) => void;
} & Pick<TabsApi, "openFileTab" | "setEditorLeafPath">;

/**
 * File-open / rename / delete wiring shared by the local explorer, the SSH
 * tree, the extension workspace bridge, and OS file drops. Moved verbatim from
 * App with identical dependency arrays. `disposeTab` is threaded in (it stays
 * in App).
 *
 * `handleOpenFile` is the single place that decides WHICH surface a local file
 * opens in, so every one of those callers agrees. Adding the choice at one
 * call site instead would leave the others opening a PDF as "Binary file".
 */
export function useFileActions({
  tabs,
  disposeTab,
  openFileTab,
  setEditorLeafPath,
  sshBindingByConnection,
  openPreviewTab,
}: Params): {
  handleOpenFile: (path: string, pin?: boolean) => void;
  handleOpenRemoteFile: (path: string, sessionId: number, hostLabel: string | null) => void;
  handlePathRenamed: (from: string, to: string) => void;
  handlePathDeleted: (path: string) => void;
} {
  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // A PDF goes to the system browser, which has a viewer for it; every
      // other file goes to an editor tab. Images need no branch here -
      // `fs_read_file` returns them as a data URL and `EditorPane` renders it.
      // A non-absolute path yields a null URL and falls through to the editor.
      const url = isPdfPath(path) ? pathToFileUrl(path) : null;
      if (url) {
        void openUrl(url).catch(console.error);
        return;
      }
      openFileTab(path, pin ?? false);
    },
    [openFileTab, openPreviewTab],
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

  // Same handler, exposed to a driving agent (`scripts/mcp/`). Opening a
  // file by path is the one editor entry point a driver otherwise cannot reach:
  // clicking the tree only works for a path already expanded into view, so any
  // deep file was unopenable. Routed through `handleOpenFile` rather than
  // `openFileTab` so a driver-opened PDF is handled exactly like a clicked one. Gated on `TEDI_DEBUG_PORT` like the rest of `window.__tedi`
  // (see `shortcuts/lib/commandRegistry.ts`), and merged into it, since three
  // files contribute to that one object and none may clobber the others.
  useEffect(() => {
    registerBridge({
      openFile: (path: string, pin = true) => {
        handleOpenFile(path, pin);
        return true;
      },
    });
  }, [handleOpenFile]);

  // SSH tree calls this when the user clicks a remote file. Pin the tab
  // because preview-mode shares one slot with local previews and would
  // silently replace whichever local file is in preview.
  const handleOpenRemoteFile = useCallback(
    (path: string, sessionId: number, hostLabel: string | null) => {
      // Record the saved profile behind this session, not just the session
      // number: the number dies with the app, the profile is what lets the tab
      // come back and rebind after a restart. Ad-hoc sessions have none, and
      // stay session-only.
      let sshConnectionId: string | undefined;
      for (const [connId, binding] of sshBindingByConnection) {
        if (binding.sessionId === sessionId) {
          sshConnectionId = connId;
          break;
        }
      }
      openFileTab(path, true, {
        sshConnectionId,
        sshSessionId: sessionId,
        sshHostLabel: hostLabel ?? "remote",
      });
    },
    [openFileTab, sshBindingByConnection],
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
