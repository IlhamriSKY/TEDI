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
 * Icon source: well-known first-party extensions render a curated Lucide icon
 * from `ICON_MAP` so the status bar stays visually homogeneous with core
 * buttons like `ScmRightOpenButton` (`GitBranch`) and `AiOpenButton`
 * (`Sparkles`). Third-party extensions fall back to their manifest
 * `icon` rendered as an `<img>`.
 *
 * The button stays in place while its panel is open (showing an active
 * state) so the status-bar row never reflows.
 *
 * Compact mode (`panel.compact === true`): same icon-only chrome as the
 * default variant; the flag now only governs ordering (compact toggles
 * cluster with `ExtensionStatusItems` at the left of the right group).
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
import { Camera, Folder, type LucideIcon } from "lucide-react";

import { useResolvedExtensionIcon } from "../icon";
import { commandsRegistry, keybindingsRegistry, panelsRegistry } from "../registries";
import { useRegistry } from "../useRegistry";
import { isRightPanelOpen, useRightPanelStore } from "../rightPanelStore";

/**
 * Per-extension icon overrides for the status-bar toggle. Keeps the icon
 * choice in sync with the rest of the status bar (all Lucide line-art)
 * without forcing each extension to bundle a matching SVG.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  "tedi.screenshot": Camera,
  "tedi.secondary-folder-tree": Folder,
};

function useSortedRightPanels(match: (p: { compact?: boolean; kind?: string }) => boolean) {
  const panels = useRegistry(panelsRegistry);
  const filtered = panels.filter((p) => p.item.surface === "right" && match(p.item));
  return [...filtered].sort((a, b) => {
    const e = a.extensionId.localeCompare(b.extensionId);
    return e !== 0 ? e : a.item.id.localeCompare(b.item.id);
  });
}

/**
 * One icon-only toggle row. `compactOnly` selects which cluster to render —
 * the chrome is identical, only the status-bar placement differs (see the
 * two exported wrappers).
 */
function RightPanelToggleRow({
  match,
}: {
  match: (p: { compact?: boolean; kind?: string }) => boolean;
}) {
  const sorted = useSortedRightPanels(match);
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
          toggleCommand={item.toggleCommand ?? null}
          isAction={item.kind === "action"}
        />
      ))}
    </div>
  );
}

/**
 * Action-kind buttons (`panel.kind === "action"`): a click runs the panel's
 * `toggleCommand` and nothing slides out. Its own group in the status bar,
 * because "do a thing" and "show me a panel" are different promises.
 */
export function RightPanelActionToggles() {
  return <RightPanelToggleRow match={(p) => p.kind === "action"} />;
}

/**
 * Compact-flagged right-panel toggles (`panel.compact === true`). Rendered
 * alongside `ExtensionStatusItems` at the left of the status-bar right group
 * so borderless icons (Screenshot, Discord, ...) sit together as one cluster.
 */
export function RightPanelCompactToggles() {
  return <RightPanelToggleRow match={(p) => p.kind !== "action" && p.compact === true} />;
}

/**
 * Default (non-compact) right-panel toggles. Rendered next to `AiOpenButton` /
 * `ScmRightOpenButton`. Chrome is identical to the compact cluster (icon-only);
 * only the placement differs. The title + shortcut chip appear in the tooltip.
 */
export function RightPanelDefaultToggles() {
  return <RightPanelToggleRow match={(p) => p.kind !== "action" && p.compact !== true} />;
}

function ToggleButton({
  extensionId,
  panelId,
  title,
  icon,
  toggleCommand,
  isAction,
}: {
  extensionId: string;
  panelId: string;
  title: string;
  icon: string | null;
  toggleCommand: string | null;
  /** Runs `toggleCommand` instead of opening the panel, and never reads as
   *  "open". */
  isAction?: boolean;
}) {
  const panels = useRightPanelStore((s) => s.panels);
  const toggle = useRightPanelStore((s) => s.toggle);
  const keybindings = useRegistry(keybindingsRegistry);
  const overrides = usePreferencesStore((s) => s.extensionShortcuts);
  const isOpen = isRightPanelOpen(panels, extensionId, panelId);

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
      <span>{isAction ? title : `${isOpen ? "Close" : "Open"} ${title}`}</span>
      {chipText ? <Kbd className="h-4 min-w-4 px-1">{chipText}</Kbd> : null}
    </span>
  );

  // An action runs its command in place. Before `kind: "action"` the only
  // button the host offered was a panel toggle, so an extension that just
  // wanted to DO something had to intercept its own click in the capture phase
  // to stop a panel sliding out behind it.
  const onClick = () => {
    if (!isAction) {
      toggle(extensionId, panelId);
      return;
    }
    if (!toggleCommand) return;
    const handler = commandsRegistry.getRuntime(extensionId, toggleCommand);
    if (typeof handler !== "function") return;
    try {
      (handler as () => unknown)();
    } catch (err) {
      console.error(`[extensions] command "${extensionId}:${toggleCommand}" threw`, err);
    }
  };

  // Borderless icon-only button, always present (never removed from the row, so
  // the status bar never reflows). The open state shows as active instead.
  return (
    <IconTooltip label={tooltipLabel} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        aria-pressed={isAction ? undefined : isOpen}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          !isAction && isOpen
            ? "text-foreground bg-accent/60"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <PanelIcon extensionId={extensionId} icon={icon} alt={title} size={16} />
      </button>
    </IconTooltip>
  );
}

/**
 * Renders the toggle icon. Curated Lucide icons take priority via `ICON_MAP`
 * so first-party extensions stay visually consistent with core's
 * `GitBranch` / `Sparkles` line-art. Third-party extensions fall
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
  const Icon = ICON_MAP[extensionId];
  if (Icon) {
    return (
      <Icon
        size={size}
        strokeWidth={size >= 16 ? 1.75 : 2}
        className="shrink-0"
        aria-label={alt || undefined}
      />
    );
  }
  return <PanelImageIcon extensionId={extensionId} icon={icon} size={size} />;
}

function PanelImageIcon({
  extensionId,
  icon,
  size,
}: {
  extensionId: string;
  icon: string | null;
  size: number;
}) {
  const url = useResolvedExtensionIcon(extensionId, icon);
  const style = { width: `${size}px`, height: `${size}px` } as const;
  if (!url) {
    // Manifest didn't ship an icon (or it failed to load) - fall back to
    // a muted square so the button is still visible.
    return <span className="bg-muted shrink-0 rounded-sm" style={style} aria-hidden />;
  }
  // Decorative: the wrapping toggle button already carries aria-label={title},
  // so an empty alt avoids screen readers announcing the name twice.
  return (
    <img
      src={url}
      alt=""
      style={style}
      className="shrink-0 object-contain"
      loading="lazy"
      draggable={false}
      aria-hidden
    />
  );
}
