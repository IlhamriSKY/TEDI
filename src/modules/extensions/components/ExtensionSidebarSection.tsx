/**
 * Renders an extension-contributed `SidebarSection` (from
 * `sidebarSectionsRegistry`) with the exact chrome of the built-in
 * Workspaces panel: an h-8 header (drag grip + section icon + title +
 * divider + action buttons) over a `ScrollArea` of h-7 rows. Mounted as a
 * dynamic, reorderable / collapsible section by `AppSidebar`; it exists only
 * while the owning extension is active, so it appears / disappears with
 * enable / disable.
 *
 * Icon resolution mirrors `ExtensionHeaderItems`: `lucide:<Name>` (or legacy
 * `hugeicon:<Name>`) renders a Lucide icon; otherwise the string is treated as a
 * `data:` URL or an `ext-asset:<relPath>` resolved via `loadExtensionIcon`.
 */
import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { resolveExtIcon, useIconsReady } from "@/lib/iconRegistry";

import { explorerIconUrl, useExplorerIconsReady } from "@/modules/explorer/lib/iconResolver";

import { useResolvedExtensionIcon } from "../icon";
import type { SidebarSection, SidebarSectionItem } from "../registries";
import { useRightPanelStore } from "../rightPanelStore";
import {
  sectionPanelId,
  sidebarSectionKey,
  useSidebarPlacementStore,
} from "../sidebarPlacementStore";
import {
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Search,
  X,
} from "lucide-react";

/**
 * Client-side tree filter for a `searchable` section. A node is kept when its
 * own label/sublabel matches `q` (then its loaded children are shown) or any
 * loaded descendant matches (then the node auto-expands to reveal it). `q` must
 * be pre-lowercased. Lazy/unloaded children can't be matched (only what the
 * extension has loaded into the tree is searchable).
 */
function filterSidebarItems(list: SidebarSectionItem[], q: string): SidebarSectionItem[] {
  const out: SidebarSectionItem[] = [];
  for (const it of list) {
    const selfMatch =
      it.label.toLowerCase().includes(q) || (it.sublabel ?? "").toLowerCase().includes(q);
    const kids = it.children ? filterSidebarItems(it.children, q) : [];
    if (selfMatch) {
      out.push({ ...it, expanded: it.children && it.children.length > 0 ? true : it.expanded });
    } else if (kids.length > 0) {
      out.push({ ...it, children: kids, expanded: true });
    }
  }
  return out;
}

/** One icon, resolving a `lucide:`/`hugeicon:` named icon first, then asset/data
 *  URLs. Sized to the caller's `size`; tints with `currentColor` (Lucide) or a
 *  mask (SVG asset). */
