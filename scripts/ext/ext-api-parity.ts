/**
 * Compile-time parity guard between the extension host and its published
 * types.
 *
 * `extensions/tedi.d.ts` is what third-party authors code against. It is
 * hand-written (standalone, import-free, heavily commented - none of which
 * `tsc --declaration` can emit from `host.ts`, whose types reach into React,
 * CodeMirror and the tab store). Hand-written means it can drift, and a drifted
 * `.d.ts` is worse than no `.d.ts`: it tells an author a method exists that the
 * host never had, or hides one that does.
 *
 * So the two are asserted mutually assignable here. Add a member to
 * `ExtensionContext` in `host.ts` and forget the public copy, rename one on
 * either side, change a signature - `pnpm typecheck` fails with the offending
 * facade named, because the assertion is split per facade rather than done in
 * one lump (a single whole-context assert reports one useless error for any
 * drift anywhere).
 *
 * This file is type-only: it emits no JavaScript and is never bundled. It is
 * reached by `tsconfig.json`'s `include`, so CI's existing typecheck covers it
 * with no new script to run.
 */

import type {
  AiStateSnapshot as HostAiState,
  AppContextSnapshot as HostAppContext,
  ExtensionContext as HostContext,
  HostFeature as HostFeatureName,
} from "../../src/modules/extensions/host";
import type {
  HeaderItem as HostHeaderItem,
  PanelRenderer as HostPanelRenderer,
  ShellCommandTransformer as HostShellTransformer,
  SidebarSection as HostSidebarSection,
  StatusItem as HostStatusItem,
} from "../../src/modules/extensions/registries";
import type { KnownPermission as HostKnownPermission } from "../../src/modules/extensions/permissions";
import type { ActiveEditorSnapshot as HostEditorSnapshot } from "../../src/modules/extensions/editorBridge";
import type { SafeSshConnection as HostSshConnection } from "../../src/modules/extensions/sshBridge";
import type {
  CodeEditorHandle as HostCodeEditorHandle,
  CodeEditorOptions as HostCodeEditorOptions,
} from "../../src/modules/extensions/codeEditor";
import type {
  MountedFolderTree as HostMountedFolderTree,
  MountFolderTreeOptions as HostMountFolderTreeOptions,
} from "../../src/modules/extensions/components/mountFolderTree";
import type { ExtensionTabState as HostTabState } from "../../src/modules/tabs/lib/tabTypes";

import type {
  ActiveEditorSnapshot,
  AiStateSnapshot,
  AppContextSnapshot,
  CodeEditorHandle,
  CodeEditorOptions,
  ExtensionContext,
  ExtensionTabState,
  HeaderItem,
  HostFeature,
  KnownPermission,
  MountedFolderTree,
  MountFolderTreeOptions,
  PanelRenderer,
  SafeSshConnection,
  ShellCommandTransformer,
  SidebarSection,
  StatusItem,
} from "../../extensions/tedi";

