import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Clock, GitCommitHorizontal, GitMerge, Hash, User } from "lucide-react";
import { gitLog } from "./api";
import {
  authorHue,
  dayKey,
  dayLabel,
  formatAbsTime,
  formatClock,
  formatRelTime,
  githubAvatar,
  initials,
  parseRefs,
} from "./historyMeta";
import { MetaPill, RefBadge } from "./components/RefBadge";
import { CommitDetailPane, type CommitAction } from "./CommitDetailPane";
import type { OpenDiffInput } from "./types";
import type { GitCommit } from "./types";

type Props = {
  rootPath: string | null;
  isRepo: boolean;
  /** Bump this number to force a refetch (e.g. after commit/push). */
  refreshToken?: number;
  /** Open a per-commit file diff in a tab (from the detail card). When
   *  omitted, the detail card lists changed files read-only. */
  onOpenDiff?: (input: OpenDiffInput) => void;
  /**
   * Where the commit detail card anchors. "row" pins it to the clicked row
   * (side panel); "mouse" floats it at the cursor (the spacious tab view).
   */
  anchorMode?: "row" | "mouse";
  /** Acts on the commit shown in the detail card (revert, cherry-pick, reset,
   *  branch, tag). Omitted leaves the card read-only. */
  onCommitAction?: (action: CommitAction, sha: string, shortSha: string) => void;
};

const ROW_H = 28;
const LANE_W = 14;
const DOT_R = 4;
const LANE_PAD_X = 8;
/** Height of a day separator. The lanes are redrawn across it so the graph
 *  stays one continuous tree instead of breaking at every date. */
const DAY_H = 24;
/** Ref chips past this many collapse into a `+N` pill. Without a cap the HEAD
 *  commit (HEAD + branch + tag + remote) took 60% of the row and squeezed the
 *  commit subject to literally zero width. */
const MAX_CHIPS = 3;
// Beyond this many concurrent lanes the graph would eat the subject/time
// columns (there's no horizontal scrollbar), so lanes compress toward
// MIN_LANE_W. Keeps a busy history readable instead of shoving text off-screen.
const COMFORTABLE_LANES = 6;
const MIN_LANE_W = 9;

/** Lane pixel width for a given lane count: full width until it gets crowded,
 *  then squeezed so the graph column stays compact. */
function laneWidthFor(laneCount: number): number {
  if (laneCount <= COMFORTABLE_LANES) return LANE_W;
  return Math.max(MIN_LANE_W, Math.round((COMFORTABLE_LANES * LANE_W) / laneCount));
}

/** Stable color per lane index. Pulls from the themed ANSI palette so each
 * preset (Solarized, Monokai, etc.) tints branches in its own palette while
 * keeping the 8 lanes visually distinct from one another. */
const LANE_COLOR_VARS = [
  "var(--tedi-ansi-bright-blue)",
  "var(--tedi-ansi-bright-green)",
  "var(--tedi-ansi-bright-yellow)",
  "var(--tedi-ansi-bright-magenta)",
  "var(--tedi-ansi-bright-cyan)",
  "var(--tedi-ansi-bright-red)",
  "var(--tedi-ansi-cyan)",
  "var(--tedi-ansi-yellow)",
];

function laneColor(lane: number): string {
  return LANE_COLOR_VARS[lane % LANE_COLOR_VARS.length];
}

type LaidOut = {
  commit: GitCommit;
  /** Lane index for this commit's dot. */
  lane: number;
  /** Snapshot of "active SHA per lane" BEFORE this row was processed. */
  laneIn: (string | null)[];
  /** Snapshot AFTER this row was processed. */
  laneOut: (string | null)[];
  /** Lanes newly opened for extra parents (merge commits with 2+ parents). */
  branchedLanes: number[];
};

/**
 * Greedy top-down lane assignment. Walks commits in display order (newest
 * first) keeping `active`: the SHA each lane is "waiting for". A commit either
 * occupies an existing lane that was expecting it, or starts a fresh one. Its
 * first parent reuses the lane; extra parents (merges) open new lanes.
 */
