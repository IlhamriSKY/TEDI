import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MODELS,
  PLAN_MODE_PROMPT_BODY,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LITE,
} from "@/modules/ai/config";
import { SUBAGENTS } from "@/modules/ai/agents/registry";
import {
  MAX_PROMPT_CHARS,
  PROMPT_META,
  type PromptId,
  type PromptMeta,
} from "@/modules/ai/lib/prompts";
import { usePromptsStore } from "@/modules/ai/store/promptsStore";
import { COMPLETION_SYSTEM_PROMPT } from "@/modules/editor/lib/autocomplete/prompt";
import { COMMIT_SYSTEM_PROMPT } from "@/modules/scm/commitAi";
import { ArrowReloadHorizontalIcon, Edit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";

/** Built-in default text per prompt id. Sourced from the real call-site
 *  constants so the "reset to default" baseline can never drift from runtime. */
const DEFAULTS: Record<PromptId, string> = {
  core: SYSTEM_PROMPT,
  "core-lite": SYSTEM_PROMPT_LITE,
  "plan-mode": PLAN_MODE_PROMPT_BODY,
  "subagent:explore": SUBAGENTS.explore.systemPrompt,
  "subagent:code-review": SUBAGENTS["code-review"].systemPrompt,
  "subagent:security": SUBAGENTS.security.systemPrompt,
  "subagent:general": SUBAGENTS.general.systemPrompt,
  autocomplete: COMPLETION_SYSTEM_PROMPT,
  commit: COMMIT_SYSTEM_PROMPT,
};

const GROUP_ORDER = ["Main agent", "Sub-agents", "Other"] as const;

type Draft = {
  prompt: string;
  model: string;
  /** Kept as a string so the field can be empty (= unset). */
  temperature: string;
};

export function SystemPromptsCard() {
  const hydrate = usePromptsStore((s) => s.hydrate);
  const overrides = usePromptsStore((s) => s.overrides);
  const setOverride = usePromptsStore((s) => s.setOverride);
  const reset = usePromptsStore((s) => s.reset);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // All prompts stay hidden behind this toggle so the card is collapsed by
  // default. Any existing override forces it open so the user always sees what
  // they changed (and can't lose track of an edit hidden behind the switch).
  const hasAnyEdit = useMemo(() => PROMPT_META.some((m) => overrides[m.id]), [overrides]);
  const [showAll, setShowAll] = useState(false);
  // An existing override force-shows the list; keep `showAll` in sync so the
  // list doesn't collapse the moment the user resets the last override.
  useEffect(() => {
    if (hasAnyEdit) setShowAll(true);
  }, [hasAnyEdit]);
  const listVisible = showAll || hasAnyEdit;

  // Snapshot the initial draft at open time so re-renders from the store
  // subscription can't reset the dialog while the user is typing.
  const [editing, setEditing] = useState<{ meta: PromptMeta; initial: Draft } | null>(null);

  const openEditor = (m: PromptMeta) => {
    const o = overrides[m.id];
    setEditing({
      meta: m,
      initial: {
        prompt: o?.prompt ?? DEFAULTS[m.id],
        model: o?.model ?? "",
        temperature: o?.temperature != null ? String(o.temperature) : "",
      },
    });
  };

  const grouped = useMemo(() => {
    const by = new Map<string, PromptMeta[]>();
    for (const m of PROMPT_META) {
      const list = by.get(m.group) ?? [];
      list.push(m);
      by.set(m.group, list);
    }
    return by;
  }, []);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <Label>System prompts</Label>
          <span className="text-muted-foreground text-[10.5px] leading-relaxed">
            Edit the built-in instructions for TEDI's AI agents. Reset restores the default.
          </span>
        </div>
        <label
          htmlFor="show-all-prompts"
          className="flex shrink-0 cursor-pointer items-center gap-2 pt-0.5"
        >
          <span className="text-muted-foreground text-[10.5px]">Show all</span>
          <Switch
            id="show-all-prompts"
            size="sm"
            checked={listVisible}
            disabled={hasAnyEdit}
            onCheckedChange={setShowAll}
            aria-label="Show all system prompts"
          />
        </label>
      </div>

      {!listVisible ? (
        <div className="border-border/60 bg-card/30 text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-[11px]">
          Turn on <span className="text-foreground/80">Show all</span> to view and edit the agent,
          sub-agent, inline-completion, and commit prompts.
        </div>
      ) : (
        GROUP_ORDER.map((group) => {
          const items = grouped.get(group) ?? [];
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                {group}
              </span>
              <div className="flex flex-col gap-1.5">
                {items.map((m) => (
                  <PromptRow
                    key={m.id}
                    meta={m}
                    edited={!!overrides[m.id]}
                    onEdit={() => openEditor(m)}
                    onReset={overrides[m.id] ? () => reset(m.id) : null}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      <PromptEditorDialog
        meta={editing?.meta ?? null}
        defaultText={editing ? DEFAULTS[editing.meta.id] : ""}
        initial={editing?.initial ?? null}
        onClose={() => setEditing(null)}
        onSave={(draft) => {
          if (!editing) return;
          const { meta } = editing;
          const def = DEFAULTS[meta.id];
          const tempNum = draft.temperature.trim() === "" ? null : Number(draft.temperature);
          setOverride(meta.id, {
            // Store the prompt only when it differs from the default so the
            // entry can collapse back to stock when nothing custom remains.
            prompt: draft.prompt.trim() !== "" && draft.prompt !== def ? draft.prompt : undefined,
            model: meta.capabilities.model ? draft.model || null : undefined,
            temperature:
              meta.capabilities.temperature && tempNum != null && Number.isFinite(tempNum)
                ? tempNum
                : null,
          });
          setEditing(null);
        }}
      />
    </section>
  );
}

function PromptRow({
  meta,
  edited,
  onEdit,
  onReset,
}: {
  meta: PromptMeta;
  edited: boolean;
  onEdit: () => void;
  onReset: (() => void) | null;
}) {
  return (
    <div className="group border-border/60 bg-card/60 hover:border-border flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-[12px] font-medium">
          {meta.label}
          {edited ? (
            <span className="bg-icon-working/15 text-icon-working rounded px-1 py-0.5 text-[9px] tracking-wide uppercase">
              Edited
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground line-clamp-1 text-[10.5px]">{meta.description}</span>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <IconTooltip label="Edit" side="top">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={onEdit}
            aria-label={`Edit ${meta.label}`}
          >
            <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
        {onReset ? (
          <IconTooltip label="Reset to default" side="top">
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground size-7"
              onClick={onReset}
              aria-label={`Reset ${meta.label}`}
            >
              <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={12} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
    </div>
  );
}

function PromptEditorDialog({
  meta,
  defaultText,
  initial,
  onClose,
  onSave,
}: {
  meta: PromptMeta | null;
  defaultText: string;
  initial: Draft | null;
  onClose: () => void;
  onSave: (draft: Draft) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(initial);
  useEffect(() => setDraft(initial), [initial]);
  if (!meta || !draft) return null;

  const overLimit = draft.prompt.length > MAX_PROMPT_CHARS;
  const isDefault = draft.prompt === defaultText;
  const tempInvalid =
    draft.temperature.trim() !== "" &&
    (!Number.isFinite(Number(draft.temperature)) ||
      Number(draft.temperature) < 0 ||
      Number(draft.temperature) > 2);

  return (
    <Dialog open={!!meta} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{meta.label}</DialogTitle>
        </DialogHeader>
        <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6">
          <span className="text-muted-foreground text-[11px] leading-relaxed">
            {meta.description}
          </span>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <Label>Prompt</Label>
              <button
                type="button"
                onClick={() => setDraft({ ...draft, prompt: defaultText })}
                disabled={isDefault}
                className={cn(
                  "text-[10.5px] underline-offset-2 hover:underline",
                  isDefault ? "text-muted-foreground/50 cursor-default" : "text-muted-foreground",
                )}
              >
                Reset to default
              </button>
            </div>
            <Textarea
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              className="min-h-72 resize-y font-mono text-[11.5px] leading-relaxed"
              spellCheck={false}
            />
            {overLimit ? (
              <span className="text-destructive text-[10px]">
                Over the {MAX_PROMPT_CHARS.toLocaleString()} character limit - the end will be
                trimmed when saved.
              </span>
            ) : null}
          </div>

          {meta.capabilities.model ? (
            <div className="flex flex-col gap-1">
              <Label>Model</Label>
              <select
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                className="border-border bg-card/60 h-8 rounded-md border px-2 text-[12px]"
              >
                <option value="">Same as chat (default)</option>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.hint}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground text-[10px]">
                Run this sub-agent on its own model (e.g. a cheaper one for large searches).
              </span>
            </div>
          ) : null}

          {meta.capabilities.temperature ? (
            <div className="flex flex-col gap-1">
              <Label>Temperature</Label>
              <Input
                value={draft.temperature}
                onChange={(e) => setDraft({ ...draft, temperature: e.target.value })}
                placeholder="Provider default (leave empty)"
                inputMode="decimal"
                className={cn("h-8 w-full text-[12px]", tempInvalid && "border-destructive")}
              />
              <span className="text-muted-foreground text-[10px]">
                0-2. Leave empty to use the provider default. Some reasoning models reject this.
              </span>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={tempInvalid} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}
