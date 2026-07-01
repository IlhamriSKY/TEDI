import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ArrowDown01Icon, ChatGptIcon, PinIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type DynamicModelId, type ModelInfo, type ProviderId, type ProviderInfo } from "../config";
import { isPinnedFor } from "./modelPinUtils";

export type ModelSectionRow = {
  model: ModelInfo;
  provider: ProviderInfo;
  hasKey: boolean;
};

export function ModelSection({
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
  // Active query force-expands the section so search hits aren't hidden.
  const showItems = !!query || !collapsed;
  return (
    <div className="px-1 pt-1 first:pt-1">
      <div className="flex items-center gap-1.5">
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
            "group hover:bg-accent/50 hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 transition-colors",
            "text-muted-foreground text-[10px] font-medium tracking-wide uppercase",
          )}
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className={cn(
              "shrink-0 opacity-60 transition-transform duration-150",
              showItems ? "rotate-0" : "-rotate-90",
            )}
          />
          {providerIcon ? (
            <HugeiconsIcon icon={providerIcon} size={11} strokeWidth={1.75} className="shrink-0" />
          ) : (
            <HugeiconsIcon
              icon={PinIcon}
              size={11}
              strokeWidth={1.75}
              className="fill-foreground/70 shrink-0"
            />
          )}
          <span className="truncate">{title}</span>
          <span className="text-muted-foreground/60 tracking-normal normal-case">
            ({models.length})
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
            className="text-icon-working text-icon-working cursor-pointer rounded-sm px-1 text-[9px] tracking-normal normal-case underline-offset-2 hover:underline"
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
                  isSelected && "bg-accent/50",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0">
                  <span className="truncate">{m.label}</span>
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
                          : "text-muted-foreground/60 hover:bg-accent hover:text-accent-foreground opacity-0 group-hover:opacity-100 focus:opacity-100",
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
