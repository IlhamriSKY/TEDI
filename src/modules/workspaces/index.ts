export { WorkspacesPanel } from "./WorkspacesPanel";
export {
  useWorkspacesStore,
  newWorkspaceId,
  type Workspace,
  type SavedTab,
  type SavedPaneTab,
  type SavedPreviewTab,
  type SavedPaneNode,
} from "./store";
export {
  tabToSaved,
  savedToTab,
  defaultTabForEmptyWorkspace,
} from "./serialize";
