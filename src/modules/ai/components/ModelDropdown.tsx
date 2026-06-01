import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  ArrowDown01Icon,
  ChatGptIcon,
  ClaudeIcon,
  CloudServerIcon,
  ComputerIcon,
  CpuIcon,
  DeepseekIcon,
  FlashIcon,
  GlobalIcon,
  GoogleGeminiIcon,
  Grok02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPinnedModelIds } from "@/modules/settings/store";
import {
  getDetectedModels,
  getModel,
  MODELS,
  providerNeedsKey,
  PROVIDERS,
  type DynamicModelId,
  type ModelInfo,
  type ProviderId,
  type ProviderInfo,
} from "../config";
import { getOpenAICompatibleModelsState, useOpenAICompatibleModels } from "../lib/openaiCompatible";
import { useSumopodModels } from "../lib/sumopod";
import { useChatStore } from "../store/chatStore";
import { pinKey } from "./modelPinUtils";
import { ModelSection } from "./ModelSection";

const PROVIDER_ICON = {
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  deepseek: DeepseekIcon,
  sumopod: CloudServerIcon,
  "openai-compatible": GlobalIcon,
  lmstudio: ComputerIcon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

function matchesQuery(m: { id: string; label: string; hint: string }, q: string): boolean {
  if (!q) return true;
  const t = q.toLowerCase();
  return (
    m.id.toLowerCase().includes(t) ||
    m.label.toLowerCase().includes(t) ||
    m.hint.toLowerCase().includes(t)
  );
}

export function ModelDropdown() {
  const selected = useChatStore((s) => s.selectedModelId);
  const selectedProvider = useChatStore((s) => s.selectedProvider);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const sumopodModels = useSumopodModels();
  // Subscribe to openai-compatible detection changes (any instance) so the
  // dropdown re-renders as catalogues resolve. The aggregated model list is
  // read from the dynamic registry; per-instance status drives the note.
  useOpenAICompatibleModels();
  const oaiCompatInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);
  const oaiCompatModels = getDetectedModels("openai-compatible");
  const oaiCompatAggStatus = (() => {
    let sawError = false;
    let sawOk = false;
    for (const inst of oaiCompatInstances) {
      const s = getOpenAICompatibleModelsState(inst.id).status;
      if (s === "loading") return "loading" as const;
      if (s === "ok") sawOk = true;
      if (s === "error") sawError = true;
    }
    if (sawOk) return "ok" as const;
    if (sawError) return "error" as const;
    return "idle" as const;
  })();
  const pinnedModelIds = usePreferencesStore((s) => s.pinnedModelIds);
  const [query, setQuery] = useState("");
  // Sections start expanded; component-local state resets each open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // `getModel` throws for runtime-detected ids missing from MODELS. Fall back
  // to a synthetic ModelInfo so the trigger doesn't mislabel them.
  let current: ModelInfo;
  try {
    current = getModel(selected);
  } catch {
    const providerLabel =
      PROVIDERS.find((p) => p.id === selectedProvider)?.label ?? selectedProvider;
    current = {
      id: selected,
      provider: selectedProvider,
      label: selected,
      hint: providerLabel,
    };
  }
  const currentProviderHasKey = !!apiKeys[current.provider];

  const onPick = (id: DynamicModelId, providerId: ProviderId) => {
    if (!apiKeys[providerId]) {
      void openSettingsWindow("models");
      return;
    }
    setSelected(id, providerId);
  };

  const togglePin = useCallback((providerId: ProviderId, modelId: string) => {
    const pinned = usePreferencesStore.getState().pinnedModelIds;
    const k = pinKey(providerId, modelId);
    if (pinned.includes(k)) {
      void setPinnedModelIds(pinned.filter((id) => id !== k));
      return;
    }
    // Swap any legacy unqualified entry for the qualified form so future
    // toggles distinguish providers.
    const withoutLegacy = pinned.filter((id) => id !== modelId);
    void setPinnedModelIds([k, ...withoutLegacy]);
  }, []);

  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const modelTooltip = currentProviderHasKey
    ? `Model: ${current.label}`
    : `${current.label}, no key configured`;

  // Hide providers the user has not configured. Keyless providers
  // (LM Studio) are always shown because they don't gate on a credential
  // the user can withhold. Filtering keeps the chat dropdown clean - a
  // grid of 10 empty "Set key →" rows for someone who only configured
  // Anthropic is noise, not affordance.
  const sections = useMemo(
    () =>
      PROVIDERS.flatMap((p) => {
        if (providerNeedsKey(p.id) && !apiKeys[p.id]) return [];
        const all =
          p.id === "sumopod"
            ? sumopodModels.models
            : p.id === "openai-compatible"
              ? oaiCompatModels
              : MODELS.filter((m) => m.provider === p.id);
        const filtered = all.filter((m) => matchesQuery(m, query));
        return [{ provider: p, all, filtered }];
      }),
    [query, apiKeys, sumopodModels.models, oaiCompatModels],
  );

  // Resolve pinned ids to ModelInfo. Two lookups: qualified (provider::modelId)
  // for new pins, legacy (modelId only) for back-compat. Legacy picks the first
  // provider in PROVIDERS order. Unresolvable ids are dropped.
  const pinnedEntries = useMemo(() => {
    const qualified = new Map<string, { model: ModelInfo; provider: ProviderInfo }>();
    const legacy = new Map<string, { model: ModelInfo; provider: ProviderInfo }>();
    for (const { provider, all } of sections) {
      for (const m of all) {
        qualified.set(pinKey(provider.id, m.id), { model: m, provider });
        if (!legacy.has(m.id)) legacy.set(m.id, { model: m, provider });
      }
    }
    const out: { model: ModelInfo; provider: ProviderInfo }[] = [];
    for (const pinId of pinnedModelIds) {
      const hit = qualified.get(pinId) ?? legacy.get(pinId);
      if (hit) out.push(hit);
    }
    return out;
  }, [sections, pinnedModelIds]);

  const pinnedFiltered = useMemo(
    () => pinnedEntries.filter(({ model }) => matchesQuery(model, query)),
    [pinnedEntries, query],
  );

  const totalMatches = pinnedFiltered.length + sections.reduce((n, s) => n + s.filtered.length, 0);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={modelTooltip}
              className={cn(
                TOOLBAR_HOVER,
                "my-1 h-5.5 max-w-28 min-w-0 gap-1 rounded-md px-1.5 text-xs",
                currentProviderHasKey ? "text-muted-foreground" : "text-icon-working",
              )}
            >
              <span className="truncate">{current.label}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={2}
                className="shrink-0 opacity-70"
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{modelTooltip}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-105 w-72 overflow-hidden p-0">
        <div className="border-border/60 bg-popover sticky top-0 z-10 border-b p-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Radix DropdownMenu uses letter keys for type-ahead. Stop them
              // here so typing doesn't jump focus to items.
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
        <div className="max-h-92 overflow-y-auto">
          {pinnedEntries.length > 0 ? (
            <ModelSection
              sectionKey="__pinned"
              title="Pinned"
              models={pinnedFiltered.map(({ model, provider }) => ({
                model,
                provider,
                hasKey: providerNeedsKey(provider.id) ? !!apiKeys[provider.id] : true,
              }))}
              collapsed={collapsed.has("__pinned")}
              onToggle={() => toggleSection("__pinned")}
              query={query}
              selectedId={selected}
              selectedProviderId={selectedProvider}
              pinnedIds={pinnedModelIds}
              onPick={onPick}
              onTogglePin={togglePin}
            />
          ) : null}
          {sections.map(({ provider: p, filtered }) => {
            if (filtered.length === 0 && query) return null;
            const hasKey = providerNeedsKey(p.id) ? !!apiKeys[p.id] : true;
            // Detection status note for providers whose catalogue is fetched
            // dynamically (SumoPod, OpenRouter, OpenAI-Compatible). The
            // variable name is historic; it now covers three gateways.
            const sumopodNote =
              p.id === "sumopod" && hasKey
                ? sumopodModels.status === "loading"
                  ? "Detecting models…"
                  : sumopodModels.status === "error"
                    ? "Detection failed"
                    : filtered.length === 0
                      ? "No models detected"
                      : null
                : p.id === "openai-compatible" && hasKey
                  ? oaiCompatAggStatus === "loading"
                    ? "Detecting models…"
                    : oaiCompatAggStatus === "error"
                      ? "Detection failed"
                      : filtered.length === 0
                        ? "No models detected · open Settings → Models"
                        : null
                  : null;
            return (
              <ModelSection
                key={p.id}
                sectionKey={p.id}
                title={p.label}
                providerIcon={PROVIDER_ICON[p.id]}
                missingKey={!hasKey}
                onSetKey={() => void openSettingsWindow("models")}
                note={sumopodNote}
                models={filtered.map((m) => ({
                  model: m,
                  provider: p,
                  hasKey,
                }))}
                collapsed={collapsed.has(p.id)}
                onToggle={() => toggleSection(p.id)}
                query={query}
                selectedId={selected}
                selectedProviderId={selectedProvider}
                pinnedIds={pinnedModelIds}
                onPick={onPick}
                onTogglePin={togglePin}
              />
            );
          })}
          {!query && pinnedEntries.length === 0 && sections.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
              <span className="text-muted-foreground text-[11px]">
                No AI providers configured yet.
              </span>
              <button
                type="button"
                onClick={() => void openSettingsWindow("models")}
                className="text-foreground hover:bg-accent border-border/60 rounded-md border px-2 py-1 text-[11px]"
              >
                Open Settings → Models
              </button>
            </div>
          ) : null}
          {query && totalMatches === 0 ? (
            <div className="text-muted-foreground px-3 py-6 text-center text-[11px]">
              No models match “{query}”.
            </div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
