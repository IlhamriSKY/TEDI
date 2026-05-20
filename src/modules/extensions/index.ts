/**
 * Public barrel for the extension subsystem. Anything outside this folder
 * should import from `@/modules/extensions` and not reach into individual
 * files - the internals can move without breaking call sites.
 */

export type { Manifest, ContributedSetting } from "./manifest";
export { ManifestSchema, safeParseManifest } from "./manifest";
export { useExtensionsStore } from "./store";
export type { InstalledExtension } from "./store";
export {
  aiToolsRegistry,
  commandsRegistry,
  editorThemesRegistry,
  keybindingsRegistry,
  panelsRegistry,
  settingsRegistry,
  slashCommandsRegistry,
  statusItemsRegistry,
  themesRegistry,
} from "./registries";
export type { StatusItem } from "./registries";
export { permissionRiskTier } from "./permissions";
export { loadExtensionIcon } from "./icon";
export { ExtensionStatusItems } from "./components/ExtensionStatusItems";
