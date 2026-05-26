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
  MODELS,
  OPENAI_COMPATIBLE_PRESETS,
  PROVIDERS,
  getProvider,
  providerNeedsKey,
  tryGetModel,
  type AutocompleteProviderId,
  type ProviderId,
} from "@/modules/ai/config";
import { clearKey, getAllKeys, setKey } from "@/modules/ai/lib/keyring";
import {
  clearOpenAICompatibleModels,
  refreshOpenAICompatibleModels,
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
  setOpenAICompatibleBaseURL,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { Add01Icon, ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
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

export function ModelsSection() {
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const defaultModel = usePreferencesStore((s) => s.defaultModelId);
  const defaultProvider = usePreferencesStore((s) => s.defaultProviderId);
  const openaiCompatibleBaseURL = usePreferencesStore((s) => s.openaiCompatibleBaseURL);
  const sumopodModels = useSumopodModels();
  const oaiCompatModels = useOpenAICompatibleModels();
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
      if (k["openai-compatible"] && openaiCompatibleBaseURL) {
        void refreshOpenAICompatibleModels(k["openai-compatible"], openaiCompatibleBaseURL);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async (provider: ProviderId, value: string, urlOverride?: string) => {
    await setKey(provider, value);
    setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
    await emitKeysChanged();
    // Once the key is persisted, the provider is "connected"; clear the
    // in-progress add slot so the configured-providers list takes over.
    setAddingProvider((cur) => (cur === provider ? null : cur));
    if (provider === "sumopod") void refreshSumopodModels(value);
    if (provider === "openai-compatible") {
      // Prefer the URL the block just committed (passed explicitly) over the
      // store value, which a closure may still see as the previous default
      // if React hasn't re-rendered yet. Without this, saving a key right
      // after typing a new URL fired /models against the OLD endpoint -
      // OpenRouter key sent to api.openai.com → 401 → "Detection failed",
      // surfacing as "input AI terdetect tapi model tidak muncul".
      const url = urlOverride ?? openaiCompatibleBaseURL;
      if (url) void refreshOpenAICompatibleModels(value, url);
    }
  };

  const onClear = async (provider: ProviderId) => {
    await clearKey(provider);
    setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
    await emitKeysChanged();
    if (provider === "sumopod") clearSumopodModels();
    if (provider === "openai-compatible") clearOpenAICompatibleModels();
  };

  if (!keys) {
    return <div className="text-muted-foreground text-[12px]">Loading…</div>;
  }

  // Resolve display info using the saved provider when present. Disambiguates ids shared across providers.
  const defaultModelInfo = (() => {
    if (defaultProvider) {
      const pool =
        defaultProvider === "sumopod"
          ? sumopodModels.models
          : defaultProvider === "openai-compatible"
            ? oaiCompatModels.models
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
  const oaiCompatConfigured = !!keys["openai-compatible"];
  const oaiCompatAdding = addingProvider === "openai-compatible";
  // Providers eligible to appear in the "+ Add provider" dropdown: every
  // provider needing a key, minus the ones already connected and minus the
  // one mid-add. OpenAI Compatible is included because it's still a
  // separate gateway choice; LM Studio is excluded because it's keyless
  // and configured from the Editor autocomplete block below instead.
  const addableProviders = PROVIDERS.filter(
    (p) =>
      providerNeedsKey(p.id) &&
      !keys[p.id] &&
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
            <div className="border-border/60 bg-popover sticky top-0 z-10 border-b px-1.5 py-1.5">
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
                const blocks = PROVIDERS.filter(
                  (p) => providerNeedsKey(p.id) && !!keys[p.id],
                ).map((p) => {
                  const all =
                    p.id === "sumopod"
                      ? sumopodModels.models
                      : p.id === "openai-compatible"
                        ? oaiCompatModels.models
                        : MODELS.filter((m) => m.provider === p.id);
                  const filtered = all.filter((m) => matchesQuery(m, modelQuery));
                  totalMatches += filtered.length;
                  if (filtered.length === 0 && searching) return null;
                  const hasKey = !!keys[p.id];
                  const dynamicState =
                    p.id === "sumopod"
                      ? sumopodModels
                      : p.id === "openai-compatible"
                        ? oaiCompatModels
                        : null;
                  const isDynamicEmpty = !!dynamicState && hasKey && filtered.length === 0;
                  const dynamicNote =
                    dynamicState && hasKey
                      ? dynamicState.status === "loading"
                        ? "Detecting models…"
                        : dynamicState.status === "error"
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
        <div className="border-border/60 bg-card/40 flex flex-col gap-3 rounded-lg border px-3 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="text-muted-foreground text-[11.5px] sm:w-24 sm:shrink-0">
              Chat model
            </span>
            <div className="min-w-0 flex-1">{defaultModelDropdown}</div>
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
                <div className="border-border/60 bg-popover sticky top-0 z-10 border-b px-1.5 py-1.5">
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

      {/* OpenAI Compatible: shown only when configured OR being added. */}
      {oaiCompatConfigured || oaiCompatAdding ? (
        <div className="flex flex-col gap-2">
          {oaiCompatAdding && !oaiCompatConfigured ? (
            <div className="flex items-center gap-2 text-[10.5px]">
              <div className="border-border/60 h-px flex-1 border-t" />
              <span className="text-muted-foreground">
                Connecting OpenAI Compatible endpoint
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
          ) : null}
          <OpenAICompatibleBlock
            apiKey={keys["openai-compatible"]}
            baseURL={openaiCompatibleBaseURL}
            status={oaiCompatModels.status}
            error={oaiCompatModels.error}
            modelsCount={oaiCompatModels.models.length}
            onSaveKey={(v, url) => onSave("openai-compatible", v, url)}
            onClearKey={() => onClear("openai-compatible")}
          />
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

function OpenAICompatibleBlock({
  apiKey,
  baseURL,
  status,
  error,
  modelsCount,
  onSaveKey,
  onClearKey,
}: {
  apiKey: string | null;
  baseURL: string;
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  modelsCount: number;
  /** `url` is the URL the block just committed; parent should prefer it
   *  over its own (possibly stale-by-one-render) `openaiCompatibleBaseURL`. */
  onSaveKey: (key: string, url: string) => Promise<void>;
  onClearKey: () => Promise<void>;
}) {
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [keyDraft, setKeyDraft] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => setUrlDraft(baseURL), [baseURL]);
  useEffect(() => {
    setKeyDraft("");
    setRevealKey(false);
    setKeyError(null);
  }, [apiKey]);

  const commitURL = () => {
    const v = urlDraft.trim();
    if (v && v !== baseURL) {
      void setOpenAICompatibleBaseURL(v);
      if (apiKey) void refreshOpenAICompatibleModels(apiKey, v);
    }
  };

  const saveKey = async () => {
    const trimmedKey = keyDraft.trim();
    if (!trimmedKey) {
      setKeyError("Enter your API key.");
      return;
    }
    setSavingKey(true);
    setKeyError(null);
    // Commit the URL FIRST when it has changed. Without this, a user who
    // types a new base URL (e.g. OpenRouter) then immediately hits Save on
    // the key field never blurs the URL input - `baseURL` in the store stays
    // at the old default (api.openai.com/v1) and the auto-refresh inside
    // `onSave` fires /models against the wrong endpoint with the new key,
    // returns 401, and surfaces as "Detection failed - check key / URL".
    // Pass `trimmedUrl` explicitly to onSaveKey so the parent's refresh
    // uses the value we just committed, regardless of React render timing.
    const trimmedUrl = urlDraft.trim();
    try {
      if (trimmedUrl && trimmedUrl !== baseURL) {
        await setOpenAICompatibleBaseURL(trimmedUrl);
      }
      await onSaveKey(trimmedKey, trimmedUrl || baseURL);
    } catch (e) {
      setKeyError(`Failed to save: ${String(e)}`);
    } finally {
      setSavingKey(false);
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
    if (!apiKey) return;
    void refreshOpenAICompatibleModels(apiKey, urlDraft.trim() || baseURL);
  };

  const maskedKey =
    apiKey && apiKey.length > 8
      ? `${apiKey.slice(0, 4)}${"•".repeat(8)}${apiKey.slice(-4)}`
      : apiKey
        ? "•".repeat(apiKey.length)
        : "";

  // Highlight the chip whose baseURL matches the current draft. Trims
  // trailing slashes so "/v1" and "/v1/" both stay matched.
  const activePresetId = (() => {
    const norm = urlDraft.trim().replace(/\/$/, "");
    return OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseURL.replace(/\/$/, "") === norm)?.id;
  })();

  return (
    <div className="flex flex-col gap-2">
      <Label>OpenAI Compatible endpoint</Label>
      <div className="border-border/60 bg-card/60 flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ProviderIcon provider="openai-compatible" size={14} />
          <span className="text-[12px] font-medium">OpenAI Compatible</span>
          {apiKey ? (
            <span className="rounded border border-diff-added/40 bg-diff-added/10 px-1.5 py-0.5 text-[9.5px] tracking-wide text-diff-added uppercase text-diff-added">
              Configured
            </span>
          ) : (
            <span className="bg-muted/50 text-muted-foreground rounded px-1.5 py-0.5 text-[9.5px] tracking-wide uppercase">
              Not set
            </span>
          )}
        </div>

        {/* Quick-pick presets - OpenAI / OpenRouter / 9Router. Clicking a
         *  chip drops its URL into the field. Saves the user from
         *  remembering "is it /v1 or /api/v1?" or 9Router's local port.
         *  Hidden once a key is configured to keep the configured row tight. */}
        {!apiKey ? (
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
                          if (preset.baseURL !== baseURL) {
                            void setOpenAICompatibleBaseURL(preset.baseURL);
                          }
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

        <div className="flex flex-col gap-2 sm:grid sm:grid-cols-2 sm:gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px]">Base URL</span>
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={commitURL}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitURL();
                }
              }}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              className="h-7 font-mono text-[11px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px]">API key</span>
            {apiKey ? (
              <div className="flex items-center gap-1">
                <code className="bg-muted/40 text-muted-foreground flex-1 truncate rounded px-2 py-1 font-mono text-[10.5px]">
                  {maskedKey}
                </code>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-7"
                      onClick={() => void onClearKey()}
                      aria-label="Remove key"
                    >
                      ×
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Remove key</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <div className="relative flex-1">
                  <Input
                    type={revealKey ? "text" : "password"}
                    value={keyDraft}
                    disabled={savingKey}
                    onChange={(e) => {
                      setKeyDraft(e.target.value);
                      if (keyError) setKeyError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveKey();
                      }
                    }}
                    placeholder="Paste API key"
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void saveKey()}
                  disabled={!keyDraft.trim() || savingKey}
                  className="h-7 px-2.5 text-[10.5px]"
                >
                  {savingKey ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
          </div>
        </div>

        {keyError ? <span className="text-destructive text-[10px]">{keyError}</span> : null}

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
            ) : !apiKey ? (
              "Add key & URL to detect models."
            ) : status === "loading" ? (
              "Detecting models…"
            ) : status === "error" ? (
              <span className="text-destructive">
                Detection failed{error ? ` · ${error}` : ""}.
              </span>
            ) : status === "ok" ? (
              `${modelsCount} model${modelsCount === 1 ? "" : "s"} detected · pick one in the dropdown above.`
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
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={!apiKey}
            className="h-7 px-2 text-[10.5px]"
          >
            Detect
          </Button>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}
