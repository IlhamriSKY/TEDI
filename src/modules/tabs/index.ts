export { TabBar } from "./TabBar";
export {
  MAX_PANES_PER_TAB,
  useTabs,
  activeLeaf,
  activeLeafKind,
  isEditorLikeTab,
  isTerminalLikeTab,
  type Tab,
  type PaneTab,
  type PreviewTab,
  type AiDiffTab,
  type AiDiffStatus,
  type GitDiffTab,
  type GitChangeStatusTab,
  type ScmTab,
  type TabPatch,
} from "./lib/useTabs";
export { useWorkspaceCwd } from "./lib/useWorkspaceCwd";
