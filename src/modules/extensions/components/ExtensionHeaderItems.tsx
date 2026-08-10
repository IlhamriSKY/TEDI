/**
 * Header-bar slot for extension icons. Renders every `HeaderItem` in
 * `headerItemsRegistry`, sorted by (extensionId, itemId), and dispatches
 * `onClick` to the registering extension's handler.
 * Visual baseline matches the host's own header icon buttons (SSH /
 * Extensions / Settings): size-7 ghost button, SVG mask tint, hover bg.
 */
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { PANE_HEADER_HOVER, TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { resolveExtIcon, useIconsReady } from "@/lib/iconRegistry";

import { useResolvedExtensionIcon } from "../icon";
import { headerItemsRegistry, type HeaderItem } from "../registries";
import { useRegistry } from "../useRegistry";

export function ExtensionHeaderItems({
  placement = "right",
  compact = false,
}: { placement?: "left" | "right"; compact?: boolean } = {}) {
  const items = useRegistry(headerItemsRegistry);
  // Subscribe so the icon row re-renders once the lazy icon chunk arrives.
  useIconsReady();
  const matching = items.filter(({ item }) => (item.placement ?? "right") === placement);
  if (matching.length === 0) return null;
  const sorted = [...matching].sort((a, b) => {
    const e = a.extensionId.localeCompare(b.extensionId);
    return e !== 0 ? e : a.item.id.localeCompare(b.item.id);
  });
  return (
    <>
      {sorted.map(({ extensionId, item }) => (
        <HeaderItemView
          key={`${extensionId}:${item.id}`}
          extensionId={extensionId}
          item={item}
          compact={compact}
        />
      ))}
    </>
  );
}

/** `compact` shrinks the button to the 20px scale of a pane header's own
 *  buttons (grip / float / gear), where `placement: "left"` items now live. */
function HeaderItemView({
  extensionId,
  item,
  compact,
}: {
  extensionId: string;
  item: HeaderItem;
  compact: boolean;
}) {
  // `lucide:<Name>` / legacy `hugeicon:<Name>` short-circuits the asset loader
  // and renders a Lucide icon (line-art, current-color, parity with the host's
  // SSH / Extensions / Settings buttons). Falls back to file / data: URL
  // loading via `loadExtensionIcon` otherwise.
  const Icon = resolveExtIcon(item.icon);
  const iconUrl = useResolvedExtensionIcon(extensionId, Icon ? "" : item.icon);
  const isSvg =
    iconUrl !== null && (iconUrl.startsWith("data:image/svg+xml") || iconUrl.endsWith(".svg"));
  const tone = item.tone ?? "default";
  const toneColorClass =
    tone === "success"
      ? "text-foreground"
      : tone === "error"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <IconTooltip label={item.tooltip} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        type="button"
        aria-label={item.tooltip}
        onClick={(event) => {
          try {
            item.onClick(event.nativeEvent);
          } catch (err) {
            console.error(`[extensions] header item "${extensionId}:${item.id}" threw`, err);
          }
        }}
        className={cn(
          compact ? PANE_HEADER_HOVER : TOOLBAR_HOVER,
          compact ? "size-5 shrink-0 rounded" : "size-7 shrink-0 rounded-md",
          Icon && toneColorClass,
          tone === "warning" && "animate-pulse",
        )}
      >
        {Icon ? (
          // The `size` prop only sets width/height *attributes*, which the
          // Button's `[&_svg:not([class*='size-'])]:size-4` rule overrides -
          // compact needs the class so it matches the pane header's own 12px
          // icons instead of rendering 16px.
          <Icon
            className={compact ? "size-3" : undefined}
            size={compact ? 12 : 15}
            strokeWidth={compact ? 2 : 1.75}
          />
        ) : iconUrl ? (
          isSvg ? (
            <span
              aria-hidden
              style={{
                mask: `url("${iconUrl}") center / contain no-repeat`,
                WebkitMask: `url("${iconUrl}") center / contain no-repeat`,
              }}
              className={cn(
                compact ? "size-3" : "size-[15px]",
                "transition-colors duration-200",
                tone === "success"
                  ? "bg-foreground"
                  : tone === "error"
                    ? "bg-destructive"
                    : "bg-muted-foreground",
              )}
            />
          ) : (
            <img
              src={iconUrl}
              alt=""
              className={cn(
                compact ? "size-3" : "size-[15px]",
                "object-contain transition-opacity duration-200",
                tone === "success" ? "opacity-100" : "opacity-80",
              )}
              loading="lazy"
              draggable={false}
            />
          )
        ) : (
          <span className="bg-muted size-[15px] rounded-sm" aria-hidden />
        )}
      </Button>
    </IconTooltip>
  );
}
