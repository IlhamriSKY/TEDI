import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { aiCliIconClass } from "@/modules/terminal/lib/aiCliStatus";
import { tryGetHugeIcon } from "@/lib/hugeIconsBarrel";
import {
  CloudServerIcon,
  ComputerTerminal02Icon,
  Database01Icon,
  GitBranchIcon,
  GitCompareIcon,
  Globe02Icon,
  LockedIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Entry } from "../lib/entries";

/**
 * Pill badge stamped next to terminal entries. Same ordinal the AI sees in
 * `<env>`. Public tabs use the muted palette so the emerald/yellow/red
 * palette stays reserved for the AI CLI icon tint. Private tabs override
 * the badge to solid red so the number-going-red is the headline signal
 * that the AI cannot see this tab.
 */
function TerminalOrdinalBadge({ ordinal, isPrivate }: { ordinal: number; isPrivate?: boolean }) {
  return (
    <span
      aria-label={
        isPrivate ? `Terminal ${ordinal} (private, hidden from AI)` : `Terminal ${ordinal}`
      }
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
    // Private leaves swap to a lock so the AI-can't-read signal reads at a
    // glance, regardless of terminal vs editor or ssh. The red lives on the
    // label text (see renderEntryBody) so the lock's colour stays free to
    // carry AI CLI status, same as a non-private icon.
    if (entry.isPrivate) {
      const aiTint = entry.aiCliStatus ? aiCliIconClass(entry.aiCliStatus) : null;
      return (
        <span className="inline-flex shrink-0 items-center gap-1">
          <HugeiconsIcon
            icon={LockedIcon}
            size={14}
            strokeWidth={2}
            className={cn("shrink-0", aiTint)}
          />
          {entry.leafKind === "terminal" && entry.terminalOrdinal ? (
            <TerminalOrdinalBadge ordinal={entry.terminalOrdinal} isPrivate />
          ) : null}
        </span>
      );
    }
    if (entry.leafKind === "editor") {
      const url = fileIconUrl(entry.label);
      // Remote files reuse the file-type icon shape but get recolored sky-blue
      // via `mask-image`. Trade-off: loses per-language color cues.
      if (entry.remoteHost) {
        if (!url) return null;
        return (
          <span
            aria-hidden
            className="bg-info size-3.5 shrink-0"
            style={{
              mask: `url("${url}") center / contain no-repeat`,
              WebkitMask: `url("${url}") center / contain no-repeat`,
            }}
          />
        );
      }
      return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
    }
    // Terminal leaf. Pick the icon, then tint by AI CLI status. SSH status
    // colors the title text; the icon shows AI CLI state on both local and remote.
    const aiTint = entry.aiCliStatus ? aiCliIconClass(entry.aiCliStatus) : null;
    const terminalIcon = entry.sshConnectionId ? (
      <HugeiconsIcon
        icon={CloudServerIcon}
        size={14}
        strokeWidth={2}
        className={cn("shrink-0", aiTint)}
      />
    ) : (
      <HugeiconsIcon
        icon={ComputerTerminal02Icon}
        size={14}
        strokeWidth={2}
        className={cn("shrink-0", aiTint)}
      />
    );
    if (entry.terminalOrdinal) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1">
          {terminalIcon}
          <TerminalOrdinalBadge ordinal={entry.terminalOrdinal} />
        </span>
      );
    }
    return terminalIcon;
  }
  if (entry.kind === "preview") {
    return <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={2} className="shrink-0" />;
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
