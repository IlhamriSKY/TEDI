/**
 * Status-bar toggle buttons for extension sidebar sections that have been moved
 * to the right slot (placement === "right"). Mirrors `ScmRightOpenButton`: an
 * icon-only button that opens the section in the shared right slot, hidden while
 * it's already open. One button per moved section, using the section's own icon.
 */
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { resolveExtIcon, useIconsReady } from "@/lib/iconRegistry";
import { LayoutDashboard } from "lucide-react";

import { sidebarSectionsRegistry } from "../registries";
import { useRegistry } from "../useRegistry";
import { isRightPanelOpen, useRightPanelStore } from "../rightPanelStore";
import {
  sectionPanelId,
  sidebarSectionKey,
  useSidebarPlacementStore,
} from "../sidebarPlacementStore";

/** One moved sidebar section, as the status bar's zone layout sees it. */
export type SidebarToggleEntry = { id: string; node: React.ReactNode };

/** Each moved section as an individually placeable status-bar entry. */
export function useSidebarSectionToggleEntries(): SidebarToggleEntry[] {
  const sections = useRegistry(sidebarSectionsRegistry);
  const placement = useSidebarPlacementStore((s) => s.placement);
  const panels = useRightPanelStore((s) => s.panels);

  return sections
    .filter(
      ({ extensionId, item }) =>
        item.movableToRight && placement[sidebarSectionKey(extensionId, item.id)] === "right",
    )
    .map(({ extensionId, item }) => ({
      id: `section:${extensionId}:${item.id}`,
      node: (
        <SectionToggle
          extensionId={extensionId}
          sectionId={item.id}
          title={item.title}
          icon={item.icon}
          isOpen={isRightPanelOpen(panels, extensionId, sectionPanelId(item.id))}
        />
      ),
    }));
}

function SectionToggle({
  extensionId,
  sectionId,
  title,
  icon,
  isOpen,
}: {
  extensionId: string;
  sectionId: string;
  title: string;
  icon?: string;
  isOpen: boolean;
}) {
  // Subscribe so this re-renders once the lazy icon chunk loads and
  // resolveExtIcon() starts resolving (the boolean itself isn't needed here).
  useIconsReady();
  // Always visible (never removed from the row, so the status bar never
  // reflows); clicking toggles the panel, and the open state shows as active.
  const toggle = useRightPanelStore((s) => s.toggle);
  const Icon = resolveExtIcon(icon) ?? LayoutDashboard;
  return (
    <IconTooltip label={`${isOpen ? "Close" : "Open"} ${title}`} side="top">
      <button
        type="button"
        onClick={() => toggle(extensionId, sectionPanelId(sectionId))}
        aria-label={`${isOpen ? "Close" : "Open"} ${title}`}
        aria-pressed={isOpen}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          isOpen ? "text-foreground bg-accent/60" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon size={16} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}
