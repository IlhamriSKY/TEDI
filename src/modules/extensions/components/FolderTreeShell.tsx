import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Cancel01Icon, FolderEditIcon, Home02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { FileExplorer } from "@/modules/explorer";

/**
 * Owns the effective root: extension-provided `rootPath` or a user pick.
 * When `rootPath` changes the pick is cleared so workspace switches win.
 * `initialPickedPath` lets the caller restore a prior pick (persisted in
 * extension storage) so close/reopen of the panel doesn't reset to home.
 */
export function FolderTreeShell({
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

  const handlePick = useCallback(async (): Promise<void> => {
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
  }, [effectiveRoot, onPickedPathChange]);

  const handleReset = useCallback((): void => {
    setPickedPath(null);
    onPickedPathChange?.(null);
  }, [onPickedPathChange]);

  // Action row appended to FileExplorer's header (after Search/Refresh/Collapse).
  // Folder name + icon come from FileExplorer.
  const extras = useMemo(
    () => (
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
    ),
    [showOpenFolder, pickedPath, onClose, handlePick, handleReset],
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
