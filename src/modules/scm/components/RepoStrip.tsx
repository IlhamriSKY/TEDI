import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { basename, toForwardSlash } from "@/lib/path";
import { Check, ChevronDown, FolderGit2 } from "lucide-react";

/** Comparable form of a path. Lower-cased because the Windows filesystem is
 *  case-insensitive and git and the workspace do not agree on drive-letter case. */
export function repoKey(path: string): string {
  return toForwardSlash(path).replace(/\/+$/, "").toLowerCase();
}

/** A repository named by where it sits under the workspace, which is what tells
 *  two `app` folders apart. The workspace's own repository keeps its name. */
export function repoLabel(repo: string, workspaceRoot: string): string {
  const root = repoKey(workspaceRoot);
  const key = repoKey(repo);
  if (key === root || !key.startsWith(root + "/")) return basename(repo);
  return toForwardSlash(repo).slice(root.length + 1);
}

type Props = {
  workspaceRoot: string;
  /** Every repository found at or below the workspace root. */
  repos: string[];
  /** The repository the panel is showing now, if it resolved one. */
  current: string | null;
  /** True while a repository other than the workspace's own is picked. */
  targeted: boolean;
  onPick: (repo: string) => void;
  onFollowWorkspace: () => void;
};

/**
 * Which repository Source Control is on, and the others the workspace folder
 * holds. One strip for both jobs: a pick made in the Explorer and a pick made
 * here set the same target, so they must read and undo the same way.
 */
export function RepoStrip({
  workspaceRoot,
  repos,
  current,
  targeted,
  onPick,
  onFollowWorkspace,
}: Props) {
  const label = current ? repoLabel(current, workspaceRoot) : "Pick a repository";
  return (
    <div className="border-border/60 bg-muted/40 flex shrink-0 items-center gap-1 border-b px-2 py-1">
      {repos.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="hover:border-border aria-expanded:border-border h-6 min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1.5 text-[11px]"
              title={current ?? undefined}
              aria-label={`Repository ${label}. Switch repository`}
            >
              <FolderGit2 size={13} strokeWidth={2} className="text-icon-working shrink-0" />
              <span className="truncate">{label}</span>
              <ChevronDown
                size={11}
                strokeWidth={2.5}
                className="text-muted-foreground ml-auto shrink-0"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[60vh] w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 overflow-y-auto"
          >
            {repos.map((r) => (
              <DropdownMenuItem key={r} onSelect={() => onPick(r)} title={r}>
                <FolderGit2 size={12} strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate">{repoLabel(r, workspaceRoot)}</span>
                {current && repoKey(r) === repoKey(current) ? (
                  <Check size={12} strokeWidth={2.5} className="shrink-0" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[11px]"
          title={current ?? undefined}
        >
          <FolderGit2 size={13} strokeWidth={2} className="text-icon-working shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      )}
      {targeted ? (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={onFollowWorkspace}
          aria-label="Follow the workspace repository again"
        >
          Follow workspace
        </Button>
      ) : null}
    </div>
  );
}
