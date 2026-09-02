import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setModelReasoning } from "@/modules/settings/store";
import { Brain, Check } from "lucide-react";
import { REASONING_AUTO, reasoningControlFor } from "../lib/reasoning";
import { useChatStore } from "../store/chatStore";

/**
 * Reasoning-level picker for the current model.
 *
 * RENDERS NOTHING AT ALL unless the selected model genuinely has the capability.
 * That is the whole contract: the control is not a cosmetic setting that some
 * models happen to ignore, it is a view onto a real provider parameter, so a
 * model without one shows no control rather than a disabled or lying one.
 *
 * The values are the PROVIDER'S OWN, ascending in depth, and the footer names the
 * exact request field they map to - the mapping should be inspectable rather than
 * folklore. Nothing here normalises across providers: `xhigh` on GPT-5.6 and
 * `max` on Claude are different words for different APIs and are shown as such.
 */
export function ReasoningDropdown() {
  const modelId = useChatStore((s) => s.selectedModelId);
  const provider = useChatStore((s) => s.selectedProvider);
  // Subscribe to the map, not a derived value: a zustand selector returning a
  // fresh object every render would re-render this on every unrelated pref change.
  const byModel = usePreferencesStore((s) => s.modelReasoning);

  const control = reasoningControlFor(provider, modelId);
  if (!control) return null;

  const key = `${provider}::${modelId}`;
  const stored = byModel[key] ?? REASONING_AUTO;
  // A stored value survives a provider changing its accepted set; fall back to
  // Auto for display rather than showing a level that would not be sent.
  const current = control.values.includes(stored) ? stored : REASONING_AUTO;

  const pick = (value: string): void => {
    const next = { ...byModel };
    // Auto is the absence of a setting, so it deletes the row instead of storing
    // a sentinel - the map only ever holds models the user actually tuned.
    if (value === REASONING_AUTO) delete next[key];
    else next[key] = value;
    void setModelReasoning(next);
  };

  const label = current === REASONING_AUTO ? "Auto" : current;
  const autoNote = control.providerDefault
    ? `Auto (provider default: ${control.providerDefault})`
    : "Auto (provider default)";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Reasoning effort: ${label}`}
              className={cn(
                "text-muted-foreground my-1 h-5.5 min-w-0 shrink-0 gap-1 rounded-md px-1.5 text-xs",
                current !== REASONING_AUTO && "text-foreground",
              )}
            >
              <Brain size={11} strokeWidth={1.75} className="shrink-0 opacity-70" />
              <span className="truncate">{label}</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Reasoning effort</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => pick(REASONING_AUTO)} className="gap-2 text-xs">
          <Check
            size={12}
            className={cn("shrink-0", current === REASONING_AUTO ? "opacity-100" : "opacity-0")}
          />
          <span className="min-w-0 truncate">{autoNote}</span>
        </DropdownMenuItem>
        {control.values.map((v) => (
          <DropdownMenuItem key={v} onSelect={() => pick(v)} className="gap-2 text-xs">
            <Check
              size={12}
              className={cn("shrink-0", current === v ? "opacity-100" : "opacity-0")}
            />
            <span className="min-w-0 truncate">{v}</span>
          </DropdownMenuItem>
        ))}
        {/* Names the real parameter, so "what does this actually send" has an
            answer in the UI rather than only in the source. */}
        <div className="text-muted-foreground/70 border-t px-2 py-1.5 text-[10px] leading-tight">
          Sends <code>{control.wire}</code>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
