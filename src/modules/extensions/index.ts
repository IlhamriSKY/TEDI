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
  statusItemsRegistry,
} from "./registries";
export type { PanelRenderer, StatusItem } from "./registries";
export { permissionRiskTier } from "./permissions";
export { loadExtensionIcon } from "./icon";
export { ExtensionStatusItems } from "./components/ExtensionStatusItems";
export { RightPanelHost } from "./components/RightPanelHost";
export {
  RightPanelCompactToggles,
  RightPanelTextToggles,
} from "./components/RightPanelToggleButtons";
export { useRightPanelStore } from "./rightPanelStore";
export {
  setExtensionWorkspaceBridge,
  getExtensionWorkspaceBridge,
  type ExtensionWorkspaceBridge,
} from "./workspaceBridge";
export type { MountedFolderTree, MountFolderTreeOptions } from "./components/mountFolderTree";
