/**
 * Mounts TEDI's `FileExplorer` into a plain DOM container so extensions
 * get a folder tree that matches the left sidebar exactly. Call from a
 * `registerPanelRenderer` callback.
 * Header is a single row: folder name + icon, action icons, optional close X.
 * Pair with `hideHostHeader: true` on the panel manifest entry.
 * Default `onOpenFile` routes through `extensionWorkspaceBridge`; pass your
 * own callback to override.
 * Returns a disposer the caller must invoke on cleanup.
 */
import { createRoot, type Root } from "react-dom/client";
import { StrictMode, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileExplorer } from "@/modules/explorer";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Cancel01Icon, FolderEditIcon, Home02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { getExtensionWorkspaceBridge } from "../workspaceBridge";

export type MountFolderTreeOptions = {
  /** Absolute path of the tree root. A user pick via "Open Folder" wins
   *  until the prop changes; a new `rootPath` from `update()` clears the pick. */
  rootPath: string | null;
  /** Restore an "Open Folder" pick on first mount so close/reopen doesn't
   *  send the user back to `rootPath`. Only honored on first render of the
   *  React tree; pass via every `mountFolderTree` call (the React root is
   *  fresh after each `dispose()`). Subsequent `update()` calls within the
   *  same mount lifecycle do NOT override the live pick. */
  initialPickedPath?: string | null;
  /** Fires after every pick change: user pick, header reset, or
   *  workspace-switch clear. Persist this in extension storage (and an
   *  in-closure variable) so the next mount can pass it back as
   *  `initialPickedPath`. */
  onPickedPathChange?: (path: string | null) => void;
  /** File-open handler. Defaults to routing through the workspace bridge. */
  onOpenFile?: (path: string, pin?: boolean) => void;
  /** Show the "Open Folder" picker icon and a reset chip when a pick is active. */
  showOpenFolder?: boolean;
  /** Click handler for the header close X. Omit to hide the button. */
  onClose?: () => void;
};

export type MountedFolderTree = {
  /** Replace props without remounting. Preserves expansion state. */
  update(next: MountFolderTreeOptions): void;
  /** Detach React root and clear children. Idempotent. */
  dispose(): void;
};

/**
 * Owns the effective root: extension-provided `rootPath` or a user pick.
 * When `rootPath` changes the pick is cleared so workspace switches win.
 * `initialPickedPath` lets the caller restore a prior pick (persisted in
 * extension storage) so close/reopen of the panel doesn't reset to home.
 */
function FolderTreeShell({
  rootPath,
  initialPickedPath,
  onPickedPathChange,
  onOpenFile,
  showOpenFolder,
  onClose,
}: {
  rootPath: string | null;
  initialPickedPath: string | null;
  onPickedPathChange?: (path: string | null) => void;
  onOpenFile: (path: string, pin?: boolean) => void;
  showOpenFolder: boolean;
  onClose?: () => void;
}) {
  const [pickedPath, setPickedPath] = useState<string | null>(initialPickedPath);
  // When `rootPath` changes (workspace switch), drop the user pick.
  const lastPropRootRef = useRef<string | null>(rootPath);
  useEffect(() => {
    if (lastPropRootRef.current !== rootPath) {
      lastPropRootRef.current = rootPath;
      setPickedPath(null);
      onPickedPathChange?.(null);
    }
  }, [rootPath, onPickedPathChange]);

  const effectiveRoot = pickedPath ?? rootPath;

  const handlePick = async (): Promise<void> => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: effectiveRoot ?? undefined,
        title: "Open Folder",
      });
      if (typeof selected === "string" && selected.length > 0) {
        setPickedPath(selected);
        onPickedPathChange?.(selected);
      }
    } catch (err) {
      console.error("[extensions] folder picker failed", err);
    }
  };

  const handleReset = (): void => {
    setPickedPath(null);
    onPickedPathChange?.(null);
  };

  // Action row appended to FileExplorer's header (after Search/Refresh/Collapse).
  // Folder name + icon come from FileExplorer.
  const extras = (
    <>
      {showOpenFolder ? (
        <IconTooltip label="Open a folder to browse" side="bottom">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => void handlePick()}
            aria-label="Open Folder"
            className="text-muted-foreground hover:text-foreground size-6"
          >
            <HugeiconsIcon icon={FolderEditIcon} size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      {pickedPath ? (
        // Distinct icon (home) + non-destructive hover so it can't be confused
        // with the close X next to it. Tooltip spells out what "home" means.
        <IconTooltip label="Back to workspace folder" side="bottom">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={handleReset}
            aria-label="Back to workspace folder"
            className="text-muted-foreground hover:text-foreground size-6"
          >
            <HugeiconsIcon icon={Home02Icon} size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      {onClose ? (
        <IconTooltip label="Close panel" side="bottom">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onClose}
            aria-label="Close panel"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-6"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
    </>
  );

  return (
    <FileExplorer
      rootPath={effectiveRoot}
      onOpenFile={onOpenFile}
      hideCreateActions
      hideGrep
      headerExtras={extras}
    />
  );
}

export function mountFolderTree(
  container: HTMLElement,
  initial: MountFolderTreeOptions,
): MountedFolderTree {
  let disposed = false;
  let root: Root | null = createRoot(container);
  let current: MountFolderTreeOptions = initial;

  const handleOpenFile = (path: string, pin?: boolean): void => {
    if (current.onOpenFile) {
      current.onOpenFile(path, pin);
      return;
    }
    const bridge = getExtensionWorkspaceBridge();
    bridge?.openFile(path, { pin });
  };

  const renderInto = (): void => {
    if (!root) return;
    root.render(
      <StrictMode>
        {/*
         * React context doesn't cross roots, so re-wrap providers used
         * by FileExplorer. Without TooltipProvider, IconTooltip throws.
         * Skip ThemeProvider: it sets a class on documentElement that
         * cascades through every root.
         */}
        <TooltipProvider>
          <FolderTreeShell
            rootPath={current.rootPath}
            initialPickedPath={current.initialPickedPath ?? null}
            onPickedPathChange={current.onPickedPathChange}
            onOpenFile={handleOpenFile}
            showOpenFolder={current.showOpenFolder ?? false}
            onClose={current.onClose}
          />
        </TooltipProvider>
      </StrictMode>,
    );
  };

  renderInto();

  return {
    update(next) {
      if (disposed) return;
      current = next;
      renderInto();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Defer unmount so it doesn't race React's scheduler. Calling
      // `root.unmount()` mid-render commit warns.
      queueMicrotask(() => {
        try {
          root?.unmount();
        } catch (err) {
          console.error("[extensions] mountFolderTree unmount threw", err);
        }
        root = null;
        try {
          container.replaceChildren();
        } catch {
          // ignore
        }
      });
    },
  };
}
