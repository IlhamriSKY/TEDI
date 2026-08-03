/**
 * Mounts each `ExtensionTab` (`kind: "ext"`) into a host-owned `<div>`
 * by calling the renderer registered via `ctx.registerPanelRenderer`.
 *
 * Each tab gets its own persistent mount node so the extension's DOM
 * state survives tab switches (mirroring how PaneStack keeps xterm
 * canvases alive). Switching just toggles `pointer-events-none invisible`
 * on the inactive tabs.
 *
 * Cleanup callback returned by the renderer fires when the tab is
 * closed or the renderer registration is dropped (deactivate /
 * uninstall). If the extension is disabled while its tab is open, the
 * tab stays visible but its panel will look empty until the extension
 * re-activates.
 */
import { useMemo } from "react";

import { cn } from "@/lib/utils";

import type { ExtensionTab } from "@/modules/tabs/lib/useTabs";
import { ExtensionPanelMount } from "./ExtensionPanelMount";

type Props = {
  tabs: { id: number; kind: string }[];
  activeId: number | null;
};

export function ExtensionTabStack({ tabs, activeId }: Props) {
  // Filter once per render. ExtensionTabPane is keyed by tab id so React
  // preserves the mount node across re-renders of the parent.
  const extTabs = useMemo(() => tabs.filter((t): t is ExtensionTab => t.kind === "ext"), [tabs]);
  if (extTabs.length === 0) return null;
  return (
    <>
      {extTabs.map((tab) => (
        <ExtensionTabPane key={tab.id} tab={tab} active={tab.id === activeId} />
      ))}
    </>
  );
}

function ExtensionTabPane({ tab, active }: { tab: ExtensionTab; active: boolean }) {
  return (
    <div
      data-ext-tab
      data-ext-id={tab.extensionId}
      data-panel-id={tab.panelId}
      className={cn(
        "absolute inset-0 flex min-h-0 flex-col overflow-hidden",
        !active && "pointer-events-none invisible",
      )}
      aria-hidden={active ? "false" : "true"}
    >
      <ExtensionPanelMount
        extensionId={tab.extensionId}
        panelId={tab.panelId}
        surface="tab"
        reuseKey={tab.reuseKey}
      />
    </div>
  );
}