function layoutCommits(commits: GitCommit[]): { rows: LaidOut[]; laneCount: number } {
  const active: (string | null)[] = [];
  const rows: LaidOut[] = [];
  let laneCount = 0;

  const firstNullSlot = (): number => {
    for (let i = 0; i < active.length; i++) if (active[i] === null) return i;
    active.push(null);
    return active.length - 1;
  };

  for (const c of commits) {
    const laneIn = [...active];

    let myLane = active.findIndex((s) => s === c.sha);
    if (myLane === -1) {
      myLane = firstNullSlot();
    } else {
      for (let i = 0; i < active.length; i++) {
        if (i !== myLane && active[i] === c.sha) active[i] = null;
      }
    }

    active[myLane] = c.parents[0] ?? null;

    const branchedLanes: number[] = [];
    for (let i = 1; i < c.parents.length; i++) {
      const slot = firstNullSlot();
      active[slot] = c.parents[i];
      branchedLanes.push(slot);
    }

    while (active.length > 0 && active[active.length - 1] === null) {
      active.pop();
    }

    laneCount = Math.max(laneCount, laneIn.length, active.length, myLane + 1);
    rows.push({
      commit: c,
      lane: myLane,
      laneIn,
      laneOut: [...active],
      branchedLanes,
    });
  }

  return { rows, laneCount };
}

function laneX(lane: number, laneW: number): number {
  return LANE_PAD_X + lane * laneW;
}

