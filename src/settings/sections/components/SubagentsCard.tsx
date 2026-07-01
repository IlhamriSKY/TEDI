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
import { Label } from "../../components/Label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  WIDE_DIALOG_WIDTH,
} from "@/components/ui/dialog";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Add01Icon, Delete02Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { READ_ONLY_TOOLS } from "@/modules/ai/agents/registry";
import { useSubagentsStore, type CustomSubagentDef } from "@/modules/ai/store/subagentsStore";
import { PromptModelDropdown } from "@/settings/sections/components/SystemPromptsCard";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setSubagentsEnabled } from "@/modules/settings/store";

/**
 * Sub-agents: a single on/off toggle, plus user-defined custom workers.
 * When ON, the AI automatically delegates broad explore/review/audit tasks
 * to parallel sub-agents (the AI decides task count, parallelism,
 * and summary depth). When OFF, all work is done inline by the main agent.
 */
export function SubagentsCard() {
  const enabled = usePreferencesStore((s) => s.subagentsEnabled);

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/30 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-medium">Sub-agents</span>
            <span className="text-muted-foreground text-[11px] leading-relaxed">
              Workers the AI can spawn in parallel to study, review, and audit the codebase
              (read-only), plus an autonomous worker (Odyssey) that edits files and runs
              commands to implement a scoped task. When on, broad work is auto-delegated; the AI
              decides how many workers, their depth, and summary size. Off means all work is done
              inline.
            </span>
          </div>
          <Switch checked={enabled} onCheckedChange={(v) => void setSubagentsEnabled(v)} />
        </div>
        <div className="text-muted-foreground/80 border-border/40 border-t pt-2 text-[10.5px] leading-relaxed">
          {enabled
            ? "Sub-agents are active. The AI auto-delegates broad explore/review/audit work, and can hand a scoped change to the Odyssey worker, which edits files and runs commands directly (no approval card; changes are checkpointed and can be reverted)."
            : "Sub-agents are off. The AI will handle all tasks inline using its own tools."}
        </div>
      </section>

      <CustomSubagentsSection />
    </div>
  );
}

/** CRUD for user-defined read-only sub-agents. Active state is the store's
 *  `enabledCustomIds` (what `getAllSubagentDefs` filters on); new agents are
 *  enabled on create. */
