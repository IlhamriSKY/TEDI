import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { Bot, Columns2, Globe, Lock, NotepadText, Plus, Rows2, SquareTerminal } from "lucide-react";

type NewTabMenuProps = {
  onNewTerminal: () => void;
  /** Open a new local terminal tab pre-flagged as private. */
  onNewPrivateTerminal?: () => void;
  onNewPreview: () => void;
  /** Open a scratch note in the editor: a quick-notes file that needs no name,
   *  no folder and no Ctrl+S (it autosaves and comes back after a restart). */
  onNewNote: () => void;
  /** Open the agent picker (`AgentSpawnDialog`). */
  onOpenAgents: () => void;
  /** Split the active pane. Wired into the `+` dropdown next to New Terminal.
   *  `kind` picks what the new pane holds (defaults to a terminal). */
  onSplit?: (dir: "row" | "col", kind?: "terminal" | "editor" | "browser") => void;
  /** Disable the split-pane items when the active tab is at its split cap. */
  canSplit: boolean;
};

/** New-tab cluster: the `+` dropdown trigger plus its terminal/agent/preview/split items. */
export function NewTabMenu({
  onNewTerminal,
  onNewPrivateTerminal,
  onNewPreview,
  onNewNote,
  onOpenAgents,
  onSplit,
  canSplit,
}: NewTabMenuProps) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("text-muted-foreground", TOOLBAR_HOVER, "size-7 shrink-0 rounded-md")}
              aria-label="New"
            >
              <Plus size={14} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">New</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-auto min-w-64">
        <DropdownMenuItem onSelect={() => onNewTerminal()}>
          <SquareTerminal size={14} strokeWidth={1.75} />
          <span className="flex-1 whitespace-nowrap">Terminal</span>
          <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
            {fmtShortcut(MOD_KEY, "T")}
          </span>
        </DropdownMenuItem>
        {onNewPrivateTerminal ? (
          <DropdownMenuItem onSelect={() => onNewPrivateTerminal()}>
            <Lock size={14} strokeWidth={1.75} className="text-destructive" />
            <span className="flex-1 whitespace-nowrap">Private Terminal</span>
            <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
              {fmtShortcut(MOD_KEY, "Shift", "T")}
            </span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onOpenAgents()}>
          <Bot size={14} strokeWidth={1.75} />
          <span className="flex-1 whitespace-nowrap">Agent...</span>
          <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
            {fmtShortcut(MOD_KEY, "Shift", "N")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNewNote()}>
          <NotepadText size={14} strokeWidth={1.75} />
          <span className="flex-1 whitespace-nowrap">Note</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNewPreview()}>
          <Globe size={14} strokeWidth={1.75} />
          <span className="flex-1 whitespace-nowrap">Browser</span>
          <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
            {fmtShortcut(MOD_KEY, "Alt", "P")}
          </span>
        </DropdownMenuItem>
        {onSplit ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!canSplit} onSelect={() => onSplit("row")}>
              <Columns2 size={14} strokeWidth={1.75} />
              <span className="flex-1 whitespace-nowrap">Split right</span>
              <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                {fmtShortcut(MOD_KEY, "D")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canSplit} onSelect={() => onSplit("col")}>
              <Rows2 size={14} strokeWidth={1.75} />
              <span className="flex-1 whitespace-nowrap">Split down</span>
              <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                {fmtShortcut(MOD_KEY, "Shift", "D")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canSplit} onSelect={() => onSplit("row", "browser")}>
              <Globe size={14} strokeWidth={1.75} />
              <span className="flex-1 whitespace-nowrap">Split with browser</span>
              <span className="text-muted-foreground ml-4 text-xs whitespace-nowrap">
                {fmtShortcut(MOD_KEY, "Shift", "B")}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
