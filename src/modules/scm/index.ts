// Public surface of the source-control module (the git/ Rust backend's frontend).
// Components render the SCM panel + side-by-side diffs; api.ts wraps the git_*
// Tauri commands; commitAi.ts drives the "AI write commit message" affordance.
export { SourceControlPanel } from "./SourceControlPanel";
export { ScmStack } from "./ScmStack";
export { GitDiffStack } from "./GitDiffStack";
export { GitDiffPane } from "./GitDiffPane";
export { CommitDetailPane } from "./CommitDetailPane";
export { GitGraphView } from "./GitGraphView";
export { useScmRightPanelStore } from "./scmRightPanelStore";
export {
  COMMIT_SYSTEM_PROMPT,
  fallbackCommitMessage,
  generateCommitMessage,
  type GenerateCommitMessageResult,
} from "./commitAi";
export * from "./api";
export * from "./types";
