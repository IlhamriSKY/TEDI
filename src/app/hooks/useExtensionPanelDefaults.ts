import {
  BUILTIN_SECTION_EXT,
  MOVABLE_BUILTIN_SECTIONS,
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
        // Every defaultOpen panel opens: the right column stacks them, so they
        // no longer compete for one slot. `markDefaultOpenHandled` keeps it to
        // once per session, so a panel the user closes stays closed.
        if (store.markDefaultOpenHandled(ext.id, panel.id)) store.open(ext.id, panel.id);
      }
    }
  }, [extensionsHydrated, extensionsList]);

  // Drop any open right-column panel whose extension is now disabled or
  // uninstalled, so the column doesn't show a dead header. Every open panel is
  // checked, not just the newest: the column stacks them.
  const rightPanels = useRightPanelStore((s) => s.panels);
  const sidebarSections = useRegistry(sidebarSectionsRegistry);
  useEffect(() => {
    for (const panel of rightPanels) {
      // A moved sidebar section (panelId sentinel `__section__:<id>`) is hosted
      // in the column but is NOT a manifest panel. Validate it against the
      // sidebar-section registry instead — keep it open while still contributed.
      const sectionId = parseSectionPanelId(panel.panelId);
      if (sectionId !== null) {
        // Built-in sections (Files/Workspaces) share the `__section__:` sentinel
        // but live under `BUILTIN_SECTION_EXT`, not the extension registry - so
        // validate them against the movable-built-ins list instead. Without this
        // they'd never match `sidebarSections` and get closed the instant they
        // dock right (the built-in right-dock was dead on arrival otherwise).
        if (panel.extensionId === BUILTIN_SECTION_EXT) {
          const known = MOVABLE_BUILTIN_SECTIONS.some((b) => b.id === sectionId);
          if (!known) useRightPanelStore.getState().close(panel.extensionId, panel.panelId);
          continue;
        }
        const stillThere = sidebarSections.some(
          (s) => s.extensionId === panel.extensionId && s.item.id === sectionId,
        );
        if (!stillThere) useRightPanelStore.getState().close(panel.extensionId, panel.panelId);
        continue;
      }
      const owner = extensionsList.find((e) => e.id === panel.extensionId && e.enabled);
      const hasPanel =
        owner?.manifest.contributes.panels?.some((p) => p.id === panel.panelId) ?? false;
      if (!owner || !hasPanel) {
        useRightPanelStore.getState().close(panel.extensionId, panel.panelId);
      }
    }
  }, [extensionsList, rightPanels, sidebarSections]);
}
