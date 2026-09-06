/**
 * Mounts an extension panel's renderer (registered via
 * `ctx.registerPanelRenderer`) into a host-owned `<div>` and returns its
 * cleanup on unmount. Shared by the extension TAB stack
 * (`ExtensionTabStack`) and the split-pane leaf renderer
 * (`PaneTreeView`) so both drive the exact same `(container) => cleanup`
 * contract — there is one mounting implementation, not two.
 *
 * Tracks the renderer as state so a live re-register (extension reload)
 * re-mounts the content. Shows a "Loading extension…" placeholder while the
 * extension is still activating, and says what is actually wrong once waiting
 * stops being the explanation.
 */
import { useEffect, useRef, useState } from "react";

import { useExtensionsStore, type InstalledExtension } from "../store";
import { panelRenderersRegistry, type PanelRenderer } from "../registries";

/**
 * How long a missing renderer is still just "starting".
 *
 * ONLY for the case nothing else can answer: the extension is installed and
 * switched on, and its renderer still has not appeared. Disabled and
 * uninstalled are read straight off the store and reported at once, because a
 * timer is the wrong tool for a fact already known.
 *
 * Generous on purpose. `bootAll` activates in PARALLEL, so the pass is as long
 * as its slowest member rather than their sum - but a real boot here still saw
 * one extension spend 6.2s inside `activate()` alone, and that is the bound
 * that matters. A tighter one would accuse a perfectly healthy extension of
 * failing on every cold start.
 *
 * WHY ANY OF THIS MATTERS. A panel leaf serialises and restores perfectly well
 * on its own, so a pane whose extension is off comes back on EVERY launch with
 * nothing on screen naming the extension or saying it is switched off. It reads
 * as an empty tab the user can neither use, diagnose, nor fix.
 */
const ACTIVATION_GRACE_MS = 30_000;

/**
 * What to say once the wait is over.
 *
 * Named precisely rather than "something went wrong", because the answer is
 * almost always one fact the user can act on: the extension is off, or gone.
 */
function missingPanelReason(
  extensionId: string,
  panelId: string,
  installed: InstalledExtension | undefined,
  listLoaded: boolean,
  graceOver: boolean,
): string | null {
  if (installed) {
    if (!installed.enabled) {
      const name = installed.manifest.name || extensionId;
      return `"${name}" is disabled - turn it on in Settings > Extensions.`;
    }
    // Installed and on, so the only honest answer is "not yet" until the wait
    // has gone on long enough to stop being one.
    if (!graceOver) return null;
    return `"${installed.manifest.name || extensionId}" did not provide its "${panelId}" panel.`;
  }
  // An EMPTY list is "not read yet", not "nothing installed": the store fills
  // in asynchronously, and answering from it too early would accuse every panel
  // on screen of being uninstalled for the first frames of every launch.
  if (!listLoaded) return null;
  return `Extension "${extensionId}" is not installed.`;
}

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
  // Read straight from the store rather than through `listExtensions()`: this
  // has to re-render when the extension is enabled again, so the pane recovers
  // on its own instead of needing the tab reopened.
  const installed = useExtensionsStore((st) => st.list.find((e) => e.id === extensionId));
  const listLoaded = useExtensionsStore((st) => st.list.length > 0);
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

  // Reset on every renderer/panel change, so a re-register clears a stale
  // message and a second panel does not inherit the first one's verdict.
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (renderer) {
      setGraceOver(false);
      return;
    }
    const t = setTimeout(() => setGraceOver(true), ACTIVATION_GRACE_MS);
    return () => clearTimeout(t);
  }, [renderer, extensionId, panelId]);

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
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[11px]">
          {missingPanelReason(extensionId, panelId, installed, listLoaded, graceOver) ??
            "Loading extension…"}
        </div>
      ) : null}
    </div>
  );
}
