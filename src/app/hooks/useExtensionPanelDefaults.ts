import {
  parseSectionPanelId,
  sidebarSectionsRegistry,
  useExtensionsStore,
  useRegistry,
  useRightPanelStore,
} from "@/modules/extensions";
import { useEffect } from "react";

/**
 * Extension boot + right-surface panel lifecycle. Boots the extension host
 * (idempotent) after prefs so extension-contributed settings land before first
 * render, honors each manifest's `defaultOpen` once per session, and hides a
 * right-panel target whose owning extension has been disabled or uninstalled.
 *
 * Reads the extensions / right-panel stores directly (the trigger values are
 * not needed elsewhere in App). Effects are moved verbatim with identical
 * dependency arrays. Must be called after `useAiBootstrap` so the extension
 * boot still follows `initPrefs` in mount order.
 */
export function useExtensionPanelDefaults(): void {
  // Boot extensions after prefs so extension-contributed settings (themes,
  // slash commands, AI tools) land before first render. Idempotent.
  useEffect(() => {
    void useExtensionsStore.getState().init();
  }, []);

  // Honor manifest `defaultOpen` for right-surface panels once per session.
  // Reads from the extensions store so this runs after `bootAll()` or when
  // an extension is enabled. `markDefaultOpenHandled` stops us reopening a
  // panel the user has closed.
  const extensionsList = useExtensionsStore((s) => s.list);
  const extensionsHydrated = useExtensionsStore((s) => s.hydrated);
  useEffect(() => {
    if (!extensionsHydrated) return;
    const store = useRightPanelStore.getState();
    for (const ext of extensionsList) {
      if (!ext.enabled) continue;
      const panels = ext.manifest.contributes.panels ?? [];
      for (const panel of panels) {
        if (panel.surface !== "right" || panel.defaultOpen !== true) continue;
        if (store.markDefaultOpenHandled(ext.id, panel.id)) {
          store.open(ext.id, panel.id);
          // First defaultOpen wins. The user can toggle the rest.
          return;
        }
      }
    }
  }, [extensionsHydrated, extensionsList]);

  // Hide an active right-panel target whose extension is now disabled or
  // uninstalled, so the slot doesn't show a dead header.
  const rightPanelActive = useRightPanelStore((s) => s.active);
  const sidebarSections = useRegistry(sidebarSectionsRegistry);
  useEffect(() => {
    if (!rightPanelActive) return;
    // A moved sidebar section (panelId sentinel `__section__:<id>`) is hosted in
    // the right slot but is NOT a manifest panel. Validate it against the
    // sidebar-section registry instead — keep it open while still contributed.
    const sectionId = parseSectionPanelId(rightPanelActive.panelId);
    if (sectionId !== null) {
      const stillThere = sidebarSections.some(
        (s) => s.extensionId === rightPanelActive.extensionId && s.item.id === sectionId,
      );
      if (!stillThere) useRightPanelStore.getState().close();
      return;
    }
    const owner = extensionsList.find((e) => e.id === rightPanelActive.extensionId && e.enabled);
    const hasPanel =
      owner?.manifest.contributes.panels?.some((p) => p.id === rightPanelActive.panelId) ?? false;
    if (!owner || !hasPanel) {
      useRightPanelStore.getState().close();
    }
  }, [extensionsList, rightPanelActive, sidebarSections]);
}
