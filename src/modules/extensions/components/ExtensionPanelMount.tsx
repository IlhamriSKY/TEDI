/**
 * Mounts an extension panel's renderer (registered via
 * `ctx.registerPanelRenderer`) into a host-owned `<div>` and returns its
 * cleanup on unmount. Shared by the extension TAB stack
 * (`ExtensionTabStack`) and the split-pane leaf renderer
 * (`PaneTreeView`) so both drive the exact same `(container) => cleanup`
 * contract — there is one mounting implementation, not two.
 *
 * Tracks the renderer as state so a live re-register (extension reload)
 * re-mounts the content. Shows a "Loading extension…" placeholder until
 * the renderer is available (e.g. before the extension finishes
 * activating on restore).
 */
import { useEffect, useRef, useState } from "react";

import { panelRenderersRegistry, type PanelRenderer } from "../registries";

export function ExtensionPanelMount({
  extensionId,
  panelId,
  surface = "tab",
  reuseKey,
}: {
  extensionId: string;
  panelId: string;
  /** Where the panel is mounted, so the extension can adapt its chrome
   *  (e.g. drop its own header when it's a split-pane leaf — the pane frame
   *  already provides one). Defaults to "tab". */
  surface?: "tab" | "pane";
  /** The key this pane/tab was opened with. Handed to the renderer so a panel
   *  with one instance per key knows which one it is being asked to paint. */
  reuseKey?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Wrap with `() => fn` so React doesn't call the renderer as a state-updater.
  const [renderer, setRenderer] = useState<PanelRenderer | null>(() =>
    panelRenderersRegistry.get(extensionId, panelId),
  );

  useEffect(() => {
    const read = () => {
      const fn = panelRenderersRegistry.get(extensionId, panelId);
      setRenderer(() => fn);
    };
    read();
    return panelRenderersRegistry.subscribe(read);
  }, [extensionId, panelId]);

  useEffect(() => {
    if (!renderer) return;
    const el = containerRef.current;
    if (!el) return;
    let cleanup: (() => void) | void;
    try {
      cleanup = renderer(el, { surface, reuseKey });
    } catch (err) {
      console.error(`[extensions] panel renderer for "${extensionId}:${panelId}" threw`, err);
    }
    return () => {
      try {
        cleanup?.();
      } catch (err) {
        console.error(`[extensions] panel cleanup for "${extensionId}:${panelId}" threw`, err);
      }
      if (el.firstChild) {
        try {
          el.replaceChildren();
        } catch {
          // ignore
        }
      }
    };
  }, [renderer, extensionId, panelId, surface, reuseKey]);

  return (
    <div
      data-ext-panel-mount
      data-ext-id={extensionId}
      data-panel-id={panelId}
      // `h-full` (not just flex-1): the split-pane leaf body wrapper
      // (PaneTreeView) is a relative *block*, so flex-1 alone gives no definite
      // height and an overflowing panel (e.g. a short SQL Explorer pane) can't
      // scroll. h-full pins it to the leaf height; flex-1 still fills the tab
      // surface whose wrapper IS a flex container.
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
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
