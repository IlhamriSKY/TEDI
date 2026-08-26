import { invoke } from "@tauri-apps/api/core";
import {
  CHATGPT_CONNECTED_MARKER,
  getProvider,
  KEYRING_SERVICE,
  openaiCompatibleKeyringAccount,
  PROVIDERS,
  providerNeedsKey,
  type ProviderId,
} from "../config";

export type ProviderKeys = Record<ProviderId, string | null>;

export const EMPTY_PROVIDER_KEYS: ProviderKeys = {
  openai: null,
  anthropic: null,
  google: null,
  xai: null,
  cerebras: null,
  groq: null,
  deepseek: null,
  sumopod: null,
  agentrouter: null,
  "openai-compatible": null,
  lmstudio: null,
  // Signed in over OAuth, not pasted. `providerNeedsKey` skips it, so this
  // stays null and `buildLanguageModel` reads the token from chatgptAuth.
  chatgpt: null,
};

export async function getKey(provider: ProviderId): Promise<string | null> {
  if (!providerNeedsKey(provider)) return null;
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: getProvider(provider).keyringAccount,
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setKey(provider: ProviderId, key: string): Promise<void> {
  if (!providerNeedsKey(provider)) {
    throw new Error(`${provider} does not use an API key`);
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: getProvider(provider).keyringAccount,
    password: trimmed,
  });
}

export async function clearKey(provider: ProviderId): Promise<void> {
  if (!providerNeedsKey(provider)) return;
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: getProvider(provider).keyringAccount,
    });
  } catch {
    // already absent - fine
  }
}

/** Is a ChatGPT account signed in? Reads only for presence, never returns the
 *  token: callers of `getAllKeys` want "is it connected", not the credential. */
async function chatgptConnected(): Promise<boolean> {
  try {
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: getProvider("chatgpt").keyringAccount,
    });
    return !!raw && raw.length > 0;
  } catch {
    return false;
  }
}

export async function getAllKeys(): Promise<ProviderKeys> {
  const out = { ...EMPTY_PROVIDER_KEYS };
  // Marker, not a token - see CHATGPT_CONNECTED_MARKER.
  if (await chatgptConnected()) out.chatgpt = CHATGPT_CONNECTED_MARKER;
  const need = PROVIDERS.filter((p) => providerNeedsKey(p.id));
  try {
    const results = await invoke<(string | null)[]>("secrets_get_all", {
      service: KEYRING_SERVICE,
      accounts: need.map((p) => p.keyringAccount),
    });
    need.forEach((p, i) => {
      const v = results[i];
      out[p.id] = v && v.length > 0 ? v : null;
    });
    return out;
  } catch {
    const entries = await Promise.all(need.map(async (p) => [p.id, await getKey(p.id)] as const));
    for (const [id, v] of entries) out[id] = v;
    return out;
  }
}

export function hasAnyKey(keys: ProviderKeys): boolean {
  return PROVIDERS.some((p) => providerNeedsKey(p.id) && !!keys[p.id]);
}

// --- Per-instance OpenAI-compatible keys -----------------------------------
// Each openai-compatible endpoint stores its key under its own keychain
// account. The default instance reuses the original unsuffixed account
// (`openai-compatible-api-key`) so a pre-existing single-endpoint key is
// preserved; other instances use `openai-compatible-api-key:<id>`.

export async function getOpenAICompatibleInstanceKey(instanceId: string): Promise<string | null> {
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: openaiCompatibleKeyringAccount(instanceId),
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setOpenAICompatibleInstanceKey(
  instanceId: string,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: openaiCompatibleKeyringAccount(instanceId),
    password: trimmed,
  });
}

export async function clearOpenAICompatibleInstanceKey(instanceId: string): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: openaiCompatibleKeyringAccount(instanceId),
    });
  } catch {
    // already absent - fine
  }
}
