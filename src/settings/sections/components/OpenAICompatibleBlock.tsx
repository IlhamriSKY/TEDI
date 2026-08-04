import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { cn, maskKey } from "@/lib/utils";
import {
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_PRESETS,
  isLoopbackBaseURL,
  normalizeOpenAICompatibleBaseURL,
  type OpenAICompatibleInstance,
} from "@/modules/ai/config";
import { corsFallbackFetch } from "@/modules/ai/lib/httpProxy";
import {
  isOpenAICompatibleInstanceReady,
  refreshOpenAICompatibleInstance,
  setManualOpenAICompatibleModels,
} from "@/modules/ai/lib/openaiCompatible";
import { setOpenAICompatibleInstances } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import { Eye, EyeOff, Pencil, X } from "lucide-react";

/**
 * One OpenAI-compatible endpoint card: label + base URL + API key + presets +
 * test/detect. `instance` is `null` while adding a new endpoint (the user fills
 * the fields, then Save mints it via the parent's `onSave`); otherwise it edits
 * an existing instance. The key lives in the OS keychain; only `apiKey`
 * (presence) is passed in so the card can show a masked value.
 */
export function OpenAICompatibleBlock({
  instance,
  apiKey,
  status,
  error,
  modelsCount,
  onSave,
  onRemove,
}: {
  instance: OpenAICompatibleInstance | null;
  apiKey: string | null;
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  modelsCount: number;
  /** Persist label + base URL + key for this endpoint (mint when adding). */
  onSave: (label: string, baseURL: string, apiKey: string) => Promise<string>;
  /** Remove the endpoint (or cancel the add when `instance` is null). */
  onRemove: () => Promise<void>;
}) {
  const initialURL = instance?.baseURL ?? OPENAI_COMPATIBLE_DEFAULT_BASE_URL;
  const initialLabel = instance?.label ?? "";
  const configured = !!instance && !!apiKey;

  const [labelDraft, setLabelDraft] = useState(initialLabel);
  const [urlDraft, setUrlDraft] = useState(initialURL);
  const [keyDraft, setKeyDraft] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(!apiKey);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => setUrlDraft(initialURL), [initialURL]);
  useEffect(() => setLabelDraft(initialLabel), [initialLabel]);
  useEffect(() => {
    setKeyDraft("");
    setRevealKey(false);
    setSaveError(null);
    setEditingKey(!apiKey);
  }, [apiKey]);

  // Save persists label + URL + key in one shot. For an existing endpoint with
  // a key already stored, the key field may stay blank (keeping the old key).
  // A new endpoint needs a key UNLESS it is a local server, which has none.
  const save = async () => {
    const trimmedKey = keyDraft.trim();
    const trimmedUrl = urlDraft.trim();
    if (!trimmedUrl) {
      setSaveError("Enter a base URL.");
      return;
    }
    const isLocal = isLoopbackBaseURL(normalizeOpenAICompatibleBaseURL(trimmedUrl));
    if (!instance && !trimmedKey && !isLocal) {
      setSaveError("Enter your API key. (A local endpoint can be saved without one.)");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(labelDraft.trim(), trimmedUrl, trimmedKey);
      setKeyDraft("");
      setRevealKey(false);
      setEditingKey(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : `Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const testEndpoint = async () => {
    setTestStatus("testing");
    setTestError(null);
    try {
      const url = normalizeOpenAICompatibleBaseURL(urlDraft) + "/models";
      const auth = (keyDraft.trim() || apiKey || "").trim();
      // Not `http_ping`: a bare status code cannot tell a working API from the
      // gateway's own website. A base URL missing its `/v1` answers 200 with the
      // landing page, so Test went green on an endpoint that could never chat.
      // The timeout replaces the one `http_ping` got from its 5s reqwest client:
      // the streaming proxy this can fall back to has no overall cap, so without
      // it a host that connects and then says nothing leaves Test spinning.
      const res = await corsFallbackFetch(url, {
        method: "GET",
        headers: {
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      void res.body?.cancel().catch(() => {});
      const html = /^\s*text\/html/i.test(res.headers.get("content-type") ?? "");
      const reachable = res.status >= 200 && res.status < 400 && !html;
      setTestStatus(reachable ? "ok" : "fail");
      if (!reachable) {
        setTestError(html ? "not an API base URL - it usually ends in /v1" : `HTTP ${res.status}`);
      }
    } catch (e) {
      setTestStatus("fail");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  };

  // A typed key, or a loopback URL that needs none.
  const canSaveWithoutKey =
    !!keyDraft.trim() || isLoopbackBaseURL(normalizeOpenAICompatibleBaseURL(urlDraft.trim()));

  const refresh = () => {
    if (!instance) return;
    const url = urlDraft.trim() || initialURL;
    // Keyless is valid for a local server, so Detect must not require a key.
    if (!isOpenAICompatibleInstanceReady(url, apiKey ?? null)) return;
    void refreshOpenAICompatibleInstance(instance.id, apiKey ?? "", url, instance.label);
  };

  // Hand-typed model ids. Some gateways never expose `GET /models`: their own
  // docs hand you a model id and tell you to type it (AgentRouter documents
  // `gpt-5.5` that way, and Cline and Cursor let you). Without this the endpoint
  // saves, detects nothing, and cannot be picked, which reads as "I cannot add
  // it" even though the endpoint itself is fine.
  const allInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);
  const manualModels = instance?.manualModels ?? [];
  const [modelDraft, setModelDraft] = useState("");

  /** Persist the instance's manual ids and republish them into the picker. */
  const writeManualModels = async (next: string[]) => {
    if (!instance) return;
    const deduped = [...new Set(next.map((m) => m.trim()).filter(Boolean))];
    await setOpenAICompatibleInstances(
      allInstances.map((i) =>
        i.id === instance.id
          ? { ...i, ...(deduped.length ? { manualModels: deduped } : { manualModels: undefined }) }
          : i,
      ),
    );
    setManualOpenAICompatibleModels(
      instance.id,
      urlDraft.trim() || instance.baseURL,
      apiKey ?? "",
      deduped,
      instance.label,
    );
  };

  const maskedKey = maskKey(apiKey ?? "");

  // Highlight the chip whose baseURL matches the current draft. Trims trailing
  // slashes so "/v1" and "/v1/" both stay matched.
  const activePresetId = (() => {
    const norm = urlDraft.trim().replace(/\/$/, "");
    return OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseURL.replace(/\/$/, "") === norm)?.id;
  })();

  // Unsaved label/URL edit on an existing endpoint. The footer normally shows
  // "Detect" once configured; surface "Save" while these differ so a label (or
  // URL) change can be persisted without first entering key-replace mode.
  const dirty =
    !!instance && (labelDraft.trim() !== instance.label || urlDraft.trim() !== instance.baseURL);

  return (
    <div className="border-border/60 bg-card flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider="openai-compatible" size={14} />
        <span className="text-[12px] font-medium">{instance?.label || "OpenAI Compatible"}</span>
        {configured ? (
          <span className="border-diff-added/40 bg-diff-added/10 text-diff-added rounded border px-1.5 py-0.5 text-[9.5px] tracking-wide uppercase">
            Configured
          </span>
        ) : (
          <span className="bg-muted/50 text-muted-foreground rounded px-1.5 py-0.5 text-[9.5px] tracking-wide uppercase">
            Not set
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              // Same button is "Remove endpoint" on a saved instance and plain
              // "Cancel" on an unsaved draft; only the destructive one is red.
              className={cn(
                "ml-auto size-7",
                instance
                  ? DESTRUCTIVE_ACTION
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => void onRemove()}
              aria-label={instance ? "Remove endpoint" : "Cancel"}
            >
              <X size={12} strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{instance ? "Remove endpoint" : "Cancel"}</TooltipContent>
        </Tooltip>
      </div>

      {/* Quick-pick presets - OpenAI / OpenRouter / 9Router. Clicking a chip
       *  drops its URL into the field. Shown while editing the endpoint. */}
      {editingKey ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">Quick start</span>
          <div className="flex flex-wrap gap-1">
            {OPENAI_COMPATIBLE_PRESETS.map((preset) => {
              const active = preset.id === activePresetId;
              return (
                <Tooltip key={preset.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setUrlDraft(preset.baseURL);
                        if (!labelDraft.trim()) setLabelDraft(preset.label);
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
                        active
                          ? "border-accent bg-accent/60"
                          : "border-border/60 hover:bg-accent/30 bg-transparent",
                      )}
                    >
                      <span>{preset.label}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{preset.description}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-[10px]">Label</span>
        <Input
          value={labelDraft}
          onChange={(e) => setLabelDraft(e.target.value)}
          placeholder="e.g. OpenRouter"
          spellCheck={false}
          className="h-7 text-[11px]"
        />
      </div>

      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-2 sm:gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">Base URL</span>
          <Input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
            className="h-7 font-mono text-[11px]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">API key</span>
          {apiKey && !editingKey ? (
            <div className="flex items-center gap-1">
              <code className="bg-muted/40 text-muted-foreground flex-1 truncate rounded px-2 py-1 font-mono text-[10.5px]">
                {maskedKey}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:bg-accent size-7"
                    onClick={() => setEditingKey(true)}
                    aria-label="Replace key"
                  >
                    <Pencil size={12} strokeWidth={1.75} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Replace key</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <div className="relative">
              <Input
                type={revealKey ? "text" : "password"}
                value={keyDraft}
                disabled={saving}
                onChange={(e) => {
                  setKeyDraft(e.target.value);
                  if (saveError) setSaveError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
                placeholder={
                  isLoopbackBaseURL(normalizeOpenAICompatibleBaseURL(urlDraft.trim()))
                    ? "Not needed for a local server"
                    : apiKey
                      ? "Paste a new key (or leave blank)"
                      : "Paste API key"
                }
                autoComplete="off"
                spellCheck={false}
                className="h-7 pr-8 font-mono text-[11px]"
              />
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                tabIndex={-1}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer"
                aria-label={revealKey ? "Hide key" : "Show key"}
              >
                {revealKey ? (
                  <EyeOff size={12} strokeWidth={1.75} />
                ) : (
                  <Eye size={12} strokeWidth={1.75} />
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {saveError ? <span className="text-destructive text-[10px]">{saveError}</span> : null}

      {/* Manual model ids. Only once the endpoint exists, since they are stored
          on the instance. Offered always, not just after a failed detection: an
          endpoint can serve a model it does not list. */}
      {instance ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Input
              value={modelDraft}
              placeholder="Add a model id by hand (e.g. gpt-5.5)"
              spellCheck={false}
              className="h-8 text-[11px]"
              onChange={(e) => setModelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (!modelDraft.trim()) return;
                void writeManualModels([...manualModels, modelDraft]);
                setModelDraft("");
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!modelDraft.trim()}
              className="h-8 shrink-0 px-2 text-[11px]"
              onClick={() => {
                void writeManualModels([...manualModels, modelDraft]);
                setModelDraft("");
              }}
            >
              Add model
            </Button>
          </div>
          {manualModels.length ? (
            <div className="flex flex-wrap items-center gap-1">
              {manualModels.map((m) => (
                <span
                  key={m}
                  className="border-border/60 bg-muted/40 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px]"
                >
                  <span className="max-w-40 truncate">{m}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${m}`}
                    className="text-muted-foreground hover:text-destructive cursor-pointer"
                    onClick={() => void writeManualModels(manualModels.filter((x) => x !== m))}
                  >
                    <X size={10} strokeWidth={2.5} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground flex-1 truncate text-[10px]">
          {testStatus === "ok" ? (
            <span className="text-diff-added">Endpoint reachable.</span>
          ) : testStatus === "fail" ? (
            <span className="text-destructive">
              Unreachable{testError ? ` (${testError})` : ""}.
            </span>
          ) : testStatus === "testing" ? (
            "Testing…"
          ) : !configured ? (
            "Add key & URL, then Save to detect models."
          ) : status === "loading" ? (
            "Detecting models…"
          ) : status === "error" ? (
            <span className="text-destructive">Detection failed{error ? ` · ${error}` : ""}.</span>
          ) : status === "ok" ? (
            `${modelsCount} model${modelsCount === 1 ? "" : "s"} detected · pick one above.`
          ) : (
            "Click Detect to fetch the catalogue."
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void testEndpoint()}
          className="h-8 px-2 text-[11px]"
        >
          Test
        </Button>
        {configured && !editingKey && !dirty ? (
          <Button size="sm" variant="outline" onClick={refresh} className="h-8 px-2 text-[11px]">
            Detect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void save()}
            // A new endpoint normally needs a key, but a local server has none to
            // give: requiring one made Ollama / llama.cpp / vLLM impossible to add
            // at all, which is the first step of a local-only setup.
            disabled={saving || !urlDraft.trim() || (!instance && !canSaveWithoutKey)}
            className="h-8 px-2 text-[11px]"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
    </div>
  );
}
