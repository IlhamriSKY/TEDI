/**
 * Status-bar slot for extension-contributed icons. Renders every
 * `StatusItem` currently sitting in `statusItemsRegistry`, ordered by
 * (extensionId, itemId) for stable visual layout across renders.
 *
 * Each item is a bare 16 px icon with a tooltip. 11 px (the size used
 * by the labeled pills next door) read as too small for a stand-alone
 * mark next to the "Open AI agent" / "Ctrl+I" affordances - 16 px is
 * the standard `size-4` utility, balanced with the surrounding text.
 * No frame chrome - icons read as marks, not buttons.
 * The icon resolves via `loadExtensionIcon` so its bytes are cached
 * across re-renders and across extensions sharing the same path.
 *
 * Tone tinting:
 *   - `success` → icon at full opacity, no extra badge (the live
 *     vs. dimmed state already conveys "connected").
 *   - `warning` / `error` → tiny dot in the top-right corner so the
 *     user notices something needs attention.
 */
import { useEffect, useState } from "react";

import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";

import { loadExtensionIcon } from "../icon";
import { statusItemsRegistry, type StatusItem } from "../registries";
import { useRegistry } from "../useRegistry";

export function ExtensionStatusItems() {
  const items = useRegistry(statusItemsRegistry);
  if (items.length === 0) return null;
  // Stable order: by extension id first, then by item id within. Avoids
  // jitter when registries emit on unrelated updates.
  const sorted = [...items].sort((a, b) => {
    const e = a.extensionId.localeCompare(b.extensionId);
    return e !== 0 ? e : a.item.id.localeCompare(b.item.id);
  });
  return (
    <div className="flex items-center gap-1">
      {sorted.map(({ extensionId, item }) => (
        <StatusItemView key={`${extensionId}:${item.id}`} extensionId={extensionId} item={item} />
      ))}
    </div>
  );
}

function StatusItemView({ extensionId, item }: { extensionId: string; item: StatusItem }) {
  const iconUrl = useResolvedIcon(extensionId, item.icon);
  // `<img>` ignores the parent's CSS `color`, so a `currentColor` SVG
  // loaded that way always paints at whatever the SVG file declared
  // (typically black). For theme-aware tinting we render the icon as a
  // CSS mask instead - the `<span>` provides the colour via
  // `background-color`, and only the SVG's opaque silhouette shows
  // through. Works on every modern browser the Tauri webview targets.
  //
  // Detection: any data: SVG URL or a path ending in `.svg`. Raster
  // formats (PNG / JPG / WEBP) fall back to a regular `<img>` with
  // opacity + grayscale for the dimmed state.
  const isLive = item.tone === "success";
  const isSvg =
    iconUrl !== null &&
    (iconUrl.startsWith("data:image/svg+xml") || iconUrl.endsWith(".svg"));
  const dot =
    item.tone === "warning"
      ? "bg-amber-500"
      : item.tone === "error"
        ? "bg-red-500"
        : null;
  return (
    <IconTooltip label={item.tooltip} side="top">
      <span
        role="img"
        aria-label={item.tooltip}
        className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center transition-opacity hover:opacity-80"
      >
        {iconUrl ? (
          isSvg ? (
            <span
              aria-hidden
              // CSS mask paints the parent's `background-color` only
              // where the SVG is opaque. The two state classes pick
              // the host theme's `--foreground` (connected, full
              // attention) vs the muted-foreground at 40% (clearly
              // "off" without being invisible).
              style={{
                WebkitMaskImage: `url("${iconUrl}")`,
                maskImage: `url("${iconUrl}")`,
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
                WebkitMaskSize: "contain",
                maskSize: "contain",
              }}
              className={cn(
                "size-4 transition-colors duration-200",
                isLive ? "bg-foreground" : "bg-muted-foreground/40",
              )}
            />
          ) : (
            <img
              src={iconUrl}
              alt=""
              className={cn(
                "size-4 object-contain transition-opacity duration-200",
                isLive ? "opacity-100" : "opacity-40 grayscale",
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

/**
 * Hook that resolves the StatusItem `icon` field into a renderable URL:
 *   - `data:` URLs pass through unchanged.
 *   - Otherwise the value is treated as a path relative to the
 *     extension's install root and read via `loadExtensionIcon`
 *     (cached + deduped).
 */
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
