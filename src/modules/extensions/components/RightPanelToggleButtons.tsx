/**
 * Status-bar toggle buttons for extension right panels.
 * Renders one button per `panelsRegistry` entry with `surface === "right"`.
 * Click calls `rightPanelStore.toggle`. All variants render icon-only —
 * the title + optional shortcut chip live in the tooltip, so the status
 * bar stays a uniform row of glyphs (Discord/Screenshot-style) instead of
 * a mix of bordered "Open X" pills. Shortcut chips resolve from
 * `panel.toggleCommand` against `keybindingsRegistry` plus user overrides
 * in `preferences.extensionShortcuts`.
 *
 * Icon source: well-known first-party extensions render a HugeIcon from
 * `HUGE_ICON_MAP` so the status bar stays visually homogeneous with core
 * buttons like `ScmRightOpenButton` (`GitBranchIcon`) and `AiOpenButton`
 * (`SparklesIcon`). Third-party extensions fall back to their manifest
 * `icon` rendered as an `<img>`.
 *
 * The button hides while its own panel is open.
 *
 * Compact mode (`panel.compact === true`): same icon-only chrome as the
 * default variant; the flag now only governs ordering (compact toggles
 * cluster with `ExtensionStatusItems` at the left of the right group).
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
          toggleCommand={item.toggleCommand ?? null}
        />
      ))}
    </div>
  );
}

/**
 * Default-priority right-panel toggles. Rendered next to `AiOpenButton` /
 * `ScmRightOpenButton`; the chrome is now icon-only so the full row of
 * status-bar buttons stays uniform. The title + shortcut chip appear in
 * the tooltip on hover.
 */
export function RightPanelTextToggles() {
  const sorted = useSortedRightPanels(false);
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
  toggleCommand,
}: {
  extensionId: string;
  panelId: string;
  title: string;
  icon: string | null;
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
  // manifest's `keybindings[].key`. Surfaces in the tooltip so users can
  // discover the shortcut without losing the icon-row compactness.
  let chipBinding: KeyBinding | null = null;
  if (toggleCommand) {
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
  const tooltipLabel = (
    <span className="inline-flex items-center gap-1.5">
      <span>Open {title}</span>
      {chipText ? <Kbd className="h-4 min-w-4 px-1">{chipText}</Kbd> : null}
    </span>
  );

  // Borderless icon-only button — same chrome as compact mode. The
  // `compact` prop now only controls ordering inside the status bar.
  return (
    <IconTooltip label={tooltipLabel} side="top">
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
