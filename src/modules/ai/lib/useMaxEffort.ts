import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "../store/chatStore";
import { reasoningControlFor } from "./reasoning";

/**
 * Is the selected model set to its deepest reasoning level?
 *
 * `max` is the one level with its own material - the foil (`.tedi-effort-max`)
 * rather than a hue off the ramp - so anything that wants to say "this turn is
 * running at max" has to ask the same question the picker asks, and get the
 * same answer. Hence one hook rather than the check copied per indicator.
 *
 * Deliberately only `max`, not "the highest value this provider offers":
 * `xhigh` on GPT-5.6 is its own level with its own colour, and promoting it to
 * foil would make two different settings look identical.
 */
export function useIsMaxEffort(): boolean {
  const modelId = useChatStore((s) => s.selectedModelId);
  const provider = useChatStore((s) => s.selectedProvider);
  // The map, not a derived value: a selector returning a fresh object would
  // re-render every subscriber on every unrelated preference write.
  const byModel = usePreferencesStore((s) => s.modelReasoning);
  if (byModel[`${provider}::${modelId}`] !== "max") return false;
  // Same guard the picker displays with: a level stored before a provider
  // dropped it is not actually being sent, so it must not colour anything.
  return reasoningControlFor(provider, modelId)?.values.includes("max") ?? false;
}
