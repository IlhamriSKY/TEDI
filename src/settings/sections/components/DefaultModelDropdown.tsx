import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  MODELS,
  PROVIDERS,
  getDetectedModels,
  providerNeedsKey,
  tryGetModel,
  type DynamicModelId,
  type OpenAICompatibleInstance,
  type ProviderId,
} from "@/modules/ai/config";
import { getOpenAICompatibleModelsState } from "@/modules/ai/lib/openaiCompatible";
import type { useSumopodModels } from "@/modules/ai/lib/sumopod";
import { setDefaultModel } from "@/modules/settings/store";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { KeysMap } from "./modelsTypes";

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
  // Open provider accordions. Reset on dropdown open to start with the current default expanded.
  const [expandedProviders, setExpandedProviders] = useState<Set<ProviderId>>(new Set());
  const toggleProvider = (id: ProviderId) =>
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
          setExpandedProviders(defaultProvider ? new Set([defaultProvider]) : new Set());
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
}
