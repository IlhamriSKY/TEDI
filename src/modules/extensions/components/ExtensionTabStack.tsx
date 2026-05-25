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
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { ExtensionTab } from "@/modules/tabs/lib/useTabs";
import {
  panelRenderersRegistry,
  type PanelRenderer,
} from "../registries";

type Props = {
  tabs: { id: number; kind: string }[];
  activeId: number | null;
};

export function ExtensionTabStack({ tabs, activeId }: Props) {
  // Filter once per render. ExtensionTabPane is keyed by tab id so React
  // preserves the mount node across re-renders of the parent.
  const extTabs = useMemo(
    () => tabs.filter((t): t is ExtensionTab => t.kind === "ext"),
    [tabs],
  );
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track the renderer as state so a live re-register (extension reload)
  // remounts the content. Wrap with `() => fn` so React doesn't call the
  // function as a state-updater.
  const [renderer, setRenderer] = useState<PanelRenderer | null>(() =>
    panelRenderersRegistry.get(tab.extensionId, tab.panelId),
  );
  useEffect(() => {
    const read = () => {
      const fn = panelRenderersRegistry.get(tab.extensionId, tab.panelId);
      setRenderer(() => fn);
    };
    read();
    return panelRenderersRegistry.subscribe(read);
  }, [tab.extensionId, tab.panelId]);

  useEffect(() => {
    if (!renderer) return;
    const el = containerRef.current;
    if (!el) return;
    let cleanup: (() => void) | void;
    try {
      cleanup = renderer(el);
    } catch (err) {
      console.error(
        `[extensions] tab renderer for "${tab.extensionId}:${tab.panelId}" threw`,
        err,
      );
    }
    return () => {
      try {
        cleanup?.();
      } catch (err) {
        console.error(
          `[extensions] tab cleanup for "${tab.extensionId}:${tab.panelId}" threw`,
          err,
        );
      }
      if (el.firstChild) {
        try {
          el.replaceChildren();
        } catch {
          // ignore
        }
      }
    };
  }, [renderer, tab.extensionId, tab.panelId]);

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
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-auto" />
      {!renderer ? (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-[11px]">
          Loading extension…
        </div>
      ) : null}
    </div>
  );
}
