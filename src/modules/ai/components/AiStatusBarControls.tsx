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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { useSumopodModels } from "../lib/sumopod";
import { useChatStore } from "../store/chatStore";

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
          "flex h-6 cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 text-xs",
          "text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground",
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
  const closePanel = useChatStore((s) => s.closePanel);

  return (
    <div className="flex items-center gap-0.5">
      {/* <Button
        onClick={closePanel}
        title="Close AI panel"
        size="xs"
        variant="outline"
        aria-label="Close AI panel"
        className="text-[11px] text-foreground/85 pl-1.5"
      > */}
      {/* <Kbd className="h-4 gap-px text-[11px]">
          ⌘<span className="font-mono">I</span>
        </Kbd> */}
      {/* Close */}
      {/* </Button> */}
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
          onClick={() =>
            c.voice.recording ? c.voice.stop() : void c.voice.start()
          }
          disabled={c.isBusy || c.voice.transcribing || !c.voice.hasKey}
          className={cn(
            c.voice.recording &&
              "bg-destructive/10 text-destructive hover:bg-destructive/15",
          )}
        >
          {c.voice.recording ? (
            <span className="size-2 animate-pulse rounded-full bg-destructive" />
          ) : c.voice.transcribing ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={Mic01Icon} size={13} strokeWidth={1.75} />
          )}
        </IconBtn>
      )}

      <ModelDropdown />

      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <IconTooltip label="Close AI panel" side="top">
        <Button
          onClick={closePanel}
          size="xs"
          variant="ghost"
          aria-label="Close AI panel"
          className="text-[11px] text-foreground/85 px-1"
        >
          <Kbd className="h-4 gap-px px-2 font-mono text-[11px]">
            {fmtShortcut(MOD_KEY, "I")}
          </Kbd>
        </Button>
      </IconTooltip>

      {c.isBusy ? (
        <IconTooltip label="Stop" side="top">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={c.stop}
            className="size-6"
            aria-label="Stop"
          >
            <HugeiconsIcon icon={StopCircleIcon} size={13} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      ) : (
        <IconTooltip label="Send (Enter)" side="top">
          <Button
            type="button"
            size="icon"
            onClick={c.submit}
            disabled={!c.canSend}
            className="h-5.5 w-7.5 ml-1"
            aria-label="Send (Enter)"
          >
            <HugeiconsIcon icon={ArrowUpIcon} size={13} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      )}
    </div>
  );
}

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

