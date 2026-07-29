import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CliAgentIcon } from "@/components/CliAgentIcon";
import { cn } from "@/lib/utils";
import { Minus } from "lucide-react";
import { layoutsFor, type PaneLayout } from "@/modules/terminal";
import {
  effectiveCliAgents,
  MAX_AGENT_SPAWN,
  useCliAgentsStore,
} from "@/modules/terminal/lib/cliAgents";

const LAYOUT_LABEL: Record<PaneLayout, string> = {
  row: "Side by side",
  col: "Stacked",
  grid: "Combined",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Spawn one terminal per id, in pick order, arranged by `layout`. */
  onSpawn: (agentIds: string[], layout: PaneLayout) => void;
};

/**
 * Picker behind the tab strip's `+` -> Agent. A dialog rather than a submenu:
 * a two-column grid and a layout chooser do not belong in a roving-focus menu,
 * and a menu's item semantics fight both.
 *
 * `picked` is a multiset, not a set: the same agent can be taken several times
 * (three Claude panes side by side is a normal thing to want), so a card shows a
 * count rather than a checkmark. Array order is pane order, so a click appends
 * and the minus button drops the most recent copy.
 */
export function AgentSpawnDialog({ open, onOpenChange, onSpawn }: Props) {
  const hydrate = useCliAgentsStore((s) => s.hydrate);
  const customAgents = useCliAgentsStore((s) => s.customAgents);
  const overrides = useCliAgentsStore((s) => s.overrides);
  const agents = effectiveCliAgents(customAgents, overrides).filter((a) => a.command.trim() !== "");

  const [picked, setPicked] = useState<string[]>([]);
  const [layout, setLayout] = useState<PaneLayout>("row");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Start clean on every open so a previous pick never spawns by accident.
  useEffect(() => {
    if (open) {
      setPicked([]);
      setLayout("row");
    }
  }, [open]);

  const options = layoutsFor(picked.length);
  // Dropping from 3 picks to 2 makes "Combined" meaningless; fall back rather
  // than spawn a layout the user can no longer see selected.
  const effectiveLayout = options.includes(layout) ? layout : "row";

  const add = (id: string) =>
    setPicked((curr) => (curr.length >= MAX_AGENT_SPAWN ? curr : [...curr, id]));
  /** Drop the most recently added copy, so removing never reshuffles the rest. */
  const removeOne = (id: string) =>
    setPicked((curr) => {
      const at = curr.lastIndexOf(id);
      return at === -1 ? curr : [...curr.slice(0, at), ...curr.slice(at + 1)];
    });

  const atCap = picked.length >= MAX_AGENT_SPAWN;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run AI agents</DialogTitle>
          <DialogDescription>
            Click to add a pane, click again for a second copy of the same agent. Up to{" "}
            {MAX_AGENT_SPAWN} panes in one tab, in the order you pick them. Start commands live in
            Settings &rarr; Agents.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          {agents.map((a) => {
            const count = picked.filter((id) => id === a.id).length;
            const isPicked = count > 0;
            return (
              <div
                key={a.id}
                className={cn(
                  "flex items-center rounded-lg border pr-1.5 transition-colors",
                  isPicked
                    ? "border-primary bg-primary/5"
                    : "border-border/60 bg-card hover:border-border hover:bg-accent/40",
                  atCap && !isPicked && "opacity-40",
                )}
              >
                <button
                  type="button"
                  disabled={atCap}
                  aria-label={`Add ${a.name || "unnamed agent"}`}
                  onClick={() => add(a.id)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-3 py-2.5 text-left",
                    "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
                    atCap && "cursor-not-allowed",
                  )}
                >
                  <CliAgentIcon
                    agentId={a.id}
                    size={16}
                    className={isPicked ? "text-foreground" : "text-muted-foreground"}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {a.name || "(unnamed)"}
                  </span>
                </button>
                {isPicked ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="bg-primary text-primary-foreground flex size-4.5 items-center justify-center rounded-full text-[10px] font-semibold">
                      {count}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove one ${a.name || "unnamed agent"}`}
                      onClick={() => removeOne(a.id)}
                      className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 flex size-5 items-center justify-center rounded outline-none focus-visible:ring-2"
                    >
                      <Minus size={12} strokeWidth={2} />
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {options.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px]">
              Pane layout &middot; {picked.length}/{MAX_AGENT_SPAWN}
            </span>
            <div className="grid grid-cols-3 gap-2">
              {options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={opt === effectiveLayout}
                  onClick={() => setLayout(opt)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2 transition-colors",
                    "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
                    opt === effectiveLayout
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-card hover:border-border hover:bg-accent/40",
                  )}
                >
                  <LayoutPreview layout={opt} count={picked.length} />
                  <span className="text-[11px] font-medium">{LAYOUT_LABEL[opt]}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={picked.length === 0}
            onClick={() => {
              onSpawn(picked, effectiveLayout);
              onOpenChange(false);
            }}
          >
            {picked.length > 1 ? `Run ${picked.length} agents` : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Miniature of the resulting split. Mirrors `buildPaneTree`'s branches exactly -
 * if that changes, this must follow, or the preview lies about what you get.
 */
function LayoutPreview({ layout, count }: { layout: PaneLayout; count: number }) {
  const cell = "bg-muted-foreground/40 flex-1 rounded-[2px]";
  const box = "flex h-6 w-9 gap-0.5";
  if (layout === "grid" && count === 3) {
    return (
      <div className={box}>
        <div className={cell} />
        <div className="flex flex-1 flex-col gap-0.5">
          <div className={cell} />
          <div className={cell} />
        </div>
      </div>
    );
  }
  if (layout === "grid" && count >= 4) {
    const top = Math.ceil(count / 2);
    return (
      <div className={cn(box, "flex-col")}>
        {[top, count - top].map((n, r) => (
          <div key={r} className="flex flex-1 gap-0.5">
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className={cell} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={cn(box, layout === "col" && "flex-col")}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cell} />
      ))}
    </div>
  );
}
