import { invoke } from "@tauri-apps/api/core";
import { KEYRING_SERVICE, getProvider } from "../config";
import { emitKeysChanged } from "@/modules/settings/store";

/**
 * ChatGPT-account credentials for the `chatgpt` provider.
 *
 * The OAuth dance itself is Rust (`modules/chatgpt_auth.rs`): only it can bind
 * the loopback callback and reach the token endpoint, which sends no CORS
 * headers. This module owns what happens after - where the tokens live, and
 * keeping the access token fresh so a long session never 401s mid-turn.
 *
 * Storage is the OS keychain, the same place the pasted API keys go. A refresh
 * token is a long-lived credential; the LazyStore files are plain JSON on disk
 * and would be the wrong home for it.
 */

export type ChatGptTokens = {
  access_token: string;
  refresh_token: string;
  id_token: string;
  /** Unix SECONDS, absolute. */
  expires_at: number;
  account_id: string | null;
  email: string | null;
  plan: string | null;
};

/** What a turn needs to build the model. */
export type ChatGptAccess = { accessToken: string; accountId: string | null };

/** What Settings shows. No token material. */
export type ChatGptAccount = {
  email: string | null;
  plan: string | null;
  accountId: string | null;
};

const ACCOUNT = getProvider("chatgpt").keyringAccount;

/** Refresh this far ahead of expiry. A turn can run for minutes, so refreshing
 *  at the last second would still expire mid-stream. */
const REFRESH_SKEW_SECONDS = 300;

async function readTokens(): Promise<ChatGptTokens | null> {
  try {
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: ACCOUNT,
    });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatGptTokens>;
    if (!parsed.access_token) return null;
    return {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token ?? "",
      id_token: parsed.id_token ?? "",
      expires_at: parsed.expires_at ?? 0,
      account_id: parsed.account_id ?? null,
      email: parsed.email ?? null,
      plan: parsed.plan ?? null,
    };
  } catch {
    // Absent, or a keychain that refused. Either way: not signed in.
    return null;
  }
}

async function writeTokens(t: ChatGptTokens): Promise<void> {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: ACCOUNT,
    password: JSON.stringify(t),
  });
}

/** Run the browser sign-in and persist the result. Resolves once the callback
 *  has been received and exchanged, or rejects with the reason it failed. */
export async function signInWithChatGpt(): Promise<ChatGptAccount> {
  const tokens = await invoke<ChatGptTokens>("chatgpt_auth_login");
  await writeTokens(tokens);
  notifyChanged();
  return { email: tokens.email, plan: tokens.plan, accountId: tokens.account_id };
}

export async function signOutChatGpt(): Promise<void> {
  try {
    await invoke("secrets_delete", { service: KEYRING_SERVICE, account: ACCOUNT });
  } catch {
    // Already gone.
  }
  notifyChanged();
}

/** The signed-in account, or null. Never refreshes: this is for display, and a
 *  Settings render must not be able to spend a refresh token. */
export async function getChatGptAccount(): Promise<ChatGptAccount | null> {
  const t = await readTokens();
  if (!t) return null;
  return { email: t.email, plan: t.plan, accountId: t.account_id };
}

export async function isSignedInToChatGpt(): Promise<boolean> {
  return (await readTokens()) !== null;
}

// Concurrent turns (a chat plus a sub-agent, or two sub-agents) would each see
// the same expiring token and each burn a refresh. Share one in-flight attempt.
let refreshing: Promise<ChatGptTokens | null> | null = null;

async function refreshTokens(current: ChatGptTokens): Promise<ChatGptTokens | null> {
  if (!current.refresh_token) return null;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const next = await invoke<ChatGptTokens>("chatgpt_auth_refresh", {
        refreshToken: current.refresh_token,
      });
      // The refresh response carries no id_token in some flows, so the account
      // fields would come back null and the `chatgpt-account-id` header would
      // vanish mid-session. Keep what we already knew.
      const merged: ChatGptTokens = {
        ...next,
        account_id: next.account_id ?? current.account_id,
        email: next.email ?? current.email,
        plan: next.plan ?? current.plan,
        id_token: next.id_token || current.id_token,
      };
      await writeTokens(merged);
      return merged;
    } catch {
      // A dead refresh token means the user must sign in again. Do NOT delete
      // the stored tokens here: a network blip would then look like a sign-out.
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * The access token to send this turn, refreshed if it is close to expiry.
 * Null when there is nothing signed in, or the refresh failed.
 */
export async function getChatGptAccess(): Promise<ChatGptAccess | null> {
  const current = await readTokens();
  if (!current) return null;
  const now = Math.floor(Date.now() / 1000);
  if (current.expires_at > now + REFRESH_SKEW_SECONDS) {
    return { accessToken: current.access_token, accountId: current.account_id };
  }
  const next = await refreshTokens(current);
  if (next) return { accessToken: next.access_token, accountId: next.account_id };
  // Expired and unrefreshable: send the stale token anyway rather than failing
  // locally. The server's 401 is the honest error, and it names the fix.
  return { accessToken: current.access_token, accountId: current.account_id };
}

// Settings and the model picker both show sign-in state and neither owns it.
const listeners = new Set<() => void>();
function notifyChanged(): void {
  for (const fn of listeners) fn();
  // Same broadcast a saved API key uses, so the model picker, the bootstrap
  // hook and any other window re-read connection state without their own
  // subscription. Without it the picker keeps offering (or hiding) ChatGPT
  // models until the next restart.
  void emitKeysChanged();
}
export function onChatGptAuthChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
