import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// The transition names `scale`/`rotate` and NOT `transform`: Tailwind v4's
// scale-* / rotate-* utilities set the INDIVIDUAL transform properties, so
// `transition-transform` would leave them snapping.
const SLOT =
  "col-start-1 row-start-1 flex items-center justify-center transition-[scale,rotate,opacity] duration-200 ease-out motion-reduce:transition-none";
const HIDDEN = "pointer-events-none scale-50 -rotate-45 opacity-0";

/**
 * Morph between icons that share no geometry (copy -> check, sun -> moon,
 * icon -> spinner). A ternary between two icons replaces the DOM node, so it
 * can never animate; here every icon stays mounted in one grid cell and the
 * outgoing one shrinks away while the incoming one turns in.
 *
 * Pass a spinner as `busy && <Spinner />`, so a hidden one is unmounted instead
 * of spinning invisibly (idle CPU is the budget).
 */
export function IconSwap({
  active,
  icons,
  className,
}: {
  active: number;
  icons: ReactNode[];
  className?: string;
}) {
  return (
    <span className={cn("inline-grid shrink-0 place-items-center", className)}>
      {icons.map((icon, i) => (
        <span
          key={i}
          aria-hidden={i !== active || undefined}
          className={cn(SLOT, i !== active && HIDDEN)}
        >
          {icon}
        </span>
      ))}
    </span>
  );
}

/**
 * The "-off" variant of an icon as the icon itself plus a slash that draws in
 * from the top-left, instead of a swap to lucide's `*Off` glyph (which redraws
 * the base shape, so swapping jumps). The slash is lucide's own (2,2)-(22,22)
 * in the 24 viewBox at the icon's strokeWidth, so it scales with any size.
 */
export function IconSlash({
  icon: Icon,
  slashed,
  size,
  strokeWidth = 2,
  className,
}: {
  icon: LucideIcon;
  slashed: boolean;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <Icon size={size} strokeWidth={strokeWidth} />
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        className="pointer-events-none absolute inset-0 size-full"
      >
        {/* Opacity rides along so the round caps of a zero-length dash do not
            leave dots at both ends while hidden. */}
        <line
          x1="2"
          y1="2"
          x2="22"
          y2="22"
          pathLength={1}
          strokeDasharray="1"
          style={{ strokeDashoffset: slashed ? 0 : 1, opacity: slashed ? 1 : 0 }}
          className="transition-[stroke-dashoffset,opacity] duration-200 ease-out motion-reduce:transition-none"
        />
      </svg>
    </span>
  );
}
