import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Streamdown } from "streamdown";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { safeUrlTransform } from "@/lib/markdownSafety";
import { cn } from "@/lib/utils";
import {
  checkName,
  checkOutcome,
  checkUrl,
  friendlyGhError,
  mergeBlockReason,
  summarizeChecks,
  type GhOps,
  type MergeMethod,
  type PrDetail,
  type ReviewVerdict,
} from "./gh";
import { formatRelTime } from "./historyMeta";
import { patchLineKind, splitPatch, type PatchFile } from "./patch";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  MessageSquare,
  RefreshCw,
  Send,
  TriangleAlert,
  X,
} from "lucide-react";

type Props = {
  gh: GhOps;
  /** Which pull request. Passed by number so a reload always re-reads the one
   *  that was opened, never whatever branch gh would resolve on its own. */
  number: number;
  onBack: () => void;
  /** A checkout or a merge moves HEAD, so the panel's own status is stale. */
  onRefresh: () => void;
  /** True while a git write is in flight, so gh does not run on top of it. */
  busy?: boolean;
};

/**
 * Above this the patch is collapsed file by file on arrival. A review usually
 * starts by picking a file, and pouring 2,000 rows into the DOM before the user
 * has chosen one costs the whole panel its scroll performance for nothing.
 */
const AUTO_EXPAND_MAX_LINES = 1200;
/** Per file. Past this, reviewing in a sidebar has stopped being the right
 *  tool, so the rest is a link rather than 40,000 more rows. */
const MAX_FILE_LINES = 800;

const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  comment: "Comment",
};

const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** gh review states, in the words GitHub shows. */
const REVIEW_STATE_LABEL: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

function relTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatRelTime(Math.floor(ms / 1000)) : "";
}

/** Markdown from GitHub is third-party text, so every instance here goes
 *  through the shared URL sanitizer rather than Streamdown's own defaults. */
function Body({ text }: { text: string }) {
  if (!text.trim()) {
    return <p className="text-muted-foreground text-[11px] italic">No description.</p>;
  }
  return (
    <div className="text-[11.5px] leading-relaxed break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Streamdown urlTransform={safeUrlTransform}>{text}</Streamdown>
    </div>
  );
}

function CheckDot({ outcome }: { outcome: ReturnType<typeof checkOutcome> }) {
  const cls =
    outcome === "success"
      ? "text-icon-done"
      : outcome === "failure"
        ? "text-destructive"
        : outcome === "pending"
          ? "text-icon-working"
          : "text-muted-foreground";
  if (outcome === "success") return <Check size={11} strokeWidth={2.5} className={cls} />;
  if (outcome === "failure") return <X size={11} strokeWidth={2.5} className={cls} />;
  return <CircleDot size={11} strokeWidth={2} className={cls} />;
}

