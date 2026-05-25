/**
 * Status-bar toggle buttons for extension right panels.
 * Renders one button per `panelsRegistry` entry with `surface === "right"`.
 * Click calls `rightPanelStore.toggle`. Matches `AiOpenButton` styling: h-6,
 * border + accent hover, drop-in motion, optional `<Kbd>` chip resolved from
 * `panel.toggleCommand` against `keybindingsRegistry` plus user overrides in
 * `preferences.extensionShortcuts`.
 *
 * Icon source: well-known first-party extensions render a HugeIcon from
 * `HUGE_ICON_MAP` so the status bar stays visually homogeneous with core
 * buttons like `ScmRightOpenButton` (`GitBranchIcon`) and `AiOpenButton`
 * (`SparklesIcon`). Third-party extensions fall back to their manifest
 * `icon` rendered as an `<img>`.
 *
 * The button hides while its own panel is open.
 *
 * Compact mode (`panel.compact === true`): icon-only, no border, no card
 * background. Matches `ExtensionStatusItems`' borderless 16 px presentation
 * so a compact panel toggle reads as part of the same icon row as
 * extension-contributed status items.
 */
import { useEffect, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { KEY_SEP } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  parseKeybindingString,
  type KeyBinding,
} from "@/modules/shortcuts/shortcuts";
import { Camera01Icon, Folder02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";

import { loadExtensionIcon } from "../icon";
import { keybindingsRegistry, panelsRegistry } from "../registries";
import { useRegistry } from "../useRegistry";
import { useRightPanelStore } from "../rightPanelStore";

/**
 * Per-extension HugeIcon overrides for the status-bar toggle. Keeps the icon
 * choice in sync with the rest of the status bar (all HugeIcons line-art)
 * without forcing each extension to bundle a matching SVG.
 */
type HugeIconShape = typeof Camera01Icon;
const HUGE_ICON_MAP: Record<string, HugeIconShape> = {
  "tedi.screenshot": Camera01Icon,
  "tedi.secondary-folder-tree": Folder02Icon,
};

function useSortedRightPanels(compactOnly: boolean) {
  const panels = useRegistry(panelsRegistry);
  const filtered = panels.filter(
    (p) => p.item.surface === "right" && (p.item.compact === true) === compactOnly,
  );
  return [...filtered].sort((a, b) => {
    const e = a.extensionId.localeCompare(b.extensionId);
    return e !== 0 ? e : a.item.id.localeCompare(b.item.id);
  });
}

/**
 * Compact (icon-only) right-panel toggles. Rendered alongside
 * `ExtensionStatusItems` at the left of the status-bar right group so
 * borderless icons (Screenshot, Discord, ...) sit together as one icon
 * cluster.
 */
export function RightPanelCompactToggles() {
  const sorted = useSortedRightPanels(true);
  if (sorted.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {sorted.map(({ extensionId, item }) => (
        <ToggleButton
          key={`${extensionId}:${item.id}`}
          extensionId={extensionId}
          panelId={item.id}
          title={item.title}
          icon={item.icon ?? null}
          compact
          toggleCommand={item.toggleCommand ?? null}
        />
      ))}
    </div>
  );
}

/**
 * Full-label (text + icon + Kbd) right-panel toggles. Rendered near
 * `AiOpenButton` / `ScmRightOpenButton` so they read as a row of
 * matched bordered "open X" affordances.
 */
export function RightPanelTextToggles() {
  const sorted = useSortedRightPanels(false);
  if (sorted.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      {sorted.map(({ extensionId, item }) => (
        <ToggleButton
          key={`${extensionId}:${item.id}`}
          extensionId={extensionId}
          panelId={item.id}
          title={item.title}
          icon={item.icon ?? null}
          compact={false}
          toggleCommand={item.toggleCommand ?? null}
        />
      ))}
    </div>
  );
}

function ToggleButton({
  extensionId,
  panelId,
  title,
  icon,
  compact,
  toggleCommand,
}: {
  extensionId: string;
  panelId: string;
  title: string;
  icon: string | null;
  compact: boolean;
  toggleCommand: string | null;
}) {
  const active = useRightPanelStore((s) => s.active);
  const toggle = useRightPanelStore((s) => s.toggle);
  const keybindings = useRegistry(keybindingsRegistry);
  const overrides = usePreferencesStore((s) => s.extensionShortcuts);
  const isOpen = active?.extensionId === extensionId && active?.panelId === panelId;

  // Hide while this panel is open; close via the panel header X.
  if (isOpen) return null;

  // Resolve the shortcut chip. User overrides win; otherwise parse the
  // manifest's `keybindings[].key`. Skipped in compact mode (icon-only).
  let chipBinding: KeyBinding | null = null;
  if (!compact && toggleCommand) {
    const userBinding = overrides[toggleCommand]?.[0];
    if (userBinding) {
      chipBinding = userBinding;
    } else {
      const entry = keybindings.find(
        (k) => k.extensionId === extensionId && k.item.command === toggleCommand,
      );
      if (entry) chipBinding = parseKeybindingString(entry.item.key);
    }
  }
  // `KEY_SEP` is "+" on Win/Linux, empty on macOS. Matches `fmtShortcut`.
  const chipText = chipBinding ? getBindingTokens(chipBinding).join(KEY_SEP) : null;

  // Compact: borderless icon-only button, 16 px icon, matches
  // `ExtensionStatusItems` so compact toggles share a row with status items
  // without visual seams.
  if (compact) {
    return (
      <IconTooltip label={`Open ${title}`} side="top">
        <motion.button
          initial={{ y: -15 }}
          animate={{ y: 0 }}
          type="button"
          onClick={() => toggle(extensionId, panelId)}
          aria-label={title}
          className={cn(
            "text-muted-foreground hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-opacity hover:opacity-80",
          )}
        >
          <PanelIcon extensionId={extensionId} icon={icon} alt={title} size={16} />
        </motion.button>
      </IconTooltip>
    );
  }

  return (
    <IconTooltip label={`Open ${title}`} side="top">
      <motion.button
        initial={{ y: -15 }}
        animate={{ y: 0 }}
        type="button"
        onClick={() => toggle(extensionId, panelId)}
        aria-label={title}
        className={cn(
          "border-border/60 bg-card flex h-6 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs",
          "text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground transition-colors",
        )}
      >
        <PanelIcon extensionId={extensionId} icon={icon} alt="" size={11} />
        <span className="max-w-32 truncate">{title}</span>
        {chipText ? <Kbd className="h-4 min-w-4 px-1">{chipText}</Kbd> : null}
      </motion.button>
    </IconTooltip>
  );
}

/**
 * Renders the toggle icon. HugeIcons take priority via `HUGE_ICON_MAP` so
 * first-party extensions stay visually consistent with core's
 * `GitBranchIcon` / `SparklesIcon` line-art. Third-party extensions fall
 * back to their manifest `icon` rendered as a raster `<img>`.
 */
function PanelIcon({
  extensionId,
  icon,
  alt,
  size,
}: {
  extensionId: string;
  icon: string | null;
  alt: string;
  size: number;
}) {
  const hugeIcon = HUGE_ICON_MAP[extensionId];
  if (hugeIcon) {
    return (
      <HugeiconsIcon
        icon={hugeIcon}
        size={size}
        strokeWidth={size >= 16 ? 1.75 : 2}
        className="shrink-0"
        aria-label={alt || undefined}
      />
    );
  }
  return <PanelImageIcon extensionId={extensionId} icon={icon} alt={alt} size={size} />;
}

function PanelImageIcon({
  extensionId,
  icon,
  alt,
  size,
}: {
  extensionId: string;
  icon: string | null;
  alt: string;
  size: number;
}) {
  const url = useResolvedPanelIcon(extensionId, icon);
  const style = { width: `${size}px`, height: `${size}px` } as const;
  if (!url) {
    // Manifest didn't ship an icon (or it failed to load) - fall back to
    // a muted square so the button is still visible.
    return <span className="bg-muted shrink-0 rounded-sm" style={style} aria-hidden />;
  }
  return (
    <img
      src={url}
      alt={alt}
      style={style}
      className="shrink-0 object-contain"
      loading="lazy"
      draggable={false}
    />
  );
}

function useResolvedPanelIcon(extensionId: string, icon: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    icon && icon.startsWith("data:") ? icon : null,
  );
  useEffect(() => {
    if (!icon) {
      setUrl(null);
      return;
    }
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
