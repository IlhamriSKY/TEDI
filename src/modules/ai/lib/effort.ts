import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "../store/chatStore";
import { REASONING_AUTO, reasoningControlFor } from "./reasoning";

/**
 * Colour per reasoning level, cool to warm, so depth reads at a glance wherever
 * the level is shown - the picker's label, and the pixel block that runs while
 * the turn does.
 *
 * Theme TOKENS, never a fixed hue: these have to stay legible across every
 * preset, light and dark, and only the tokens are tuned for that. `max` is the
 * one exception and does not appear here - it steps off the hue ramp into foil,
 * which no theme can supply (`.tedi-foil` in `styles/globals.css`).
 *
 * A level with no entry falls back to its caller's own colour rather than
 * picking one, so a value a provider adds later is uncoloured, not miscoloured.
 * The fallback differs by surface, which is why it is not baked in here.
 */
export const LEVEL_COLOR: Record<string, string> = {
  minimal: "text-muted-foreground",
  low: "text-info",
  medium: "text-diff-added",
  high: "text-icon-working",
  xhigh: "text-destructive",
};

/**
 * The reasoning level the next turn will actually run at, or `REASONING_AUTO`
 * when TEDI is sending no level at all.
 *
 * One hook rather than the lookup copied per indicator: the running-turn block
 * in the chat, the status-bar pill and the picker all have to agree, and they
 * only agree if they ask the same question.
 *
 * The guard matters as much as the lookup: a level stored before a provider
 * dropped it is not being sent, so it must not colour anything.
 */
export function useEffortLevel(): string {
  const modelId = useChatStore((s) => s.selectedModelId);
  const provider = useChatStore((s) => s.selectedProvider);
  // The map, not a derived value: a selector returning a fresh object would
  // re-render every subscriber on every unrelated preference write.
  const byModel = usePreferencesStore((s) => s.modelReasoning);
  const stored = byModel[`${provider}::${modelId}`];
  if (!stored) return REASONING_AUTO;
  return reasoningControlFor(provider, modelId)?.values.includes(stored) ? stored : REASONING_AUTO;
}

/**
 * The ink an activity indicator draws in at `level`.
 *
 * Auto and any unknown level stay muted, which is exactly what the picker shows
 * for them: an indicator must never claim a depth that was never set.
 *
 * `max` is absent on purpose. It is a MATERIAL, not a colour - callers switch
 * the block to the foil for it, the same sheet the word and the brain icon are
 * cut from.
 */
export function effortTextClass(level: string): string {
  return LEVEL_COLOR[level] ?? "text-muted-foreground";
}