function ModelDropdown() {
  const selected = useChatStore((s) => s.selectedModelId);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const sumopodModels = useSumopodModels();
  const pinnedModelIds = usePreferencesStore((s) => s.pinnedModelIds);
  const [query, setQuery] = useState("");
  // Provider sections (and the synthetic "pinned" section) start expanded
  // and the user can collapse any of them. State is component-local so it
  // resets every time the dropdown reopens - lighter than persisting it
  // and keeps the default "everything visible" experience.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Static `getModel` would throw for runtime-detected SumoPod ids that
  // aren't in the MODELS const. Fall back to a synthetic ModelInfo using
  // the raw id so the dropdown can render labels for detected models.
  let current: ModelInfo;
  try {
    current = getModel(selected);
  } catch {
    current = {
      id: selected,
      provider: "sumopod",
      label: selected,
      hint: "SumoPod",
    };
  }
  const currentProviderHasKey = !!apiKeys[current.provider];

  const onPick = (id: DynamicModelId, providerId: ProviderId) => {
    if (!apiKeys[providerId]) {
      void openSettingsWindow("models");
      return;
    }
    setSelected(id);
  };

  const togglePin = useCallback(
    (modelId: string) => {
      const pinned = usePreferencesStore.getState().pinnedModelIds;
      const next = pinned.includes(modelId)
        ? pinned.filter((id) => id !== modelId)
        : [modelId, ...pinned];
      void setPinnedModelIds(next);
    },
    [],
  );

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
            : MODELS.filter((m) => m.provider === p.id);
        const filtered = all.filter((m) => matchesQuery(m, query));
        return { provider: p, all, filtered };
      }),
    [query, sumopodModels.models],
  );

  // Resolve pinned ids to actual ModelInfo entries (with their provider) by
  // looking them up across every section. Drop ids that no longer correspond
  // to any known model so stale entries don't ghost-render.
  const pinnedEntries = useMemo(() => {
    const lookup = new Map<string, { model: ModelInfo; provider: ProviderInfo }>();
    for (const { provider, all } of sections) {
      for (const m of all) lookup.set(m.id, { model: m, provider });
    }
    const out: { model: ModelInfo; provider: ProviderInfo }[] = [];
    for (const id of pinnedModelIds) {
      const hit = lookup.get(id);
      if (hit) out.push(hit);
    }
    return out;
  }, [sections, pinnedModelIds]);

  const pinnedFiltered = useMemo(
    () => pinnedEntries.filter(({ model }) => matchesQuery(model, query)),
    [pinnedEntries, query],
  );

  const totalMatches =
    pinnedFiltered.length +
    sections.reduce((n, s) => n + s.filtered.length, 0);

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
                "h-5.5 gap-1 rounded-md px-1.5 my-1 text-xs hover:bg-accent hover:text-foreground",
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
      <DropdownMenuContent
        align="end"
        className="max-h-105 w-72 overflow-hidden p-0"
      >
        <div className="sticky top-0 z-10 border-b border-border/60 bg-popover px-1.5 py-1.5">
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
                hasKey: providerNeedsKey(provider.id)
                  ? !!apiKeys[provider.id]
                  : true,
              }))}
              collapsed={collapsed.has("__pinned")}
              onToggle={() => toggleSection("__pinned")}
              query={query}
              selectedId={selected}
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
                pinnedIds={pinnedModelIds}
                onPick={onPick}
                onTogglePin={togglePin}
              />
            );
          })}
          {query && totalMatches === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
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
  pinnedIds: string[];
  onPick: (id: DynamicModelId, providerId: ProviderId) => void;
  onTogglePin: (modelId: string) => void;
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
            "text-[9.5px] font-medium tracking-wide text-muted-foreground uppercase",
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
            <HugeiconsIcon
              icon={providerIcon}
              size={14}
              strokeWidth={1.25}
              className="shrink-0"
            />
          ) : (
            <HugeiconsIcon
              icon={PinIcon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0 fill-foreground/70"
            />
          )}
          <span className="truncate">{title}</span>
          <span className="ml-auto text-[9px] tabular-nums text-muted-foreground/70 normal-case tracking-normal">
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
            className="cursor-pointer rounded-sm px-1 text-[9px] normal-case tracking-normal text-amber-600 underline-offset-2 hover:underline dark:text-amber-400"
          >
            Set key…
          </button>
        ) : null}
      </div>
      {showItems && note ? (
        <div className="px-2 pb-1 text-[10px] text-muted-foreground/80 normal-case">
          {note}
        </div>
      ) : null}
      {showItems
        ? models.map(({ model: m, provider: p, hasKey }) => {
            const pinned = pinnedIds.includes(m.id);
            return (
              <DropdownMenuItem
                key={`${sectionKey}-${m.id}`}
                disabled={!hasKey}
                onSelect={() => onPick(m.id, p.id)}
                className={cn(
                  "group flex items-center gap-2 text-xs",
                  m.id === selectedId && "bg-accent/40",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0">
                  <span className="truncate font-medium">{m.label}</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {m.hint}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onTogglePin(m.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label={pinned ? `Unpin ${m.label}` : `Pin ${m.label}`}
                  title={pinned ? "Unpin from top" : "Pin to top"}
                  className={cn(
                    "shrink-0 cursor-pointer rounded p-1 transition-colors",
                    pinned
                      ? "text-foreground hover:bg-accent"
                      : "text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100",
                  )}
                >
                  <HugeiconsIcon
                    icon={PinIcon}
                    size={11}
                    strokeWidth={pinned ? 2 : 1.5}
                    className={cn(pinned && "fill-foreground")}
                  />
                </button>
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
        className={cn(
          "size-6 rounded-md text-muted-foreground hover:text-foreground",
          className,
        )}
      >
        {children}
      </Button>
    </IconTooltip>
  );
}
