import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { CreatePrDialog, StackBranchDialog } from "./components/PrDialogs";
import {
  friendlyGhError,
  ghFor,
  loosePrs,
  stackRows,
  type GhStatus,
  type PullRequest,
  type StackRow,
  type StackView,
} from "./gh";
import type { GitBranch } from "./types";
import {
  Clock,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Layers,
  MoreHorizontal,
  Plus,
  RefreshCw,
  TriangleAlert,
  Upload,
} from "lucide-react";

type Props = {
  /** Local repository root. gh runs against this working tree. */
  repoPath: string;
  /** Checked-out branch, or null on a detached HEAD. */
  branch: string | null;
  /** Publish `branch` before a PR is opened for it, through the panel's own
   *  push path so publishing behaves identically wherever it is triggered. */
  onPublish: (branch: string) => Promise<void>;
  /** gh moves HEAD (checkout, stack sync); the panel has to re-read status. */
  onRefresh: () => void;
  loadBranches: () => Promise<GitBranch[]>;
  /** True while a git write is in flight, so gh does not run on top of it. */
  busy?: boolean;
};

/** Centred message with an optional action, used by every empty / blocked state. */
function Notice({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[11px]">
      <p className="max-w-[36ch] leading-relaxed">{text}</p>
      {action}
    </div>
  );
}

/**
 * A layer's state, in gh's own vocabulary. `needsRebase` outranks the rest:
 * it is the one that needs the user to do something, and it is the failure
 * mode a stack has that a lone PR does not.
 */
function rowIcon(row: StackRow) {
  if (row.isMerged) return <GitMerge size={12} strokeWidth={2} className="text-icon-branch" />;
  if (row.isQueued) return <Clock size={12} strokeWidth={2} className="text-icon-done" />;
  if (row.needsRebase)
    return <TriangleAlert size={12} strokeWidth={2} className="text-icon-working" />;
  if (row.pr?.isDraft)
    return <GitPullRequestDraft size={12} strokeWidth={2} className="text-muted-foreground" />;
  return (
    <GitPullRequest
      size={12}
      strokeWidth={2}
      className={row.pr ? "text-icon-branch" : "text-muted-foreground/50"}
    />
  );
}