export function GitGraphView({
  rootPath,
  isRepo,
  refreshToken = 0,
  onOpenDiff,
  anchorMode = "row",
  onCommitAction,
}: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The open detail carries the repo root it was opened under (so a workspace
  // switch invalidates it synchronously during render, no stale fetch) and,
  // in "mouse" mode, the viewport point to float the card at.
  const [open, setOpen] = useState<{
    root: string;
    sha: string;
    point?: { x: number; y: number };
  } | null>(null);
  const openSha = open && open.root === rootPath ? open.sha : null;
  const toggle = useCallback(
    (sha: string, point?: { x: number; y: number }) => {
      setOpen((cur) =>
        cur && cur.sha === sha && cur.root === rootPath
          ? null
          : rootPath
            ? { root: rootPath, sha, point }
            : null,
      );
    },
    [rootPath],
  );
  const handleOpenDiff = useCallback(
    (input: OpenDiffInput) => {
      onOpenDiff?.(input);
      // Opening a diff switches tabs; close the floating popover so it doesn't
      // linger (it is portaled to the body and would otherwise stay visible).
      setOpen(null);
    },
    [onOpenDiff],
  );
  const rootRef = useRef(rootPath);

  useEffect(() => {
    rootRef.current = rootPath;
  }, [rootPath]);

  const fetchLog = useCallback(async () => {
    const cur = rootRef.current;
    if (!cur || !isRepo) {
      setCommits([]);
      return;
    }
    setLoading(true);
    try {
      const list = await gitLog(cur, 500);
      if (rootRef.current === cur) {
        setCommits(list);
        setError(null);
        // Drop the open detail card if its commit is no longer in history
        // (e.g. amend/rebase/reset from a terminal then a refresh) so we don't
        // leave a frozen card fetching a missing SHA.
        setOpen((o) => (o && list.some((c) => c.sha === o.sha) ? o : null));
      }
    } catch (e) {
      if (rootRef.current === cur) {
        setError(String(e));
        setCommits([]);
      }
    } finally {
      // Don't clear a newer fetch's spinner: only the latest root's run owns it.
      if (rootRef.current === cur) setLoading(false);
    }
  }, [isRepo]);

  useEffect(() => {
    void fetchLog();
  }, [fetchLog, rootPath, refreshToken]);

  const { rows, laneCount } = useMemo(() => layoutCommits(commits), [commits]);

  /**
   * Rows with a day separator inserted whenever the date changes. Each
   * separator carries the `laneIn` of the row below it - the lane state
   * immediately above that row - so the graph can be drawn straight through
   * the gap and the tree reads as continuous.
   */
  const items = useMemo(() => {
    const out: (
      | { kind: "day"; key: string; label: string; lanes: (string | null)[] }
      | { kind: "row"; row: LaidOut }
    )[] = [];
    const now = new Date();
    let last = "";
    for (const row of rows) {
      const key = dayKey(row.commit.authorTime);
      if (key !== last) {
        last = key;
        out.push({
          kind: "day",
          key,
          label: dayLabel(row.commit.authorTime, now),
          lanes: row.laneIn,
        });
      }
      out.push({ kind: "row", row });
    }
    return out;
  }, [rows]);

  if (!rootPath) return null;
  if (!isRepo) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px]">
        Not a git repository.
      </div>
    );
  }
  if (loading && commits.length === 0) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center gap-2 px-3 text-center text-[11px]">
        <Spinner className="size-3" />
        Loading history…
      </div>
    );
  }
  if (error) {
    return <div className="text-destructive px-3 py-2 text-[11px]">{error}</div>;
  }
  if (commits.length === 0) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[11px]">
        No commits yet.
      </div>
    );
  }

  const laneW = laneWidthFor(laneCount);
  // Shrink the dot alongside the lane so compressed lanes don't overlap.
  const dotR = Math.min(DOT_R, laneW / 2 - 1);
  const graphWidth = LANE_PAD_X * 2 + Math.max(1, laneCount) * laneW;

  return (
    <Popover
      open={openSha !== null}
      onOpenChange={(o) => {
        if (!o) setOpen(null);
      }}
    >
      <ScrollArea className="min-h-0 flex-1">
        {/* @container: rows drop the author/sha columns as the sidebar narrows
            (see GraphRow) so the history stays legible at any width. */}
        <ul className="@container py-0.5">
          {items.map((item) =>
            item.kind === "day" ? (
              <DaySeparator
                key={`day-${item.key}`}
                label={item.label}
                lanes={item.lanes}
                graphWidth={graphWidth}
                laneW={laneW}
              />
            ) : (
              <GraphRow
                key={item.row.commit.sha}
                row={item.row}
                graphWidth={graphWidth}
                laneW={laneW}
                dotR={dotR}
                selected={openSha === item.row.commit.sha}
                anchorMode={anchorMode}
                onSelect={(point) => toggle(item.row.commit.sha, point)}
              />
            ),
          )}
        </ul>
      </ScrollArea>
      {/* "mouse" mode anchors the card to a 0-size element pinned at the
          cursor point where the commit was clicked. */}
      {anchorMode === "mouse" && openSha && open?.point ? (
        <PopoverAnchor asChild>
          <div
            aria-hidden
            style={{
              position: "fixed",
              left: open.point.x,
              top: open.point.y,
              width: 0,
              height: 0,
            }}
          />
        </PopoverAnchor>
      ) : null}
      {openSha && rootPath ? (
        <PopoverContent
          side="right"
          align="start"
          collisionPadding={8}
          className="w-[min(88vw,460px)] gap-0 overflow-hidden rounded-xl p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // A click on another commit row is handled by that row's own
            // toggle; don't also let the dismissable layer fire (it would
            // race the toggle into a close/reopen flicker).
            const target = e.target as HTMLElement | null;
            if (target?.closest("[data-scm-commit-row]")) e.preventDefault();
          }}
        >
          <CommitDetailPane
            repoPath={rootPath}
            sha={openSha}
            onOpenDiff={onOpenDiff ? handleOpenDiff : undefined}
            onAction={
              onCommitAction
                ? (action, sha, shortSha) => {
                    // Close the card first: every action changes HEAD or the
                    // ref list, so leaving it open would show a stale commit
                    // over a history that has already moved.
                    setOpen(null);
                    onCommitAction(action, sha, shortSha);
                  }
                : undefined
            }
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/**
 * Date heading between two days of commits.
 *
 * The lane lines are redrawn across its full height so the graph never breaks:
 * a bare header row would leave a gap in every branch line and the tree would
 * read as a stack of disconnected fragments. Deliberately not `sticky` - a
 * pinned heading would keep showing lanes from the row it was built for while
 * hovering over rows with a different lane layout.
 */
function DaySeparator({
  label,
  lanes,
  graphWidth,
  laneW,
}: {
  label: string;
  lanes: (string | null)[];
  graphWidth: number;
  laneW: number;
}) {
  return (
    <li className="flex items-center pr-4 select-none">
      <div className="shrink-0" style={{ width: graphWidth, height: DAY_H }}>
        <svg
          width={graphWidth}
          height={DAY_H}
          viewBox={`0 0 ${graphWidth} ${DAY_H}`}
          className="block"
        >
          {lanes.map((sha, i) =>
            sha ? (
              <line
                key={i}
                x1={laneX(i, laneW)}
                y1={0}
                x2={laneX(i, laneW)}
                y2={DAY_H}
                stroke={laneColor(i)}
                strokeWidth={1.4}
              />
            ) : null,
          )}
        </svg>
      </div>
      <span className="text-muted-foreground/80 shrink-0 pr-2 text-[10px] font-medium tracking-wide uppercase">
        {label}
      </span>
      {/* Hairline to the right edge, so the date reads as a divider rather than
          as a very short commit subject. */}
      <span className="bg-border/60 h-px min-w-0 flex-1" aria-hidden />
    </li>
  );
}

type RowProps = {
  row: LaidOut;
  graphWidth: number;
  /** Pixel width per lane for this render (compressed when many lanes). */
  laneW: number;
  /** Dot radius for this render (shrinks with laneW). */
  dotR: number;
  selected: boolean;
  anchorMode: "row" | "mouse";
  /** Receives the viewport point of the activating event (used in mouse mode). */
  onSelect: (point: { x: number; y: number }) => void;
};

function GraphRow({ row, graphWidth, laneW, dotR, selected, anchorMode, onSelect }: RowProps) {
  const { commit, lane, laneIn, laneOut, branchedLanes } = row;
  const midY = ROW_H / 2;
  const myX = laneX(lane, laneW);
  const refChips = useMemo(() => parseRefs(commit.refs), [commit.refs]);
  // One URL per author, so 500 rows share a handful of cache entries; `lazy`
  // keeps the off-screen ones from being requested at all.
  const avatar = useMemo(() => githubAvatar(commit.authorEmail), [commit.authorEmail]);
  const isHead = refChips.some((c) => c.kind === "head");
  const isMerge = commit.parents.length > 1;

  // Build SVG segments. Top half = incoming lines (above the dot), bottom
  // half = outgoing lines (below the dot). Lanes that pass through unchanged
  // get a full-height vertical line.
  const segments: ReactNode[] = [];
  const maxLanes = Math.max(laneIn.length, laneOut.length, lane + 1);
  const branchedLanesSet = new Set(branchedLanes);

  for (let i = 0; i < maxLanes; i++) {
    const x = laneX(i, laneW);
    const inSha = laneIn[i] ?? null;
    const outSha = laneOut[i] ?? null;

    // Pass-through lane: same active SHA above and below, untouched by this row.
    if (i !== lane && inSha !== null && inSha === outSha) {
      segments.push(
        <line
          key={`thru-${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={ROW_H}
          stroke={laneColor(i)}
          strokeWidth={1.4}
        />,
      );
      continue;
    }

    // Lane merging into the commit (was waiting for this SHA, but lives in a
    // different column). Draw an L from above into the dot.
    if (i !== lane && inSha === commit.sha) {
      segments.push(
        <path
          key={`merge-${i}`}
          d={`M ${x} 0 L ${x} ${midY - 4} Q ${x} ${midY} ${x + (myX - x) / Math.abs(myX - x || 1)} ${midY} L ${myX} ${midY}`}
          stroke={laneColor(i)}
          strokeWidth={1.4}
          fill="none"
        />,
      );
      continue;
    }

    // Lane that holds the commit dot. May have an incoming line from above
    // (the lane was already active waiting for this SHA) and/or an outgoing
    // line below (its first parent extends down in the same column).
    if (i === lane) {
      if (inSha === commit.sha) {
        segments.push(
          <line
            key={`dot-in`}
            x1={myX}
            y1={0}
            x2={myX}
            y2={midY}
            stroke={laneColor(lane)}
            strokeWidth={1.4}
          />,
        );
      }
      if (outSha !== null) {
        segments.push(
          <line
            key={`dot-out`}
            x1={myX}
            y1={midY}
            x2={myX}
            y2={ROW_H}
            stroke={laneColor(lane)}
            strokeWidth={1.4}
          />,
        );
      }
      continue;
    }

    // A new lane opened below for an extra parent: draw an L from the dot
    // out into that lane.
    if (branchedLanesSet.has(i) && outSha !== null) {
      segments.push(
        <path
          key={`branch-${i}`}
          d={`M ${myX} ${midY} L ${x - (x - myX) / Math.abs(x - myX || 1)} ${midY} Q ${x} ${midY} ${x} ${midY + 4} L ${x} ${ROW_H}`}
          stroke={laneColor(i)}
          strokeWidth={1.4}
          fill="none"
        />,
      );
    }
  }

  const rowEl = (
    <div
      data-scm-commit-row=""
      className={cn(
        // pr-4 keeps the last column clear of the Radix ScrollArea's 10px
        // overlay thumb (pr-3 left only ~2px and the time read as covered).
        "group hover:bg-accent/40 flex cursor-pointer items-stretch pr-4",
        selected && "bg-accent/60",
      )}
      // Pinned, not "however tall the content turns out": the SVG beside it
      // draws exactly ROW_H of lane line, so anything that grows the text
      // column (a wrapping ref chip did) opens a gap in every branch line.
      style={{ height: ROW_H }}
      role="button"
      tabIndex={0}
      onClick={(e) => onSelect({ x: e.clientX, y: e.clientY })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onSelect({ x: r.right, y: r.top });
        }
      }}
    >
      <div className="shrink-0" style={{ width: graphWidth, height: ROW_H }}>
        <svg
          width={graphWidth}
          height={ROW_H}
          viewBox={`0 0 ${graphWidth} ${ROW_H}`}
          className="block"
        >
          {segments}
          {/* The checked-out commit gets a halo so "where am I" is answerable
              without reading the badges. Kept tight (+1.5, not +2.5): at
              LANE_PAD_X=8 the wider ring left under a pixel of air and read as
              touching the panel edge. */}
          {isHead ? (
            <circle
              cx={myX}
              cy={midY}
              r={dotR + 1.5}
              fill="none"
              stroke={laneColor(lane)}
              strokeWidth={1.1}
              opacity={0.45}
            />
          ) : null}
          {/* Hollow for a merge, solid otherwise - the same convention every
              other git UI uses, and it tells the two apart at a glance where
              previously every dot looked identical. The background-coloured
              stroke on a normal dot punches it out of lines crossing behind. */}
          <circle
            cx={myX}
            cy={midY}
            r={dotR}
            fill={isMerge ? "var(--background)" : laneColor(lane)}
            stroke={isMerge ? laneColor(lane) : "var(--background)"}
            strokeWidth={1.6}
          />
        </svg>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
        {/* Capped and allowed to shrink. Both matter: the cap keeps a
            heavily-tagged commit from filling the row, and dropping `shrink-0`
            is what stops the chips squeezing the subject out of existence.
            Gone entirely below 22rem: three chips sharing 45% of a narrow row
            render as unreadable two-pixel slivers ("HE…", "m…", "v0…") AND
            leave the subject one character wide. Measured, not guessed - 19rem
            was tried first and the HEAD row was still slivers at 310px. The
            hover peek still lists every ref, and the HEAD halo on the dot
            still answers "where am I". */}
        {refChips.length > 0 ? (
          <span className="hidden max-w-[45%] min-w-0 shrink items-center gap-1 overflow-hidden @[22rem]:flex">
            {refChips.slice(0, MAX_CHIPS).map((chip, i) => (
              <RefBadge key={`${chip.kind}-${chip.label}-${i}`} chip={chip} maxW="max-w-24" />
            ))}
            {refChips.length > MAX_CHIPS ? (
              // `shrink-0`: the count is the whole message, and MetaPill's
              // `min-w-0` would otherwise let a crowded row clip it to "+".
              <MetaPill tone="bg-muted text-muted-foreground border-border shrink-0">
                +{refChips.length - MAX_CHIPS}
              </MetaPill>
            ) : null}
          </span>
        ) : null}
        <span className="text-foreground/90 min-w-0 flex-1 truncate text-[11.5px]">
          {commit.subject}
        </span>
        {/* The author's picture when the email names a public account, over a
            coloured initial when it doesn't - one glyph either way, rather than
            a name repeated down every row. Full name and email stay in the row
            tooltip. */}
        <span
          className="relative hidden size-4 shrink-0 place-items-center overflow-hidden text-[7.5px] font-semibold text-white @[15rem]:grid"
          style={{
            backgroundColor: `hsl(${authorHue(commit.authorEmail || commit.authorName)} 42% 42%)`,
          }}
          aria-hidden
        >
          {initials(commit.authorName)}
          {avatar ? (
            <img
              src={avatar}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 size-full object-cover"
              // Hidden straight on the node, not via state: offline or a
              // deleted account would otherwise re-render every row it
              // appears on, and the initials are already sitting underneath.
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : null}
        </span>
        {/* Columns drop cheapest-first as the sidebar narrows: the sha (48px,
            and both the hover peek and the detail card repeat it) before the
            chips, the chips before the avatar, the clock never. Tuned against
            rendered pixels - the old 12rem/13rem gates predate the avatar and
            left three columns fighting over a 300px row. 25rem, not 26rem:
            the side panel's list measures exactly 416px, so a 26rem gate would
            sit on the boundary and flicker this column on any 1px resize. */}
        <span className="text-muted-foreground/70 hidden shrink-0 font-mono text-[10px] tabular-nums @[25rem]:block">
          {commit.shortSha}
        </span>
        {/* Clock time, not "7d ago": the day separator above already says which
            day, so this can be exact instead of repeating itself. */}
        <span className="text-muted-foreground/70 w-10 shrink-0 text-right text-[10px] tabular-nums">
          {formatClock(commit.authorTime)}
        </span>
      </div>
    </div>
  );
  // The open row is the popover anchor (row mode) or just highlighted while
  // the card floats at the cursor (mouse mode); either way its hover tooltip
  // is suppressed so the peek doesn't fight the open detail card.
  if (selected) {
    return (
      <li className="contents">
        {anchorMode === "row" ? <PopoverAnchor asChild>{rowEl}</PopoverAnchor> : rowEl}
      </li>
    );
  }
  return (
    <li className="contents">
      <Tooltip>
        <TooltipTrigger asChild>{rowEl}</TooltipTrigger>
        {/* A peek, not a second detail card: everything here is already loaded
            with the row, so hovering costs nothing. It adds what the row has no
            width for - the exact timestamp behind "3d ago", the author's email,
            whether this is a merge - and repeats the lane color so the bubble
            reads as belonging to the dot it points at. */}
        <TooltipContent
          side="right"
          className="max-w-[22rem] flex-col items-start gap-2 px-3 py-2.5"
        >
          {refChips.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {refChips.map((chip, i) => (
                <RefBadge key={`tip-${chip.kind}-${chip.label}-${i}`} chip={chip} />
              ))}
            </span>
          ) : null}
          <span className="flex items-start gap-2">
            {/* SVG, not a rounded div: globals.css forces border-radius 0 on
                every element, so only a real circle matches the graph dot. */}
            <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden className="mt-[3px] shrink-0">
              <circle cx={4} cy={4} r={3.5} fill={laneColor(lane)} />
            </svg>
            <span className="text-[11.5px] leading-snug font-medium break-words">
              {commit.subject}
            </span>
          </span>
          <span className="border-border/60 flex w-full flex-col gap-1 border-t pt-1.5 text-[10.5px]">
            <span className="flex min-w-0 items-center gap-1.5">
              <User size={11} strokeWidth={2} className="text-info shrink-0" />
              <span className="min-w-0 truncate">
                {commit.authorName}
                {commit.authorEmail ? (
                  <span className="text-muted-foreground"> {commit.authorEmail}</span>
                ) : null}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <Clock size={11} strokeWidth={2} className="text-icon-working shrink-0" />
              <span>
                {formatAbsTime(commit.authorTime)}
                <span className="text-muted-foreground"> ({formatRelTime(commit.authorTime)})</span>
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className="inline-flex items-center gap-1 font-mono tabular-nums"
                style={{ color: laneColor(lane) }}
              >
                <Hash size={11} strokeWidth={2} className="shrink-0" />
                {commit.shortSha}
              </span>
              {commit.parents.length > 1 ? (
                <MetaPill tone="bg-info/15 text-info border-info/30">
                  <GitMerge size={9} strokeWidth={2.25} className="shrink-0" />
                  Merge of {commit.parents.length} parents
                </MetaPill>
              ) : commit.parents.length === 0 ? (
                <MetaPill tone="bg-diff-added/15 text-diff-added border-diff-added/30">
                  <GitCommitHorizontal size={9} strokeWidth={2.25} className="shrink-0" />
                  Root commit
                </MetaPill>
              ) : null}
            </span>
          </span>
          <span className="text-muted-foreground/70 text-[10px]">Click to see changed files</span>
        </TooltipContent>
      </Tooltip>
    </li>
  );
}
