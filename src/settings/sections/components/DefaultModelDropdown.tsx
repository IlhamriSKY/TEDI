import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn, matchesQuery } from "@/lib/utils";
import {
  MODELS,
  PROVIDERS,
  getDetectedModels,
  groupOpenAICompatibleByInstance,
  parseOpenAICompatibleModelId,
  providerNeedsKey,
  tryGetModel,
  type DynamicModelId,
  type OpenAICompatibleInstance,
  type ProviderId,
} from "@/modules/ai/config";
import {
  getOpenAICompatibleModelsState,
  isOpenAICompatibleInstanceReady,
} from "@/modules/ai/lib/openaiCompatible";
import type { useSumopodModels } from "@/modules/ai/lib/sumopod";
import { setDefaultModel } from "@/modules/settings/store";
import { useState } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { KeysMap } from "./modelsTypes";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Default-model dropdown rendered in the AI defaults card. The card itself owns
 * the surrounding layout (label, description, hr) - this is the trigger +
 * popover only.
 */
export function DefaultModelDropdown({
  keys,
  defaultModel,
  defaultProvider,
  sumopodModels,
  oaiCompatInstances,
}: {
  keys: KeysMap;
  defaultModel: DynamicModelId;
  defaultProvider: ProviderId | null;
  sumopodModels: ReturnType<typeof useSumopodModels>;
  oaiCompatInstances: OpenAICompatibleInstance[];
}) {
  const [modelQuery, setModelQuery] = useState("");
  // Open accordions, keyed by section (provider id, or `oac:<instanceId>` for
  // each OpenAI-Compatible endpoint). Reset on open to expand the current default.
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const toggleProvider = (key: string) =>
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Section key holding the current default model, used to auto-expand on open.
  const defaultSectionKey =
    defaultProvider === "openai-compatible"
      ? `oac:${parseOpenAICompatibleModelId(defaultModel)?.instanceId ?? ""}`
      : (defaultProvider ?? null);

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

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          setExpandedProviders(defaultSectionKey ? new Set([defaultSectionKey]) : new Set());
        } else {
          setModelQuery("");
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 w-full justify-between gap-2 px-2.5 text-[12px]">
          <span className="flex min-w-0 items-center gap-2 truncate">
            <ProviderIcon provider={defaultModelInfo.provider} size={14} />
            <span className="truncate font-medium">{defaultModelInfo.label}</span>
            {/* Mark this as THE app default: it drives the native AI agent
             *  and the "AI write commit message" action. */}
            <span className="border-primary/40 bg-primary/10 text-primary shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase">
              Default
            </span>
            <span className="text-muted-foreground truncate">· {defaultModelInfo.hint}</span>
          </span>
          <ChevronDown size={12} strokeWidth={2} className="shrink-0 opacity-70" />
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
            // Expand each provider to one section, except OpenAI-Compatible which
            // yields one section per configured endpoint, headed by its label.
            const sectionDefs = PROVIDERS.flatMap((p) => {
              // openai-compatible is gated per-instance below (a keyless loopback
              // endpoint is valid, and keys["openai-compatible"] only reflects the
              // default instance), so never drop the whole provider on that slot.
              if (p.id !== "openai-compatible" && !(providerNeedsKey(p.id) && !!keys[p.id]))
                return [];
              if (p.id === "openai-compatible") {
                return groupOpenAICompatibleByInstance(oaiCompatModels, oaiCompatInstances).map(
                  (g) => ({
                    provider: p,
                    sectionKey: `oac:${g.instanceId}`,
                    title: g.label,
                    instanceId: g.instanceId as string | null,
                    all: g.models,
                  }),
                );
              }
              const all =
                p.id === "sumopod"
                  ? sumopodModels.models
                  : MODELS.filter((m) => m.provider === p.id);
              return [
                {
                  provider: p,
                  sectionKey: p.id,
                  title: p.label,
                  instanceId: null as string | null,
                  all,
                },
              ];
            });
            const blocks = sectionDefs.map((s) => {
              const p = s.provider;
              const filtered = s.all.filter((m) => matchesQuery(m, modelQuery));
              totalMatches += filtered.length;
              if (filtered.length === 0 && searching) return null;
              // A keyless loopback OAC endpoint is usable, so read its own
              // readiness (baseURL + shared slot) rather than the slot alone,
              // which would grey out a working local server's models.
              const hasKey =
                p.id === "openai-compatible" && s.instanceId
                  ? isOpenAICompatibleInstanceReady(
                      oaiCompatInstances.find((i) => i.id === s.instanceId)?.baseURL ?? "",
                      keys[p.id],
                    )
                  : !!keys[p.id];
              // Detection status: SumoPod has one stream; each OAC endpoint reads
              // its own instance status.
              const dynamicStatus =
                p.id === "sumopod"
                  ? sumopodModels.status
                  : s.instanceId
                    ? getOpenAICompatibleModelsState(s.instanceId).status
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
              // While searching, expand every section with matches.
              const isOpen = searching || expandedProviders.has(s.sectionKey);
              return (
                <div key={s.sectionKey} className="px-1 pt-1">
                  <button
                    type="button"
                    onClick={() => !searching && toggleProvider(s.sectionKey)}
                    aria-expanded={isOpen}
                    disabled={searching}
                    className={cn(
                      "hover:bg-accent/50 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium tracking-wide uppercase transition-colors",
                      "text-muted-foreground",
                      searching && "cursor-default hover:bg-transparent",
                    )}
                  >
                    {isOpen ? (
                      <ChevronDown
                        size={10}
                        strokeWidth={2}
                        className={cn("opacity-60", searching && "invisible")}
                      />
                    ) : (
                      <ChevronRight
                        size={10}
                        strokeWidth={2}
                        className={cn("opacity-60", searching && "invisible")}
                      />
                    )}
                    <ProviderIcon provider={p.id} size={11} />
                    <span>{s.title}</span>
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
}
