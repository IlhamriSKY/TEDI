import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUpIcon,
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
  Mic01Icon,
  PinIcon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPinnedModelIds } from "@/modules/settings/store";
import {
  getModel,
  MODELS,
  providerNeedsKey,
  PROVIDERS,
  type DynamicModelId,
  type ModelInfo,
  type ProviderId,
  type ProviderInfo,
} from "../config";
import { ACCEPTED_FILES, useComposer } from "../lib/composer";
import { useOpenAICompatibleModels } from "../lib/openaiCompatible";
import { useSumopodModels } from "../lib/sumopod";
import { useChatStore } from "../store/chatStore";

/**
 * Pinned models are stored as `provider::modelId` strings so two models with
 * the same id (e.g. `mimo-v2.5-pro` proxied by both SumoPod and an
 * openai-compatible gateway) can coexist as independent pins. Unqualified
 * entries from before this fix are honoured for backwards compat but get
 * upgraded to the qualified form on the next toggle.
 */
const PIN_SEP = "::";

function pinKey(providerId: ProviderId, modelId: string): string {
  return `${providerId}${PIN_SEP}${modelId}`;
}

function isPinnedFor(
  pinnedIds: readonly string[],
  providerId: ProviderId,
  modelId: string,
): boolean {
  if (pinnedIds.includes(pinKey(providerId, modelId))) return true;
  // Legacy unqualified entry — matches any provider, but only when no
  // qualified pin exists for this same modelId (otherwise the legacy entry
  // would double-mark every provider).
  if (pinnedIds.includes(modelId)) {
    const hasQualifiedSameId = pinnedIds.some((p) => {
      const idx = p.indexOf(PIN_SEP);
      return idx !== -1 && p.slice(idx + PIN_SEP.length) === modelId;
    });
    return !hasQualifiedSameId;
  }
  return false;
}

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

export function AiOpenButton({ onOpen }: { onOpen: () => void }) {
  return (
    <IconTooltip label="Open AI agent" side="top">
      <motion.button
        initial={{ y: -15 }}
        animate={{ y: 0 }}
        type="button"
        onClick={onOpen}
        aria-label="Open AI agent"
        className={cn(
          "border-border/60 bg-card flex h-6 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs",
          "text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground transition-colors",
        )}
      >
        <span>Open AI agent</span>
        <Kbd className="h-4 min-w-4 px-1">{fmtShortcut(MOD_KEY, "I")}</Kbd>
      </motion.button>
    </IconTooltip>
  );
}

export function AiStatusBarControls() {
  const c = useComposer();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enqueuePrompt = useChatStore((s) => s.enqueuePrompt);

  const interruptAndSend = () => {
    const text = c.value.trim();
    if (!text) return;
    enqueuePrompt(text);
    c.setValue("");
    c.stop();
  };
  const addToQueue = () => {
    const text = c.value.trim();
    if (!text) return;
    enqueuePrompt(text);
    c.setValue("");
  };

  return (
    <div className="flex items-center gap-0.5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => {
          void c.addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <IconBtn
        title="Attach file or image"
        onClick={() => fileInputRef.current?.click()}
        disabled={c.isBusy}
      >
        <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
      </IconBtn>

      {c.voice.supported && (
        <IconBtn
          title={
            !c.voice.hasKey
              ? "Voice needs an OpenAI key"
              : c.voice.recording
                ? "Stop & transcribe"
                : c.voice.transcribing
                  ? "Transcribing…"
                  : "Voice input"
          }
          onClick={() => (c.voice.recording ? c.voice.stop() : void c.voice.start())}
          disabled={c.isBusy || c.voice.transcribing || !c.voice.hasKey}
          className={cn(
            c.voice.recording && "bg-destructive/10 text-destructive hover:bg-destructive/15",
          )}
        >
          {c.voice.recording ? (
            <span className="bg-destructive size-2 animate-pulse rounded-full" />
          ) : c.voice.transcribing ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={Mic01Icon} size={13} strokeWidth={1.75} />
          )}
        </IconBtn>
      )}

      <ModelDropdown />

      <span className="bg-border mx-1 h-5 w-px" aria-hidden />

      {c.isBusy ? (
        <>
          <IconBtn title="Stop" onClick={c.stop}>
            <HugeiconsIcon icon={StopCircleIcon} size={13} strokeWidth={1.75} />
          </IconBtn>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    disabled={!c.value.trim()}
                    className="size-6 rounded-md"
                    aria-label="Send options"
                  >
                    <HugeiconsIcon icon={ArrowUpIcon} size={13} strokeWidth={2} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">Send</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                onClick={interruptAndSend}
                disabled={!c.value.trim()}
                className="flex flex-col items-start gap-0.5 py-1.5"
              >
                <span className="text-[11.5px] font-medium">Send now (interrupt)</span>
                <span className="text-muted-foreground text-[10.5px]">
                  Stop the current run, then send this
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={addToQueue}
                disabled={!c.value.trim()}
                className="flex flex-col items-start gap-0.5 py-1.5"
              >
                <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
                  Add to queue
                  <Kbd className="h-3.5 gap-px px-1 font-mono text-[9.5px]">
                    {fmtShortcut(MOD_KEY, "Enter")}
                  </Kbd>
                </span>
                <span className="text-muted-foreground text-[10.5px]">
                  Run after the current finishes
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        <IconTooltip label="Send (Enter)" side="top">
          <Button
            type="button"
            size="icon"
            onClick={c.submit}
            disabled={!c.canSend}
            className="size-6 rounded-md"
            aria-label="Send (Enter)"
          >
            <HugeiconsIcon icon={ArrowUpIcon} size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      )}
    </div>
  );
}

