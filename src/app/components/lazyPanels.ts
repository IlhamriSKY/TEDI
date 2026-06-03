import { lazy } from "react";

/**
 * Code-split panels shared across the App layout components. Defining each
 * `lazy()` wrapper once (rather than per consumer) keeps a single chunk +
 * single component identity even when a panel is rendered from more than one
 * slot (Source Control mounts in both the sidebar and the right slot).
 *
 * Each chunk loads only when its UI is first opened:
 *   - Source Control mounts when shown in the sidebar or right slot
 *   - Diff/SCM stacks render null until a relevant tab exists
 *   - SFTP panel + its russh-sftp wrappers load only once an SSH leaf connects
 *   - AI sidebar loads once the right slot shows the AI panel
 */
export const SourceControlPanel = lazy(() =>
  import("@/modules/scm/SourceControlPanel").then((m) => ({ default: m.SourceControlPanel })),
);
export const GitDiffStack = lazy(() =>
  import("@/modules/scm/GitDiffStack").then((m) => ({ default: m.GitDiffStack })),
);
export const ScmStack = lazy(() =>
  import("@/modules/scm/ScmStack").then((m) => ({ default: m.ScmStack })),
);
export const AiDiffStack = lazy(() =>
  import("@/modules/editor/AiDiffStack").then((m) => ({ default: m.AiDiffStack })),
);
export const SshFileExplorer = lazy(() =>
  import("@/modules/ssh/SshFileExplorer").then((m) => ({ default: m.SshFileExplorer })),
);
export const AiSidebarPanel = lazy(() =>
  import("@/modules/ai/components/AiMiniWindow").then((m) => ({ default: m.AiSidebarPanel })),
);