function CustomSubagentsSection() {
  const hydrate = useSubagentsStore((s) => s.hydrate);
  const custom = useSubagentsStore((s) => s.customSubagents);
  const enabledIds = useSubagentsStore((s) => s.enabledCustomIds);
  const upsert = useSubagentsStore((s) => s.upsert);
  const remove = useSubagentsStore((s) => s.remove);
  const toggle = useSubagentsStore((s) => s.toggle);

  // Settings runs in its own webview, so hydrate the store here too.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [editing, setEditing] = useState<CustomSubagentDef | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CustomSubagentDef | null>(null);

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/30 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12.5px] font-medium">Custom sub-agents</span>
          <span className="text-muted-foreground text-[11px] leading-relaxed">
            Your own read-only workers. The AI can delegate to enabled ones by type, alongside
            the built-ins (comet, nebula, nova, orbit, eclipse, odyssey, vega, zenith, aurora,
            meteor).
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1.5 px-2 text-[11px]"
          onClick={() =>
            setEditing({
              id: "",
              name: "",
              description: "",
              systemPrompt: "",
              tools: [...READ_ONLY_TOOLS],
              model: "",
              enabled: true,
            })
          }
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
          New
        </Button>
      </div>

      {custom.length === 0 ? (
        <div className="text-muted-foreground/80 border-border/40 border-t pt-2 text-[10.5px] leading-relaxed">
          No custom sub-agents yet. Create one to give the AI a specialized read-only worker.
        </div>
      ) : (
        <ul className="border-border/40 flex flex-col gap-1.5 border-t pt-2">
          {custom.map((a) => {
            const on = enabledIds.includes(a.id);
            return (
              <li
                key={a.id}
                className="border-border/60 bg-card/60 flex items-center gap-2 rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium">{a.name || "(unnamed)"}</span>
                  {a.description ? (
                    <span className="text-muted-foreground truncate text-[10.5px]">
                      {a.description}
                    </span>
                  ) : null}
                </div>
                <Switch checked={on} onCheckedChange={() => void toggle(a.id)} />
                <IconTooltip label="Edit" side="top">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => setEditing(a)}
                    aria-label="Edit"
                  >
                    <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                </IconTooltip>
                <IconTooltip label="Delete" side="top">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-7"
                    onClick={() => setPendingDelete(a)}
                    aria-label="Delete"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                </IconTooltip>
              </li>
            );
          })}
        </ul>
      )}

      <CustomSubagentDialog
        agent={editing}
        isNew={!editing?.id}
        onClose={() => setEditing(null)}
        onSave={(draft) => {
          // New agents get a readable, stable type id (slug of the name) so the
          // AI can echo it reliably when auto-delegating; edits keep their id.
          const isNew = !draft.id;
          const id = draft.id || uniqueCustomId(draft.name, custom.map((a) => a.id));
          const wasEnabled = enabledIds.includes(id);
          void upsert({ ...draft, id, enabled: isNew || wasEnabled });
          if (isNew && !wasEnabled) void toggle(id);
          setEditing(null);
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete sub-agent?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name || "(unnamed)"}" will be permanently removed. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

const TOOL_LABEL: Record<string, string> = {
  read_file: "Read file",
  list_directory: "List dir",
  grep: "Grep",
  glob: "Glob",
};

function CustomSubagentDialog({
  agent,
  isNew,
  onClose,
  onSave,
}: {
  agent: CustomSubagentDef | null;
  isNew: boolean;
  onClose: () => void;
  onSave: (def: CustomSubagentDef) => void;
}) {
  const [draft, setDraft] = useState<CustomSubagentDef | null>(agent);
  useEffect(() => setDraft(agent), [agent]);
  if (!draft) return null;

  const canSave =
    draft.name.trim().length > 0 &&
    draft.systemPrompt.trim().length > 0 &&
    draft.tools.length > 0;

  const toggleTool = (t: string) =>
    setDraft({
      ...draft,
      tools: draft.tools.includes(t)
        ? draft.tools.filter((x) => x !== t)
        : [...draft.tools, t],
    });

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "flex max-h-[90vh] flex-col gap-4",
          WIDE_DIALOG_WIDTH,
        )}
      >
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {isNew ? "New sub-agent" : "Edit sub-agent"}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6">
          <div className="flex flex-col gap-1">
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Test mapper"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="One line - the AI reads this to decide when to delegate here"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Tools</Label>
            <div className="flex flex-wrap gap-1.5">
              {READ_ONLY_TOOLS.map((t) => {
                const on = draft.tools.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTool(t)}
                    className={cn(
                      "cursor-pointer rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                      on
                        ? "border-accent bg-accent text-foreground"
                        : "border-border/60 text-muted-foreground hover:bg-accent/40",
                    )}
                  >
                    {TOOL_LABEL[t] ?? t}
                  </button>
                );
              })}
            </div>
            <span className="text-muted-foreground text-[10px]">
              Read-only only. Pick at least one.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Label>System prompt</Label>
            <Textarea
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              placeholder="Persona & rules for this worker. It runs with a fresh history and only the tools above."
              className="min-h-72 resize-y font-mono text-[11.5px] leading-relaxed"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Model</Label>
            <PromptModelDropdown
              value={draft.model ?? ""}
              provider={draft.modelProvider}
              onChange={(model, modelProvider) => setDraft({ ...draft, model, modelProvider })}
            />
            <span className="text-muted-foreground text-[10px]">
              Run this worker on its own model (e.g. a cheaper one for large searches). Default =
              same as chat.
            </span>
          </div>
        </div>
        <DialogFooter className="grid grid-cols-1 gap-2 border-t border-border/50 pt-4 sm:grid-cols-2">
          <Button variant="outline" className="h-9 w-full" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="h-9 w-full"
            disabled={!canSave}
            onClick={() =>
              onSave({
                ...draft,
                name: draft.name.trim(),
                description: draft.description.trim(),
                systemPrompt: draft.systemPrompt.trim(),
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Slugify a name into a readable type-id fragment the AI can echo reliably. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/** Build a unique `sa-custom-<slug>` id, suffixing on collision. */
function uniqueCustomId(name: string, existing: string[]): string {
  const base = `sa-custom-${slugify(name)}`;
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
