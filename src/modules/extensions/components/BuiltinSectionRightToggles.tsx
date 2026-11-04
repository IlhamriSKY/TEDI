/**
 * Status-bar toggle buttons for BUILT-IN sidebar sections (Files / Workspaces)
 * that the user has docked to the right slot. Mirrors `SidebarSectionRightToggles`
 * (extension sections) and `ScmRightOpenButton`: an icon-only button that
 * opens/closes the section in the shared right slot, shown while its placement is
 * "right" (never removed, so the row doesn't reflow). The open state reads active.
 *
 * Also shown while one is closed in the left column, which is the way back: only
 * then, so a sidebar nobody closed anything in adds nothing to the row.
 */
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { FolderTree, LayoutDashboard, type LucideIcon } from "lucide-react";

import { isRightPanelOpen, useRightPanelStore } from "../rightPanelStore";
import {
  BUILTIN_SECTION_EXT,
  MOVABLE_BUILTIN_SECTIONS,
  reopenLeft,
  sectionPanelId,
  useSidebarPlacementStore,
  type BuiltinSectionId,
} from "../sidebarPlacementStore";

const ICONS: Record<BuiltinSectionId, LucideIcon> = {
  files: FolderTree,
  workspaces: LayoutDashboard,
};

/** One docked built-in section, as the status bar's zone layout sees it. */
export type BuiltinToggleEntry = { id: string; node: React.ReactNode };

/** Each docked built-in section as an individually placeable status-bar entry. */
export function useBuiltinSectionToggleEntries(): BuiltinToggleEntry[] {
  const placement = useSidebarPlacementStore((s) => s.placement);
  const panels = useRightPanelStore((s) => s.panels);
  const toggle = useRightPanelStore((s) => s.toggle);
  const leftClosed = useSidebarPlacementStore((s) => s.leftClosed);

  return MOVABLE_BUILTIN_SECTIONS.filter(
    (s) => placement[s.id] === "right" || leftClosed[s.id],
  ).map(({ id, title }) => {
    const Icon = ICONS[id];
    const onRight = placement[id] === "right";
    const isOpen = onRight && isRightPanelOpen(panels, BUILTIN_SECTION_EXT, sectionPanelId(id));
    return {
      id: `builtin:${id}`,
      node: (
        <IconTooltip label={`${isOpen ? "Close" : "Open"} ${title}`} side="top">
          <button
            type="button"
            onClick={() =>
              onRight ? toggle(BUILTIN_SECTION_EXT, sectionPanelId(id)) : reopenLeft(id)
            }
            aria-label={`${isOpen ? "Close" : "Open"} ${title}`}
            aria-pressed={isOpen}
            className={cn(
              "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
              isOpen
                ? "text-foreground bg-accent/60"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon size={16} strokeWidth={1.75} className="shrink-0" />
          </button>
        </IconTooltip>
      ),
    };
  });
}
