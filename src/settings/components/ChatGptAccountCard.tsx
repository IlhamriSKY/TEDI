import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { getProvider } from "@/modules/ai/config";
import {
  getChatGptAccount,
  onChatGptAuthChanged,
  signInWithChatGpt,
  signOutChatGpt,
  type ChatGptAccount,
} from "@/modules/ai/lib/chatgptAuth";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Copy, LogIn } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";

/**
 * Sign in with a ChatGPT account instead of pasting an API key.
 *
 * Turns run against the ChatGPT subscription rather than API credits. The card
 * is deliberately not a `ProviderKeyCard` variant: there is no key to show,
 * mask, or reveal, and the only states are "signed out", "waiting for the
 * browser", and "signed in as".
 */
export function ChatGptAccountCard() {
  const provider = getProvider("chatgpt");
  const [account, setAccount] = useState<ChatGptAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The authorize URL, surfaced while the sign-in is pending. The system browser
  // usually opens on its own, but a locked-down desktop silently does nothing,
  // and then a spinner with no link is a dead end.
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    void getChatGptAccount()
      .then(setAccount)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    return onChatGptAuthChanged(reload);
  }, [reload]);

  useEffect(() => {
    const un = listen<string>("chatgpt-auth-url", (e) => setAuthUrl(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setAccount(await signInWithChatGpt());
    } catch (e) {
      // Rust returns a sentence naming the actual cause (port taken, timed out,
      // refused, token endpoint status). Show it verbatim; "sign-in failed"
      // would throw all of that away.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setAuthUrl(null);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await signOutChatGpt();
      setAccount(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-border/60 bg-card flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider="openai" size={16} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {account ? (
          <Badge
            variant="outline"
            className="border-diff-added/40 bg-diff-added/10 text-diff-added ml-1 h-4 gap-1 px-1.5 text-[10px]"
          >
            <CircleCheck size={9} strokeWidth={2} />
            Signed in
          </Badge>
        ) : null}
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <Spinner className="size-3" />
          Checking…
        </div>
      ) : account ? (
        <>
          <div className="min-w-0 text-[11px]">
            <div className="truncate">{account.email ?? "ChatGPT account"}</div>
            <div className="text-muted-foreground text-[10.5px]">
              {account.plan ? `Plan: ${account.plan}. ` : ""}
              Turns run on the subscription, not API credits.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={DESTRUCTIVE_ACTION}
              disabled={busy}
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-[10.5px]">
            Use your ChatGPT Plus or Pro subscription instead of an API key. Opens your browser to
            sign in with OpenAI.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              disabled={busy}
              onClick={() => void signIn()}
            >
              {busy ? <Spinner className="size-3" /> : <LogIn size={11} strokeWidth={2} />}
              {busy ? "Waiting for browser…" : "Sign in with ChatGPT"}
            </Button>
            {busy && authUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => {
                  // Webview clipboard WRITE works (only read is blocked in wry),
                  // which is what every other copy button here uses.
                  void navigator.clipboard.writeText(authUrl).then(() => setCopied(true));
                }}
              >
                <Copy size={11} strokeWidth={2} />
                {copied ? "Link copied" : "Copy sign-in link"}
              </Button>
            ) : null}
          </div>
        </>
      )}

      {error ? <p className="text-destructive text-[10.5px]">{error}</p> : null}
    </div>
  );
}
