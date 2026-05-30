import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUTOCOMPLETE_PROVIDERS,
  DEFAULT_AUTOCOMPLETE_MODEL,
  getDetectedModels,
  MODELS,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
  OPENAI_COMPATIBLE_PRESETS,
  PROVIDERS,
  getProvider,
  providerNeedsKey,
  tryGetModel,
  type AutocompleteProviderId,
  type OpenAICompatibleInstance,
  type ProviderId,
} from "@/modules/ai/config";
import {
  clearKey,
  clearOpenAICompatibleInstanceKey,
  getAllKeys,
  getOpenAICompatibleInstanceKey,
  setKey,
  setOpenAICompatibleInstanceKey,
} from "@/modules/ai/lib/keyring";
import {
  clearOpenAICompatibleInstance,
  getOpenAICompatibleModelsState,
  refreshOpenAICompatibleInstance,
  useOpenAICompatibleModels,
} from "@/modules/ai/lib/openaiCompatible";
import {
  clearSumopodModels,
  refreshSumopodModels,
  useSumopodModels,
} from "@/modules/ai/lib/sumopod";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  emitKeysChanged,
  setAutocompleteEnabled,
  setAutocompleteModelId,
  setAutocompleteProvider,
  setDefaultModel,
  setLmstudioBaseURL,
  setOpenAICompatibleInstances,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Edit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";

type KeysMap = Record<ProviderId, string | null>;

function matchesQuery(m: { id: string; label: string; hint: string }, q: string): boolean {
  if (!q) return true;
  const t = q.toLowerCase();
  return (
    m.id.toLowerCase().includes(t) ||
    m.label.toLowerCase().includes(t) ||
    m.hint.toLowerCase().includes(t)
  );
}

/** Combine per-instance detection statuses into one for the dropdown header:
 *  "loading" if any instance is loading, "ok" if any resolved, else "error"
 *  when at least one failed, else "idle". */
function aggregateOaiCompatStatus(
  instances: ReadonlyArray<OpenAICompatibleInstance>,
): "idle" | "loading" | "ok" | "error" {
  let sawError = false;
  let sawOk = false;
  for (const inst of instances) {
    const s = getOpenAICompatibleModelsState(inst.id).status;
    if (s === "loading") return "loading";
    if (s === "ok") sawOk = true;
    if (s === "error") sawError = true;
  }
  if (sawOk) return "ok";
  if (sawError) return "error";
  return "idle";
}

