import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Folder01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useWorkspacesStore } from "./store";

type Props = {
  /**
   * Called when the user picks a different workspace. The caller is
   * responsible for snapshotting the current workspace's live tabs into the
   * store BEFORE invoking the switch, and for rehydrating the new one.
   */
  onSwitch: (workspaceId: string) => void;
  /** Called when the user clicks "+". The caller seeds a new tab strip. */
  onCreate: () => void;
  /**
   * Called when the user closes a workspace. The caller is responsible for
   * discarding the closed workspace's live tabs and rehydrating the neighbor
   * that the store hands focus to.
   */
  onClose: (workspaceId: string) => void;
  /**
   * Live open-tab count for the *active* workspace. Inactive workspaces use
   * their persisted `tabs.length` since their live state isn't mounted.
   */
  liveTabsCount?: number;
};

export function WorkspacesPanel({ onSwitch, onCreate, onClose, liveTabsCount }: Props) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const rename = useWorkspacesStore((s) => s.renameWorkspace);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (id: string, current: string) => {
    setEditingId(id);
    setDraft(current);
  };
  const commitEdit = () => {
    if (editingId && draft.trim()) rename(editingId, draft.trim());
    setEditingId(null);
    setDraft("");
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/60 text-muted-foreground flex h-7 shrink-0 items-center justify-between border-b px-2 text-[10px] font-semibold tracking-wider uppercase">
        <span>Workspaces</span>
        <IconTooltip label="New workspace">
          <Button
            onClick={onCreate}
            aria-label="New workspace"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:bg-accent hover:text-foreground size-5 shrink-0 rounded"
          >
            <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="p-1">
          {workspaces.map((w) => {
            const isActive = w.id === activeId;
            const isEditing = editingId === w.id;
            const tabCount =
              isActive && liveTabsCount !== undefined ? liveTabsCount : w.tabs.length;
            return (
              <li
                key={w.id}
                className={cn(
                  "group relative flex h-7 items-center gap-1.5 rounded px-1.5 text-xs",
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={Folder01Icon}
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
                {isEditing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      else if (e.key === "Escape") cancelEdit();
                    }}
                    onBlur={commitEdit}
                    className="border-border/60 bg-background focus:border-primary/40 min-w-0 flex-1 rounded border px-1 text-xs outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!isActive) onSwitch(w.id);
                    }}
                    onDoubleClick={() => startEdit(w.id, w.name)}
                    className="min-w-0 flex-1 truncate text-left"
                  >
                    {w.name}
                  </button>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "bg-muted/50 shrink-0 rounded px-1 text-[10px] tabular-nums transition-opacity",
                        isActive ? "text-foreground/80" : "text-muted-foreground",
                        "group-hover:opacity-0",
                      )}
                      aria-label={`${tabCount} tabs open`}
                    >
                      {tabCount}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {`${tabCount} ${tabCount === 1 ? "tab" : "tabs"} open`}
                  </TooltipContent>
                </Tooltip>
                <span className="pointer-events-none absolute right-1.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                  <IconTooltip label="Rename">
                    <Button
                      onClick={() => startEdit(w.id, w.name)}
                      aria-label="Rename workspace"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:bg-accent hover:text-foreground size-5 rounded"
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} size={11} strokeWidth={1.75} />
                    </Button>
                  </IconTooltip>
                  {workspaces.length > 1 && (
                    <IconTooltip label="Close workspace">
                      <Button
                        onClick={() => onClose(w.id)}
                        aria-label="Close workspace"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-5 rounded"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                      </Button>
                    </IconTooltip>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}
