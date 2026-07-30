import { useEffect, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { CliAgentIcon } from "@/components/CliAgentIcon";
import { cn } from "@/lib/utils";
import {
  effectiveCliAgents,
  MAX_AGENT_SPAWN,
  newCliAgentId,
  useCliAgentsStore,
  type CliAgent,
} from "@/modules/terminal/lib/cliAgents";
import { Pin, PinOff, Plus, RotateCcw, Trash2 } from "lucide-react";
import { SettingsAccordion } from "../../components/SettingsAccordion";

/**
 * The roster behind the tab strip's `+` -> Agent picker. Lives under General ->
 * Terminal (these are terminal CLIs, not the in-app AI agents the Agents tab
 * configures), collapsed by default so a dozen rows don't dominate the page.
 *
 * The start command is editable because the shipped default is only a guess at
 * what is on PATH - people alias or wrap these binaries (`claude` ->
 * `claude-start`). A built-in keeps its identity (icon, status badge) through a
 * rename; only the command changes. Pinned agents sort to the top of the picker.
 */
export function CliAgentsCard() {
  const hydrate = useCliAgentsStore((s) => s.hydrate);
  const customAgents = useCliAgentsStore((s) => s.customAgents);
  const overrides = useCliAgentsStore((s) => s.overrides);
  const upsert = useCliAgentsStore((s) => s.upsert);
  const remove = useCliAgentsStore((s) => s.remove);
  const togglePinned = useCliAgentsStore((s) => s.togglePinned);
  const resetBuiltin = useCliAgentsStore((s) => s.resetBuiltin);
  const hasOverride = useCliAgentsStore((s) => s.hasOverride);

  // Settings runs in its own webview, so hydrate the store here too.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [pendingDelete, setPendingDelete] = useState<CliAgent | null>(null);
  // Derived from the two selected slices rather than the store's `all()`, so a
  // change actually re-renders this card (a method reference never changes).
  const agents = effectiveCliAgents(customAgents, overrides);

  return (
    <>
      <SettingsAccordion
        title="Terminal AI agents"
        description="The CLIs offered by the tab strip's + menu."
        summary={`${agents.length} agent${agents.length === 1 ? "" : "s"}`}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <span className="text-muted-foreground text-[10.5px] leading-relaxed">
              {`Up to ${MAX_AGENT_SPAWN} panes (repeats allowed) open in one tab. Edit a start command if your binary is named or wrapped differently - a built-in keeps its icon and status badge through a rename. Pinned agents are listed first.`}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 gap-1.5 px-2 text-[11px]"
              onClick={() => upsert({ id: newCliAgentId(), name: "", command: "", builtIn: false })}
            >
              <Plus size={12} strokeWidth={1.75} />
              New
            </Button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {agents.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                canReset={a.builtIn && hasOverride(a.id)}
                onSave={upsert}
                onTogglePin={() => togglePinned(a.id)}
                onReset={() => resetBuiltin(a.id)}
                onDelete={() => setPendingDelete(a)}
              />
            ))}
          </ul>
        </div>
      </SettingsAccordion>

      {/* Outside the accordion: Radix unmounts collapsed content, which would
          tear down an open confirm dialog with it. */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name || "(unnamed)"}" will be removed from the + menu. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) remove(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type RowProps = {
  agent: CliAgent;
  canReset: boolean;
  onSave: (agent: CliAgent) => void;
  onTogglePin: () => void;
  onReset: () => void;
  onDelete: () => void;
};

/**
 * One roster row. The fields are local until blur/Enter so a persisted write
 * (which round-trips through the store file and broadcasts to the main window)
 * doesn't fire on every keystroke.
 */
function AgentRow({ agent, canReset, onSave, onTogglePin, onReset, onDelete }: RowProps) {
  const [name, setName] = useState(agent.name);
  const [command, setCommand] = useState(agent.command);

  // Re-sync when the stored agent changes underneath (reset, or an edit made in
  // the other window). Keyed on the values themselves, so local typing is safe:
  // it doesn't change `agent`, so this doesn't run and clobber the draft.
  useEffect(() => setName(agent.name), [agent.name]);
  useEffect(() => setCommand(agent.command), [agent.command]);

  const commit = () => {
    if (name === agent.name && command === agent.command) return;
    onSave({ ...agent, name, command });
  };

  return (
    <li className="border-border/60 bg-card flex items-center gap-2 rounded-lg border px-3 py-2">
      <CliAgentIcon agentId={agent.id} size={15} className="text-muted-foreground shrink-0" />
      {agent.builtIn ? (
        <span className="w-32 shrink-0 truncate text-[12px] font-medium">{agent.name}</span>
      ) : (
        <Input
          value={name}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="h-7 w-32 shrink-0 text-[11.5px]"
        />
      )}
      <Input
        value={command}
        placeholder="Start command"
        spellCheck={false}
        onChange={(e) => setCommand(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="h-7 min-w-0 flex-1 font-mono text-[11.5px]"
      />
      <IconTooltip label={agent.pinned ? "Unpin" : "Pin to top"} side="top">
        <Button
          size="icon"
          variant="ghost"
          className={cn("size-7", agent.pinned && "text-foreground")}
          onClick={onTogglePin}
          aria-label={agent.pinned ? "Unpin" : "Pin to top"}
        >
          {agent.pinned ? (
            <Pin size={12} strokeWidth={2} />
          ) : (
            <PinOff size={12} strokeWidth={1.75} />
          )}
        </Button>
      </IconTooltip>
      {agent.builtIn ? (
        <IconTooltip label="Restore default command" side="top">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!canReset}
            onClick={onReset}
            aria-label="Restore default command"
          >
            <RotateCcw size={12} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      ) : (
        <IconTooltip label="Delete" side="top">
          <Button
            size="icon"
            variant="ghost"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-7"
            onClick={onDelete}
            aria-label="Delete"
          >
            <Trash2 size={12} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      )}
    </li>
  );
}