/** One file of the patch: a clickable header and, when open, its hunk lines. */
function PatchFileBlock({
  file,
  open,
  onToggle,
}: {
  file: PatchFile;
  open: boolean;
  onToggle: () => void;
}) {
  const shown = open ? file.lines.slice(0, MAX_FILE_LINES) : [];
  const hidden = file.lines.length - shown.length;
  return (
    <div className="border-border/60 border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-muted/50 flex min-h-7 w-full items-center gap-1.5 px-2 py-1 text-left text-[11.5px]"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} strokeWidth={2} className="text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight size={12} strokeWidth={2} className="text-muted-foreground shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate" title={file.oldPath ?? file.path}>
          {file.oldPath ? <span className="text-muted-foreground">{file.oldPath} → </span> : null}
          {file.path}
        </span>
        {file.binary ? (
          <span className="text-muted-foreground shrink-0 text-[10px]">binary</span>
        ) : (
          <span className="shrink-0 text-[10px] tabular-nums">
            <span className="text-icon-done">+{file.additions}</span>{" "}
            <span className="text-destructive">-{file.deletions}</span>
          </span>
        )}
      </button>
      {open ? (
        <div className="overflow-x-auto">
          <pre className="min-w-full font-mono text-[10.5px] leading-[1.45]">
            {shown.map((line, i) => {
              const kind = patchLineKind(line);
              return (
                <div
                  key={i}
                  className={cn(
                    "px-2 whitespace-pre",
                    kind === "add" && "bg-icon-done/10 text-icon-done",
                    kind === "del" && "bg-destructive/10 text-destructive",
                    kind === "hunk" && "text-muted-foreground bg-muted/40",
                    kind === "meta" && "text-muted-foreground/70 italic",
                  )}
                >
                  {line || " "}
                </div>
              );
            })}
          </pre>
          {hidden > 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-[10.5px]">
              {hidden.toLocaleString()} more lines not shown. Open the pull request on GitHub to
              read the whole file.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function PrReviewView({ gh, number, onBack, onRefresh, busy }: Props) {
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [patch, setPatch] = useState<string>("");
  const [patchError, setPatchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"diff" | "conversation">("diff");
  const [running, setRunning] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());
  /** Non-null while the review form is open; the verdict picks the gh flag. */
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(null);
  const [reviewBody, setReviewBody] = useState("");
  /** Non-null while the merge confirmation is open. */
  const [mergeMethod, setMergeMethod] = useState<MergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  // Replies for a pull request the user has already navigated away from are
  // dropped rather than applied, the same guard the list view uses.
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    try {
      // The patch is a second subprocess and it is the one that can be huge or
      // refused, so a failure there must not blank the detail that worked.
      const [detail, diff] = await Promise.allSettled([gh.prDetail(number), gh.prDiff(number)]);
      if (reqRef.current !== req) return;
      if (detail.status === "fulfilled") {
        setPr(detail.value);
        setError(null);
      } else {
        setError(friendlyGhError(detail.reason));
      }
      setPatch(diff.status === "fulfilled" ? diff.value : "");
      setPatchError(diff.status === "rejected" ? friendlyGhError(diff.reason) : null);
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [gh, number]);

  useEffect(() => {
    void load();
  }, [load]);

  const files = useMemo(() => splitPatch(patch), [patch]);
  const totalPatchLines = useMemo(() => files.reduce((n, f) => n + f.lines.length, 0), [files]);

  // Small patch: open every file, which is how a review of a few lines reads.
  // Large one: leave them closed and let the user pick. Re-derived when the
  // patch changes rather than merged, so a refresh cannot leave a stale path
  // expanded.
  useEffect(() => {
    setOpenFiles(
      totalPatchLines > 0 && totalPatchLines <= AUTO_EXPAND_MAX_LINES
        ? new Set(files.map((f) => f.path))
        : new Set(),
    );
  }, [files, totalPatchLines]);

  const toggleFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const act = useCallback(
    async (label: string, fn: () => Promise<void>, done?: string) => {
      if (running || busy) return;
      setRunning(label);
      try {
        await fn();
        toast(done ?? `${label} finished.`, { variant: "success" });
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

  const checks = useMemo(() => summarizeChecks(pr?.statusCheckRollup), [pr]);
  const blocked = pr ? mergeBlockReason(pr) : "Loading…";
  const busyAll = busy || running !== null;

  /**
   * The conversation, oldest first: the description is the first message, and
   * reviews and comments are two separate gh arrays that only read as a thread
   * once they are interleaved by time.
   */
  const timeline = useMemo(() => {
    if (!pr) return [];
    const items = [
      ...pr.reviews.map((r) => ({
        kind: "review" as const,
        at: Date.parse(r.submittedAt) || 0,
        login: r.author?.login ?? "someone",
        body: r.body,
        state: r.state,
        iso: r.submittedAt,
      })),
      ...pr.comments.map((c) => ({
        kind: "comment" as const,
        at: Date.parse(c.createdAt) || 0,
        login: c.author?.login ?? "someone",
        body: c.body,
        state: "",
        iso: c.createdAt,
      })),
    ];
    // A review with no body and no verdict says nothing; GitHub does not show
    // one either. An APPROVED with an empty body is still an event worth a row.
    return items
      .filter((i) => i.body.trim() || (i.kind === "review" && i.state !== "COMMENTED"))
      .sort((a, b) => a.at - b.at);
  }, [pr]);

  if (loading && !pr) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center gap-2 text-[11px]">
        <Spinner className="size-3" />
        Reading pull request #{number}…
      </div>
    );
  }

  if (!pr) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-muted-foreground max-w-[36ch] text-[11px] leading-relaxed">
          {error ?? `Could not read pull request #${number}.`}
        </p>
        <Button size="sm" variant="outline" onClick={onBack}>
          <ArrowLeft size={12} strokeWidth={2} />
          Back to the list
        </Button>
      </div>
    );
  }

  const StateIcon = pr.isDraft
    ? GitPullRequestDraft
    : pr.state === "MERGED"
      ? GitMerge
      : GitPullRequest;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex h-8 shrink-0 items-center gap-1 px-1.5">
        <IconTooltip label="Back to the list" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={onBack}
            aria-label="Back to the pull request list"
          >
            <ArrowLeft size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        <StateIcon
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0",
            pr.state === "MERGED"
              ? "text-icon-branch"
              : pr.isDraft
                ? "text-muted-foreground"
                : "text-icon-done",
          )}
        />
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          #{pr.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" title={pr.title}>
          {pr.title}
        </span>
        {running ? <Spinner className="size-3" /> : null}
        <IconTooltip label="Refresh" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={() => void load()}
            disabled={loading || busyAll}
            aria-label="Refresh this pull request"
          >
            <RefreshCw size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
        <IconTooltip label="Open on GitHub" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={() => void openUrl(pr.url)}
            aria-label="Open this pull request on GitHub"
          >
            <ExternalLink size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      </div>

      {/* Meta strip */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pb-1.5 text-[10.5px]">
        <span className="truncate">
          {pr.author?.login ? `@${pr.author.login}` : "unknown author"}
          {pr.createdAt ? ` · ${relTime(pr.createdAt)}` : ""}
        </span>
        <span className="truncate" title={`${pr.headRefName} into ${pr.baseRefName}`}>
          {pr.headRefName} → {pr.baseRefName}
        </span>
        <span className="tabular-nums">
          <span className="text-icon-done">+{pr.additions}</span>{" "}
          <span className="text-destructive">-{pr.deletions}</span> in {pr.changedFiles}{" "}
          {pr.changedFiles === 1 ? "file" : "files"}
        </span>
        {pr.reviewDecision ? (
          <Badge
            variant={pr.reviewDecision === "APPROVED" ? "default" : "outline"}
            className={cn(
              "h-4 px-1.5 text-[10px]",
              pr.reviewDecision === "CHANGES_REQUESTED" && "text-destructive",
            )}
          >
            {pr.reviewDecision === "APPROVED"
              ? "approved"
              : pr.reviewDecision === "CHANGES_REQUESTED"
                ? "changes requested"
                : "review required"}
          </Badge>
        ) : null}
        {checks.state !== "none" ? (
          <span className="inline-flex items-center gap-1">
            <CheckDot outcome={checks.state} />
            {checks.failed > 0
              ? `${checks.failed} failing`
              : checks.pending > 0
                ? `${checks.pending} running`
                : `${checks.passed} checks passed`}
          </span>
        ) : null}
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-2 mb-1 h-6 shrink-0">
          <TabsTrigger value="diff" className="h-5 gap-1 px-2 text-[11px]">
            <FileDiff size={11} strokeWidth={2} />
            Files
          </TabsTrigger>
          <TabsTrigger value="conversation" className="h-5 gap-1 px-2 text-[11px]">
            <MessageSquare size={11} strokeWidth={2} />
            Conversation
            {timeline.length > 0 ? (
              <span className="tabular-nums opacity-70">{timeline.length}</span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        {/* Radix unmounts the panel that is not selected, so the patch rows
            leave the DOM whenever the conversation is on screen. */}
        <TabsContent value="diff" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            {patchError ? (
              <p className="text-muted-foreground px-2.5 py-2 text-[11px] leading-relaxed">
                {patchError}
              </p>
            ) : files.length === 0 ? (
              <p className="text-muted-foreground px-2.5 py-2 text-[11px]">
                {loading ? "Reading the patch…" : "This pull request changes nothing."}
              </p>
            ) : (
              <div>
                {files.map((f) => (
                  <PatchFileBlock
                    key={f.path}
                    file={f}
                    open={openFiles.has(f.path)}
                    onToggle={() => toggleFile(f.path)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="conversation" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 px-2.5 py-1.5">
              <section>
                <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                  Description
                </p>
                <Body text={pr.body} />
              </section>

              {checks.total > 0 ? (
                <section>
                  <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                    Checks
                  </p>
                  <ul className="flex flex-col">
                    {(pr.statusCheckRollup ?? []).map((c, i) => {
                      const url = checkUrl(c);
                      return (
                        <li
                          key={`${checkName(c)}-${i}`}
                          className="flex min-h-5 items-center gap-1.5 text-[11px]"
                        >
                          <CheckDot outcome={checkOutcome(c)} />
                          {url ? (
                            <button
                              type="button"
                              className="hover:text-foreground min-w-0 flex-1 truncate text-left"
                              onClick={() => void openUrl(url)}
                            >
                              {checkName(c)}
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1 truncate">{checkName(c)}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              <section>
                <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                  Conversation
                </p>
                {timeline.length === 0 ? (
                  <p className="text-muted-foreground text-[11px] italic">
                    No reviews or comments yet.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2.5">
                    {timeline.map((item, i) => (
                      <li key={`${item.kind}-${item.at}-${i}`} className="flex flex-col gap-0.5">
                        <p className="text-muted-foreground flex items-center gap-1.5 text-[10.5px]">
                          <span className="text-foreground/80 font-medium">@{item.login}</span>
                          {item.kind === "review" ? (
                            <span
                              className={cn(
                                item.state === "APPROVED" && "text-icon-done",
                                item.state === "CHANGES_REQUESTED" && "text-destructive",
                              )}
                            >
                              {REVIEW_STATE_LABEL[item.state] ?? item.state.toLowerCase()}
                            </span>
                          ) : null}
                          <span className="opacity-70">{relTime(item.iso)}</span>
                        </p>
                        {item.body.trim() ? <Body text={item.body} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* The one thing this view cannot do, said once and plainly
                  rather than by silently omitting it. */}
              <p className="text-muted-foreground/70 text-[10px] leading-relaxed">
                Comments pinned to a line live only in GitHub&apos;s API, which TEDI does not hold a
                key for. Open the pull request on GitHub to read or write those.
              </p>
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Actions */}
      <div className="border-border/60 flex shrink-0 flex-col gap-1 border-t px-2 py-1.5">
        {/* Said in the open, not in a tooltip: the Button base class carries
            `disabled:pointer-events-none`, so a tooltip on the disabled Merge
            trigger can never fire - which is precisely when its reason is the
            thing worth reading. */}
        {blocked && pr.state === "OPEN" ? (
          <p className="text-muted-foreground text-[10.5px] leading-snug">{blocked}</p>
        ) : null}
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busyAll || pr.state !== "OPEN"}>
              <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]">
                <Send size={11} strokeWidth={2} />
                Review
                <ChevronDown size={11} strokeWidth={2} className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuLabel>Submit a review</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => {
                  setReviewBody("");
                  setVerdict("approve");
                }}
              >
                <CheckCheck size={12} strokeWidth={2} className="text-icon-done" />
                Approve
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setReviewBody("");
                  setVerdict("request-changes");
                }}
              >
                <TriangleAlert size={12} strokeWidth={2} className="text-destructive" />
                Request changes…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setReviewBody("");
                  setVerdict("comment");
                }}
              >
                <MessageSquare size={12} strokeWidth={2} />
                Comment…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            {/* `DropdownMenuTrigger asChild` hands its props to its child, and
              IconTooltip takes only label/side/children and forwards nothing -
              wrapping the Button in it swallows every trigger prop and the menu
              never opens. Radix triggers DO compose with each other, so the
              tooltip goes on the OUTSIDE. */}
            <IconTooltip label="Merge this pull request" side="top">
              <DropdownMenuTrigger asChild disabled={busyAll || blocked !== null}>
                <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]">
                  <GitMerge size={11} strokeWidth={2} />
                  Merge
                  <ChevronDown size={11} strokeWidth={2} className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
            </IconTooltip>
            <DropdownMenuContent align="start" className="min-w-52">
              <DropdownMenuLabel>Merge method</DropdownMenuLabel>
              {(Object.keys(MERGE_LABEL) as MergeMethod[]).map((m) => (
                <DropdownMenuItem key={m} onSelect={() => setMergeMethod(m)}>
                  <GitMerge size={12} strokeWidth={2} />
                  {MERGE_LABEL[m]}…
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex-1" />

          {pr.isDraft ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busyAll}
              onClick={() =>
                void act("Mark ready", () => gh.markReady(pr.number), "Marked ready for review.")
              }
            >
              Ready for review
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={busyAll}
            onClick={() => void act(`Checkout #${pr.number}`, () => gh.checkoutPr(pr.number))}
          >
            Check out
          </Button>
        </div>
      </div>

      {/* Review form. `approve` is the one verdict GitHub accepts with no body,
          so it is the only one whose submit stays enabled while empty. */}
      <Dialog
        open={verdict !== null}
        onOpenChange={(o) => {
          if (!o) setVerdict(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {verdict ? VERDICT_LABEL[verdict] : ""} #{pr.number}
            </DialogTitle>
            <DialogDescription>
              {verdict === "approve"
                ? "Approve this pull request. A message is optional."
                : "GitHub requires a message for this review."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reviewBody}
            onChange={(e) => setReviewBody(e.target.value)}
            placeholder={verdict === "approve" ? "Optional message" : "What needs to change?"}
            className="min-h-28 text-[12px]"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVerdict(null)}>
              Cancel
            </Button>
            <Button
              disabled={verdict !== "approve" && !reviewBody.trim()}
              onClick={() => {
                const v = verdict;
                setVerdict(null);
                if (!v) return;
                void act(
                  VERDICT_LABEL[v],
                  () => gh.reviewPr(pr.number, v, reviewBody),
                  "Review submitted.",
                );
              }}
            >
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={mergeMethod !== null}
        onOpenChange={(o) => {
          if (!o) setMergeMethod(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {mergeMethod ? MERGE_LABEL[mergeMethod] : ""} #{pr.number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Merges {pr.headRefName} into {pr.baseRefName} on GitHub. This publishes the change and
              cannot be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-[12px]">
            <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} />
            Delete {pr.headRefName} after merging
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const m = mergeMethod;
                setMergeMethod(null);
                if (!m) return;
                void act(
                  MERGE_LABEL[m],
                  () => gh.mergePr(pr.number, m, deleteBranch),
                  "Pull request merged.",
                );
              }}
            >
              Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
