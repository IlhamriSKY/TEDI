/**
 * Status-bar slot for extension icons. Renders every `StatusItem` in
 * `statusItemsRegistry`, metered items first, then by (extensionId, itemId).
 * Icons are 16 px (size-4), no frame. Bytes cached via `loadExtensionIcon`.
 * Tone: `success` full opacity, `warning` pulses, `error` adds a red corner dot.
 */
import { useState } from "react";

import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";

import { useExtensionIcon } from "../icon";
import { orderStatusItems, statusItemsRegistry, type StatusItem } from "../registries";
import { useRegistry } from "../useRegistry";

/** One extension status item, as the status bar's zone layout sees it. */
export type StatusItemEntry = {
  /** `ext:<extensionId>:<itemId>` - stable across reloads, and the key the
   *  saved zone layout is written against. */
  id: string;
  /** A meter (something with a bar) belongs with the readouts; a bare icon is
   *  an indicator. */
  meter: boolean;
  node: React.ReactNode;
};

/**
 * Every extension status item as an individually placeable entry.
 *
 * The bar used to render these as one block, which is why they could only ever
 * be one group; the status bar now owns the layout, so it needs them one at a
 * time. Ordering still comes from `orderStatusItems`, which decides the
 * DEFAULT order - the user's own arrangement is applied on top of it.
 */
export function useStatusItemEntries(): StatusItemEntry[] {
  const items = useRegistry(statusItemsRegistry);
  return orderStatusItems(items).map(({ extensionId, item }) => ({
    id: `ext:${extensionId}:${item.id}`,
    meter: item.progress !== undefined,
    node: <StatusItemView extensionId={extensionId} item={item} />,
  }));
}

