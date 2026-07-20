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
  getProvider,
  isLoopbackBaseURL,
  providerNeedsKey,
  type AutocompleteProviderId,
} from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setAutocompleteEnabled,
  setAutocompleteModelId,
  setAutocompleteProvider,
  setLmstudioBaseURL,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { KeysMap } from "./modelsTypes";
import { ChevronDown } from "lucide-react";

export function AutocompleteBlock({ keys }: { keys: KeysMap }) {
  const enabled = usePreferencesStore((s) => s.autocompleteEnabled);
  const provider = usePreferencesStore((s) => s.autocompleteProvider);
  const modelId = usePreferencesStore((s) => s.autocompleteModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const openaiCompatibleBaseURL = usePreferencesStore((s) => s.openaiCompatibleBaseURL);

  const [urlDraft, setUrlDraft] = useState(lmstudioBaseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");

  useEffect(() => setUrlDraft(lmstudioBaseURL), [lmstudioBaseURL]);
  useEffect(() => setModelDraft(modelId), [modelId]);

  const onProviderChange = (next: AutocompleteProviderId) => {
    if (next === provider) return;
    void setAutocompleteProvider(next);
    // A model id belongs to one provider, so always reset it. Keeping a custom
    // id (the free-text field below makes those normal now) meant switching to
    // Anthropic while still pointing at "my-local-q4.gguf" and 404ing on every
    // keystroke, even though the row the user clicked was labelled "Claude".
    void setAutocompleteModelId(DEFAULT_AUTOCOMPLETE_MODEL[next]);
    setModelDraft(DEFAULT_AUTOCOMPLETE_MODEL[next]);
  };

  const providerInfo = getProvider(provider);
  // ONE definition of "connected", used by both the selected-provider notice and
  // every dropdown row. They were separate predicates before, which is how the
  // row came to say "not connected" while the panel below it said the opposite.
  // A local OpenAI-compatible server (Ollama, llama.cpp, vLLM) authenticates with
  // nothing, so a loopback base URL counts.
  const isConnected = (id: AutocompleteProviderId) =>
    !providerNeedsKey(id) ||
    !!keys[id] ||
    (id === "openai-compatible" && isLoopbackBaseURL(openaiCompatibleBaseURL));

  const oacIsLocal = provider === "openai-compatible" && isLoopbackBaseURL(openaiCompatibleBaseURL);
  const hasKey = isConnected(provider);

  /** Blank falls back to the provider default rather than persisting "". */
  const commitModelDraft = () => {
    const next = modelDraft.trim() || DEFAULT_AUTOCOMPLETE_MODEL[provider];
    if (next !== modelId) void setAutocompleteModelId(next);
    setModelDraft(next);
  };

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
        <div className={cn("min-w-0 flex-1", !enabled && "pointer-events-none opacity-55")}>
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
                <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
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
                const itemHasKey = isConnected(id);
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

      {/* Model id. Free text because a local server names its own models
       *  ("qwen2.5-coder:7b" on Ollama, a GGUF filename on llama.cpp) and no
       *  registry can know them. Blank falls back to the provider default. */}
      {enabled ? (
        <div className="flex flex-col gap-1.5 sm:pl-[calc(6rem+1.5rem+0.75rem)]">
          <span className="text-muted-foreground text-[10px]">Model</span>
          <Input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            // Commit on Enter as well as blur: closing Settings without leaving
            // the field would otherwise discard what the user just typed.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitModelDraft();
              }
            }}
            onBlur={commitModelDraft}
            placeholder={DEFAULT_AUTOCOMPLETE_MODEL[provider]}
            spellCheck={false}
            className="h-8 font-mono text-[11.5px]"
          />
        </div>
      ) : null}

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
            <span className="text-diff-added text-[10.5px]">Connected - server responded.</span>
          ) : testStatus === "fail" ? (
            <span className="text-destructive text-[10.5px]">
              Could not reach the server. Is LM Studio running?
            </span>
          ) : testStatus === "testing" ? (
            <span className="text-muted-foreground text-[10.5px]">Testing…</span>
          ) : null}
        </div>
      ) : null}

      {/* OpenAI-compatible points at an endpoint configured once in Models, so
       *  show where it resolves rather than duplicating the editor here. */}
      {enabled && provider === "openai-compatible" ? (
        <div className="text-muted-foreground/80 text-[10.5px] sm:pl-[calc(6rem+1.5rem+0.75rem)]">
          Using <span className="font-mono">{openaiCompatibleBaseURL || "no endpoint set"}</span>
          {oacIsLocal ? " - local server, no key needed." : "."} Change it under Models.
        </div>
      ) : null}
    </>
  );
}
