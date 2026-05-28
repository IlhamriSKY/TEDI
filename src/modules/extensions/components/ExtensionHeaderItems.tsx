/**
 * Header-bar slot for extension icons. Renders every `HeaderItem` in
 * `headerItemsRegistry`, sorted by (extensionId, itemId), and dispatches
 * `onClick` to the registering extension's handler.
 * Visual baseline matches the host's own header icon buttons (SSH /
 * Extensions / Settings): size-7 ghost button, SVG mask tint, hover bg.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { tryGetHugeIcon, useHugeIconsReady } from "@/lib/hugeIconsBarrel";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

import { loadExtensionIcon } from "../icon";
import { headerItemsRegistry, type HeaderItem } from "../registries";
import { useRegistry } from "../useRegistry";

/** Strip the `hugeicon:` prefix and resolve against the lazy-loaded
 *  `@hugeicons/core-free-icons` barrel. Returns null for unknown names so
 *  the caller falls back to the empty-placeholder branch; also returns null
 *  while the barrel is still in flight on first paint. */
function resolveHugeIcon(icon: string): IconSvgElement | null {
  const m = icon.match(/^hugeicon:(.+)$/);
  if (!m) return null;
  return tryGetHugeIcon(m[1]);
}

export function ExtensionHeaderItems({ placement = "right" }: { placement?: "left" | "right" } = {}) {
  const items = useRegistry(headerItemsRegistry);
  // Subscribe so the icon row re-renders once the lazy barrel arrives.
  useHugeIconsReady();
  const matching = items.filter(({ item }) => (item.placement ?? "right") === placement);
  if (matching.length === 0) return null;
  const sorted = [...matching].sort((a, b) => {
    const e = a.extensionId.localeCompare(b.extensionId);
    return e !== 0 ? e : a.item.id.localeCompare(b.item.id);
  });
  return (
    <>
      {sorted.map(({ extensionId, item }) => (
        <HeaderItemView key={`${extensionId}:${item.id}`} extensionId={extensionId} item={item} />
      ))}
    </>
  );
}

function HeaderItemView({ extensionId, item }: { extensionId: string; item: HeaderItem }) {
  // `hugeicon:<Name>` short-circuits the asset loader and renders the host's
  // own HugeIcon component (line-art, current-color, pixel-perfect parity
  // with SSH / Extensions / Settings buttons). Falls back to file / data:
  // URL loading via `loadExtensionIcon` otherwise.
  const hugeIcon = resolveHugeIcon(item.icon);
  const iconUrl = useResolvedIcon(extensionId, hugeIcon ? "" : item.icon);
  const isSvg =
    iconUrl !== null &&
    (iconUrl.startsWith("data:image/svg+xml") || iconUrl.endsWith(".svg"));
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
          "hover:bg-accent hover:text-accent-foreground size-7 shrink-0 rounded-md",
          hugeIcon && toneColorClass,
          tone === "warning" && "animate-pulse",
        )}
      >
        {hugeIcon ? (
          <HugeiconsIcon icon={hugeIcon} size={15} strokeWidth={1.75} />
        ) : iconUrl ? (
          isSvg ? (
            <span
              aria-hidden
              style={{
                mask: `url("${iconUrl}") center / contain no-repeat`,
                WebkitMask: `url("${iconUrl}") center / contain no-repeat`,
              }}
              className={cn(
                "size-[15px] transition-colors duration-200",
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
                "size-[15px] object-contain transition-opacity duration-200",
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

function useResolvedIcon(extensionId: string, icon: string): string | null {
  const [url, setUrl] = useState<string | null>(() => (icon.startsWith("data:") ? icon : null));
  useEffect(() => {
    if (icon.startsWith("data:")) {
      setUrl(icon);
      return;
    }
    let alive = true;
    void loadExtensionIcon(extensionId, icon).then((next) => {
      if (alive) setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [extensionId, icon]);
  return url;
}
