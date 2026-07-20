import { getAllKeys, hasKeyForModel, useChatStore } from "@/modules/ai";
import { providerNeedsKey, type ProviderId } from "@/modules/ai/config";
import { getOpenAICompatibleInstanceKey } from "@/modules/ai/lib/keyring";
import {
  clearOpenAICompatibleInstance,
  isOpenAICompatibleInstanceReady,
  refreshOpenAICompatibleInstance,
} from "@/modules/ai/lib/openaiCompatible";
import { clearSumopodModels, refreshSumopodModels } from "@/modules/ai/lib/sumopod";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { usePromptsStore } from "@/modules/ai/store/promptsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { useSubagentsStore } from "@/modules/ai/store/subagentsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged, setLastModelId, setLastProviderId } from "@/modules/settings/store";
import { useEffect, useRef, useState } from "react";

/**
 * One-time AI / model boot wiring for the main window: load the API keys from
 * the OS keychain (and re-load on change), detect openai-compatible endpoints,
 * init the preferences store, restore + persist the last-used model, and
 * hydrate the chat / agents / prompts / snippets stores.
 *
 * Every store slice these effects touch is read here directly (none is needed
 * elsewhere in App), so the hook takes no params. `keysLoaded` gates the boot
 * model-restore and the right-slot render, so it is returned. Effects are moved
 * verbatim from App with identical dependency arrays and source order; the
 * async hydration gates (`prefsHydrated`, `keysLoaded`, the `bootModelRestored`
 * ref) make their relative mount order irrelevant.
 */
export function useAiBootstrap(): { keysLoaded: boolean } {
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  const apiKeys = useChatStore((s) => s.apiKeys);

  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  const prefDefaultProvider = usePreferencesStore((s) => s.defaultProviderId);
  const prefLastModelId = usePreferencesStore((s) => s.lastModelId);
  const prefLastProviderId = usePreferencesStore((s) => s.lastProviderId);
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const openaiCompatibleInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);

  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
        // Refresh SumoPod models when the key arrives or changes.
        if (keys.sumopod) {
          void refreshSumopodModels(keys.sumopod);
        } else {
          clearSumopodModels();
        }
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys]);

  useEffect(() => {
    // Detect models for every configured openai-compatible endpoint. Each
    // instance's key is read from the OS keychain by its instance id (the
    // default instance reuses the legacy unsuffixed account). An instance with
    // no key or no base URL is cleared rather than fetched.
    let cancelled = false;
    void (async () => {
      for (const inst of openaiCompatibleInstances) {
        if (!inst.baseURL) {
          clearOpenAICompatibleInstance(inst.id);
          continue;
        }
        const key = await getOpenAICompatibleInstanceKey(inst.id);
        if (cancelled) return;
        // A local endpoint needs no key, so readiness is not just "has a key".
        if (!isOpenAICompatibleInstanceReady(inst.baseURL, key)) {
          clearOpenAICompatibleInstance(inst.id);
          continue;
        }
        void refreshOpenAICompatibleInstance(inst.id, key ?? "", inst.baseURL, inst.label);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `apiKeys` kept as a dependency so a key change in the same window
    // re-triggers detection (keychain writes don't otherwise notify here).
  }, [openaiCompatibleInstances, apiKeys]);

  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);

  // One-shot boot restore. Picks the last-used model, falling back to the
  // workspace default if it's gone (key removed, model deleted). The ref
  // guards against late prefs/keys hydration clobbering a fresh user pick.
  const bootModelRestoredRef = useRef(false);
  useEffect(() => {
    if (bootModelRestoredRef.current) return;
    if (!prefsHydrated || !keysLoaded) return;
    // Use the saved provider instead of re-deriving via tryGetModel. The
    // registry may still be hydrating (openai-compatible /v1/models hasn't
    // returned), and that race would demote the last pick to default.
    const savedProvider = prefLastProviderId as ProviderId | null;
    const savedHasKey =
      savedProvider != null && (providerNeedsKey(savedProvider) ? !!apiKeys[savedProvider] : true);
    if (prefLastModelId && savedProvider && savedHasKey) {
      setSelectedModelId(prefLastModelId, savedProvider);
    } else if (prefLastModelId && hasKeyForModel(prefLastModelId)) {
      // Pre-fix data: no saved provider. Fall back to registry lookup.
      setSelectedModelId(prefLastModelId);
    } else if (prefDefaultProvider) {
      // Explicit default provider sidesteps the id/provider ambiguity that
      // lastProviderId fixes for the active selection.
      setSelectedModelId(prefDefaultModel, prefDefaultProvider as ProviderId);
    } else {
      setSelectedModelId(prefDefaultModel);
    }
    bootModelRestoredRef.current = true;
  }, [
    prefsHydrated,
    keysLoaded,
    prefLastModelId,
    prefLastProviderId,
    prefDefaultModel,
    prefDefaultProvider,
    setSelectedModelId,
    apiKeys,
  ]);
  // Persist the active model and provider on change (after boot restore
  // settles). Lets the next launch land on the same model and provider,
  // avoiding the registry race that would mislabel the chip.
  useEffect(() => {
    const unsub = useChatStore.subscribe((s, prev) => {
      if (!bootModelRestoredRef.current) return;
      if (
        s.selectedModelId === prev.selectedModelId &&
        s.selectedProvider === prev.selectedProvider
      )
        return;
      if (s.selectedModelId !== prev.selectedModelId) {
        void setLastModelId(s.selectedModelId);
      }
      if (s.selectedProvider !== prev.selectedProvider) {
        void setLastProviderId(s.selectedProvider);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    // The agent runs in THIS (main) window; prompt overrides are saved from the
    // separate Settings webview. Hydrate here so getPromptOverrides() sees them
    // at runtime without waiting for the Settings panel to mount.
    void usePromptsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
    void useSubagentsStore.getState().hydrate();
  }, [hydrateSessions]);

  return { keysLoaded };
}