export function ModelsSection() {
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const defaultModel = usePreferencesStore((s) => s.defaultModelId);
  const defaultProvider = usePreferencesStore((s) => s.defaultProviderId);
  const oaiCompatInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);
  // Per-instance API keys, loaded from the OS keychain (never persisted to the
  // settings store). Keyed by instance id. Mirrors `keys["openai-compatible"]`
  // for the default instance so existing gating still works.
  const [instanceKeys, setInstanceKeys] = useState<Record<string, string | null>>({});
  const sumopodModels = useSumopodModels();
  // Subscribe to openai-compatible detection-state changes (any instance) so
  // the dropdown re-renders when a catalogue resolves. The return value isn't
  // read directly; per-instance state is pulled via getOpenAICompatibleModelsState.
  useOpenAICompatibleModels();
  const [modelQuery, setModelQuery] = useState("");
  // Search filter for the "+ Add provider" dropdown. Cleared when the
  // dropdown closes so reopening starts fresh.
  const [addProviderQuery, setAddProviderQuery] = useState("");
  // When the user picks a provider from the "Add provider" dropdown, we
  // hold its id here. The provider's card is rendered in editing mode below
  // the connected list until the key is saved (which clears this back to
  // null). For OpenAI Compatible the "card" is the full URL+key block.
  const [addingProvider, setAddingProvider] = useState<ProviderId | null>(null);
  // Open provider accordions. Reset on dropdown open to start with the current default expanded.
  const [expandedProviders, setExpandedProviders] = useState<Set<ProviderId>>(new Set());
  const toggleProvider = (id: ProviderId) =>
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    void getAllKeys().then((k) => {
      setKeys(k);
      if (k.sumopod) void refreshSumopodModels(k.sumopod);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load each openai-compatible instance's key from the keychain and kick off
  // detection. Runs when the instances list changes (add/remove/edit URL).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        oaiCompatInstances.map(
          async (inst) => [inst.id, await getOpenAICompatibleInstanceKey(inst.id)] as const,
        ),
      );
      if (cancelled) return;
      setInstanceKeys((prev) => {
        const next = { ...prev };
        for (const [id, key] of entries) next[id] = key;
        return next;
      });
      for (const inst of oaiCompatInstances) {
        const key = entries.find(([id]) => id === inst.id)?.[1] ?? null;
        if (key && inst.baseURL) {
          void refreshOpenAICompatibleInstance(inst.id, key, inst.baseURL);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [oaiCompatInstances]);

  const onSave = async (provider: ProviderId, value: string) => {
    await setKey(provider, value);
    setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
    await emitKeysChanged();
    // Once the key is persisted, the provider is "connected"; clear the
    // in-progress add slot so the configured-providers list takes over.
    setAddingProvider((cur) => (cur === provider ? null : cur));
    if (provider === "sumopod") void refreshSumopodModels(value);
  };

  const onClear = async (provider: ProviderId) => {
    await clearKey(provider);
    setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
    await emitKeysChanged();
    if (provider === "sumopod") clearSumopodModels();
  };

  // Persist (or update) one openai-compatible endpoint: writes label + base URL
  // to the instances list, stores the key in the keychain, then refreshes the
  // catalogue. `instanceId` is supplied when editing an existing endpoint;
  // omit it to mint a new one. Returns the resolved instance id.
  const onSaveInstance = async (
    input: { instanceId?: string; label: string; baseURL: string; apiKey: string },
  ): Promise<string> => {
    const baseURL = input.baseURL.trim();
    const apiKey = input.apiKey.trim();
    const isFirst = oaiCompatInstances.length === 0;
    // First endpoint claims the legacy id so it reuses the original keychain
    // account and the migrated base URL; later ones get a unique id.
    const instanceId =
      input.instanceId ??
      (isFirst ? OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID : `oc-${Date.now().toString(36)}`);
    const label = input.label.trim() || "OpenAI Compatible";

    // Reject a duplicate API key: two endpoints sharing the same key surface the
    // identical model catalogue, cluttering the model dropdown. Same base URL is
    // fine (two accounts on one gateway), but the key must differ. Checked
    // against every OTHER instance's key loaded from the keychain.
    if (apiKey) {
      const clash = oaiCompatInstances.find(
        (i) => i.id !== instanceId && (instanceKeys[i.id] ?? "").trim() === apiKey,
      );
      if (clash) {
        throw new Error(`API key already used by "${clash.label}". Use a different key.`);
      }
    }

    const existing = oaiCompatInstances.find((i) => i.id === instanceId);
    const nextInstances: OpenAICompatibleInstance[] = existing
      ? oaiCompatInstances.map((i) => (i.id === instanceId ? { ...i, label, baseURL } : i))
      : [...oaiCompatInstances, { id: instanceId, label, baseURL }];

    await setOpenAICompatibleInstances(nextInstances);
    if (apiKey) await setOpenAICompatibleInstanceKey(instanceId, apiKey);
    setInstanceKeys((prev) => ({ ...prev, [instanceId]: apiKey || prev[instanceId] || null }));
    // Mirror connectivity into the shared keys map so dropdown gating treats
    // "openai-compatible" as connected when any instance has a key.
    setKeys((prev) => (prev ? { ...prev, "openai-compatible": apiKey || prev["openai-compatible"] } : prev));
    await emitKeysChanged();
    setAddingProvider((cur) => (cur === "openai-compatible" ? null : cur));
    const keyForRefresh = apiKey || instanceKeys[instanceId];
    if (keyForRefresh && baseURL) {
      void refreshOpenAICompatibleInstance(instanceId, keyForRefresh, baseURL);
    }
    return instanceId;
  };

  // Remove one openai-compatible endpoint entirely: drop it from the list,
  // delete its keychain key, and clear its detected models.
  const onRemoveInstance = async (instanceId: string): Promise<void> => {
    const nextInstances = oaiCompatInstances.filter((i) => i.id !== instanceId);
    await setOpenAICompatibleInstances(nextInstances);
    await clearOpenAICompatibleInstanceKey(instanceId);
    clearOpenAICompatibleInstance(instanceId);
    setInstanceKeys((prev) => {
      const next = { ...prev };
      delete next[instanceId];
      return next;
    });
    // If no endpoints remain, mark openai-compatible disconnected in the gate map.
    if (nextInstances.length === 0) {
      setKeys((prev) => (prev ? { ...prev, "openai-compatible": null } : prev));
    }
    await emitKeysChanged();
  };

  if (!keys) {
    return <div className="text-muted-foreground text-[12px]">Loading…</div>;
  }

  // All detected openai-compatible models across every instance. Aggregated
  // from the dynamic registry so the dropdown lists each endpoint's catalogue
  // under one "OpenAI Compatible" section.
  const oaiCompatModels = getDetectedModels("openai-compatible");

  // Resolve display info using the saved provider when present. Disambiguates ids shared across providers.
  const defaultModelInfo = (() => {
    if (defaultProvider) {
      const pool =
        defaultProvider === "sumopod"
          ? sumopodModels.models
          : defaultProvider === "openai-compatible"
            ? oaiCompatModels
            : MODELS.filter((m) => m.provider === defaultProvider);
      const hit = pool.find((m) => m.id === defaultModel);
      if (hit) return hit;
      const providerLabel =
        PROVIDERS.find((p) => p.id === defaultProvider)?.label ?? defaultProvider;
      return {
        id: defaultModel,
        provider: defaultProvider,
        label: defaultModel,
        hint: providerLabel,
      };
    }
    return (
      tryGetModel(defaultModel) ?? {
        id: defaultModel,
        provider: "sumopod" as ProviderId,
        label: defaultModel,
        hint: "SumoPod",
      }
    );
  })();
  // Native key providers (excluding OpenAI Compatible, which has its own
  // URL+key block). Each appears as a card only when configured OR when
  // currently being added from the dropdown below.
  const keyedProviders = PROVIDERS.filter(
    (p) => providerNeedsKey(p.id) && p.id !== "openai-compatible",
  );
  const configuredKeyed = keyedProviders.filter((p) => !!keys[p.id]);
  const oaiCompatConfigured = oaiCompatInstances.length > 0;
  const oaiCompatAdding = addingProvider === "openai-compatible";
  // Providers eligible to appear in the "+ Add provider" dropdown: every
  // provider needing a key, minus the ones already connected and minus the
  // one mid-add. OpenAI Compatible is special: it's always addable (each pick
  // mints a NEW endpoint, since multiple are supported). LM Studio is excluded
  // because it's keyless and configured from the Editor autocomplete block.
  const addableProviders = PROVIDERS.filter(
    (p) =>
      providerNeedsKey(p.id) &&
      (p.id === "openai-compatible" || !keys[p.id]) &&
      p.id !== addingProvider,
  );

  // Default-model dropdown rendered both at the top (rare path) and at the
  // bottom in the AI defaults card. Extracted into a small JSX const so the
  // markup stays in one place. The card itself owns the surrounding layout
  // (label, description, hr) - this is the trigger + popover only.
  const defaultModelDropdown = (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          setExpandedProviders(defaultProvider ? new Set([defaultProvider]) : new Set());
        } else {
          setModelQuery("");
        }
      }}
    >
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-9 w-full justify-between gap-2 px-2.5 text-[12px]"
            >
              <span className="flex min-w-0 items-center gap-2 truncate">
                <ProviderIcon provider={defaultModelInfo.provider} size={14} />
                <span className="truncate font-medium">{defaultModelInfo.label}</span>
                {/* Mark this as THE app default: it drives the native AI agent
                 *  and the "AI write commit message" action. */}
                <span className="border-primary/40 bg-primary/10 text-primary shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase">
                  Default
                </span>
                <span className="text-muted-foreground truncate">
                  · {defaultModelInfo.hint}
                </span>
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
            className="max-h-105 w-(--radix-dropdown-menu-trigger-width) min-w-72 overflow-hidden p-0"
          >
            <div className="border-border/60 bg-popover sticky top-0 z-10 border-b p-1.5">
              <Input
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
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
            <div className="max-h-92 overflow-y-auto">
              {(() => {
                const searching = modelQuery.length > 0;
                let totalMatches = 0;
                // Only iterate providers the user has actually configured.
                // The previous behaviour listed all 10 providers as "no key"
                // rows, padding the dropdown with affordances for accounts
                // the user has not (and may never) sign up for.
                const blocks = PROVIDERS.flatMap((p) => {
                  if (!(providerNeedsKey(p.id) && !!keys[p.id])) return [];
                  const all =
                    p.id === "sumopod"
                      ? sumopodModels.models
                      : p.id === "openai-compatible"
                        ? oaiCompatModels
                        : MODELS.filter((m) => m.provider === p.id);
                  const filtered = all.filter((m) => matchesQuery(m, modelQuery));
                  totalMatches += filtered.length;
                  if (filtered.length === 0 && searching) return null;
                  const hasKey = !!keys[p.id];
                  // Aggregate detection status: SumoPod has one stream;
                  // openai-compatible combines every instance's status.
                  const dynamicStatus =
                    p.id === "sumopod"
                      ? sumopodModels.status
                      : p.id === "openai-compatible"
                        ? aggregateOaiCompatStatus(oaiCompatInstances)
                        : null;
                  const isDynamicEmpty = !!dynamicStatus && hasKey && filtered.length === 0;
                  const dynamicNote =
                    dynamicStatus && hasKey
                      ? dynamicStatus === "loading"
                        ? "Detecting models…"
                        : dynamicStatus === "error"
                          ? "Detection failed - check key / URL"
                          : null
                      : null;
                  // While searching, expand every provider with matches.
                  const isOpen = searching || expandedProviders.has(p.id);
                  return (
                    <div key={p.id} className="px-1 pt-1">
                      <button
                        type="button"
                        onClick={() => !searching && toggleProvider(p.id)}
                        aria-expanded={isOpen}
                        disabled={searching}
                        className={cn(
                          "hover:bg-accent/50 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium tracking-wide uppercase transition-colors",
                          "text-muted-foreground",
                          searching && "cursor-default hover:bg-transparent",
                        )}
                      >
                        <HugeiconsIcon
                          icon={isOpen ? ArrowDown01Icon : ArrowRight01Icon}
                          size={10}
                          strokeWidth={2}
                          className={cn("opacity-60", searching && "invisible")}
                        />
                        <ProviderIcon provider={p.id} size={11} />
                        <span>{p.label}</span>
                        <span className="text-muted-foreground/60 tracking-normal normal-case">
                          ({filtered.length})
                        </span>
                        {!hasKey && (
                          <span className="text-muted-foreground/70 ml-auto tracking-normal normal-case">
                            no key
                          </span>
                        )}
                      </button>
                      {isOpen ? (
                        <div className="pt-0.5 pb-1">
                          {dynamicNote ? (
                            <div className="text-muted-foreground/80 px-2 pb-1 text-[10px] normal-case">
                              {dynamicNote}
                            </div>
                          ) : null}
                          {isDynamicEmpty && !dynamicNote ? (
                            <div className="text-muted-foreground/80 px-2 pb-1 text-[10px] normal-case">
                              No models detected.
                            </div>
                          ) : null}
                          {filtered.map((m) => (
                            <DropdownMenuItem
                              key={`${m.provider}::${m.id}`}
                              disabled={!hasKey}
                              onSelect={() => hasKey && void setDefaultModel(m.id, m.provider)}
                              className={cn(
                                "flex items-center justify-between gap-2 text-[12px]",
                                m.id === defaultModel &&
                                  m.provider === defaultModelInfo.provider &&
                                  "bg-accent/50",
                              )}
                            >
                              <span className="flex flex-col">
                                <span>{m.label}</span>
                                <span className="text-muted-foreground text-[10px]">{m.hint}</span>
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                });
                return (
                  <>
                    {blocks}
                    {!searching && blocks.length === 0 ? (
                      <div className="text-muted-foreground px-3 py-6 text-center text-[11px]">
                        No providers connected yet. Add one below.
                      </div>
                    ) : null}
                    {searching && totalMatches === 0 ? (
                      <div className="text-muted-foreground px-3 py-6 text-center text-[11px]">
                        No models match “{modelQuery}”.
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
  );

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Models"
        description="Connect the providers you use. Keys live in your OS keychain and are used only by TEDI."
      />

      {/* Defaults card - Chat model + Autocomplete on inline label-control
       *  rows. Per the spec mockup: label fixed-width on the left, control
       *  fills the rest. The autocomplete row also gets a Switch directly
       *  next to the label so toggling on/off is one click away from
       *  picking the model. */}
      <div className="flex flex-col gap-2">
        <Label>Defaults</Label>
        <div className="border-border/60 bg-card/40 flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="text-muted-foreground text-[11.5px] sm:w-24 sm:shrink-0">
                Default model
              </span>
              <div className="min-w-0 flex-1">{defaultModelDropdown}</div>
            </div>
            {/* Clarify that this picker sets the app-wide default model: it
             *  drives the native AI agent and the SCM "AI write commit message"
             *  action. */}
            <span className="text-muted-foreground/80 text-[10.5px] sm:pl-[calc(6rem+0.75rem)]">
              Used by the AI agent and to generate Git commit messages.
            </span>
          </div>

          <AutocompleteBlock keys={keys} />
        </div>
      </div>

      {/* Providers section - header has "+ Add provider" inline on the
       *  right; cards (or empty state) sit below. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label>Providers</Label>
          {addableProviders.length > 0 ? (
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) setAddProviderQuery("");
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 rounded-full px-3 text-[11.5px]"
                >
                  <HugeiconsIcon
                    icon={Add01Icon}
                    size={12}
                    strokeWidth={2}
                    className="opacity-80"
                  />
                  Add provider
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="bottom"
                sideOffset={4}
                avoidCollisions={false}
                className="w-64 overflow-hidden p-0"
              >
                <div className="border-border/60 bg-popover sticky top-0 z-10 border-b p-1.5">
                  <Input
                    value={addProviderQuery}
                    onChange={(e) => setAddProviderQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // Radix dropdown uses letters for type-ahead; trap
                      // them here so typing only goes into the search box.
                      if (
                        e.key !== "Escape" &&
                        e.key !== "ArrowDown" &&
                        e.key !== "ArrowUp" &&
                        e.key !== "Enter"
                      ) {
                        e.stopPropagation();
                      }
                    }}
                    placeholder="Search providers…"
                    spellCheck={false}
                    autoFocus
                    className="h-7 text-[11.5px]"
                  />
                </div>
                {/* Cap the visible item list to ~5 rows; everything past
                 *  that scrolls. With ~30px per row (text-[12px] + py-1.5)
                 *  + 4px wrapper padding, 160px fits 5 items cleanly. */}
                <div className="max-h-[160px] overflow-y-auto py-1">
                  {(() => {
                    const q = addProviderQuery.trim().toLowerCase();
                    const filtered = addableProviders.filter(
                      (p) =>
                        !q || p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
                    );
                    if (filtered.length === 0) {
                      return (
                        <div className="text-muted-foreground px-3 py-4 text-center text-[11px]">
                          No providers match &ldquo;{addProviderQuery}&rdquo;.
                        </div>
                      );
                    }
                    return filtered.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onSelect={() => setAddingProvider(p.id)}
                        className="flex items-center gap-2 text-[12px]"
                      >
                        <ProviderIcon provider={p.id} size={13} />
                        <span>{p.label}</span>
                      </DropdownMenuItem>
                    ));
                  })()}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        {/* Empty-state: no providers connected AND no add in progress. */}
        {configuredKeyed.length === 0 &&
        !oaiCompatConfigured &&
        addingProvider === null ? (
          <div className="border-border/50 bg-card/30 flex flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-6 text-center">
            <span className="text-foreground text-[12.5px]">No providers connected yet.</span>
            <span className="text-muted-foreground text-[10.5px]">
              Click &ldquo;Add provider&rdquo; to connect a cloud or local model source.
            </span>
          </div>
        ) : null}

        {/* Cards for currently-connected native providers. */}
        {configuredKeyed.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {configuredKeyed.map((p) => (
              <ProviderKeyCard
                key={p.id}
                provider={p}
                currentKey={keys[p.id]}
                onSave={(v: string) => onSave(p.id, v)}
                onClear={() => onClear(p.id)}
              />
            ))}
          </div>
        ) : null}

        {/* Card for the provider being added - keyed kind only. */}
        {addingProvider && addingProvider !== "openai-compatible" ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[10.5px]">
              <div className="border-border/60 h-px flex-1 border-t" />
              <span className="text-muted-foreground">
                Connecting {getProvider(addingProvider).label}
              </span>
              <button
                type="button"
                onClick={() => setAddingProvider(null)}
                className="text-muted-foreground hover:text-foreground cursor-pointer underline-offset-2 hover:underline"
              >
                Cancel
              </button>
              <div className="border-border/60 h-px flex-1 border-t" />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ProviderKeyCard
                provider={getProvider(addingProvider)}
                currentKey={null}
                onSave={(v: string) => onSave(addingProvider, v)}
                onClear={() => {
                  setAddingProvider(null);
                  return Promise.resolve();
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* OpenAI Compatible endpoints: one block per configured instance, plus
       *  a block for the one being added. Multiple independent endpoints are
       *  supported (OpenRouter, a local router, a company gateway, …). */}
      {oaiCompatConfigured || oaiCompatAdding ? (
        <div className="flex flex-col gap-2">
          <Label>OpenAI Compatible endpoints</Label>
          {oaiCompatInstances.map((inst) => {
            const st = getOpenAICompatibleModelsState(inst.id);
            return (
              <OpenAICompatibleBlock
                key={inst.id}
                instance={inst}
                apiKey={instanceKeys[inst.id] ?? null}
                status={st.status}
                error={st.error}
                modelsCount={st.models.length}
                onSave={(label, url, key) =>
                  onSaveInstance({ instanceId: inst.id, label, baseURL: url, apiKey: key })
                }
                onRemove={() => onRemoveInstance(inst.id)}
              />
            );
          })}
          {oaiCompatAdding ? (
            <OpenAICompatibleBlock
              instance={null}
              apiKey={null}
              status="idle"
              error={null}
              modelsCount={0}
              onSave={(label, url, key) => onSaveInstance({ label, baseURL: url, apiKey: key })}
              onRemove={() => {
                setAddingProvider(null);
                return Promise.resolve();
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AutocompleteBlock({ keys }: { keys: KeysMap }) {
  const enabled = usePreferencesStore((s) => s.autocompleteEnabled);
  const provider = usePreferencesStore((s) => s.autocompleteProvider);
  const modelId = usePreferencesStore((s) => s.autocompleteModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);

  const [urlDraft, setUrlDraft] = useState(lmstudioBaseURL);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");

  useEffect(() => setUrlDraft(lmstudioBaseURL), [lmstudioBaseURL]);

  const onProviderChange = (next: AutocompleteProviderId) => {
    void setAutocompleteProvider(next);
    const knownDefaults = Object.values(DEFAULT_AUTOCOMPLETE_MODEL);
    if (knownDefaults.includes(modelId)) {
      void setAutocompleteModelId(DEFAULT_AUTOCOMPLETE_MODEL[next]);
    }
  };

  const providerInfo = getProvider(provider);
  const hasKey = providerNeedsKey(provider) ? !!keys[provider] : true;

  const testLmStudio = async () => {
    setTestStatus("testing");
    try {
      const url = urlDraft.replace(/\/$/, "") + "/models";
      const auth = keys[provider] ?? null;
      const status = await invoke<number>("http_ping", { url, auth });
      setTestStatus(status >= 200 && status < 400 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  // Display name for the currently-selected autocomplete combo. Walks the
  // static MODELS list first (gets the pretty label + hint), falls back to
  // the raw model id when the user has typed a custom one (LM Studio with
  // a local model not in the registry, mostly).
  const currentDisplay = (() => {
    const fromRegistry = MODELS.find((m) => m.id === modelId);
    if (fromRegistry) return { label: fromRegistry.label, hint: fromRegistry.hint };
    return { label: modelId, hint: providerInfo.label };
  })();

  // No outer container - the parent (the Defaults card) wraps both rows in
  // a single bordered panel. Returning a fragment keeps the markup compact
  // and matches the screenshot's "Chat model / Autocomplete" row layout.
  return (
    <>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
        <span className="text-muted-foreground text-[11.5px] sm:w-24 sm:shrink-0">
          Autocomplete
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => void setAutocompleteEnabled(v)}
          className="shrink-0"
        />
        <div
          className={cn(
            "min-w-0 flex-1",
            !enabled && "pointer-events-none opacity-55",
          )}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="h-9 w-full justify-between gap-2 px-2.5 text-[12px]"
              >
                <span className="flex items-center gap-2 truncate">
                  <ProviderIcon provider={provider} size={14} />
                  <span className="truncate font-medium">{currentDisplay.label}</span>
                  <span className="text-muted-foreground truncate">· {currentDisplay.hint}</span>
                </span>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                  className="opacity-70"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-(--radix-dropdown-menu-trigger-width) min-w-72"
            >
              {AUTOCOMPLETE_PROVIDERS.map((id) => {
                const info = getProvider(id);
                const defaultModel = DEFAULT_AUTOCOMPLETE_MODEL[id];
                const modelInfo = MODELS.find((m) => m.id === defaultModel);
                const label = modelInfo?.label ?? defaultModel;
                const itemHasKey = providerNeedsKey(id) ? !!keys[id] : true;
                return (
                  <DropdownMenuItem
                    key={id}
                    onSelect={() => onProviderChange(id)}
                    className={cn(
                      "flex items-center gap-2 text-[12px]",
                      id === provider && "bg-accent/50",
                    )}
                  >
                    <ProviderIcon provider={id} size={14} />
                    <span className="flex flex-col">
                      <span className="font-medium">{label}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {info.label}
                        {!itemHasKey ? " · not connected" : ""}
                      </span>
                    </span>
                    {!itemHasKey ? (
                      <span className="text-muted-foreground/70 ml-auto text-[10px]">no key</span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Warning when the selected autocomplete provider has no API key.
       *  Indented under the dropdown so it reads as a sub-message of the
       *  picker row above. */}
      {enabled && !hasKey ? (
        <div className="text-muted-foreground/80 text-center text-[10.5px] sm:pl-[calc(6rem+1.5rem+0.75rem)] sm:text-left">
          {providerInfo.label} isn&rsquo;t connected - add it below.
        </div>
      ) : null}

      {/* LM Studio URL field - only shown when LM Studio is the selected
       *  autocomplete provider. Indented to align with the dropdown. */}
      {enabled && provider === "lmstudio" ? (
        <div className="flex flex-col gap-1.5 sm:pl-[calc(6rem+1.5rem+0.75rem)]">
          <span className="text-muted-foreground text-[10px]">LM Studio base URL</span>
          <div className="flex gap-1.5">
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => {
                const v = urlDraft.trim();
                if (v && v !== lmstudioBaseURL) void setLmstudioBaseURL(v);
              }}
              placeholder="http://localhost:1234/v1"
              spellCheck={false}
              className="h-8 flex-1 font-mono text-[11.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void testLmStudio()}
              className="h-8 px-2.5 text-[11px]"
            >
              Test
            </Button>
          </div>
          {testStatus === "ok" ? (
            <span className="text-[10.5px] text-diff-added">Connected - server responded.</span>
          ) : testStatus === "fail" ? (
            <span className="text-destructive text-[10.5px]">
              Could not reach the server. Is LM Studio running?
            </span>
          ) : testStatus === "testing" ? (
            <span className="text-muted-foreground text-[10.5px]">Testing…</span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * One OpenAI-compatible endpoint card: label + base URL + API key + presets +
 * test/detect. `instance` is `null` while adding a new endpoint (the user fills
 * the fields, then Save mints it via the parent's `onSave`); otherwise it edits
 * an existing instance. The key lives in the OS keychain; only `apiKey`
 * (presence) is passed in so the card can show a masked value.
 */
function OpenAICompatibleBlock({
  instance,
  apiKey,
  status,
  error,
  modelsCount,
  onSave,
  onRemove,
}: {
  instance: OpenAICompatibleInstance | null;
  apiKey: string | null;
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  modelsCount: number;
  /** Persist label + base URL + key for this endpoint (mint when adding). */
  onSave: (label: string, baseURL: string, apiKey: string) => Promise<string>;
  /** Remove the endpoint (or cancel the add when `instance` is null). */
  onRemove: () => Promise<void>;
}) {
  const initialURL = instance?.baseURL ?? OPENAI_COMPATIBLE_DEFAULT_BASE_URL;
  const initialLabel = instance?.label ?? "";
  const configured = !!instance && !!apiKey;

  const [labelDraft, setLabelDraft] = useState(initialLabel);
  const [urlDraft, setUrlDraft] = useState(initialURL);
  const [keyDraft, setKeyDraft] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(!apiKey);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => setUrlDraft(initialURL), [initialURL]);
  useEffect(() => setLabelDraft(initialLabel), [initialLabel]);
  useEffect(() => {
    setKeyDraft("");
    setRevealKey(false);
    setSaveError(null);
    setEditingKey(!apiKey);
  }, [apiKey]);

  // Save persists label + URL + key in one shot. For an existing endpoint with
  // a key already stored, the key field may stay blank (keeping the old key);
  // for a new endpoint a key is required.
  const save = async () => {
    const trimmedKey = keyDraft.trim();
    const trimmedUrl = urlDraft.trim();
    if (!trimmedUrl) {
      setSaveError("Enter a base URL.");
      return;
    }
    if (!instance && !trimmedKey) {
      setSaveError("Enter your API key.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(labelDraft.trim(), trimmedUrl, trimmedKey);
      setKeyDraft("");
      setRevealKey(false);
      setEditingKey(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : `Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const testEndpoint = async () => {
    setTestStatus("testing");
    setTestError(null);
    try {
      const url = urlDraft.trim().replace(/\/$/, "") + "/models";
      const auth = keyDraft.trim() || apiKey;
      const code = await invoke<number>("http_ping", { url, auth });
      setTestStatus(code >= 200 && code < 400 ? "ok" : "fail");
      if (!(code >= 200 && code < 400)) setTestError(`HTTP ${code}`);
    } catch (e) {
      setTestStatus("fail");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  };

  const refresh = () => {
    if (!instance || !apiKey) return;
    void refreshOpenAICompatibleInstance(instance.id, apiKey, urlDraft.trim() || initialURL);
  };

  const maskedKey =
    apiKey && apiKey.length > 8
      ? `${apiKey.slice(0, 4)}${"•".repeat(8)}${apiKey.slice(-4)}`
      : apiKey
        ? "•".repeat(apiKey.length)
        : "";

  // Highlight the chip whose baseURL matches the current draft. Trims trailing
  // slashes so "/v1" and "/v1/" both stay matched.
  const activePresetId = (() => {
    const norm = urlDraft.trim().replace(/\/$/, "");
    return OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseURL.replace(/\/$/, "") === norm)?.id;
  })();

  return (
    <div className="border-border/60 bg-card/60 flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider="openai-compatible" size={14} />
        <span className="text-[12px] font-medium">{instance?.label || "OpenAI Compatible"}</span>
        {configured ? (
          <span className="rounded border border-diff-added/40 bg-diff-added/10 px-1.5 py-0.5 text-[9.5px] tracking-wide text-diff-added uppercase">
            Configured
          </span>
        ) : (
          <span className="bg-muted/50 text-muted-foreground rounded px-1.5 py-0.5 text-[9.5px] tracking-wide uppercase">
            Not set
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive ml-auto size-7"
              onClick={() => void onRemove()}
              aria-label={instance ? "Remove endpoint" : "Cancel"}
            >
              ×
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{instance ? "Remove endpoint" : "Cancel"}</TooltipContent>
        </Tooltip>
      </div>

      {/* Quick-pick presets - OpenAI / OpenRouter / 9Router. Clicking a chip
       *  drops its URL into the field. Shown while editing the endpoint. */}
      {editingKey ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">Quick start</span>
          <div className="flex flex-wrap gap-1">
            {OPENAI_COMPATIBLE_PRESETS.map((preset) => {
              const active = preset.id === activePresetId;
              return (
                <Tooltip key={preset.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setUrlDraft(preset.baseURL);
                        if (!labelDraft.trim()) setLabelDraft(preset.label);
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
                        active
                          ? "border-foreground/40 bg-accent/60"
                          : "border-border/60 hover:bg-accent/30 bg-transparent",
                      )}
                    >
                      <span>{preset.label}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{preset.description}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-[10px]">Label</span>
        <Input
          value={labelDraft}
          onChange={(e) => setLabelDraft(e.target.value)}
          placeholder="e.g. OpenRouter"
          spellCheck={false}
          className="h-7 text-[11px]"
        />
      </div>

      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-2 sm:gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">Base URL</span>
          <Input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
            className="h-7 font-mono text-[11px]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">API key</span>
          {apiKey && !editingKey ? (
            <div className="flex items-center gap-1">
              <code className="bg-muted/40 text-muted-foreground flex-1 truncate rounded px-2 py-1 font-mono text-[10.5px]">
                {maskedKey}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:bg-accent size-7"
                    onClick={() => setEditingKey(true)}
                    aria-label="Replace key"
                  >
                    <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Replace key</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <div className="relative">
              <Input
                type={revealKey ? "text" : "password"}
                value={keyDraft}
                disabled={saving}
                onChange={(e) => {
                  setKeyDraft(e.target.value);
                  if (saveError) setSaveError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
                placeholder={apiKey ? "Paste a new key (or leave blank)" : "Paste API key"}
                autoComplete="off"
                spellCheck={false}
                className="h-7 pr-12 font-mono text-[11px]"
              />
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                tabIndex={-1}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer text-[10px]"
                aria-label={revealKey ? "Hide key" : "Show key"}
              >
                {revealKey ? "Hide" : "Show"}
              </button>
            </div>
          )}
        </div>
      </div>

      {saveError ? <span className="text-destructive text-[10px]">{saveError}</span> : null}

      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground flex-1 truncate text-[10px]">
          {testStatus === "ok" ? (
            <span className="text-diff-added">Endpoint reachable.</span>
          ) : testStatus === "fail" ? (
            <span className="text-destructive">
              Unreachable{testError ? ` (${testError})` : ""}.
            </span>
          ) : testStatus === "testing" ? (
            "Testing…"
          ) : !configured ? (
            "Add key & URL, then Save to detect models."
          ) : status === "loading" ? (
            "Detecting models…"
          ) : status === "error" ? (
            <span className="text-destructive">
              Detection failed{error ? ` · ${error}` : ""}.
            </span>
          ) : status === "ok" ? (
            `${modelsCount} model${modelsCount === 1 ? "" : "s"} detected · pick one above.`
          ) : (
            "Click Detect to fetch the catalogue."
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void testEndpoint()}
          className="h-7 px-2 text-[10.5px]"
        >
          Test
        </Button>
        {configured && !editingKey ? (
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            className="h-7 px-2 text-[10.5px]"
          >
            Detect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void save()}
            disabled={saving || !urlDraft.trim() || (!instance && !keyDraft.trim())}
            className="h-7 px-2.5 text-[10.5px]"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}
