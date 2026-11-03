import { useAiCliStatuses } from "@/modules/terminal/lib/aiCliStatusStore";

/**
 * "3 agents · 1 needs you" in the status bar, so an agent asking for something
 * is seen even with the sidebar shut. Nothing while no agent runs.
 */
export function AgentsPill() {
  const byLeaf = useAiCliStatuses((s) => s.statuses);
  const statuses = Object.values(byLeaf);
  if (statuses.length === 0) return null;
  const needs = statuses.filter((s) => s.state === "blocking").length;
  return (
    <span className="text-muted-foreground flex h-6 items-center gap-1 px-1 text-[11px] whitespace-nowrap tabular-nums">
      {statuses.length} {statuses.length === 1 ? "agent" : "agents"}
      {needs > 0 ? <span className="text-icon-blocked">· {needs} needs you</span> : null}
    </span>
  );
}