function matchesQuery(m: { id: string; label: string; hint: string }, q: string): boolean {
  if (!q) return true;
  const t = q.toLowerCase();
  return (
    m.id.toLowerCase().includes(t) ||
    m.label.toLowerCase().includes(t) ||
    m.hint.toLowerCase().includes(t)
  );
}

function ModelDropdown() {
  const selected = useChatStore((s) => s.selectedModelId);
  const selectedProvider = useChatStore((s) => s.selectedProvider);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const sumopodModels = useSumopodModels();
  const oaiCompatModels = useOpenAICompatibleModels();
  const pinnedModelIds = usePreferencesStore((s) => s.pinnedModelIds);
  const [query, setQuery] = useState("");
  // Provider sections (and the synthetic "pinned" section) start expanded
  // and the user can collapse any of them. State is component-local so it
  // resets every time the dropdown reopens - lighter than persisting it
  // and keeps the default "everything visible" experience.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Static `getModel` would throw for runtime-detected ids that aren't in
  // the MODELS const. Fall back to a synthetic ModelInfo using the user's
  // selected provider so the trigger never mislabels a model whose dynamic
  // registry entry hasn't been refreshed yet.
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
    // If a legacy unqualified entry exists for this modelId, swap it for
    // the qualified form so future toggles distinguish providers.
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
    : `${current.label} - no key configured`;

  const sections = useMemo(
    () =>
      PROVIDERS.map((p) => {
        const all =
          p.id === "sumopod"
            ? sumopodModels.models
            : p.id === "openai-compatible"
              ? oaiCompatModels.models
              : MODELS.filter((m) => m.provider === p.id);
        const filtered = all.filter((m) => matchesQuery(m, query));
        return { provider: p, all, filtered };
      }),
    [query, sumopodModels.models, oaiCompatModels.models],
  );

  // Resolve pinned ids to actual ModelInfo entries (with their provider).
  // We build two lookups: qualified (provider::modelId) for new-style pins,
  // and legacy (modelId only) for backward compat. The legacy lookup picks
  // the FIRST encountered provider for a given modelId — the order is the
  // PROVIDERS array, so this is deterministic. Stale ids that no longer
  // resolve are dropped so ghost rows don't render.
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
                "hover:bg-accent hover:text-foreground my-1 h-5.5 gap-1 rounded-md px-1.5 text-xs",
                currentProviderHasKey
                  ? "text-muted-foreground"
                  : "text-amber-600 dark:text-amber-400",
              )}
            >
              {current.label}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={2}
                className="opacity-70"
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{modelTooltip}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-105 w-72 overflow-hidden p-0">
        <div className="border-border/60 bg-popover sticky top-0 z-10 border-b px-1.5 py-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Radix's DropdownMenu treats letter keys as type-ahead nav.
              // Stop them at the input so typing doesn't jump focus to items.
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
                  ? oaiCompatModels.status === "loading"
                    ? "Detecting models…"
                    : oaiCompatModels.status === "error"
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

