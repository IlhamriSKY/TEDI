/**
 * Status-bar toggle buttons for BUILT-IN sidebar sections (Files / Workspaces)
 * that the user has docked to the right slot. Mirrors `SidebarSectionRightToggles`
 * (extension sections) and `ScmRightOpenButton`: an icon-only button that
 * opens/closes the section in the shared right slot, shown while its placement is
 * "right" (never removed, so the row doesn't reflow). The open state reads active.
 */
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { FolderTree, LayoutDashboard, type LucideIcon } from "lucide-react";

import { isRightPanelOpen, useRightPanelStore } from "../rightPanelStore";
import {
  BUILTIN_SECTION_EXT,
  MOVABLE_BUILTIN_SECTIONS,
  sectionPanelId,
  useSidebarPlacementStore,
  type BuiltinSectionId,
} from "../sidebarPlacementStore";

const ICONS: Record<BuiltinSectionId, LucideIcon> = {
  files: FolderTree,
  workspaces: LayoutDashboard,
};

export function BuiltinSectionRightToggles() {
  const placement = useSidebarPlacementStore((s) => s.placement);
  const panels = useRightPanelStore((s) => s.panels);
  const toggle = useRightPanelStore((s) => s.toggle);

  const moved = MOVABLE_BUILTIN_SECTIONS.filter((s) => placement[s.id] === "right");
  if (moved.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      {moved.map(({ id, title }) => {
        const Icon = ICONS[id];
        const isOpen = isRightPanelOpen(panels, BUILTIN_SECTION_EXT, sectionPanelId(id));
        return (
          <IconTooltip key={id} label={`${isOpen ? "Close" : "Open"} ${title}`} side="top">
            <button
              type="button"
              onClick={() => toggle(BUILTIN_SECTION_EXT, sectionPanelId(id))}
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
        );
      })}
    </div>
  );
}
