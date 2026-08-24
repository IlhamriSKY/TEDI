import { type PaneNode } from "@/modules/terminal/lib/panes";

/**
 * A pane tab holds a tmux-style pane tree of terminal or editor leaves.
 * Splitting (Ctrl+D / Ctrl+Shift+D) adds a new leaf next to the focused one.
 * Trees can mix horizontal and vertical orientations.
 * `title` / `cwd` / `path` / `dirty` / `preview` mirror the active leaf and
 * resync whenever the tree or active leaf changes.
 */
export type PaneTab = {
  id: number;
  kind: "pane";
  title: string;
  paneTree: PaneNode;
  activeLeafId: number;
  // Mirrors of the active leaf, populated by `syncPaneMirror`.
  cwd?: string;
  path?: string;
  dirty?: boolean;
  preview?: boolean;
};

export type AiDiffStatus = "pending" | "approved" | "rejected";

export type AiDiffTab = {
  id: number;
  kind: "ai-diff";
  title: string;
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type GitChangeStatusTab =
  "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "ignored";

export type GitDiffTab = {
  id: number;
  kind: "git-diff";
  title: string;
  /** Absolute working-tree path. */
  path: string;
  /** Repo-relative forward-slash path. */
  relative: string;
  /** Absolute repo root. */
  repoPath: string;
  changeStatus: GitChangeStatusTab;
  /** Bumps on Refresh so the pane re-reads HEAD and working tree. */
  reloadKey: number;
  /**
   * Per-commit diff mode. When `commitSha` is set the pane diffs the file at
   * `commitSha` against `baseRev` (its first parent, or null for the root
   * commit) instead of HEAD vs the working tree.
   */
  commitSha?: string;
  baseRev?: string | null;
  /** Previous repo-relative path for a renamed/copied file (left side at `baseRev`). */
  oldRelative?: string | null;
  /** Short SHA shown in the diff header. */
  commitLabel?: string;
};

/**
 * Full Source Control surface hosted in a tab (branch + working-tree changes,
 * commit/push, and a commit-history graph with per-commit detail + diffs).
 * Deduped to one instance; `openScmTab` focuses the existing tab. Content is
 * driven by the live workspace root, so the tab carries no repo state itself.
 */
export type ScmTab = {
  id: number;
  kind: "scm";
  title: string;
};

/**
 * Lifecycle hint an extension can attach to its tab so the title text
 * colour reflects connection / job state. Mirrors the SSH tab palette so
 * "remote-ish" extensions read consistently next to terminal tabs:
 * `connecting`/`reconnecting` → pulsing yellow, `connected` → green,
 * `disconnected`/`error` → red, `idle`/undefined → default.
 */
export type ExtensionTabState =
  "idle" | "connecting" | "reconnecting" | "connected" | "disconnected" | "error";

/**
 * Extension-owned tab. The content is mounted by `ExtensionTabStack`
 * which calls the renderer registered by `ctx.registerPanelRenderer`.
 * Opened via `ctx.tabs.openExtensionTab({ extensionId, panelId, title })`.
 */
export type ExtensionTab = {
  id: number;
  kind: "ext";
  title: string;
  extensionId: string;
  panelId: string;
  /** Optional icon path relative to the extension root (or `data:` URL). */
  icon?: string;
  /** Caller-supplied stable id for dedup (so re-opening focuses the
   *  existing tab instead of pushing a new one). */
  reuseKey?: string;
  /** Optional lifecycle tone for the tab title text. Updated by the
   *  extension via `ctx.tabs.setExtensionTabState(...)`. */
  state?: ExtensionTabState;
};

/**
 * Any tab, plus the flags that apply to every kind.
 *
 * `pinned` is an intersection rather than a field repeated on all five kinds so
 * there is one place to read the contract from, and so a new tab kind gets it
 * automatically instead of silently being unpinnable.
 *
 * PINNING IS A PROPERTY OF THE TAB, NEVER OF A PANE LEAF. The strip draws one
 * chip per leaf, so a split tab looks like several tabs - but the unit that can
 * actually be reordered is the tab (`tab:<id>` to dnd-kit); a leaf can only move
 * within its own split. Since pinning means "sit at the front of the strip and
 * stay there", it can only mean something at the tab level. Right-clicking any
 * leaf of a split therefore pins the whole group, and the menu says "Pin Group"
 * so nobody expects one pane of a split to fly out on its own.
 */
export type Tab = (PaneTab | AiDiffTab | GitDiffTab | ExtensionTab | ScmTab) & {
  /** Pinned tabs sort ahead of unpinned ones and render compact. */
  pinned?: boolean;
};