export function PullRequestsView({
  repoPath,
  branch,
  onPublish,
  onRefresh,
  loadBranches,
  busy,
}: Props) {
  const gh = useMemo(() => ghFor(repoPath), [repoPath]);
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [view, setView] = useState<StackView | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [trunk, setTrunk] = useState("main");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Label of the gh operation in flight, which also blocks a second one. */
  const [running, setRunning] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Non-null while the branch-name dialog is open; the mode picks the gh verb. */
  const [stackPrompt, setStackPrompt] = useState<"init" | "add" | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  // Replies for a repository the user has already navigated away from are
  // dropped rather than applied, the same guard BranchMenu uses.
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const probe = await gh.probe();
      if (reqRef.current !== req) return;
      setStatus(probe);
      if (!probe.installed || !probe.authenticated) {
        setView(null);
        setPrs([]);
        setError(null);
        return;
      }
      // Neither list is required for the other to render, so one failing (no
      // GitHub remote, no stack extension) must not blank the one that worked.
      const [stack, list, def] = await Promise.allSettled([
        probe.stackExtension ? gh.stack() : Promise.resolve(null),
        gh.prs(),
        gh.defaultBranch(),
      ]);
      if (reqRef.current !== req) return;
      setView(stack.status === "fulfilled" ? stack.value : null);
      setPrs(list.status === "fulfilled" ? list.value : []);
      if (def.status === "fulfilled") setTrunk(def.value);
      setError(list.status === "rejected" ? friendlyGhError(list.reason) : null);
    } catch (e) {
      if (reqRef.current === req) setError(friendlyGhError(e));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [gh]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run one gh operation, then reload. Nothing polls this view: every gh call
   * is a subprocess plus a network round trip, so the lists refresh when the
   * user acts or asks, not on a timer.
   */
  const act = useCallback(
    async (label: string, fn: () => Promise<void>, done?: string) => {
      if (running || busy) return;
      setRunning(label);
      try {
        await fn();
        toast(done ?? `${label} finished.`, { variant: "success" });
        // gh checkout / sync move HEAD, so the panel's own status is stale too.
        onRefresh();
        await load();
      } catch (e) {
        toast(friendlyGhError(e), { variant: "error" });
      } finally {
        setRunning(null);
      }
    },
    [running, busy, onRefresh, load],
  );

  const rows = useMemo(() => (view ? stackRows(view, prs) : []), [view, prs]);
  const loose = useMemo(() => loosePrs(view, prs), [view, prs]);
  /**
   * What a new PR from this branch should target. Inside a stack that is the
   * layer below - which is exactly what makes the PR a stacked one, since
   * GitHub reads the stack off this chain of base branches.
   */
  const defaultBase = useMemo(() => {
    const i = view?.branches.findIndex((b) => b.name === branch) ?? -1;
    if (view && i === 0) return view.trunk;
    if (view && i > 0) return view.branches[i - 1]?.name ?? view.trunk;
    return trunk;
  }, [view, branch, trunk]);

  /**
   * On the trunk there is nothing to open a pull request FROM - it would merge
   * a branch into itself. Blocking the button says so before the dialog does,
   * rather than offering a form whose only outcome is a gh error.
   */
  const onTrunk = branch !== null && branch === (view?.trunk ?? trunk);

  const openRow = useCallback(
    (row: StackRow) =>
      row.pr
        ? void act(`Checkout #${row.pr.number}`, () => gh.checkoutPr(row.pr!.number))
        : void act(`Checkout ${row.name}`, () => gh.checkoutStackBranch(row.name)),
    [act, gh],
  );

  const busyAll = busy || running !== null;
  /** The blocked states are all fixed outside TEDI, so each one needs a way
   *  back in without making the user switch tabs to force a remount. */
  const retry = (
    <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
      <RefreshCw size={12} strokeWidth={2} />
      Check again
    </Button>
  );

  // Before the probe answers there is nothing to claim. Reading `installed`
  // off a null status would announce "gh is not installed" for as long as the
  // probe takes, on every machine that has it.
  if (status === null) {
    return <Notice text={error ?? "Reading pull requests…"} action={error ? retry : <Spinner />} />;
  }
  if (!status.installed) {
    return (
      <Notice
        text="The GitHub CLI (gh) is not installed. TEDI drives pull requests and stacks through it, so GitHub owns the credential and the rebase logic rather than TEDI holding a second copy."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void openUrl("https://cli.github.com")}
          >
            <ExternalLink size={12} strokeWidth={2} />
            Get the GitHub CLI
          </Button>
        }
      />
    );
  }
  if (!status.authenticated) {
    return (
      <Notice
        text="Not signed in to GitHub. Run `gh auth login` in a terminal, then check again."
        action={retry}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[10.5px] font-medium tracking-wide uppercase">
          {view ? `Stack on ${view.trunk}` : "Pull requests"}
        </span>
        {running ? <Spinner className="size-3" /> : null}
        <IconTooltip
          label={
            onTrunk
              ? `You are on ${branch}. Switch to a feature branch to open a pull request.`
              : "New pull request"
          }
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={() => setCreating(true)}
            disabled={busyAll || !branch || onTrunk}
            aria-label="New pull request"
          >
            <Plus size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        <IconTooltip label="Refresh" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={() => void load()}
            disabled={loading || busyAll}
            aria-label="Refresh pull requests"
          >
            <RefreshCw size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={busyAll}>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
              aria-label="Stack actions"
            >
              <MoreHorizontal size={13} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuLabel>Stack</DropdownMenuLabel>
            {!status.stackExtension ? (
              <DropdownMenuItem
                onSelect={() =>
                  void act(
                    "Install gh-stack",
                    () => gh.installStackExtension(),
                    "Installed GitHub's gh-stack extension.",
                  )
                }
              >
                <Layers size={12} strokeWidth={2} />
                Install the gh-stack extension
              </DropdownMenuItem>
            ) : !view ? (
              <DropdownMenuItem onSelect={() => setStackPrompt("init")}>
                <Layers size={12} strokeWidth={2} />
                Start a stack…
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => setStackPrompt("add")}>
                  <Plus size={12} strokeWidth={2} />
                  Add a branch on top…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void act("Submit stack", () => gh.submitStack(false), "Stack is up on GitHub.")
                  }
                >
                  <Upload size={12} strokeWidth={2} />
                  Submit for review
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void act("Submit stack", () => gh.submitStack(true))}
                >
                  <GitPullRequestDraft size={12} strokeWidth={2} />
                  Submit as drafts
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    void act("Sync stack", () => gh.syncStack(), "Stack rebased and pushed.")
                  }
                >
                  <RefreshCw size={12} strokeWidth={2} />
                  Sync (fetch, rebase, push)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setConfirmMerge(true)}>
                  <GitMerge size={12} strokeWidth={2} />
                  Merge the stack…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {error ? <div className="text-destructive px-3 pb-1 text-[11px]">{error}</div> : null}

      {rows.length === 0 && loose.length === 0 ? (
        <Notice
          text={
            status.stackExtension
              ? "No open pull requests. Open one from this branch, or start a stack to split a big change into a reviewable chain."
              : "No open pull requests. Install GitHub's gh-stack extension from the menu above to work with stacked pull requests."
          }
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="pb-1">
            {rows.map((row) => (
              <li key={row.name}>
                <div
                  className={cn(
                    "group/pr hover:bg-muted/50 flex min-h-7 items-center gap-1.5 px-2 py-1 text-[11.5px]",
                    row.isCurrent && "bg-muted/40",
                  )}
                >
                  {/* The stack drawn as gh prints it: top layer first, each
                      row connected to the one below, trunk closing it off. */}
                  <span className="text-muted-foreground/60 w-3 shrink-0 text-center">
                    {row.isCurrent ? "»" : "├"}
                  </span>
                  {rowIcon(row)}
                  <button
                    type="button"
                    className="hover:text-foreground min-w-0 flex-1 truncate text-left"
                    onClick={() => openRow(row)}
                    disabled={busyAll || row.isCurrent}
                    title={`${row.name} → ${row.parent}`}
                  >
                    <span className={cn("truncate", row.isCurrent && "font-medium")}>
                      {row.name}
                    </span>
                    {row.pr ? (
                      <span className="text-muted-foreground ml-1.5 tabular-nums">
                        #{row.pr.number}
                      </span>
                    ) : null}
                  </button>
                  {row.needsRebase ? (
                    <Badge variant="outline" className="text-warning h-4 px-1.5 text-[10px]">
                      rebase
                    </Badge>
                  ) : null}
                  {!row.pr ? (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                      local
                    </Badge>
                  ) : null}
                  {row.pr ? (
                    <IconTooltip label="Open on GitHub" side="left">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="hover:text-foreground size-5 opacity-0 transition-[color,opacity] group-hover/pr:opacity-100 focus-visible:opacity-100"
                        onClick={() => void openUrl(row.pr!.url)}
                        aria-label={`Open pull request ${row.pr.number} on GitHub`}
                      >
                        <ExternalLink size={11} strokeWidth={2} />
                      </Button>
                    </IconTooltip>
                  ) : null}
                </div>
              </li>
            ))}
            {view ? (
              <li className="text-muted-foreground flex min-h-7 items-center gap-1.5 px-2 py-1 text-[11.5px]">
                <span className="w-3 shrink-0 text-center opacity-60">└</span>
                <span className="truncate">{view.trunk}</span>
              </li>
            ) : null}

            {loose.length > 0 ? (
              <li className="text-muted-foreground bg-background sticky top-0 z-1 mt-1 flex min-h-7 items-center px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
                {view ? "Other pull requests" : "Open pull requests"}
              </li>
            ) : null}
            {loose.map((pr) => (
              <li key={pr.number}>
                <div className="group/pr hover:bg-muted/50 flex min-h-7 items-center gap-1.5 px-2 py-1 text-[11.5px]">
                  <span className="w-3 shrink-0" />
                  {pr.isDraft ? (
                    <GitPullRequestDraft
                      size={12}
                      strokeWidth={2}
                      className="text-muted-foreground"
                    />
                  ) : (
                    <GitPullRequest size={12} strokeWidth={2} className="text-icon-branch" />
                  )}
                  <button
                    type="button"
                    className="hover:text-foreground min-w-0 flex-1 truncate text-left"
                    onClick={() =>
                      void act(`Checkout #${pr.number}`, () => gh.checkoutPr(pr.number))
                    }
                    disabled={busyAll}
                    title={`${pr.headRefName} → ${pr.baseRefName}`}
                  >
                    <span className="text-muted-foreground tabular-nums">#{pr.number}</span>{" "}
                    {pr.title}
                  </button>
                  <IconTooltip label="Open on GitHub" side="left">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:text-foreground size-5 opacity-0 transition-[color,opacity] group-hover/pr:opacity-100 focus-visible:opacity-100"
                      onClick={() => void openUrl(pr.url)}
                      aria-label={`Open pull request ${pr.number} on GitHub`}
                    >
                      <ExternalLink size={11} strokeWidth={2} />
                    </Button>
                  </IconTooltip>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}

      <CreatePrDialog
        open={creating}
        onOpenChange={setCreating}
        head={branch ?? ""}
        defaultBase={defaultBase}
        loadBranches={loadBranches}
        onCreate={async (input) => {
          setCreating(false);
          await act(
            "Create pull request",
            async () => {
              // gh only opens the PR; the branch has to exist on the remote
              // first, and publishing it here reuses the panel's push path
              // rather than letting gh guess at a remote with no terminal to
              // ask on.
              await onPublish(input.head);
              const url = await gh.createPr(input);
              if (url) void openUrl(url);
            },
            "Pull request opened.",
          );
        }}
      />

      <StackBranchDialog
        mode={stackPrompt}
        onOpenChange={(o) => {
          if (!o) setStackPrompt(null);
        }}
        trunk={view?.trunk ?? trunk}
        top={rows[0]?.name ?? branch}
        onSubmit={(name) => {
          const mode = stackPrompt;
          setStackPrompt(null);
          if (!mode) return;
          void act(mode === "init" ? "Start stack" : "Add branch", () =>
            mode === "init" ? gh.initStack(name, trunk) : gh.addToStack(name),
          );
        }}
      />

      <AlertDialog open={confirmMerge} onOpenChange={setConfirmMerge}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge the whole stack?</AlertDialogTitle>
            <AlertDialogDescription>
              Merges every pull request in this stack into {view?.trunk ?? trunk}, bottom first.
              This publishes the change on GitHub and cannot be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void act("Merge stack", () => gh.mergeStack(), "Stack merged.")}
            >
              Merge stack
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
