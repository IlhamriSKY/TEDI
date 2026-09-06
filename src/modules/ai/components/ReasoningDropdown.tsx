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

/**
 * Colour per level, cool to warm, so depth reads at a glance on the trigger
 * without opening anything.
 *
 * Theme TOKENS, never a fixed hue: these have to stay legible across every
 * preset, light and dark, and only the tokens are tuned for that. `max` is the
 * one exception and does not appear here - it steps off the hue ramp into foil,
 * which no theme can supply (`.tedi-effort-max` in `styles/globals.css`).
 *
 * A level with no entry falls back to the menu's own colour rather than picking
 * one, so a value a provider adds later is uncoloured, not miscoloured.
 */
const LEVEL_COLOR: Record<string, string> = {
  minimal: "text-muted-foreground",
  low: "text-info",
  medium: "text-diff-added",
  high: "text-icon-working",
  xhigh: "text-destructive",
};

/**
 * The classes for one level, per element.
 *
 * They differ only at `max`, and only because of where the foil has to be
 * painted: the label takes it as a gradient clipped to the TEXT, the icon as a
 * gradient its STROKE references. Same palette, same 14s cycle, two paint
 * mechanisms - because `background-clip: text` needs `color: transparent`, and
 * that would erase a glyph drawn with `currentColor`.
 */
function levelClass(level: string, target: "label" | "icon"): string {
  if (level !== "max") return LEVEL_COLOR[level] ?? "text-foreground";
  return target === "label" ? "tedi-effort-max font-medium" : "tedi-effort-max-icon";
}

/**
 * The paint server the brain icon's stroke points at.
 *
 * An SVG `url(#id)` paint resolves within the DOCUMENT, so the gradient has to
 * be mounted somewhere - and mounting it HERE, beside the only icon that uses
 * it, is what keeps it working in the float and settings windows too. Those are
 * separate documents; a definition parked in the main app's root would resolve
 * to nothing in them, and the icon would fall back to a solid hue with no sign
 * that anything was missing.
 *
 * Rendered outside the `Button`: the button's own rule forces every descendant
 * svg to 16px, which would give this zero-sized element a real box.
 *
 * The stops carry the animation, not the gradient - three stops each walking
 * the same palette a third of a cycle apart, which is what makes the ink DRIFT
 * across the glyph instead of pulsing on it.
 */
function MaxInkDefs() {
  return (
    <svg width="0" height="0" aria-hidden focusable="false" className="absolute">
      <defs>
        {/* Diagonal, matching the angle the foil label runs its hues at. */}
        <linearGradient id="tedi-max-ink" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" className="tedi-max-ink-a" />
          <stop offset="50%" className="tedi-max-ink-b" />
          <stop offset="100%" className="tedi-max-ink-c" />
        </linearGradient>
      </defs>
    </svg>
  );
}
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
      {current === "max" ? <MaxInkDefs /> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Reasoning effort: ${label}`}
              className="text-muted-foreground my-1 h-5.5 min-w-0 shrink-0 gap-1 rounded-md px-1.5 text-xs"
            >
              {/* Icon and label are coloured SEPARATELY rather than by tinting
                  the button, because `max` makes the label's own `color`
                  transparent and an icon inheriting that would disappear. Full
                  opacity once a level is picked: the dimming is what marks Auto
                  as unset, and it would mute the colour the level just chose. */}
              <Brain
                size={11}
                strokeWidth={2}
                className={cn(
                  "shrink-0",
                  current === REASONING_AUTO ? "opacity-70" : levelClass(current, "icon"),
                )}
              />
              <span
                className={cn(
                  "truncate",
                  current !== REASONING_AUTO && levelClass(current, "label"),
                )}
              >
                {label}
              </span>
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
            <span className={cn("min-w-0 truncate", levelClass(v, "label"))}>{v}</span>
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
