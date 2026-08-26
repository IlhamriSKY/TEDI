import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, matchesQuery } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useCallback, useMemo, useState } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPinnedModelIds } from "@/modules/settings/store";
import {
  getDetectedModels,
  groupOpenAICompatibleByInstance,
  MODELS,
  providerIsConnected,
  PROVIDERS,
  resolveModelInfo,
  type DynamicModelId,
  type ModelInfo,
  type ProviderId,
  type ProviderInfo,
} from "../config";
import {
  getOpenAICompatibleModelsState,
  isOpenAICompatibleInstanceReady,
  useOpenAICompatibleModels,
} from "../lib/openaiCompatible";
import { useSumopodModels } from "../lib/sumopod";
import { useAgentRouterModels } from "../lib/agentrouter";
import { useChatStore } from "../store/chatStore";
import { pinKey } from "./modelPinUtils";
import { ModelSection } from "./ModelSection";
import { ChevronDown } from "lucide-react";

export function ModelDropdown() {
  const selected = useChatStore((s) => s.selectedModelId);
  const selectedProvider = useChatStore((s) => s.selectedProvider);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const sumopodModels = useSumopodModels();
  const agentRouterModels = useAgentRouterModels();
  // Gateways whose catalogue is fetched at runtime rather than living in the
  // static MODELS table. Keyed by provider id so both the model list and the
  // detection note are one lookup instead of a ternary chain per provider.
  // Memoised so it stays referentially stable between detections: the section
  // list below depends on it, and a fresh object each render would defeat that
  // memo and re-filter every model on every keystroke.
  const gatewayCatalogues = useMemo(
    () =>
      ({ sumopod: sumopodModels, agentrouter: agentRouterModels }) as Partial<
        Record<ProviderId, { models: ModelInfo[]; status: string; error: string | null }>
      >,
    [sumopodModels, agentRouterModels],
  );
  // Subscribe to openai-compatible detection changes (any instance) so the
  // dropdown re-renders as catalogues resolve. The aggregated model list is
  // read from the dynamic registry; per-instance status drives the note.
  useOpenAICompatibleModels();
  const oaiCompatInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);
  const oaiCompatModels = getDetectedModels("openai-compatible");
  const pinnedModelIds = usePreferencesStore((s) => s.pinnedModelIds);
  const [query, setQuery] = useState("");
  // Sections default to COLLAPSED: with every provider expanded the list ran to
  // hundreds of rows and the current model was somewhere off-screen. Only the
  // two worth landing on open themselves - Pinned, and the group holding the
  // model in use.
  //
  // This holds ONLY sections the user toggled by hand, never the default, so
  // picking a model in another provider still moves the auto-opened group. It is
  // cleared when the dropdown closes, so every open starts tidy again.
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});
  // Resolve against the SELECTED provider, not id-lookup: an id shared by two
  // providers (e.g. deepseek-v4-pro on native DeepSeek + SumoPod) must report the
  // key status of the one actually picked, else the trigger shows a false "no key"
  // warning for a model that works. Mirrors the send path (resolveModelInfo), and
  // never throws for runtime-detected ids missing from MODELS.
  const current = resolveModelInfo(selected, selectedProvider);
  const currentProviderHasKey = providerIsConnected(current.provider, apiKeys);

  const onPick = (id: DynamicModelId, providerId: ProviderId) => {
    // Keyless providers (LM Studio) have no apiKeys entry, and ChatGPT is
    // connected by signing in rather than by a key - `providerIsConnected` is
    // the question worth asking, "does it take a key" is not.
    if (!providerIsConnected(providerId, apiKeys)) {
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

  const toggleSection = useCallback((key: string, isOpen: boolean) => {
    setOpenOverrides((prev) => ({ ...prev, [key]: !isOpen }));
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
        // openai-compatible is gated per-instance below (a keyless loopback
        // endpoint is valid, and the shared apiKeys slot only reflects the
        // default instance), so never drop the whole provider on that slot -
        // that hid every working local server's models from the picker.
        if (p.id !== "openai-compatible" && !providerIsConnected(p.id, apiKeys)) return [];
        // OpenAI-Compatible: one section per configured endpoint, headed by its
        // label, since several can be added under the one provider id.
        if (p.id === "openai-compatible") {
          return groupOpenAICompatibleByInstance(oaiCompatModels, oaiCompatInstances).map((g) => ({
            provider: p,
            sectionKey: `oac:${g.instanceId}`,
            title: g.label,
            instanceId: g.instanceId as string | null,
            all: g.models,
            filtered: g.models.filter((m) => matchesQuery(m, query)),
          }));
        }
        const all = gatewayCatalogues[p.id]?.models ?? MODELS.filter((m) => m.provider === p.id);
        const filtered = all.filter((m) => matchesQuery(m, query));
        return [
          {
            provider: p,
            sectionKey: p.id,
            title: p.label,
            instanceId: null as string | null,
            all,
            filtered,
          },
        ];
      }),
    [query, apiKeys, gatewayCatalogues, oaiCompatModels, oaiCompatInstances],
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

  // Which section holds the model in use. Provider-matched first: an id served by
  // two providers (deepseek-v4-pro on native DeepSeek and on SumoPod) would
  // otherwise open whichever section happens to come first. `current.provider` is
  // the resolved one, so it agrees with the trigger label and the send path.
  const selectedSectionKey = useMemo(() => {
    const holdsSelected = (s: (typeof sections)[number]): boolean =>
      s.all.some((m) => m.id === selected);
    return (
      sections.find((s) => s.provider.id === current.provider && holdsSelected(s)) ??
      sections.find(holdsSelected)
    )?.sectionKey;
  }, [sections, selected, current.provider]);

  // A search must never hide its own matches, so a query opens everything;
  // sections with no match are dropped from the list entirely below.
  const isSectionOpen = (key: string): boolean =>
    query ? true : (openOverrides[key] ?? (key === "__pinned" || key === selectedSectionKey));

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) return;
        setQuery("");
        // Drop hand-toggled sections too, so the next open is back to just
        // Pinned + the current model's group rather than however it was left.
        setOpenOverrides({});
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
                // `shrink` overrides the Button base `shrink-0` so this trigger
                // is the element that gives up width when the composer toolbar
                // is narrow - the action buttons (incl. Send) stay full-size.
                "my-1 h-5.5 max-w-52 min-w-0 shrink gap-1.5 rounded-md px-1.5 text-xs",
                currentProviderHasKey ? "text-muted-foreground" : "text-icon-working",
              )}
            >
              {/* Provider icon intentionally omitted here - it lives only in the
                  dropdown's section headers, keeping the composer trigger compact.
                  Label + hint truncate as one line so the trigger can shrink to
                  near-zero (ellipsis at the end) instead of clipping Send. */}
              <span className="min-w-0 truncate text-left">
                <span className="font-medium">{current.label}</span>
                {current.hint ? (
                  <span className="text-muted-foreground/70 font-normal"> · {current.hint}</span>
                ) : null}
              </span>
              <ChevronDown size={11} strokeWidth={2} className="shrink-0 opacity-70" />
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
                hasKey: providerIsConnected(provider.id, apiKeys),
              }))}
              collapsed={!isSectionOpen("__pinned")}
              onToggle={() => toggleSection("__pinned", isSectionOpen("__pinned"))}
              query={query}
              selectedId={selected}
              selectedProviderId={selectedProvider}
              pinnedIds={pinnedModelIds}
              onPick={onPick}
              onTogglePin={togglePin}
            />
          ) : null}
          {sections.map((s) => {
            const p = s.provider;
            if (s.filtered.length === 0 && query) return null;
            // Per-instance for openai-compatible: a local endpoint is usable with
            // no key at all, and the shared `apiKeys["openai-compatible"]` slot
            // only ever reflects the default instance. Gating on it alone greyed
            // out a working local server's models.
            const hasKey =
              p.id === "openai-compatible" && s.instanceId
                ? isOpenAICompatibleInstanceReady(
                    oaiCompatInstances.find((i) => i.id === s.instanceId)?.baseURL ?? "",
                    apiKeys[p.id],
                  )
                : providerIsConnected(p.id, apiKeys);
            // Detection status note for gateways whose catalogue is fetched
            // dynamically. OpenAI-Compatible reads its own instance's status.
            const gateway = gatewayCatalogues[p.id];
            const note =
              gateway && hasKey
                ? gateway.status === "loading"
                  ? "Detecting models…"
                  : gateway.status === "error"
                    ? // The message, not a bare "Detection failed": AgentRouter's
                      // two 401s (rejected client vs rejected key) need opposite
                      // fixes and are indistinguishable without it.
                      (gateway.error ?? "Detection failed")
                    : s.filtered.length === 0
                      ? "No models detected"
                      : null
                : p.id === "openai-compatible" && hasKey && s.instanceId
                  ? (() => {
                      const st = getOpenAICompatibleModelsState(s.instanceId).status;
                      return st === "loading"
                        ? "Detecting models…"
                        : st === "error"
                          ? "Detection failed"
                          : s.filtered.length === 0
                            ? "No models detected · open Settings → Models"
                            : null;
                    })()
                  : null;
            return (
              <ModelSection
                key={s.sectionKey}
                sectionKey={s.sectionKey}
                title={s.title}
                providerId={p.id}
                missingKey={!hasKey}
                onSetKey={() => void openSettingsWindow("models")}
                note={note}
                models={s.filtered.map((m) => ({
                  model: m,
                  provider: p,
                  hasKey,
                }))}
                collapsed={!isSectionOpen(s.sectionKey)}
                onToggle={() => toggleSection(s.sectionKey, isSectionOpen(s.sectionKey))}
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
