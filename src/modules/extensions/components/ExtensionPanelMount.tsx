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
}: {
  extensionId: string;
  panelId: string;
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
      cleanup = renderer(el);
    } catch (err) {
      console.error(
        `[extensions] panel renderer for "${extensionId}:${panelId}" threw`,
        err,
      );
    }
    return () => {
      try {
        cleanup?.();
      } catch (err) {
        console.error(
          `[extensions] panel cleanup for "${extensionId}:${panelId}" threw`,
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
  }, [renderer, extensionId, panelId]);

  return (
    <div
      data-ext-panel-mount
      data-ext-id={extensionId}
      data-panel-id={panelId}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
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
