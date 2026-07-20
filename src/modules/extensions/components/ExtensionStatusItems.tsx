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

// Progress-bar fill colour per tone. Usage meters read best when a low bar is
// calm and a full one is alarming, so the extension drives `tone` by severity
// and the fill follows it.
const BAR_FILL: Record<NonNullable<StatusItem["tone"]>, string> = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
  default: "bg-foreground/70",
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// Text colour for the percent readout. Normal states stay muted; only the
// "about to run out" (amber) and "spent" (red) states pop, so the colour is an
// at-a-glance indicator alongside the bar.
function valueColor(tone: StatusItem["tone"]): string {
  if (tone === "error") return "text-red-500";
  if (tone === "warning") return "text-amber-500";
  return "text-muted-foreground";
}

// A blocky "pixel" progress bar: `cells` square segments, the leading
// `round(progress * cells)` filled in the tone colour, the rest muted. Sharp
// corners (no rounding) for the pixel look.
function PixelBar({
  progress,
  tone,
  cells,
  cellClass,
  className,
}: {
  progress: number;
  tone?: StatusItem["tone"];
  cells: number;
  cellClass: string;
  className?: string;
}) {
  const filled = Math.round(clamp01(progress) * cells);
  const fill = BAR_FILL[tone ?? "default"];
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} aria-hidden>
      {Array.from({ length: cells }).map((_, i) => (
        <span key={i} className={cn(cellClass, i < filled ? fill : "bg-muted-foreground/25")} />
      ))}
    </span>
  );
}

// Tooltip body. With `detail` set it renders a small panel with a pixel
// progress bar per row; otherwise the plain `tooltip` string (newlines kept).
function TooltipBody({ item }: { item: StatusItem }) {
  if (!item.detail) return <span className="whitespace-pre-line">{item.tooltip}</span>;
  const { title, rows } = item.detail;
  return (
    <div className="flex min-w-[196px] flex-col gap-1.5">
      {title ? <div className="text-foreground text-xs font-medium">{title}</div> : null}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 text-[11px] leading-none">
          {r.label ? <span className="text-muted-foreground w-14 shrink-0">{r.label}</span> : null}
          {r.progress != null ? (
            <PixelBar
              progress={r.progress}
              tone={r.tone}
              cells={10}
              cellClass="h-2.5 w-1"
              className="gap-[2px]"
            />
          ) : null}
          {r.value ? (
            <span className={cn("shrink-0 tabular-nums", valueColor(r.tone))}>{r.value}</span>
          ) : null}
          {r.note ? <span className="text-muted-foreground shrink-0">{r.note}</span> : null}
        </div>
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
  // Icon-only items keep the plain-icon tint. A metered item (has `label`
  // or `progress`) tints its icon by tone too so it never sits at 40% muted
  // beside a live bar.
  const hasMeter = item.progress != null || item.label != null;
  const iconLive = isLive || hasMeter;

  const onClick = item.onClick;
  const interactive = typeof onClick === "function";

  const iconEl = Icon ? (
    <Icon
      size={16}
      strokeWidth={1.8}
      className={cn(
        "transition-colors duration-200",
        iconLive ? "text-foreground" : "text-muted-foreground/40",
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
          iconLive ? "bg-foreground" : "bg-muted-foreground/40",
          isPulsing && "animate-pulse",
        )}
      />
    ) : (
      <img
        src={iconUrl}
        alt=""
        className={cn(
          "size-4 object-contain transition-opacity duration-200",
          iconLive ? "opacity-100" : "opacity-40 grayscale",
          isPulsing && "animate-pulse",
        )}
        loading="lazy"
        draggable={false}
      />
    )
  ) : (
    <span className="bg-muted size-4 rounded-sm" aria-hidden />
  );

  const shellClass = hasMeter
    ? "relative inline-flex h-6 shrink-0 items-center gap-1 px-0.5 transition-opacity hover:opacity-80"
    : "relative inline-flex size-6 shrink-0 items-center justify-center transition-opacity hover:opacity-80";

  const body = hasMeter ? (
    <>
      <span className="inline-flex size-4 items-center justify-center">{iconEl}</span>
      {item.label != null ? (
        <span
          className={cn("text-[10px] leading-none font-medium tabular-nums", valueColor(item.tone))}
        >
          {item.label}
        </span>
      ) : null}
      {item.progress != null ? (
        <PixelBar
          progress={item.progress}
          tone={item.tone}
          cells={8}
          cellClass="h-2 w-[3px]"
          className="gap-px"
        />
      ) : null}
    </>
  ) : (
    <>
      {iconEl}
      {dot ? (
        <span
          aria-hidden
          className={cn("ring-card absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2", dot)}
        />
      ) : null}
    </>
  );

  return (
    <IconTooltip label={<TooltipBody item={item} />} side="top">
      {/* A clickable item is a real <button>: focusable and Enter/Space
          activated. A decorative one stays <span role="img"> so nothing is
          announced as interactive when it isn't. `onClick` is third-party code,
          so a throw is caught here the same way `ExtensionHeaderItems` does it,
          rather than being allowed to unmount the status bar. */}
      {interactive ? (
        <button
          type="button"
          aria-label={item.tooltip}
          className={cn(shellClass, "cursor-pointer")}
          onClick={() => {
            try {
              onClick?.();
            } catch (err) {
              console.error(
                `[extensions] ${extensionId} status item "${item.id}" onClick threw`,
                err,
              );
            }
          }}
        >
          {body}
        </button>
      ) : (
        <span role="img" aria-label={item.tooltip} className={shellClass}>
          {body}
        </span>
      )}
    </IconTooltip>
  );
}
