import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, maskKey } from "@/lib/utils";
import {
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_PRESETS,
  normalizeOpenAICompatibleBaseURL,
  type OpenAICompatibleInstance,
} from "@/modules/ai/config";
import { refreshOpenAICompatibleInstance } from "@/modules/ai/lib/openaiCompatible";
import { invoke } from "@tauri-apps/api/core";
import { Cancel01Icon, Edit02Icon, ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";

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
  // a key already stored, the key field may stay blank (keeping the old key);
  // for a new endpoint a key is required.
  const save = async () => {
    const trimmedKey = keyDraft.trim();
    const trimmedUrl = urlDraft.trim();
    if (!trimmedUrl) {
      setSaveError("Enter a base URL.");
      return;
    }
    if (!instance && !trimmedKey) {
      setSaveError("Enter your API key.");
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
      const auth = keyDraft.trim() || apiKey;
      const code = await invoke<number>("http_ping", { url, auth });
      setTestStatus(code >= 200 && code < 400 ? "ok" : "fail");
      if (!(code >= 200 && code < 400)) setTestError(`HTTP ${code}`);
    } catch (e) {
      setTestStatus("fail");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  };

  const refresh = () => {
    if (!instance || !apiKey) return;
    void refreshOpenAICompatibleInstance(
      instance.id,
      apiKey,
      urlDraft.trim() || initialURL,
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
    <div className="border-border/60 bg-card/60 flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
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
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive ml-auto size-7"
              onClick={() => void onRemove()}
              aria-label={instance ? "Remove endpoint" : "Cancel"}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
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
                    <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
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
                placeholder={apiKey ? "Paste a new key (or leave blank)" : "Paste API key"}
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
                <HugeiconsIcon
                  icon={revealKey ? ViewOffSlashIcon : ViewIcon}
                  size={12}
                  strokeWidth={1.75}
                />
              </button>
            </div>
          )}
        </div>
      </div>

      {saveError ? <span className="text-destructive text-[10px]">{saveError}</span> : null}

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
            disabled={saving || !urlDraft.trim() || (!instance && !keyDraft.trim())}
            className="h-8 px-2 text-[11px]"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
    </div>
  );
}
