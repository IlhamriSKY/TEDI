/**
 * Status-bar toggle buttons for extension right panels.
 * Renders one button per `panelsRegistry` entry with `surface === "right"`.
 * Click calls `rightPanelStore.toggle`. Matches `AiOpenButton` styling: h-6,
 * border + accent hover, drop-in motion, optional `<Kbd>` chip resolved from
 * `panel.toggleCommand` against `keybindingsRegistry` plus user overrides in
 * `preferences.extensionShortcuts`.
 * The button hides while its own panel is open.
 */
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
  toggleCommand,
}: {
  extensionId: string;
  panelId: string;
  title: string;
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
  // manifest's `keybindings[].key`.
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
