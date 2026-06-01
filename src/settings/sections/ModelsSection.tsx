import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
  PROVIDERS,
  getProvider,
  providerNeedsKey,
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
import { emitKeysChanged, setOpenAICompatibleInstances } from "@/modules/settings/store";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";
import { AutocompleteBlock } from "./components/AutocompleteBlock";
import { DefaultModelDropdown } from "./components/DefaultModelDropdown";
import type { KeysMap } from "./components/modelsTypes";
import { OpenAICompatibleBlock } from "./components/OpenAICompatibleBlock";

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
  // Search filter for the "+ Add provider" dropdown. Cleared when the
  // dropdown closes so reopening starts fresh.
  const [addProviderQuery, setAddProviderQuery] = useState("");
  // When the user picks a provider from the "Add provider" dropdown, we
  // hold its id here. The provider's card is rendered in editing mode below
  // the connected list until the key is saved (which clears this back to
  // null). For OpenAI Compatible the "card" is the full URL+key block.
  const [addingProvider, setAddingProvider] = useState<ProviderId | null>(null);

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
  const onSaveInstance = async (input: {
    instanceId?: string;
    label: string;
    baseURL: string;
    apiKey: string;
  }): Promise<string> => {
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
    setKeys((prev) =>
      prev ? { ...prev, "openai-compatible": apiKey || prev["openai-compatible"] } : prev,
    );
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
              <div className="min-w-0 flex-1">
                <DefaultModelDropdown
                  keys={keys}
                  defaultModel={defaultModel}
                  defaultProvider={defaultProvider}
                  sumopodModels={sumopodModels}
                  oaiCompatInstances={oaiCompatInstances}
                />
              </div>
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
        {configuredKeyed.length === 0 && !oaiCompatConfigured && addingProvider === null ? (
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

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{children}</span>
  );
}
