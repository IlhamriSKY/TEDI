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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  WIDE_DIALOG_WIDTH,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { SettingsAccordion } from "../../components/SettingsAccordion";
import { Textarea } from "@/components/ui/textarea";
import { cn, matchesQuery } from "@/lib/utils";
import { Label } from "../../components/Label";
import { ProviderIcon } from "../../components/ProviderIcon";
import {
  getDetectedModels,
  MODELS,
  ORCHESTRATION_PROMPT_BODY,
  PLAN_MODE_PROMPT_BODY,
  PROVIDERS,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LITE,
  providerNeedsKey,
  tryGetModel,
  type ModelInfo,
  type ProviderId,
} from "@/modules/ai/config";
import { SUBAGENTS } from "@/modules/ai/agents/registry";
import {
  clearOpenAICompatibleInstance,
  refreshOpenAICompatibleInstance,
  useOpenAICompatibleModels,
} from "@/modules/ai/lib/openaiCompatible";
import {
  EMPTY_PROVIDER_KEYS,
  getAllKeys,
  getOpenAICompatibleInstanceKey,
  type ProviderKeys,
} from "@/modules/ai/lib/keyring";
import {
  clearSumopodModels,
  refreshSumopodModels,
  useSumopodModels,
} from "@/modules/ai/lib/sumopod";
import {
  MAX_PROMPT_CHARS,
  PROMPT_META,
  type PromptId,
  type PromptMeta,
} from "@/modules/ai/lib/prompts";
import { usePromptsStore } from "@/modules/ai/store/promptsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { COMPLETION_SYSTEM_PROMPT } from "@/modules/editor/lib/autocomplete/prompt";
import { COMMIT_SYSTEM_PROMPT } from "@/modules/scm/commitAi";
import {
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  Edit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";

/** Built-in default text per prompt id. Sourced from the real call-site
 *  constants so the "reset to default" baseline can never drift from runtime. */
const DEFAULTS: Record<PromptId, string> = {
  core: SYSTEM_PROMPT,
  "core-lite": SYSTEM_PROMPT_LITE,
  "plan-mode": PLAN_MODE_PROMPT_BODY,
  orchestration: ORCHESTRATION_PROMPT_BODY,
  "subagent:comet": SUBAGENTS.comet.systemPrompt,
  "subagent:nebula": SUBAGENTS.nebula.systemPrompt,
  "subagent:nova": SUBAGENTS.nova.systemPrompt,
  "subagent:orbit": SUBAGENTS.orbit.systemPrompt,
  "subagent:eclipse": SUBAGENTS.eclipse.systemPrompt,
  "subagent:odyssey": SUBAGENTS.odyssey.systemPrompt,
  "subagent:vega": SUBAGENTS.vega.systemPrompt,
  "subagent:zenith": SUBAGENTS.zenith.systemPrompt,
  "subagent:aurora": SUBAGENTS.aurora.systemPrompt,
  "subagent:meteor": SUBAGENTS.meteor.systemPrompt,
  autocomplete: COMPLETION_SYSTEM_PROMPT,
  commit: COMMIT_SYSTEM_PROMPT,
};

const GROUP_ORDER = ["Main agent", "Sub-agents", "Other"] as const;

type Draft = {
  prompt: string;
  model: string;
  /** Provider for `model`; disambiguates ids shared across providers. */
  modelProvider: ProviderId | null;
  /** Kept as a string so the field can be empty (= unset). */
  temperature: string;
};

type SystemPromptsCardProps = {
  title?: string;
  description?: string;
  groups?: readonly PromptMeta["group"][];
  promptIds?: readonly PromptId[];
};

export function SystemPromptsCard({
  title = "System prompts",
  description = "Edit the built-in instructions for TEDI's AI agents. Reset restores the default.",
  groups = GROUP_ORDER,
  promptIds,
}: SystemPromptsCardProps = {}) {
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
  const visibleGroups = useMemo(() => new Set(groups), [groups]);
  const visiblePromptIds = useMemo(() => (promptIds ? new Set(promptIds) : null), [promptIds]);
  const visibleMeta = useMemo(
    () =>
      PROMPT_META.filter(
        (m) => visibleGroups.has(m.group) && (!visiblePromptIds || visiblePromptIds.has(m.id)),
      ),
    [visibleGroups, visiblePromptIds],
  );
  const hasAnyEdit = useMemo(() => visibleMeta.some((m) => overrides[m.id]), [overrides, visibleMeta]);
  const editedCount = useMemo(
    () => visibleMeta.filter((m) => overrides[m.id]).length,
    [overrides, visibleMeta],
  );
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
  const [pendingReset, setPendingReset] = useState<PromptMeta | null>(null);

  const openEditor = (m: PromptMeta) => {
    const o = overrides[m.id];
    setEditing({
      meta: m,
      initial: {
        prompt: o?.prompt ?? DEFAULTS[m.id],
        model: o?.model ?? "",
        modelProvider: o?.modelProvider ?? null,
        temperature: o?.temperature != null ? String(o.temperature) : "",
      },
    });
  };

  const grouped = useMemo(() => {
    const by = new Map<string, PromptMeta[]>();
    for (const m of visibleMeta) {
      const list = by.get(m.group) ?? [];
      list.push(m);
      by.set(m.group, list);
    }
    return by;
  }, [visibleMeta]);

  const orderedGroups = useMemo(
    () => GROUP_ORDER.filter((group) => visibleGroups.has(group)),
    [visibleGroups],
  );

  return (
    <>
      <SettingsAccordion
        title={title}
        description={description}
        summary={editedCount > 0 ? `${editedCount} edited` : "Default"}
        open={listVisible}
        onOpenChange={(o) => setShowAll(o || hasAnyEdit)}
      >
        <div className="flex flex-col gap-3">
          {orderedGroups.map((group) => {
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
                      onReset={overrides[m.id] ? () => setPendingReset(m) : null}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </SettingsAccordion>

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
            modelProvider:
              meta.capabilities.model && draft.model ? (draft.modelProvider ?? null) : undefined,
            temperature:
              meta.capabilities.temperature && tempNum != null && Number.isFinite(tempNum)
                ? tempNum
                : null,
          });
          setEditing(null);
        }}
      />

      <AlertDialog open={pendingReset !== null} onOpenChange={(o) => !o && setPendingReset(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset prompt to default?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingReset
                ? `"${pendingReset.label}" will be restored to its built-in default. Your custom text will be discarded.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingReset) reset(pendingReset.id);
                setPendingReset(null);
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
        <span className="text-muted-foreground line-clamp-2 text-[10.5px] leading-snug">
          {meta.description}
        </span>
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

  // All prompt editors share the wide sub-agent dialog size for a consistent feel.
  const dialogWidthClass = WIDE_DIALOG_WIDTH;

  return (
    <Dialog open={!!meta} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn("flex max-h-[90vh] flex-col gap-4 overflow-visible", dialogWidthClass)}
      >
        <DialogHeader>
          <DialogTitle className="text-[14px]">{meta.label}</DialogTitle>
        </DialogHeader>
        <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-1">
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
              <PromptModelDropdown
                value={draft.model}
                provider={draft.modelProvider}
                onChange={(model, modelProvider) => setDraft({ ...draft, model, modelProvider })}
              />
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
        <DialogFooter className="grid grid-cols-1 gap-2 border-t border-border/50 pt-4 sm:grid-cols-2">
          <Button variant="outline" className="h-9 w-full" onClick={onClose}>
            Cancel
          </Button>
          <Button className="h-9 w-full" disabled={tempInvalid} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Model picker shared by the built-in sub-agent prompt editor and the custom
 *  sub-agent editor. Empty value = "same as chat". */
export function PromptModelDropdown({
  value,
  provider,
  onChange,
}: {
  value: string;
  provider?: ProviderId | null;
  onChange: (model: string, provider: ProviderId | null) => void;
}) {
  const [keys, setKeys] = useState<ProviderKeys>(EMPTY_PROVIDER_KEYS);
  const [instanceKeys, setInstanceKeys] = useState<Record<string, string | null>>({});
  const [query, setQuery] = useState("");
  const sumopodModels = useSumopodModels();
  useOpenAICompatibleModels();
  const oaiCompatInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);
  const oaiCompatModels = getDetectedModels("openai-compatible");

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void Promise.all([
        getAllKeys(),
        Promise.all(
          oaiCompatInstances.map(
            async (inst) => [inst.id, await getOpenAICompatibleInstanceKey(inst.id)] as const,
          ),
        ),
      ]).then(([nextKeys, nextInstanceEntries]) => {
        if (!alive) return;
        const firstInstanceKey = nextInstanceEntries.find(([, key]) => !!key)?.[1] ?? null;
        setKeys({
          ...nextKeys,
          "openai-compatible": firstInstanceKey ?? nextKeys["openai-compatible"],
        });
        setInstanceKeys(Object.fromEntries(nextInstanceEntries));
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [oaiCompatInstances]);

  useEffect(() => {
    if (keys.sumopod) {
      void refreshSumopodModels(keys.sumopod);
      return;
    }
    clearSumopodModels();
  }, [keys.sumopod]);

  useEffect(() => {
    for (const inst of oaiCompatInstances) {
      const key = instanceKeys[inst.id] ?? null;
      if (!inst.baseURL || !key) {
        clearOpenAICompatibleInstance(inst.id);
        continue;
      }
      void refreshOpenAICompatibleInstance(inst.id, key, inst.baseURL, inst.label);
    }
  }, [instanceKeys, oaiCompatInstances]);

  const availableModels = useMemo(() => {
    const out: ModelInfo[] = [];
    const seen = new Set<string>();
    const add = (models: readonly ModelInfo[]) => {
      for (const model of models) {
        const key = `${model.provider}::${model.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(model);
      }
    };

    for (const provider of PROVIDERS) {
      const hasAccess =
        providerNeedsKey(provider.id) ? !!keys[provider.id] : false;
      if (!hasAccess) continue;
      if (provider.id === "sumopod") {
        add(sumopodModels.models);
        continue;
      }
      if (provider.id === "openai-compatible") {
        add(oaiCompatModels);
        continue;
      }
      add(MODELS.filter((model) => model.provider === provider.id));
    }

    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [keys, oaiCompatModels, sumopodModels.models]);
  // Resolve the selected entry by id AND provider so a shared id shows the right
  // provider's label; fall back to id-based lookup for pre-provider saved data.
  const selected = value
    ? (availableModels.find((m) => m.id === value && (!provider || m.provider === provider)) ??
      tryGetModel(value) ??
      null)
    : null;
  const filteredModels = useMemo(
    () => availableModels.filter((m) => matchesQuery(m, query)),
    [availableModels, query],
  );
  const triggerLabel = selected ? selected.label : "Same as chat (default)";
  const triggerHint = selected ? selected.hint : "Uses the active chat model";

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger asChild>
        {/* Single-line trigger matching the default-model dropdown's style. */}
        <Button variant="outline" className="h-9 w-full justify-between gap-2 px-2.5 text-[12px]">
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selected ? <ProviderIcon provider={selected.provider} size={14} /> : null}
            <span className="truncate font-medium">{triggerLabel}</span>
            {triggerHint ? (
              <span className="text-muted-foreground truncate">· {triggerHint}</span>
            ) : null}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            strokeWidth={2}
            className="shrink-0 opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] w-(--radix-dropdown-menu-trigger-width) max-w-(--radix-dropdown-menu-trigger-width) overflow-hidden p-0"
      >
        <div className="border-border/60 bg-popover sticky top-0 z-10 border-b p-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key !== "Escape" &&
                e.key !== "ArrowDown" &&
                e.key !== "ArrowUp" &&
                e.key !== "Enter"
              ) {
                e.stopPropagation();
              }
            }}
            placeholder="Search models…"
            spellCheck={false}
            autoFocus
            className="h-7 text-[11.5px]"
          />
        </div>
        <div className="max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-1">
          <DropdownMenuItem
            className="flex flex-col items-start gap-0.5"
            onSelect={() => onChange("", null)}
          >
            <span>Same as chat (default)</span>
            <span className="text-muted-foreground text-[10px] font-normal">
              Uses the active chat model
            </span>
          </DropdownMenuItem>
          {filteredModels.map((m) => (
            <DropdownMenuItem
              key={`${m.provider}::${m.id}`}
              className={cn(
                "flex items-start gap-2",
                value === m.id && (!provider || provider === m.provider) && "bg-accent/50",
              )}
              onSelect={() => onChange(m.id, m.provider)}
            >
              <ProviderIcon provider={m.provider} size={14} className="mt-0.5 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{m.label}</span>
                <span className="text-muted-foreground line-clamp-2 text-[10px] leading-snug font-normal whitespace-normal">
                  {m.hint}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
          {availableModels.length === 0 ? (
            <div className="text-muted-foreground px-2 py-3 text-[10px] leading-snug">
              No configured models available yet. Add a provider key first.
            </div>
          ) : null}
          {availableModels.length > 0 && filteredModels.length === 0 ? (
            <div className="text-muted-foreground px-2 py-3 text-[10px] leading-snug">
              No models match “{query}”.
            </div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
