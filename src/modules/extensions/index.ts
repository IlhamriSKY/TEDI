/**
 * Public barrel for the extension subsystem. Import from
 * `@/modules/extensions`; internals may move.
 */

export type { Manifest, ContributedSetting, ContributedPanel } from "./manifest";
export { ManifestSchema, safeParseManifest } from "./manifest";
export { useExtensionsStore } from "./store";
export type { InstalledExtension } from "./store";
export {
  aiToolsRegistry,
  commandsRegistry,
  keybindingsRegistry,
  panelRenderersRegistry,
  panelsRegistry,
  settingsRegistry,
  sidebarSectionsRegistry,
  statusItemsRegistry,
} from "./registries";
export type {
  PanelRenderer,
  SidebarSection,
  SidebarSectionItem,
  SidebarSectionAction,
  StatusItem,
} from "./registries";
export { checkPermission, permissionRiskTier } from "./permissions";
export { useRegistry } from "./useRegistry";
export { loadExtensionIcon } from "./icon";
export { useStatusItemEntries, type StatusItemEntry } from "./components/ExtensionStatusItems";
export { ExtensionSidebarSection } from "./components/ExtensionSidebarSection";
export { RightPanelHost } from "./components/RightPanelHost";
export {
  useRightPanelToggleEntries,
  type PanelToggleEntry,
} from "./components/RightPanelToggleButtons";
export { isRightPanelOpen, useRightPanelStore, type ActivePanel } from "./rightPanelStore";
export {
  useSidebarPlacementStore,
  sidebarSectionKey,
  undockTarget,
  sectionPanelId,
  parseSectionPanelId,
  BUILTIN_SECTION_EXT,
  MOVABLE_BUILTIN_SECTIONS,
  type BuiltinSectionId,
} from "./sidebarPlacementStore";
export {
  useSidebarSectionToggleEntries,
  type SidebarToggleEntry,
} from "./components/SidebarSectionRightToggles";
export {
  useBuiltinSectionToggleEntries,
  type BuiltinToggleEntry,
} from "./components/BuiltinSectionRightToggles";
export {
  setExtensionWorkspaceBridge,
  getExtensionWorkspaceBridge,
  type ExtensionWorkspaceBridge,
} from "./workspaceBridge";
export type { MountedFolderTree, MountFolderTreeOptions } from "./components/mountFolderTree";
