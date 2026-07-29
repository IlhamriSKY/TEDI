import { type EditorPaneHandle } from "@/modules/editor";
import { useChatStore } from "@/modules/ai";
import { countTabEntries, type Tab } from "@/modules/tabs";
import { isRemoteEditorLeaf, leaves } from "@/modules/terminal";
import { useWorkspacesStore } from "@/modules/workspaces";
import { basename } from "@/lib/path";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

type Params = {
  tabs: Tab[];
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  wsActiveId: string | null;
};

/**
 * Three independent reactions to the `tabs` array, grouped because they share
 * no state and each just watches tabs:
 *   - AI-diff reload bridge: when an ai-diff tab flips to "approved", reload
 *     every editor leaf showing the same path (per-leaf, once per approval).
 *   - Open-editor-files sync: surface every open (non-private) editor leaf as a
 *     click-to-attach chip in the AI input, de-duped by path.
 *   - Live tab counts: track the active workspace's real tab-entry total so the
 *     sidebar badge matches the tab strip exactly.
 * Moved verbatim from App with identical dependency arrays; `liveTabCounts` is
 * returned for the WorkspacesPanel badge.
 */
export function useTabSideEffects({ tabs, editorRefs, wsActiveId }: Params): {
  liveTabCounts: Record<string, number>;
} {
  // -------- AI-diff reload bridge (per-leaf) --------
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const other of tabs) {
        if (other.kind !== "pane") continue;
        for (const leaf of leaves(other.paneTree)) {
          if (leaf.leafKind !== "editor") continue;
          // An AI diff is always about a LOCAL file, so a remote leaf that
          // happens to share the path is a different file entirely.
          if (isRemoteEditorLeaf(leaf)) continue;
          if (leaf.path !== t.path) continue;
          editorRefs.current.get(leaf.id)?.reload();
        }
      }
    }
    // Prune ids whose ai-diff tab no longer exists so the set stays bounded
    // over long sessions (mirrors the openedRef pruning in AgentRunBridge).
    const live = new Set(tabs.filter((t) => t.kind === "ai-diff").map((t) => t.approvalId));
    for (const id of appliedDiffsRef.current) {
      if (!live.has(id)) appliedDiffsRef.current.delete(id);
    }
  }, [tabs]);

  // Surface every open editor leaf as a click-to-attach chip in the AI
  // input. De-dup by path so split panes don't duplicate. The setter
  // short-circuits on shape-equal lists, so most keystroke runs are
  // no-ops downstream.
  //
  // Private editor leaves are excluded so their path never appears as a
  // chip or mention-picker entry - preventing the user from accidentally
  // attaching a private file to the AI conversation.
  const setOpenEditorFiles = useChatStore((s) => s.setOpenEditorFiles);
  useEffect(() => {
    const openFiles: { path: string; name: string }[] = [];
    const seenPaths = new Set<string>();
    for (const t of tabs) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind !== "editor") continue;
        if (l.private) continue;
        // Remote files are excluded: the AI's file tools are local-only, so
        // offering a remote path as a chip points them at the local disk.
        if (isRemoteEditorLeaf(l)) continue;
        if (seenPaths.has(l.path)) continue;
        seenPaths.add(l.path);
        openFiles.push({
          path: l.path,
          name: basename(l.path),
        });
      }
    }
    setOpenEditorFiles(openFiles);
  }, [setOpenEditorFiles, tabs]);

  // Live tab counts per workspace, keyed by id. The active workspace's entry
  // tracks the real open-tab total (every kind, including the session-only
  // diff / scm / extension tabs the persisted snapshot drops), so the sidebar
  // badge matches the tab strip exactly. Workspaces visited this session keep
  // their last live count while inactive (no jump on switch-away); never-yet-
  // visited ones fall back to the persisted `tabs.length` in WorkspacesPanel.
  const [liveTabCounts, setLiveTabCounts] = useState<Record<string, number>>({});
  // Count tab-strip entries (one per pane leaf, so a split "group" tab counts
  // its panes, not 1) rather than tabs.length, and key the effect on it so a
  // split/unsplit that leaves tabs.length unchanged still updates the badge.
  const tabEntryCount = useMemo(() => countTabEntries(tabs), [tabs]);
  useEffect(() => {
    if (!wsActiveId) return;
    setLiveTabCounts((m) =>
      m[wsActiveId] === tabEntryCount ? m : { ...m, [wsActiveId]: tabEntryCount },
    );
  }, [tabEntryCount, wsActiveId]);

  // Drop entries for workspaces that have been closed so the map stays bounded
  // (it otherwise keeps a count for every workspace ever activated).
  const workspaceIds = useWorkspacesStore((s) => s.workspaces.map((w) => w.id).join("\x1f"));
  useEffect(() => {
    const live = new Set(workspaceIds ? workspaceIds.split("\x1f") : []);
    setLiveTabCounts((m) => {
      const stale = Object.keys(m).filter((id) => !live.has(id));
      if (stale.length === 0) return m;
      const next = { ...m };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [workspaceIds]);

  return { liveTabCounts };
}
