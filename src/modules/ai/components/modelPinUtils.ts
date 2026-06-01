import { type ProviderId } from "../config";

/**
 * Pinned models use `provider::modelId` so two models with the same id (e.g.
 * `mimo-v2.5-pro` via both SumoPod and an openai-compatible gateway) pin
 * independently. Legacy unqualified entries still work; they upgrade to the
 * qualified form on the next toggle.
 */
export const PIN_SEP = "::";

export function pinKey(providerId: ProviderId, modelId: string): string {
  return `${providerId}${PIN_SEP}${modelId}`;
}

export function isPinnedFor(
  pinnedIds: readonly string[],
  providerId: ProviderId,
  modelId: string,
): boolean {
  if (pinnedIds.includes(pinKey(providerId, modelId))) return true;
  // Legacy unqualified entry matches any provider, but only if no qualified
  // pin exists for this modelId (else it would double-mark every provider).
  if (pinnedIds.includes(modelId)) {
    const hasQualifiedSameId = pinnedIds.some((p) => {
      const idx = p.indexOf(PIN_SEP);
      return idx !== -1 && p.slice(idx + PIN_SEP.length) === modelId;
    });
    return !hasQualifiedSameId;
  }
  return false;
}
