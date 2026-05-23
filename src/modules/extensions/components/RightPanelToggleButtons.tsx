/**
 * Status-bar toggle buttons for extension right panels.
 * Renders one button per `panelsRegistry` entry with `surface === "right"`.
 * Click calls `rightPanelStore.toggle`. Matches `AiOpenButton` styling: h-6,
 * border + accent hover, drop-in motion, optional `<Kbd>` chip resolved from
 * `panel.toggleCommand` against `keybindingsRegistry` plus user overrides in
 * `preferences.extensionShortcuts`.
 * The button hides while its own panel is open.
 *
 * Compact mode (`panel.compact === true`): square icon-only button with no
 * text label and no `<Kbd>` chip. The panel's `icon` is loaded via
 * `loadExtensionIcon`; `aria-label` carries the title for accessibility.
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
import { motion } from "motion/react";

import { loadExtensionIcon } from "../icon";
import { keybindingsRegistry, panelsRegistry } from "../registries";
import { useRegistry } from "../useRegistry";
import { useRightPanelStore } from "../rightPanelStore";

export function RightPanelToggleButtons() {
  const panels = useRegistry(panelsRegistry);
  const rightPanels = panels.filter((p) => p.item.surface === "right");
  if (rightPanels.length === 0) return null;
  // Sort by extension id then panel id for stable order.
  const sorted = [...rightPanels].sort((a, b) => {
    const e = a.extensionId.localeCompare(b.extensionId);
    return e !== 0 ? e : a.item.id.localeCompare(b.item.id);
  });
  return (
    <div className="flex items-center gap-1.5">
      {sorted.map(({ extensionId, item }) => (
        <ToggleButton
          key={`${extensionId}:${item.id}`}
          extensionId={extensionId}
          panelId={item.id}
          title={item.title}
          icon={item.icon ?? null}
          compact={item.compact === true}
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

  // Compact: square icon-only button. Same h-6 height as the default
  // variant so the row stays visually aligned, but width drops to size-6
  // and the text + Kbd chip are gone entirely.
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
            "border-border/60 bg-card flex size-6 cursor-pointer items-center justify-center rounded-md border",
            "text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground transition-colors",
          )}
        >
          <CompactPanelIcon extensionId={extensionId} icon={icon} alt={title} />
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
        <span className="max-w-32 truncate">{title}</span>
        {chipText ? <Kbd className="h-4 min-w-4 px-1">{chipText}</Kbd> : null}
      </motion.button>
    </IconTooltip>
  );
}

/**
 * Resolves a compact-mode panel `icon` (relative path or data URL) into a
 * 14 px `<img>`. Matches `ExtensionStatusItems`' icon resolution path —
 * `data:` URLs pass through, everything else goes through
 * `loadExtensionIcon` (cached, base64 via Rust).
 */
function CompactPanelIcon({
  extensionId,
  icon,
  alt,
}: {
  extensionId: string;
  icon: string | null;
  alt: string;
}) {
  const url = useResolvedPanelIcon(extensionId, icon);
  if (!url) {
    // Manifest didn't ship an icon (or it failed to load) — fall back to
    // a muted square so the button is still visible.
    return <span className="bg-muted size-3.5 rounded-sm" aria-hidden />;
  }
  return (
    <img
      src={url}
      alt={alt}
      className="size-3.5 object-contain"
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
