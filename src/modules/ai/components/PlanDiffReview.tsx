import { Button } from "@/components/ui/button";
import { basename } from "@/lib/path";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useChatStore } from "../store/chatStore";
import { usePlanStore, type QueuedEdit } from "../store/planStore";
import { Check, ChevronDown, FilePen, FilePlus, FolderPlus, X } from "lucide-react";

type DiffLine = { kind: "add" | "del"; text: string };

// Coarse line-level diff via set membership; sufficient for at-a-glance review.
function diffLines(original: string, proposed: string): DiffLine[] {
  const a = original.split("\n");
  const b = proposed.split("\n");
  const setA = new Set(a);
  const setB = new Set(b);
  const lines: DiffLine[] = [];
  for (const l of a) if (!setB.has(l)) lines.push({ kind: "del", text: l });
  for (const l of b) if (!setA.has(l)) lines.push({ kind: "add", text: l });
  return lines;
}

function diffStats(original: string, proposed: string): { added: number; removed: number } {
  const lines = diffLines(original, proposed);
  let added = 0;
  let removed = 0;
  for (const l of lines)
    if (l.kind === "add") added++;
    else removed++;
  return { added, removed };
}

export function PlanDiffReview() {
  const queue = usePlanStore((s) => s.queue);
  const removeOne = usePlanStore((s) => s.removeOne);
  const clear = usePlanStore((s) => s.clear);
  const applyAll = usePlanStore((s) => s.applyAll);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const [busy, setBusy] = useState(false);

  if (queue.length === 0) return null;

  const onApply = async () => {
    setBusy(true);
    try {
      const results = await applyAll(sessionId);
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        console.error("plan apply failures:", failed);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card/85 tedi-glass-panel absolute inset-0 z-10 flex flex-col backdrop-blur-xl">
      <div className="border-border/40 flex items-center justify-between border-b px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold tracking-tight">Plan review</span>
          <span className="text-muted-foreground text-[10.5px]">
            {queue.length} pending change{queue.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 gap-1.5 text-[11px]"
            onClick={() => clear()}
            disabled={busy}
          >
            <X size={12} strokeWidth={2} />
            Discard all
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 text-[11px]"
            onClick={onApply}
            disabled={busy}
          >
            <Check size={12} strokeWidth={2} />
            Apply {queue.length}
          </Button>
        </div>
      </div>
      <ul className="flex flex-1 flex-col gap-1.5 overflow-auto p-3">
        {queue.map((q) => (
          <PlanRow key={q.id} item={q} onReject={() => removeOne(q.id)} />
        ))}
      </ul>
    </div>
  );
}

function PlanRow({ item, onReject }: { item: QueuedEdit; onReject: () => void }) {
  const [open, setOpen] = useState(false);
  const isDir = item.kind === "create_directory";
  const isNew = item.isNewFile && !isDir;
  const stats = isDir ? null : diffStats(item.originalContent, item.proposedContent);
  const Icon = isDir ? FolderPlus : isNew ? FilePlus : FilePen;

  return (
    <li className="group/row border-border/50 bg-card overflow-hidden rounded-md border">
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => !isDir && setOpen((v) => !v)}
          disabled={isDir}
          className={cn(
            "text-muted-foreground mt-0.5 shrink-0 cursor-pointer transition-transform",
            open && "rotate-180",
            isDir && "invisible disabled:cursor-default",
          )}
          aria-label="Toggle diff"
        >
          <ChevronDown size={11} strokeWidth={1.75} />
        </button>
        <Icon size={13} strokeWidth={1.75} className="text-muted-foreground mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 font-mono text-[11.5px]">
            <span className="text-foreground truncate">{basename(item.path)}</span>
            {isNew ? <span className="text-diff-added text-[10px]">new</span> : null}
          </div>
          <div className="text-muted-foreground truncate font-mono text-[10px]">{item.path}</div>
          {stats ? (
            <div className="mt-0.5 flex items-center gap-2 text-[10px] tabular-nums">
              <span className="text-diff-added">+{stats.added}</span>
              <span className="text-diff-removed">−{stats.removed}</span>
              <span className="text-muted-foreground">
                {item.kind === "multi_edit" ? "multi-edit" : item.kind}
              </span>
            </div>
          ) : (
            <div className="text-muted-foreground mt-0.5 text-[10px]">
              {item.description ?? "create directory"}
            </div>
          )}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="hover:bg-destructive/10 hover:text-destructive size-5 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100"
          onClick={onReject}
          aria-label="Reject"
        >
          <X size={11} strokeWidth={1.75} />
        </Button>
      </div>
      {open && !isDir ? (
        <div className="border-border/40 bg-muted/20 border-t px-2.5 py-2">
          <UnifiedDiffPreview original={item.originalContent} proposed={item.proposedContent} />
        </div>
      ) : null}
    </li>
  );
}

function UnifiedDiffPreview({ original, proposed }: { original: string; proposed: string }) {
  const lines = diffLines(original, proposed);

  if (lines.length === 0) {
    return <div className="text-muted-foreground text-[11px] italic">no line-level changes</div>;
  }

  const MAX = 80;
  const shown = lines.slice(0, MAX);
  const rest = lines.length - shown.length;

  return (
    <div className="border-border/40 overflow-hidden rounded border font-mono text-[11px] leading-relaxed">
      <div className="max-h-72 overflow-auto">
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn(
              "flex whitespace-pre",
              l.kind === "add"
                ? "bg-diff-added/10 text-diff-added"
                : "bg-diff-removed/10 text-diff-removed",
            )}
          >
            <span className="w-4 shrink-0 px-1 text-center opacity-70 select-none">
              {l.kind === "add" ? "+" : "-"}
            </span>
            <span className="min-w-0 flex-1 overflow-x-auto pr-2">{l.text || " "}</span>
          </div>
        ))}
        {rest > 0 ? (
          <div className="text-muted-foreground px-2 py-1 text-[10px] italic">
            … {rest} more changes
          </div>
        ) : null}
      </div>
    </div>
  );
}
