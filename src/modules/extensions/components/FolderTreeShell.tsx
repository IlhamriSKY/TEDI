import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { FileExplorer } from "@/modules/explorer";
import { FolderOpen, House, X } from "lucide-react";

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
              <FolderOpen size={13} strokeWidth={2} />
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
              <House size={13} strokeWidth={2} />
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
              className={cn(DESTRUCTIVE_ACTION, "size-6")}
            >
              <X size={13} strokeWidth={2} />
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
      // Empty slot at the head of the explorer's own header row. The panel host
      // portals the section stack's grip + minimize chevron into it, so this
      // tree wears them on ONE line beside the folder name exactly like the
      // primary explorer, instead of the extra rail a `hideHostHeader` panel
      // otherwise gets above its content. Rendered unconditionally: it is a
      // zero-size span when nothing adopts it (a float window, say), and a
      // conditional one would have to be told when the host is there.
      dragHandle={<span data-tedi-panel-controls className="flex shrink-0 items-center" />}
    />
  );
}
