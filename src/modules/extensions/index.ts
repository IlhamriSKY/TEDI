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
export { permissionRiskTier } from "./permissions";
export { useRegistry } from "./useRegistry";
export { loadExtensionIcon } from "./icon";
export { ExtensionStatusItems } from "./components/ExtensionStatusItems";
export { ExtensionSidebarSection } from "./components/ExtensionSidebarSection";
export { RightPanelHost } from "./components/RightPanelHost";
export {
  RightPanelCompactToggles,
  RightPanelDefaultToggles,
} from "./components/RightPanelToggleButtons";
export { useRightPanelStore } from "./rightPanelStore";
export {
  useSidebarPlacementStore,
  sidebarSectionKey,
  sectionPanelId,
  parseSectionPanelId,
} from "./sidebarPlacementStore";
export { SidebarSectionRightToggles } from "./components/SidebarSectionRightToggles";
export {
  setExtensionWorkspaceBridge,
  getExtensionWorkspaceBridge,
  type ExtensionWorkspaceBridge,
} from "./workspaceBridge";
export type { MountedFolderTree, MountFolderTreeOptions } from "./components/mountFolderTree";
