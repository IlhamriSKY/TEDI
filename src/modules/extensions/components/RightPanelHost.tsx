/**
 * Mounts ONE right-column panel into a host-owned `<div>`.
 * Which panel is a prop, not a store read: the right column stacks several at
 * once, so the caller (AppRightSlot) renders one host per open panel. Metadata
 * comes from `panelsRegistry`, the renderer from `panelRenderersRegistry`. On
 * unmount or target change the renderer's cleanup callback runs.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";

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

/**
 * Watch `container` for a `[data-tedi-panel-controls]` slot rendered by the
 * panel's OWN header, so a `hideHostHeader` panel can host the stack's grip +
 * minimize chevron on its header row instead of wearing a separate rail above
 * it. Returns the slot element, or null while none exists.
 *
 * A portal rather than passing the node down: the panel body is a SECOND React
 * root (`mountFolderTree` calls `createRoot`), and re-rendering the controls
 * element there would strand it outside this tree - the dnd-kit context its
 * drag listeners close over, and the live `collapsed` flag driving the chevron,
 * both live here. Portaling keeps the node in THIS tree and only its DOM
 * elsewhere.
 */
function useControlsSlot(
  container: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) {
      setSlot(null);
      return;
    }
    const host = container.current;
    if (!host) return;
    // The panel mounts asynchronously (and remounts on dispose/mount), so the
    // slot has to be watched for, not read once. `isConnected` short-circuits
    // the common case: a file tree mutates constantly as folders expand, and
    // this observer sees every one of those.
    const find = () =>
      setSlot((prev) =>
        prev?.isConnected ? prev : host.querySelector("[data-tedi-panel-controls]"),
      );
    find();
    const observer = new MutationObserver(find);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [container, enabled]);
  return slot;
}

export function RightPanelHost({
  extensionId,
  panelId,
  dragHandle,
}: {
  extensionId: string;
  panelId: string;
  /** Grip + collapse controls from the section stack, rendered in the host
   *  header so a panel can be reordered and minimized like any other section. */
  dragHandle?: ReactNode;
}) {
  const close = useRightPanelStore((s) => s.close);
  // Panel list updates live so the header title tracks the manifest.
  const panels = useRegistry(panelsRegistry);
  // Sidebar sections that have been moved into the right column are hosted here
  // too, rendered as the same React tree as the left sidebar rather than a DOM
  // panel renderer.
  const sidebarSections = useRegistry(sidebarSectionsRegistry);
  const movedSectionId = parseSectionPanelId(panelId);

  // Renderer registry is key-addressed (Map<extId, Map<panelId, fn>>),
  // no `list()` snapshot. Track the current renderer via subscribe + state.
  //
  // CRITICAL: the renderer is a function. React's setState treats a bare
  // function as an updater (`prev => next`), so `setRenderer(fn)` would
  // call `fn(prevRenderer)` and crash inside `container.replaceChildren()`.
  // Always wrap in `() => fn`. The lazy initializer below is exempt.
  const [renderer, setRenderer] = useState<PanelRenderer | null>(() =>
    panelRenderersRegistry.get(extensionId, panelId),
  );
  useEffect(() => {
    const read = () => {
      const fn = panelRenderersRegistry.get(extensionId, panelId);
      // Wrap so React doesn't treat the renderer as a state updater.
      setRenderer(() => fn);
    };
    read();
    return panelRenderersRegistry.subscribe(read);
  }, [extensionId, panelId]);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const meta = panels.find((p) => p.extensionId === extensionId && p.item.id === panelId);
  const title = meta?.item.title ?? "";
  const hideHostHeader = meta?.item.hideHostHeader === true;
  // Only a header-less panel has a reason to adopt the controls; one with the
  // host header already shows them there.
  const controlsSlot = useControlsSlot(containerRef, hideHostHeader && !!dragHandle);

  useEffect(() => {
    if (!renderer) return;
    const el = containerRef.current;
    if (!el) return;
    let cleanup: (() => void) | void;
    try {
      cleanup = renderer(el);
    } catch (err) {
      console.error(`[extensions] panel renderer for "${extensionId}:${panelId}" threw`, err);
    }
    return () => {
      try {
        cleanup?.();
      } catch (err) {
        console.error(`[extensions] panel cleanup for "${extensionId}:${panelId}" threw`, err);
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
  }, [extensionId, panelId, renderer]);

  // A sidebar section moved to the right column: render the same React section
  // (its descriptor carries the live tree + callbacks) with the right-surface
  // header (move-back-to-left + close).
  if (movedSectionId) {
    const entry = sidebarSections.find(
      (s) => s.extensionId === extensionId && s.item.id === movedSectionId,
    );
    if (!entry) return null;
    return (
      <div className="border-border/60 bg-background tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
        <ExtensionSidebarSection
          extensionId={entry.extensionId}
          section={entry.item}
          surface="right"
          dragHandle={dragHandle}
        />
      </div>
    );
  }

  return (
    <div
      data-ext-right-panel
      data-ext-id={extensionId}
      data-panel-id={panelId}
      className={cn(
        "border-border/60 bg-background tedi-glass-panel relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border",
        "text-[12px]",
      )}
    >
      <div
        aria-hidden
        className="from-foreground/[0.03] pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b to-transparent"
      />
      {hideHostHeader ? (
        // The panel asked for no host header, but it is still a member of the
        // right column's stack: without somewhere to put the grip it would be
        // the one panel that cannot be reordered or minimized. A panel that
        // renders a `[data-tedi-panel-controls]` slot takes them onto its own
        // header row (the folder tree does); the slim rail is the fallback for
        // one that does not, so no panel is ever left undraggable.
        dragHandle && !controlsSlot ? (
          <div className="border-border/60 flex h-5 shrink-0 items-center border-b px-1.5">
            {dragHandle}
          </div>
        ) : null
      ) : (
        <div className="border-border/60 relative flex h-11 shrink-0 items-center justify-between gap-1 border-b px-3">
          <span className="flex min-w-0 items-center gap-1">
            {dragHandle}
            <span className="text-foreground/90 min-w-0 truncate text-[12px] font-medium">
              {title || "Panel"}
            </span>
          </span>
          <IconTooltip label="Close panel" side="top">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => close(extensionId, panelId)}
              className={cn(DESTRUCTIVE_ACTION, "size-6 rounded")}
              aria-label="Close panel"
            >
              <X size={13} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        </div>
      )}
      {/* Placeholder sits outside the extension's container so the
          extension's first `replaceChildren()` doesn't wipe it. */}
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-auto" />
      {controlsSlot && dragHandle ? createPortal(dragHandle, controlsSlot) : null}
      {!renderer ? (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 top-11 flex items-center justify-center text-[11px]">
          Loading panel…
        </div>
      ) : null}
    </div>
  );
}