type ModelSectionRow = {
  model: ModelInfo;
  provider: ProviderInfo;
  hasKey: boolean;
};

function ModelSection({
  sectionKey,
  title,
  providerIcon,
  missingKey,
  onSetKey,
  note,
  models,
  collapsed,
  onToggle,
  query,
  selectedId,
  selectedProviderId,
  pinnedIds,
  onPick,
  onTogglePin,
}: {
  sectionKey: string;
  title: string;
  providerIcon?: typeof ChatGptIcon;
  missingKey?: boolean;
  onSetKey?: () => void;
  note?: string | null;
  models: ModelSectionRow[];
  collapsed: boolean;
  onToggle: () => void;
  query: string;
  selectedId: string;
  selectedProviderId: ProviderId;
  pinnedIds: string[];
  onPick: (id: DynamicModelId, providerId: ProviderId) => void;
  onTogglePin: (providerId: ProviderId, modelId: string) => void;
}) {
  // Active queries force-expand the section so search hits aren't hidden
  // behind a collapsed header.
  const showItems = !!query || !collapsed;
  return (
    <div className="px-1 pt-1.5 first:pt-1">
      <div className="mb-0.5 flex items-center gap-1.5 px-1">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-expanded={showItems}
          aria-controls={`section-${sectionKey}`}
          className={cn(
            "group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5",
            "text-muted-foreground text-[9.5px] font-medium tracking-wide uppercase",
            "hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className={cn(
              "shrink-0 transition-transform duration-150",
              showItems ? "rotate-0" : "-rotate-90",
            )}
          />
          {providerIcon ? (
            <HugeiconsIcon icon={providerIcon} size={14} strokeWidth={1.25} className="shrink-0" />
          ) : (
            <HugeiconsIcon
              icon={PinIcon}
              size={12}
              strokeWidth={1.75}
              className="fill-foreground/70 shrink-0"
            />
          )}
          <span className="truncate">{title}</span>
          <span className="text-muted-foreground/70 ml-auto text-[9px] tracking-normal normal-case tabular-nums">
            {models.length}
          </span>
        </button>
        {missingKey && onSetKey ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSetKey();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="cursor-pointer rounded-sm px-1 text-[9px] tracking-normal text-amber-600 normal-case underline-offset-2 hover:underline dark:text-amber-400"
          >
            Set key…
          </button>
        ) : null}
      </div>
      {showItems && note ? (
        <div className="text-muted-foreground/80 px-2 pb-1 text-[10px] normal-case">{note}</div>
      ) : null}
      {showItems
        ? models.map(({ model: m, provider: p, hasKey }) => {
            const pinned = isPinnedFor(pinnedIds, p.id, m.id);
            const isSelected = m.id === selectedId && p.id === selectedProviderId;
            return (
              <DropdownMenuItem
                key={`${sectionKey}-${p.id}-${m.id}`}
                disabled={!hasKey}
                onSelect={() => onPick(m.id, p.id)}
                className={cn(
                  "group flex items-center gap-2 text-xs",
                  isSelected && "bg-accent/40",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0">
                  <span className="truncate font-medium">{m.label}</span>
                  <span className="text-muted-foreground truncate text-[10px]">{m.hint}</span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onTogglePin(p.id, m.id);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      aria-label={pinned ? `Unpin ${m.label}` : `Pin ${m.label}`}
                      className={cn(
                        "shrink-0 cursor-pointer rounded p-1 transition-colors",
                        pinned
                          ? "text-foreground hover:bg-accent"
                          : "text-muted-foreground/60 hover:bg-accent hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100",
                      )}
                    >
                      <HugeiconsIcon
                        icon={PinIcon}
                        size={11}
                        strokeWidth={pinned ? 2 : 1.5}
                        className={cn(pinned && "fill-foreground")}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {pinned ? "Unpin from top" : "Pin to top"}
                  </TooltipContent>
                </Tooltip>
              </DropdownMenuItem>
            );
          })
        : null}
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <IconTooltip label={title} side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
        className={cn("text-muted-foreground hover:text-foreground size-6 rounded-md", className)}
      >
        {children}
      </Button>
    </IconTooltip>
  );
}
