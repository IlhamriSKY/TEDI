/**
 * Mounts the active right-panel renderer into a host-owned `<div>`.
 * Reads target from `useRightPanelStore`, metadata from `panelsRegistry`,
 * renderer from `panelRenderersRegistry`. On unmount or target change the
 * renderer's cleanup callback runs.
 * Returns null when no panel is active.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";

import {
  panelRenderersRegistry,
  panelsRegistry,
  sidebarSectionsRegistry,
  type PanelRenderer,
} from "../registries";
import { useRegistry } from "../useRegistry";
import { useRightPanelStore } from "../rightPanelStore";
import { parseSectionPanelId } from "../sidebarPlacementStore";
import { ExtensionSidebarSection } from "./ExtensionSidebarSection";
import { X } from "lucide-react";

export function RightPanelHost() {
  const active = useRightPanelStore((s) => s.active);
  const close = useRightPanelStore((s) => s.close);
  // Panel list updates live so the header title tracks the manifest.
  const panels = useRegistry(panelsRegistry);
  // Sidebar sections that have been moved into the right slot are hosted here
  // too (reusing the shared slot's mutual exclusion), rendered as the same
  // React tree as the left sidebar rather than a DOM panel renderer.
  const sidebarSections = useRegistry(sidebarSectionsRegistry);
  const movedSectionId = active ? parseSectionPanelId(active.panelId) : null;

  // Renderer registry is key-addressed (Map<extId, Map<panelId, fn>>),
  // no `list()` snapshot. Track the current renderer via subscribe + state.
  //
  // CRITICAL: the renderer is a function. React's setState treats a bare
  // function as an updater (`prev => next`), so `setRenderer(fn)` would
  // call `fn(prevRenderer)` and crash inside `container.replaceChildren()`.
  // Always wrap in `() => fn`. The lazy initializer below is exempt.
  const [renderer, setRenderer] = useState<PanelRenderer | null>(() =>
    active ? panelRenderersRegistry.get(active.extensionId, active.panelId) : null,
  );
  useEffect(() => {
    if (!active) {
      setRenderer(null);
      return;
    }
    const read = () => {
      const fn = panelRenderersRegistry.get(active.extensionId, active.panelId);
      // Wrap so React doesn't treat the renderer as a state updater.
      setRenderer(() => fn);
    };
    read();
    return panelRenderersRegistry.subscribe(read);
  }, [active]);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const meta = active
    ? panels.find((p) => p.extensionId === active.extensionId && p.item.id === active.panelId)
    : null;
  const title = meta?.item.title ?? "";
  const hideHostHeader = meta?.item.hideHostHeader === true;

  useEffect(() => {
    if (!active || !renderer) return;
    const el = containerRef.current;
    if (!el) return;
    let cleanup: (() => void) | void;
    try {
      cleanup = renderer(el);
    } catch (err) {
      console.error(
        `[extensions] panel renderer for "${active.extensionId}:${active.panelId}" threw`,
        err,
      );
    }
    return () => {
      try {
        cleanup?.();
      } catch (err) {
        console.error(
          `[extensions] panel cleanup for "${active.extensionId}:${active.panelId}" threw`,
          err,
        );
      }
      // Clear leftover DOM if the extension forgot to detach.
      if (el.firstChild) {
        try {
          el.replaceChildren();
        } catch {
          // ignore
        }
      }
    };
  }, [active, renderer]);

  if (!active) return null;

  // A sidebar section moved to the right slot: render the same React section
  // (its descriptor carries the live tree + callbacks) with the right-surface
  // header (move-back-to-left + close).
  if (movedSectionId) {
    const entry = sidebarSections.find(
      (s) => s.extensionId === active.extensionId && s.item.id === movedSectionId,
    );
    if (!entry) return null;
    return (
      <div className="border-border/60 bg-card/60 tedi-glass-panel flex h-full min-h-0 flex-col border-l">
        <ExtensionSidebarSection
          extensionId={entry.extensionId}
          section={entry.item}
          surface="right"
        />
      </div>
    );
  }

  return (
    <div
      data-ext-right-panel
      data-ext-id={active.extensionId}
      data-panel-id={active.panelId}
      className={cn(
        "border-border/60 bg-card/60 relative flex h-full min-h-0 flex-col overflow-hidden border-l",
        "text-[12px]",
      )}
    >
      <div
        aria-hidden
        className="from-foreground/[0.03] pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b to-transparent"
      />
      {hideHostHeader ? null : (
        <div className="border-border/60 relative flex h-11 shrink-0 items-center justify-between gap-1 border-b px-3">
          <span className="text-foreground/90 min-w-0 truncate text-[12px] font-medium">
            {title || "Panel"}
          </span>
          <IconTooltip label="Close panel" side="top">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={close}
              className="hover:bg-destructive/10 hover:text-destructive size-7 rounded-none"
              aria-label="Close panel"
            >
              <X size={11} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        </div>
      )}
      {/* Placeholder sits outside the extension's container so the
          extension's first `replaceChildren()` doesn't wipe it. */}
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-auto" />
      {!renderer ? (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 top-11 flex items-center justify-center text-[11px]">
          Loading panel…
        </div>
      ) : null}
    </div>
  );
}
