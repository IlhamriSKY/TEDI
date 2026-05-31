import { cn } from "@/lib/utils";
import type { ScmTab, Tab } from "@/modules/tabs";
import { SourceControlPanel } from "./SourceControlPanel";
import type { OpenDiffInput } from "./types";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Live workspace repo root. The tab follows the active workspace. */
  rootPath: string | null;
  onPathDeleted?: (path: string) => void;
  /** Open a per-commit file diff in a tab (clicking a file in the commit
   *  detail card). Without it the detail card lists changed files read-only. */
  onOpenDiff?: (input: OpenDiffInput) => void;
};

/**
 * Overlay host for the Source Control tab. Mirrors GitDiffStack/AiDiffStack:
 * one absolutely-positioned layer per scm tab (deduped to a single instance),
 * the active one visible. The tab is history-only (`historyOnly`): just the
 * commit graph, with commit detail shown in a card floating at the cursor.
 */
export function ScmStack({ tabs, activeId, rootPath, onPathDeleted, onOpenDiff }: Props) {
  const scmTabs = tabs.filter((t): t is ScmTab => t.kind === "scm");
  if (scmTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {scmTabs.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn("absolute inset-0", !visible && "pointer-events-none invisible")}
            aria-hidden={visible ? "false" : "true"}
          >
            <div className="border-border/60 bg-card tedi-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
              <SourceControlPanel
                rootPath={rootPath}
                onPathDeleted={onPathDeleted}
                onOpenDiff={onOpenDiff}
                historyOnly
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
