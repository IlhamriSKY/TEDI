import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  AUTOCOMPLETE_PROVIDERS,
  DEFAULT_AUTOCOMPLETE_MODEL,
  MODELS,
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
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";

type KeysMap = Record<ProviderId, string | null>;

function matchesQuery(
  m: { id: string; label: string; hint: string },
  q: string,
): boolean {
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
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const sumopodModels = useSumopodModels();
  const oaiCompatModels = useOpenAICompatibleModels();
  const [modelQuery, setModelQuery] = useState("");

  useEffect(() => {
    void getAllKeys().then((k) => {
      setKeys(k);
      if (k.sumopod) void refreshSumopodModels(k.sumopod);
      if (k["openai-compatible"] && openaiCompatibleBaseURL) {
        void refreshOpenAICompatibleModels(
          k["openai-compatible"],
          openaiCompatibleBaseURL,
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async (provider: ProviderId, value: string) => {
    await setKey(provider, value);
    setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
    await emitKeysChanged();
    if (provider === "sumopod") void refreshSumopodModels(value);
    if (provider === "openai-compatible" && openaiCompatibleBaseURL) {
      void refreshOpenAICompatibleModels(value, openaiCompatibleBaseURL);
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
    return <div className="text-[12px] text-muted-foreground">Loading…</div>;
  }

  const defaultModelInfo = tryGetModel(defaultModel) ?? {
    id: defaultModel,
    provider: "sumopod" as ProviderId,
    label: defaultModel,
    hint: "SumoPod",
  };
  const gridProviders = PROVIDERS.filter(
    (p) => providerNeedsKey(p.id) && p.id !== "openai-compatible",
  );
  const configuredCount = gridProviders.filter((p) => !!keys[p.id]).length;

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Models"
        description="Bring your own keys. They live in your OS keychain and are used only by TEDI."
      />

      <div className="flex flex-col gap-2">
        <Label>Default model</Label>
        <DropdownMenu
          onOpenChange={(open) => {
            if (!open) setModelQuery("");
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-9 justify-between gap-2 px-2.5 text-[12px]"
            >
              <span className="flex items-center gap-2">
                <ProviderIcon provider={defaultModelInfo.provider} size={14} />
                <span>{defaultModelInfo.label}</span>
                <span className="text-muted-foreground">
                  · {defaultModelInfo.hint}
                </span>
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
            className="max-h-105 w-(--radix-dropdown-menu-trigger-width) min-w-72 overflow-hidden p-0"
          >
            <div className="sticky top-0 z-10 border-b border-border/60 bg-popover px-1.5 py-1.5">
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
                let totalMatches = 0;
                const blocks = PROVIDERS.filter((p) =>
                  providerNeedsKey(p.id),
                ).map((p) => {
                  const all =
                    p.id === "sumopod"
                      ? sumopodModels.models
                      : p.id === "openai-compatible"
                        ? oaiCompatModels.models
                        : MODELS.filter((m) => m.provider === p.id);
                  const filtered = all.filter((m) =>
                    matchesQuery(m, modelQuery),
                  );
                  totalMatches += filtered.length;
                  if (filtered.length === 0 && modelQuery) return null;
                  const hasKey = !!keys[p.id];
                  const dynamicState =
                    p.id === "sumopod"
                      ? sumopodModels
                      : p.id === "openai-compatible"
                        ? oaiCompatModels
                        : null;
                  const isDynamicEmpty =
                    !!dynamicState && hasKey && filtered.length === 0;
                  const dynamicNote =
                    dynamicState && hasKey
                      ? dynamicState.status === "loading"
                        ? "Detecting models…"
                        : dynamicState.status === "error"
                          ? "Detection failed - check key / URL"
                          : null
                      : null;
                  return (
                    <div key={p.id} className="px-1 pt-1.5">
                      <div className="mb-1 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                        <ProviderIcon provider={p.id} size={11} />
                        <span>{p.label}</span>
                        {!hasKey && (
                          <span className="ml-auto text-[9.5px] normal-case tracking-normal text-muted-foreground/70">
                            no key
                          </span>
                        )}
                      </div>
                      {dynamicNote ? (
                        <div className="px-2 pb-1 text-[10px] text-muted-foreground/80 normal-case">
                          {dynamicNote}
                        </div>
                      ) : null}
                      {isDynamicEmpty && !dynamicNote ? (
                        <div className="px-2 pb-1 text-[10px] text-muted-foreground/80 normal-case">
                          No models detected.
                        </div>
                      ) : null}
                      {filtered.map((m) => (
                        <DropdownMenuItem
                          key={m.id}
                          disabled={!hasKey}
                          onSelect={() =>
                            hasKey && void setDefaultModel(m.id)
                          }
                          className={cn(
                            "flex items-center justify-between gap-2 text-[12px]",
                            m.id === defaultModel && "bg-accent/50",
                          )}
                        >
                          <span className="flex flex-col">
                            <span>{m.label}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {m.hint}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </div>
                  );
                });
                return (
                  <>
                    {blocks}
                    {modelQuery && totalMatches === 0 ? (
                      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                        No models match “{modelQuery}”.
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <Label>API keys</Label>
          <span className="text-[10.5px] text-muted-foreground">
            {configuredCount} of {gridProviders.length} configured
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {gridProviders.map((p) => (
            <ProviderKeyCard
              key={p.id}
              provider={p}
              currentKey={keys[p.id]}
              onSave={(v: string) => onSave(p.id, v)}
              onClear={() => onClear(p.id)}
            />
          ))}
        </div>
      </div>

      <OpenAICompatibleBlock
        apiKey={keys["openai-compatible"]}
        baseURL={openaiCompatibleBaseURL}
        status={oaiCompatModels.status}
        error={oaiCompatModels.error}
        modelsCount={oaiCompatModels.models.length}
        onSaveKey={(v) => onSave("openai-compatible", v)}
        onClearKey={() => onClear("openai-compatible")}
      />

      <AutocompleteBlock keys={keys} />
    </div>
  );
}

function AutocompleteBlock({ keys }: { keys: KeysMap }) {
  const enabled = usePreferencesStore((s) => s.autocompleteEnabled);
  const provider = usePreferencesStore((s) => s.autocompleteProvider);
  const modelId = usePreferencesStore((s) => s.autocompleteModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);

  const [modelDraft, setModelDraft] = useState(modelId);
  const [urlDraft, setUrlDraft] = useState(lmstudioBaseURL);
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setModelDraft(modelId), [modelId]);
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
      const status = await invoke<number>("http_ping", { url });
      setTestStatus(status >= 200 && status < 400 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <Label>Editor autocomplete</Label>
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            Inline ghost-text suggestions in the code editor. Powered by
            ultra-fast inference (Cerebras / Groq) or a local LM Studio server.
          </span>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => void setAutocompleteEnabled(v)}
        />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <div className="flex flex-col gap-1.5">
          <Label>Provider</Label>
          <div className="flex gap-1">
            {AUTOCOMPLETE_PROVIDERS.map((id) => {
              const info = getProvider(id);
              const active = id === provider;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onProviderChange(id)}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors",
                    active
                      ? "border-foreground/40 bg-accent/60"
                      : "border-border/60 bg-transparent hover:bg-accent/30",
                  )}
                >
                  <ProviderIcon provider={id} size={12} />
                  <span>{info.label}</span>
                </button>
              );
            })}
          </div>
          {!hasKey ? (
            <span className="text-[10.5px] text-amber-500">
              No API key configured for {providerInfo.label}. Add one above.
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Model</Label>
          <Input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => {
              const v = modelDraft.trim();
              if (v && v !== modelId) void setAutocompleteModelId(v);
            }}
            placeholder={DEFAULT_AUTOCOMPLETE_MODEL[provider]}
            spellCheck={false}
            className="h-8 font-mono text-[11.5px]"
          />
        </div>

        {provider === "lmstudio" ? (
          <div className="flex flex-col gap-1.5">
            <Label>LM Studio base URL</Label>
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
              <span className="text-[10.5px] text-emerald-500">
                Connected - server responded.
              </span>
            ) : testStatus === "fail" ? (
              <span className="text-[10.5px] text-destructive">
                Could not reach the server. Is LM Studio running?
              </span>
            ) : testStatus === "testing" ? (
              <span className="text-[10.5px] text-muted-foreground">
                Testing…
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
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
  onSaveKey: (key: string) => Promise<void>;
  onClearKey: () => Promise<void>;
}) {
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [keyDraft, setKeyDraft] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");
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
    const trimmed = keyDraft.trim();
    if (!trimmed) {
      setKeyError("Enter your API key.");
      return;
    }
    setSavingKey(true);
    setKeyError(null);
    try {
      await onSaveKey(trimmed);
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
      const code = await invoke<number>("http_ping", { url });
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

  return (
    <div className="flex flex-col gap-2">
      <Label>OpenAI Compatible endpoint</Label>
      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ProviderIcon provider="openai-compatible" size={14} />
          <span className="text-[12px] font-medium">OpenAI Compatible</span>
          {apiKey ? (
            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] tracking-wide text-emerald-700 uppercase dark:text-emerald-300">
              Configured
            </span>
          ) : (
            <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[9.5px] tracking-wide text-muted-foreground uppercase">
              Not set
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground">Base URL</span>
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
            <span className="text-[10px] text-muted-foreground">API key</span>
            {apiKey ? (
              <div className="flex items-center gap-1">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[10.5px] text-muted-foreground">
                  {maskedKey}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void onClearKey()}
                  aria-label="Remove key"
                  title="Remove key"
                >
                  ×
                </Button>
              </div>
            ) : (
              <div className="relative">
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
                  placeholder="Paste API key, press Enter"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-7 pr-7 font-mono text-[11px]"
                />
                <button
                  type="button"
                  onClick={() => setRevealKey((v) => !v)}
                  tabIndex={-1}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer text-[10px] text-muted-foreground hover:text-foreground"
                  aria-label={revealKey ? "Hide key" : "Show key"}
                >
                  {revealKey ? "Hide" : "Show"}
                </button>
              </div>
            )}
          </div>
        </div>

        {keyError ? (
          <span className="text-[10px] text-destructive">{keyError}</span>
        ) : null}

        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-[10px] text-muted-foreground">
            {testStatus === "ok" ? (
              <span className="text-emerald-500">Endpoint reachable.</span>
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
                Detection failed{error ? ` — ${error}` : ""}.
              </span>
            ) : status === "ok" ? (
              `${modelsCount} model${modelsCount === 1 ? "" : "s"} detected — pick one in the dropdown above.`
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
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
