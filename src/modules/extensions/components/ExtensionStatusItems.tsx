/**
 * Status-bar slot for extension icons. Renders every `StatusItem` in
 * `statusItemsRegistry`, sorted by (extensionId, itemId).
 * Icons are 16 px (size-4), no frame. Bytes cached via `loadExtensionIcon`.
 * Tone: `success` full opacity, `warning` pulses, `error` adds a red corner dot.
 */
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { resolveExtIcon, useIconsReady } from "@/lib/iconRegistry";

import { useResolvedExtensionIcon } from "../icon";
import { statusItemsRegistry, type StatusItem } from "../registries";
import { useRegistry } from "../useRegistry";

export function ExtensionStatusItems() {
  const items = useRegistry(statusItemsRegistry);
  if (items.length === 0) return null;
  // Sort by extension id then item id so the order is stable.
  const sorted = [...items].sort((a, b) => {
    const e = a.extensionId.localeCompare(b.extensionId);
    return e !== 0 ? e : a.item.id.localeCompare(b.item.id);
  });
  return (
    <div className="flex items-center gap-1.5">
      {sorted.map(({ extensionId, item }) => (
        <StatusItemView key={`${extensionId}:${item.id}`} extensionId={extensionId} item={item} />
      ))}
    </div>
  );
}

function StatusItemView({ extensionId, item }: { extensionId: string; item: StatusItem }) {
  useIconsReady(); // re-render once the lazy icon chunk lands
  // `lucide:<Name>` / legacy `hugeicon:<Name>` renders a Lucide icon (parity
  // with the header bar); otherwise the value is a `data:` URL or `ext-asset:`.
  const Icon = resolveExtIcon(item.icon);
  const iconUrl = useResolvedExtensionIcon(extensionId, Icon ? "" : item.icon);
  // `<img>` ignores parent CSS `color`, so render SVGs as a CSS mask
  // for theme-aware tinting. Detection: data: SVG URL or `.svg` path.
  // Raster formats fall back to `<img>` with opacity + grayscale.
  const isLive = item.tone === "success";
  const isPulsing = item.tone === "warning";
  const isSvg =
    iconUrl !== null && (iconUrl.startsWith("data:image/svg+xml") || iconUrl.endsWith(".svg"));
  // Only `error` gets a corner dot. `warning` pulses instead.
  const dot = item.tone === "error" ? "bg-icon-blocked" : null;
  return (
    <IconTooltip label={item.tooltip} side="top">
      <span
        role="img"
        aria-label={item.tooltip}
        className="relative inline-flex size-6 shrink-0 items-center justify-center transition-opacity hover:opacity-80"
      >
        {Icon ? (
          <Icon
            size={16}
            strokeWidth={1.8}
            className={cn(
              "transition-colors duration-200",
              isLive ? "text-foreground" : "text-muted-foreground/40",
              isPulsing && "animate-pulse",
            )}
          />
        ) : iconUrl ? (
          isSvg ? (
            <span
              aria-hidden
              // CSS mask paints `background-color` where the SVG is opaque.
              // Connected uses `--foreground`, off uses muted at 40%.
              style={{
                mask: `url("${iconUrl}") center / contain no-repeat`,
                WebkitMask: `url("${iconUrl}") center / contain no-repeat`,
              }}
              className={cn(
                "size-4 transition-colors duration-200",
                isLive ? "bg-foreground" : "bg-muted-foreground/40",
                isPulsing && "animate-pulse",
              )}
            />
          ) : (
            <img
              src={iconUrl}
              alt=""
              className={cn(
                "size-4 object-contain transition-opacity duration-200",
                isLive ? "opacity-100" : "opacity-40 grayscale",
                isPulsing && "animate-pulse",
              )}
              loading="lazy"
              draggable={false}
            />
          )
        ) : (
          <span className="bg-muted size-4 rounded-sm" aria-hidden />
        )}
        {dot ? (
          <span
            aria-hidden
            className={cn(
              "ring-card absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2",
              dot,
            )}
          />
        ) : null}
      </span>
    </IconTooltip>
  );
}
