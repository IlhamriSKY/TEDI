import { useCallback, useEffect, useMemo, useRef } from "react";
import { activeLeaf, isTerminalLikeTab, type Tab } from "./useTabs";
import { leaves } from "@/modules/terminal/lib/panes";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

function activeTerminalCwd(tab: Tab | undefined): string | undefined {
  if (!tab || !isTerminalLikeTab(tab)) return undefined;
  const leaf = activeLeaf(tab);
  // SSH leaves report remote paths via OSC 7 - those drive the SSH file
  // tree, not the local explorer. Letting an SSH cwd leak in here would
  // root the local tree at a Linux path Windows can't resolve.
  if (!leaf || leaf.leafKind !== "terminal" || leaf.sshConnectionId) return undefined;
  return leaf.cwd;
}

function anyTerminalCwd(tabs: Tab[]): string | undefined {
  for (const t of tabs) {
    if (t.kind !== "pane") continue;
    for (const l of leaves(t.paneTree)) {
      if (l.leafKind === "terminal" && !l.sshConnectionId && l.cwd) return l.cwd;
    }
  }
  return undefined;
}

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
  pickedRoot: string | null,
): Result {
  const lastTerminalCwd = useRef<string | null>(null);

  useEffect(() => {
    const cwd = activeTerminalCwd(activeTab);
    if (cwd) lastTerminalCwd.current = cwd;
  }, [activeTab]);

  const explorerRoot = useMemo<string | null>(() => {
    // Explorer follows the focused terminal: as the user switches tabs/panes
    // or `cd`s around, the left sidebar tracks the active shell's cwd. The
    // picked workspace root is only used as a fallback when no terminal is
    // open yet (and as the default path for "Open Folder").
    const cwd = activeTerminalCwd(activeTab);
    if (cwd) return cwd;
    if (lastTerminalCwd.current) return lastTerminalCwd.current;
    const any = anyTerminalCwd(tabs);
    if (any) return any;
    if (pickedRoot) return pickedRoot;
    return home;
  }, [pickedRoot, activeTab, tabs, home]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    // Active terminal's live cwd wins over pickedRoot: if the user has cd'd
    // into a subproject and is running a long-lived command there, opening
    // a new tab should land in that subproject - not bounce them back to
    // the workspace root they picked weeks ago.
    const cwd = activeTerminalCwd(activeTab);
    if (cwd) return cwd;
    if (lastTerminalCwd.current) return lastTerminalCwd.current;
    return pickedRoot ?? home ?? undefined;
  }, [pickedRoot, activeTab, home]);

  return { explorerRoot, inheritedCwdForNewTab };
}