function SectionIcon({
  extensionId,
  icon,
  size,
  className,
}: {
  extensionId: string;
  icon?: string;
  size: number;
  className?: string;
}) {
  // Subscribe so this re-renders once the lazy icon chunk loads and
  // resolveExtIcon() starts returning a component (the boolean isn't needed here).
  useIconsReady();
  // `fileicon:<name>` resolves against the Catppuccin pack the file tree uses,
  // so SQL Explorer's database/table rows match the folder tree's glyphs.
  const fileIconName = icon?.startsWith("fileicon:") ? icon.slice("fileicon:".length) : null;
  const iconsReady = useExplorerIconsReady();
  const Icon = fileIconName ? null : resolveExtIcon(icon);
  // Resolve the asset/data URL only when we won't be using a fileicon or
  // named icon (and an `icon` was actually provided). Kept as an unconditional
  // hook call (empty string when unused) to preserve hook order.
  const assetIcon = !fileIconName && !Icon && icon ? icon : "";
  const iconUrl = useResolvedExtensionIcon(extensionId, assetIcon);
  if (fileIconName) {
    const url = iconsReady ? explorerIconUrl(fileIconName) : "";
    return url ? (
      // eslint-disable-next-line react/forbid-dom-props
      <img
        src={url}
        alt=""
        style={{ width: size, height: size }}
        className={cn("shrink-0 object-contain", className)}
        draggable={false}
      />
    ) : (
      <span
        className={cn("shrink-0", className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  if (Icon) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center", className)}>
        <Icon size={size} strokeWidth={1.75} />
      </span>
    );
  }
  if (iconUrl) {
    const isSvg = iconUrl.startsWith("data:image/svg+xml") || iconUrl.endsWith(".svg");
    return isSvg ? (
      <span
        aria-hidden
        // eslint-disable-next-line react/forbid-dom-props
        style={{
          width: size,
          height: size,
          mask: `url("${iconUrl}") center / contain no-repeat`,
          WebkitMask: `url("${iconUrl}") center / contain no-repeat`,
        }}
        className={cn("shrink-0 bg-current", className)}
      />
    ) : (
      // eslint-disable-next-line react/forbid-dom-props
      <img
        src={iconUrl}
        alt=""
        style={{ width: size, height: size }}
        className={cn("shrink-0 object-contain", className)}
        loading="lazy"
        draggable={false}
      />
    );
  }
  // Fallback: a generic dashboard glyph so the header is never empty.
  return (
    <span className={cn("flex shrink-0 items-center justify-center", className)}>
      <LayoutDashboard size={size} strokeWidth={1.75} />
    </span>
  );
}

/** Lifecycle tone → label color, matching the SSH / ext-tab palette. */
function toneLabelClass(tone: SidebarSectionItem["tone"]): string {
  switch (tone) {
    case "connecting":
      return "text-icon-working animate-pulse";
    case "connected":
      return "text-icon-idle";
    case "error":
      return "text-icon-blocked";
    default:
      return "";
  }
}

export function ExtensionSidebarSection({
  extensionId,
  section,
  dragHandle,
  collapsed,
  surface = "sidebar",
}: {
  extensionId: string;
  section: SidebarSection;
  /** Drag grip + collapse chevron injected by AppSidebar's SortableSection. */
  dragHandle?: ReactNode;
  /** True while the panel is minimized to its header; skip the heavy body. */
  collapsed?: boolean;
  /** Where this instance is mounted. `"right"` (the shared right slot) swaps the
   *  "move to right" header control for "move back to left" + a close button. */
  surface?: "sidebar" | "right";
}) {
  const headerActions = section.headerActions ?? [];
  const items = section.items ?? [];
  const placementKey = sidebarSectionKey(extensionId, section.id);
  const moveRight = () => {
    useSidebarPlacementStore.getState().moveRight(placementKey);
    useRightPanelStore.getState().open(extensionId, sectionPanelId(section.id));
  };
  const moveLeft = () => {
    useSidebarPlacementStore.getState().moveLeft(placementKey);
    useRightPanelStore.getState().close();
  };
  const closeRight = () => useRightPanelStore.getState().close();
  // The header always renders its control cluster when the section is movable
  // (so the move toggle shows even with no header actions) or when hosted right.
  const showControlCluster =
    headerActions.length > 0 || surface === "right" || !!section.movableToRight;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = section.searchable && q ? filterSidebarItems(items, q) : items;

  // Recursive row renderer: rows nest into a lazy tree (caret + indent). A
  // non-expandable row with no children is a plain leaf (the flat-list case).
  const renderRow = (item: (typeof items)[number], depth: number): ReactNode => {
    const hasActions = !!(item.actions && item.actions.length > 0);
    const rowContent = (
      <div
        // Depth indent is dynamic, so it must be inline.
        // eslint-disable-next-line react/forbid-dom-props
        style={{ paddingInlineStart: 6 + depth * 12 }}
        className={cn(
          "group relative flex h-7 items-center gap-1 rounded pe-1.5 text-xs",
          item.active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
        )}
      >
        {item.expandable ? (
          <button
            type="button"
            aria-label={item.expanded ? "Collapse" : "Expand"}
            aria-expanded={item.expanded ? "true" : "false"}
            onClick={(e) => {
              e.stopPropagation();
              try {
                section.onItemToggle?.(item.id);
              } catch (err) {
                console.error(`[extensions] sidebar toggle "${item.id}" threw`, err);
              }
            }}
            className="hover:bg-foreground/10 flex size-4 shrink-0 items-center justify-center rounded"
          >
            {item.expanded ? (
              <ChevronDown size={11} strokeWidth={2.25} />
            ) : (
              <ChevronRight size={11} strokeWidth={2.25} />
            )}
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => {
            try {
              section.onItemClick?.(item.id);
            } catch (err) {
              console.error(`[extensions] sidebar item "${item.id}" threw`, err);
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <SectionIcon
            extensionId={extensionId}
            icon={item.icon}
            size={13}
            className="opacity-90"
          />
          <span className={cn("min-w-0 truncate", !item.active && toneLabelClass(item.tone))}>
            {item.label}
          </span>
          {item.badge ? (
            // Engine-type tag (MySQL / PostgreSQL / SQLite). Compact override of
            // the host <Badge> so it matches app-wide badge styling at row scale.
            <Badge
              variant={item.badge.variant ?? "secondary"}
              className="h-4 shrink-0 rounded px-1.5 text-[9px] leading-none font-medium tracking-wide"
            >
              {item.badge.text}
            </Badge>
          ) : null}
          <span className="min-w-0 flex-1" aria-hidden />
          {item.loading ? (
            // Animated spinner while the node loads its children. On rows that
            // also have hover actions it fades out on hover so it never sits
            // under the edit/delete buttons.
            <LoaderCircle
              size={12}
              strokeWidth={2}
              aria-label="Loading"
              className={cn(
                "text-muted-foreground shrink-0 animate-spin",
                hasActions && "transition-opacity group-hover:opacity-0",
              )}
            />
          ) : null}
        </button>
        {item.actions && item.actions.length > 0 && (
          <span className="pointer-events-none absolute right-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            {item.actions.map((a) => (
              <IconTooltip key={a.id} label={a.tooltip}>
                <Button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    try {
                      section.onItemAction?.(item.id, a.id);
                    } catch (err) {
                      console.error(`[extensions] sidebar item action "${a.id}" threw`, err);
                    }
                  }}
                  aria-label={a.tooltip}
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "size-5 rounded",
                    a.danger
                      ? // Red at rest, not only on hover: a delete has to be
                        // findable (and avoidable) before the pointer is on it.
                        "text-destructive/75 hover:bg-destructive/10 hover:text-destructive"
                      : cn("text-muted-foreground", TOOLBAR_HOVER),
                  )}
                >
                  <SectionIcon extensionId={extensionId} icon={a.icon} size={11} />
                </Button>
              </IconTooltip>
            ))}
          </span>
        )}
      </div>
    );
    return (
      <li key={item.id}>
        {/* Styled (radix) tooltip for the row's detail (e.g. a connection's
            host:port), matching the app's other tooltips instead of the native
            browser title bubble. Only rows with a sublabel get one. */}
        {item.sublabel ? (
          <Tooltip>
            <TooltipTrigger asChild>{rowContent}</TooltipTrigger>
            <TooltipContent side="right">{item.sublabel}</TooltipContent>
          </Tooltip>
        ) : (
          rowContent
        )}
        {item.expanded && item.children && item.children.length > 0 ? (
          <ul>{item.children.map((child) => renderRow(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
        {dragHandle}
        <SectionIcon
          extensionId={extensionId}
          icon={section.icon}
          size={13}
          className="text-muted-foreground"
        />
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">
          {section.title}
        </span>
        {showControlCluster && (
          <>
            <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
            {headerActions.map((a) => (
              <IconTooltip key={a.id} label={a.tooltip} side="bottom">
                <Button
                  onClick={() => {
                    try {
                      section.onHeaderAction?.(a.id);
                    } catch (err) {
                      console.error(`[extensions] sidebar header action "${a.id}" threw`, err);
                    }
                  }}
                  aria-label={a.tooltip}
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-6",
                    a.danger
                      ? // Red at rest, not only on hover: a delete has to be
                        // findable (and avoidable) before the pointer is on it.
                        "text-destructive/75 hover:bg-destructive/10 hover:text-destructive"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <SectionIcon extensionId={extensionId} icon={a.icon} size={13} />
                </Button>
              </IconTooltip>
            ))}
            {surface === "sidebar" && section.movableToRight ? (
              <IconTooltip label="Move to right panel" side="bottom">
                <Button
                  onClick={moveRight}
                  aria-label="Move to right panel"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground size-6"
                >
                  <PanelRight size={13} strokeWidth={2} />
                </Button>
              </IconTooltip>
            ) : null}
            {surface === "right" ? (
              <>
                <IconTooltip label="Move to left sidebar" side="bottom">
                  <Button
                    onClick={moveLeft}
                    aria-label="Move to left sidebar"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-6"
                  >
                    <PanelLeft size={13} strokeWidth={2} />
                  </Button>
                </IconTooltip>
                <IconTooltip label="Close panel" side="bottom">
                  <Button
                    onClick={closeRight}
                    aria-label="Close panel"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-6"
                  >
                    <X size={13} strokeWidth={2} />
                  </Button>
                </IconTooltip>
              </>
            ) : null}
          </>
        )}
      </div>
      {!collapsed && section.searchable && (
        <div className="border-border/60 shrink-0 border-b px-2 py-1.5">
          {/* Filled rounded box mirroring the Source Control commit input:
              bg-input/50, transparent border that turns ring-colored on focus. */}
          <div className="bg-input/50 focus-within:border-ring flex h-7 items-center gap-1.5 rounded-md border border-transparent px-2 transition-[color,background-color]">
            <Search size={12} strokeWidth={2} className="text-muted-foreground/70 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={section.searchPlaceholder ?? "Search…"}
              aria-label={section.searchPlaceholder ?? "Search"}
              spellCheck={false}
              autoComplete="off"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[11.5px] outline-none"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="text-muted-foreground/70 hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded"
              >
                <X size={11} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </div>
      )}
      {!collapsed && (
        <ScrollArea className="min-h-0 flex-1">
          {/* pr-2.5 reserves the 10px Radix ScrollArea overlay-thumb width so the
              row hover-action cluster never sits under the scrollbar. */}
          <ul className="p-1 pr-2.5">
            {items.length === 0 ? (
              <li className="text-muted-foreground px-2 py-1.5 text-[11px]">
                {section.emptyText ?? "Nothing here yet."}
              </li>
            ) : shown.length === 0 ? (
              <li className="text-muted-foreground px-2 py-1.5 text-[11px]">No matches.</li>
            ) : (
              shown.map((item) => renderRow(item, 0))
            )}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
