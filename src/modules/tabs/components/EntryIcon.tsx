import { cn } from "@/lib/utils";
import { LeafIcon } from "@/components/LeafIcon";
import { tryGetHugeIcon } from "@/lib/hugeIconsBarrel";
import { Database01Icon, GitBranchIcon, GitCompareIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Entry } from "../lib/entries";

/**
 * Pill badge stamped next to terminal + browser entries ("Terminal 3" /
 * "Browser 2"). For terminals it's the same ordinal the AI sees in `<env>`.
 * Public tabs use the muted palette so the emerald/yellow/red palette stays
 * reserved for the AI CLI icon tint. Private tabs override the badge to solid
 * red so the number-going-red is the headline signal that the AI cannot see
 * this tab.
 */
function OrdinalBadge({
  ordinal,
  leafKind,
  isPrivate,
}: {
  ordinal: number;
  leafKind: "terminal" | "browser";
  isPrivate?: boolean;
}) {
  const word = leafKind === "browser" ? "Browser" : "Terminal";
  const label = isPrivate
    ? leafKind === "browser"
      ? `${word} ${ordinal} (private)`
      : `${word} ${ordinal} (private, hidden from AI)`
    : `${word} ${ordinal}`;
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center self-center rounded px-1.5 py-[3px] font-mono text-[10px] leading-none font-semibold tabular-nums",
        isPrivate ? "bg-icon-blocked text-background" : "bg-muted text-muted-foreground",
      )}
    >
      {ordinal}
    </span>
  );
}

export function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "pane-leaf") {
    // The leaf glyph is shared with the pane header + drag overlay (see
    // `LeafIcon`) so a leaf reads identically in every surface. The tab strip
    // adds the FIFO ordinal badge on terminals + browsers on top of that glyph.
    const glyph = (
      <LeafIcon
        info={{
          leafKind: entry.leafKind,
          isPrivate: entry.isPrivate,
          isSsh: !!entry.sshConnectionId,
          editorFileName: entry.leafKind === "editor" ? entry.label : undefined,
          editorRemote: !!entry.remoteHost,
          browserUrl: entry.browserUrl,
          aiCliStatus: entry.aiCliStatus,
        }}
        size={14}
      />
    );
    const ordinal =
      entry.leafKind === "terminal" || entry.leafKind === "browser" ? entry.ordinal : undefined;
    if (ordinal) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1">
          {glyph}
          <OrdinalBadge
            ordinal={ordinal}
            leafKind={entry.leafKind === "browser" ? "browser" : "terminal"}
            isPrivate={entry.isPrivate}
          />
        </span>
      );
    }
    return glyph;
  }
  if (entry.kind === "ext") {
    // Extension tab icon: resolve `hugeicon:<Name>` if the extension hinted
    // one, else fall back to a generic database glyph. No tint: inherits
    // the surrounding tab's foreground colour so ext tabs visually match
    // the default tab cluster.
    const iconRef = entry.icon ?? "";
    const m = iconRef.match(/^hugeicon:(.+)$/);
    const found = m ? tryGetHugeIcon(m[1]) : null;
    const iconValue: Parameters<typeof HugeiconsIcon>[0]["icon"] = found ?? Database01Icon;
    return <HugeiconsIcon icon={iconValue} size={14} strokeWidth={2} className="shrink-0" />;
  }
  if (entry.kind === "scm") {
    return (
      <HugeiconsIcon
        icon={GitBranchIcon}
        size={14}
        strokeWidth={2}
        className="text-icon-working shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={GitCompareIcon}
      size={14}
      strokeWidth={2}
      className="text-icon-working shrink-0"
    />
  );
}