// Progress-bar fill colour per tone. Usage meters read best when a low bar is
// calm and a full one is alarming, so the extension drives `tone` by severity
// and the fill follows it.
//
// The three severities ride the THEME's status triad (the same tokens the AI
// CLI badge uses), not fixed Tailwind hues: a Claude/Codex meter in a warm or
// monochrome preset used to sit at emerald/amber/red no matter what the rest of
// the window looked like. `error` already matched, via the corner dot below.
const BAR_FILL: Record<NonNullable<StatusItem["tone"]>, string> = {
  error: "bg-icon-blocked",
  warning: "bg-icon-working",
  success: "bg-icon-idle",
  default: "bg-foreground/70",
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// Text colour for the percent readout. Normal states stay muted; only the
// "about to run out" (amber) and "spent" (red) states pop, so the colour is an
// at-a-glance indicator alongside the bar.
function valueColor(tone: StatusItem["tone"]): string {
  if (tone === "error") return "text-icon-blocked";
  if (tone === "warning") return "text-icon-working";
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

/** The widest grid the tooltip's popover holds without wrapping: 48 columns of
 *  a 4 px cell plus its 2 px gap is 288 px, inside `max-w-xs` less padding. */
const MAX_CHART_COLS = 48;
/** A `cells` grid is a year of weeks, and only ever appears inside a `detail`
 *  popover, which is `max-w-md` - so it affords the five extra columns. */
const MAX_CELL_COLS = 53;

/** An unlit cell. A trend has a couple of hundred and needs a visible track;
 *  a calendar has 371 and a year of quiet days would otherwise read as a slab
 *  of grey with the actual work lost in it, so its empties sit further back. */
const EMPTY_CELL = "bg-muted-foreground/25";
const EMPTY_CALENDAR_CELL = "bg-muted-foreground/12";
/** Column pitch in cells mode: a 5 px cell (`size-[5px]` below, a pixel wider
 *  than a trend's so a year of them is legible and each is a usable hover
 *  target) plus its 2 px gap. 53 columns is 371 px, which the `max-w-md`
 *  detail popover holds. Only the column labels need the number. */
const CELL_PITCH = 7;
/** Shades a `cells` value gets, faintest first. Four steps like the calendar
 *  grid this draws: enough to read density, few enough to tell apart. */
const CELL_SHADES = ["opacity-30", "opacity-50", "opacity-75", "opacity-100"];

// One trend column: the lowest `round(v * rows)` cells lit, the top one at full
// strength so the shape reads across the grid. A zero stays dark; anything
// above it lights at least one cell, so a value sitting on the axis floor is
// still visibly a sample.
function barColumn(v: number, rows: number, fill: string): string[] {
  const lit = v <= 0 ? 0 : Math.max(1, Math.round(clamp01(v) * rows));
  return Array.from({ length: rows }, (_, r) =>
    r >= lit ? EMPTY_CELL : r === lit - 1 ? fill : cn(fill, "opacity-55"),
  );
}

// One calendar cell: the empty track for a day with nothing in it, else one of
// four shades.
function shadeCell(v: number, fill: string): string {
  if (v <= 0) return EMPTY_CALENDAR_CELL;
  const step = Math.min(CELL_SHADES.length, Math.ceil(clamp01(v) * CELL_SHADES.length));
  return cn(fill, CELL_SHADES[step - 1]);
}

/**
 * A trend or a calendar on the same grid `PixelBar` draws: 4 px cells, 2 px
 * gaps. Values arrive pre-scaled to 0..1 - the extension owns its axis, the
 * host owns the look.
 *
 * Both modes are one markup path, because only what a value MEANS differs: a
 * column of cells is a bar in `columns` mode and a week of days in `cells`.
 */
function PixelChart({ chart }: { chart: NonNullable<StatusItem["detail"]>["chart"] }) {
  // Which cell the pointer is on, so the caption can name it. Declared before
  // the early return because a hook cannot be conditional.
  const [hovered, setHovered] = useState<number | null>(null);
  if (!chart || chart.values.length === 0) return null;
  const rows = Math.max(3, Math.min(16, chart.rows ?? 8));
  const fill = BAR_FILL[chart.tone ?? "default"];
  const cells = chart.mode === "cells";
  // Trim to what fits, and keep the labels on the same slice or a cell would
  // report its neighbour's date.
  const keep = cells ? MAX_CELL_COLS * rows : MAX_CHART_COLS;
  const values = chart.values.slice(-keep);
  const cellLabels = chart.cellLabels?.slice(-keep);
  const cols: string[][] = [];
  if (cells) {
    for (const v of values) {
      if (cols.length === 0 || cols[cols.length - 1].length === rows) cols.push([]);
      cols[cols.length - 1].push(shadeCell(v, fill));
    }
  } else {
    for (const v of values) cols.push(barColumn(v, rows, fill));
  }
  const columnLabels = cells ? chart.columnLabels?.slice(-cols.length) : undefined;
  // The hovered cell's own label replaces the summary, which is the whole
  // point: a square in a grid of 371 cannot say what day it is on its own.
  const note = (hovered != null ? cellLabels?.[hovered] : null) || chart.note;
  return (
    <div className="flex flex-col gap-1">
      {columnLabels?.some(Boolean) ? (
        // Absolute, on the column pitch: a label is wider than its column and
        // has to overhang rather than push the grid out of alignment.
        <div className="text-muted-foreground relative h-2.5 text-[9px] leading-none">
          {columnLabels.map((label, i) =>
            label ? (
              <span key={i} className="absolute top-0" style={{ left: i * CELL_PITCH }}>
                {label}
              </span>
            ) : null,
          )}
        </div>
      ) : null}
      {/* A trend grows from the baseline up, a calendar reads from the top row
          down, which is the only thing the two layouts disagree about. */}
      <div
        className={cn("flex gap-[2px]", cells ? "items-start" : "items-end")}
        aria-hidden
        onMouseLeave={hovered == null ? undefined : () => setHovered(null)}
      >
        {cols.map((col, i) => (
          <span key={i} className={cn("flex gap-[2px]", cells ? "flex-col" : "flex-col-reverse")}>
            {col.map((cellClass, r) => (
              <span
                key={r}
                className={cn(cells ? "size-[5px]" : "h-1 w-1", cellClass)}
                onMouseEnter={cellLabels ? () => setHovered(i * rows + r) : undefined}
              />
            ))}
          </span>
        ))}
      </div>
      {chart.label || note ? (
        <div className="text-muted-foreground flex items-baseline justify-between gap-3 text-[10px] leading-none">
          <span className="shrink-0">{chart.label}</span>
          <span className="shrink-0 tabular-nums">{note}</span>
        </div>
      ) : null}
    </div>
  );
}

// Tooltip body. With `detail` set it renders a small panel with an optional
// pixel trend and a progress bar per row; otherwise the plain `tooltip` string
// (newlines kept).
function TooltipBody({ item }: { item: StatusItem }) {
  if (!item.detail) return <span className="whitespace-pre-line">{item.tooltip}</span>;
  const { title, rows, chart } = item.detail;
  return (
    <div className="flex min-w-[196px] flex-col gap-1.5">
      {title ? <div className="text-foreground text-xs font-medium">{title}</div> : null}
      <PixelChart chart={chart} />
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
          {/* Not pinned to the panel's right edge, even though a chart can make
              the panel much wider than a row needs: a note is as often a suffix
              to the value ("7.7G" "of 32G") as an independent fact, and pushing
              it away breaks the ones that read as a phrase. */}
          {r.note ? <span className="text-muted-foreground shrink-0">{r.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

function StatusItemView({ extensionId, item }: { extensionId: string; item: StatusItem }) {
  const { Icon, url: iconUrl, isSvg } = useExtensionIcon(extensionId, item.icon);
  const isLive = item.tone === "success";
  const isPulsing = item.tone === "warning";
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

  // `px-1` is not decoration: an icon-only item is a 16 px glyph centred in a
  // 24 px box, so its ink already sits 4 px inside its own edge. A meter drawn
  // flush against its box put 10 px of white between two meters where two icons
  // showed 14 px, which is what made the readouts read cramped next to an airy
  // row of buttons. Matching the inset makes the whole bar one rhythm.
  const shellClass = hasMeter
    ? "relative inline-flex h-6 shrink-0 items-center gap-1 px-1 transition-opacity hover:opacity-80"
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
    <IconTooltip
      label={<TooltipBody item={item} />}
      side="top"
      // A structured detail is a small panel, not a sentence: one row carries a
      // label, a bar, a value and a note (a usage meter's "Monthly [bar] 41%
      // resets in 29d 4h"), and none of them shrink. At the default `max-w-xs`
      // the note ran off the edge and was clipped mid-word. A plain string
      // tooltip keeps the narrow default, where wrapping is what you want.
      contentClassName={item.detail ? "max-w-md" : undefined}
    >
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
