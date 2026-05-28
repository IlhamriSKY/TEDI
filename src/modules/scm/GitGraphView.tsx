import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { gitLog } from "./api";
import type { GitCommit } from "./types";

type Props = {
  rootPath: string | null;
  isRepo: boolean;
  /** Bump this number to force a refetch (e.g. after commit/push). */
  refreshToken?: number;
};

const ROW_H = 26;
const LANE_W = 14;
const DOT_R = 3.5;
const LANE_PAD_X = 8;

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
  /** Lanes (other than `lane`) that were waiting for this SHA - they merge in. */
  mergedLanes: number[];
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
    const mergedLanes: number[] = [];
    if (myLane === -1) {
      myLane = firstNullSlot();
    } else {
      for (let i = 0; i < active.length; i++) {
        if (i !== myLane && active[i] === c.sha) {
          mergedLanes.push(i);
          active[i] = null;
        }
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
      mergedLanes,
      branchedLanes,
    });
  }

  return { rows, laneCount };
}

function laneX(lane: number): number {
  return LANE_PAD_X + lane * LANE_W;
}

function formatRelTime(unix: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - unix);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)}d ago`;
  if (diff < 86_400 * 365) return `${Math.floor(diff / (86_400 * 30))}mo ago`;
  return `${Math.floor(diff / (86_400 * 365))}y ago`;
}

type RefChip = { label: string; kind: "head" | "branch" | "remote" | "tag" };

/** Map git's raw `%D` entries into displayable chips. "HEAD -> main" becomes
 * a "HEAD" chip plus a "main" branch chip so both render distinctly. */
function parseRefs(refs: string[]): RefChip[] {
  const out: RefChip[] = [];
  for (const r of refs) {
    if (r.startsWith("HEAD -> ")) {
      out.push({ label: "HEAD", kind: "head" });
      out.push({ label: r.slice("HEAD -> ".length), kind: "branch" });
    } else if (r === "HEAD") {
      out.push({ label: "HEAD", kind: "head" });
    } else if (r.startsWith("tag: ")) {
      out.push({ label: r.slice("tag: ".length), kind: "tag" });
    } else if (r.includes("/")) {
      out.push({ label: r, kind: "remote" });
    } else {
      out.push({ label: r, kind: "branch" });
    }
  }
  return out;
}

export function GitGraphView({ rootPath, isRepo, refreshToken = 0 }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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
      }
    } catch (e) {
      if (rootRef.current === cur) {
        setError(String(e));
        setCommits([]);
      }
    } finally {
      setLoading(false);
    }
  }, [isRepo]);

  useEffect(() => {
    void fetchLog();
  }, [fetchLog, rootPath, refreshToken]);

  const { rows, laneCount } = useMemo(() => layoutCommits(commits), [commits]);

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

  const graphWidth = LANE_PAD_X * 2 + Math.max(1, laneCount) * LANE_W;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="py-0.5">
        {rows.map((row) => (
          <GraphRow
            key={row.commit.sha}
            row={row}
            graphWidth={graphWidth}
            selected={selected === row.commit.sha}
            onSelect={() => setSelected(row.commit.sha)}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

type RowProps = {
  row: LaidOut;
  graphWidth: number;
  selected: boolean;
  onSelect: () => void;
};

function GraphRow({ row, graphWidth, selected, onSelect }: RowProps) {
  const { commit, lane, laneIn, laneOut, mergedLanes, branchedLanes } = row;
  const midY = ROW_H / 2;
  const myX = laneX(lane);
  const refChips = useMemo(() => parseRefs(commit.refs), [commit.refs]);

  // Build SVG segments. Top half = incoming lines (above the dot), bottom
  // half = outgoing lines (below the dot). Lanes that pass through unchanged
  // get a full-height vertical line.
  const segments: ReactNode[] = [];
  const maxLanes = Math.max(laneIn.length, laneOut.length, lane + 1);
  const branchedLanesSet = new Set(branchedLanes);

  for (let i = 0; i < maxLanes; i++) {
    const x = laneX(i);
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

  // Suppress unused-var warning if mergedLanes happens to be empty; it's
  // implicitly walked above via `inSha === commit.sha`.
  void mergedLanes;

  return (
    <li className="contents">
      <div
        className={cn(
          "group hover:bg-accent/40 flex cursor-pointer items-stretch pr-3",
          selected && "bg-accent/60",
        )}
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        title={`${commit.shortSha} - ${commit.subject}`}
      >
      <div className="shrink-0" style={{ width: graphWidth, height: ROW_H }}>
        <svg
          width={graphWidth}
          height={ROW_H}
          viewBox={`0 0 ${graphWidth} ${ROW_H}`}
          className="block"
        >
          {segments}
          <circle
            cx={myX}
            cy={midY}
            r={DOT_R}
            fill={laneColor(lane)}
            stroke="var(--background)"
            strokeWidth={1.5}
          />
        </svg>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
        {refChips.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {refChips.map((chip, i) => (
              <RefBadge key={`${chip.kind}-${chip.label}-${i}`} chip={chip} />
            ))}
          </span>
        ) : null}
        <span className="text-foreground/90 min-w-0 flex-1 truncate text-[11.5px]">
          {commit.subject}
        </span>
        <span className="text-muted-foreground shrink-0 truncate text-[10px]">
          {commit.authorName}
        </span>
        <span className="text-muted-foreground/70 shrink-0 font-mono text-[10px] tabular-nums">
          {commit.shortSha}
        </span>
        <span className="text-muted-foreground/70 w-14 shrink-0 text-right text-[10px] tabular-nums">
          {formatRelTime(commit.authorTime)}
        </span>
      </div>
      </div>
    </li>
  );
}

function RefBadge({ chip }: { chip: RefChip }) {
  const tone =
    chip.kind === "head"
      ? "bg-diff-added/15 text-diff-added border-diff-added/30"
      : chip.kind === "tag"
        ? "bg-icon-working/15 text-icon-working border-icon-working/30"
        : chip.kind === "remote"
          ? "bg-info/15 text-info border-info/30"
          : "bg-primary/15 text-primary border-primary/30";
  return (
    <span
      className={cn(
        "inline-flex h-[14px] items-center rounded-sm border px-1 text-[9.5px] leading-none font-medium",
        tone,
      )}
    >
      {chip.label}
    </span>
  );
}