/**
 * Mutual assignability, not `Eq`. An exact-identity check trips on differences
 * that cannot reach an author - a widened optional here, a named alias there -
 * and the resulting error is unreadable. Both-ways-assignable still catches
 * every member that is added, removed, renamed, or given an incompatible
 * signature, which is the whole failure set that matters.
 *
 * Tuple-wrapped so a union on one side is compared as a whole rather than
 * distributed member by member.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

// --- the context, facade by facade ------------------------------------------
// Split so the error message names the drifted surface. `HostContext["x"]`
// keeps each line readable and makes a renamed key fail on its own line.

export type _ctx_id = Assert<Same<HostContext["id"], ExtensionContext["id"]>>;
export type _ctx_installPath = Assert<
  Same<HostContext["installPath"], ExtensionContext["installPath"]>
>;
export type _ctx_os = Assert<Same<HostContext["os"], ExtensionContext["os"]>>;
export type _ctx_paths = Assert<Same<HostContext["paths"], ExtensionContext["paths"]>>;
export type _ctx_storage = Assert<Same<HostContext["storage"], ExtensionContext["storage"]>>;
export type _ctx_app = Assert<Same<HostContext["app"], ExtensionContext["app"]>>;
export type _ctx_settings = Assert<Same<HostContext["settings"], ExtensionContext["settings"]>>;
export type _ctx_ai = Assert<Same<HostContext["ai"], ExtensionContext["ai"]>>;
export type _ctx_invoke = Assert<Same<HostContext["invoke"], ExtensionContext["invoke"]>>;
export type _ctx_invokeChannel = Assert<
  Same<HostContext["invokeChannel"], ExtensionContext["invokeChannel"]>
>;
export type _ctx_secrets = Assert<Same<HostContext["secrets"], ExtensionContext["secrets"]>>;
export type _ctx_events = Assert<Same<HostContext["events"], ExtensionContext["events"]>>;
export type _ctx_ui = Assert<Same<HostContext["ui"], ExtensionContext["ui"]>>;
export type _ctx_statusBar = Assert<Same<HostContext["statusBar"], ExtensionContext["statusBar"]>>;
export type _ctx_headerBar = Assert<Same<HostContext["headerBar"], ExtensionContext["headerBar"]>>;
export type _ctx_sidebar = Assert<Same<HostContext["sidebar"], ExtensionContext["sidebar"]>>;
export type _ctx_editor = Assert<Same<HostContext["editor"], ExtensionContext["editor"]>>;
export type _ctx_tabs = Assert<Same<HostContext["tabs"], ExtensionContext["tabs"]>>;
export type _ctx_ssh = Assert<Same<HostContext["ssh"], ExtensionContext["ssh"]>>;
export type _ctx_shell = Assert<Same<HostContext["shell"], ExtensionContext["shell"]>>;
export type _ctx_registerPanelRenderer = Assert<
  Same<HostContext["registerPanelRenderer"], ExtensionContext["registerPanelRenderer"]>
>;
export type _ctx_panel = Assert<Same<HostContext["panel"], ExtensionContext["panel"]>>;
export type _ctx_contribute = Assert<
  Same<HostContext["contribute"], ExtensionContext["contribute"]>
>;
export type _ctx_registerCommandHandler = Assert<
  Same<HostContext["registerCommandHandler"], ExtensionContext["registerCommandHandler"]>
>;
export type _ctx_registerAiToolHandler = Assert<
  Same<HostContext["registerAiToolHandler"], ExtensionContext["registerAiToolHandler"]>
>;
export type _ctx_logger = Assert<Same<HostContext["logger"], ExtensionContext["logger"]>>;
export type _ctx_has = Assert<Same<HostContext["has"], ExtensionContext["has"]>>;
export type _ctx_addDisposer = Assert<
  Same<HostContext["addDisposer"], ExtensionContext["addDisposer"]>
>;

/**
 * No EXTRA and no MISSING keys. The per-facade asserts above only cover keys
 * this file lists, so without this a new `ctx.foo` on either side would slip
 * through unnoticed - which is exactly the drift the file exists to stop.
 */
export type _ctx_keys = Assert<Same<keyof HostContext, keyof ExtensionContext>>;

// --- the types those facades hand back --------------------------------------

export type _t_appContext = Assert<Same<HostAppContext, AppContextSnapshot>>;
export type _t_aiState = Assert<Same<HostAiState, AiStateSnapshot>>;
export type _t_editorSnapshot = Assert<Same<HostEditorSnapshot, ActiveEditorSnapshot>>;
export type _t_sshConnection = Assert<Same<HostSshConnection, SafeSshConnection>>;
export type _t_statusItem = Assert<Same<HostStatusItem, StatusItem>>;
export type _t_headerItem = Assert<Same<HostHeaderItem, HeaderItem>>;
export type _t_sidebarSection = Assert<Same<HostSidebarSection, SidebarSection>>;
export type _t_shellTransformer = Assert<Same<HostShellTransformer, ShellCommandTransformer>>;
export type _t_panelRenderer = Assert<Same<HostPanelRenderer, PanelRenderer>>;
export type _t_tabState = Assert<Same<HostTabState, ExtensionTabState>>;
export type _t_codeEditorOptions = Assert<Same<HostCodeEditorOptions, CodeEditorOptions>>;
export type _t_codeEditorHandle = Assert<Same<HostCodeEditorHandle, CodeEditorHandle>>;
export type _t_folderTreeOptions = Assert<Same<HostMountFolderTreeOptions, MountFolderTreeOptions>>;
export type _t_folderTree = Assert<Same<HostMountedFolderTree, MountedFolderTree>>;

/**
 * The permission catalogue the editor completes from, in `manifest.json` and
 * in `.d.ts` hovers, is the one the host gates on. `KNOWN_PERMISSIONS` also
 * feeds `extensions/manifest.schema.json`, so a permission added to the gate
 * but not to the list is invisible to authors in all three places at once.
 */
export type _t_knownPermission = Assert<Same<HostKnownPermission, KnownPermission>>;

/**
 * `ctx.has()` answers from `HOST_FEATURES`, and `HostFeature` is what an
 * author sees documented. A feature implemented but not published is one no
 * extension will ever ask for.
 */
export type _t_hostFeature = Assert<Same<HostFeatureName, HostFeature>>;
