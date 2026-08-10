import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn, maskKey } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import type { ProviderInfo } from "@/modules/ai/config";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { RevealKeyButton } from "./RevealKeyButton";
import { CircleCheck, Pencil, X } from "lucide-react";

type Props = {
  provider: ProviderInfo;
  currentKey: string | null;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
};

export function ProviderKeyCard({ provider, currentKey, onSave, onClear }: Props) {
  const [editing, setEditing] = useState(!currentKey);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(!currentKey);
  }, [currentKey]);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter your API key.");
      return;
    }
    if (provider.keyPrefix && !trimmed.startsWith(provider.keyPrefix)) {
      setError(`${provider.label} keys start with "${provider.keyPrefix}".`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setValue("");
      setReveal(false);
    } catch (e) {
      setError(`Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setValue("");
    setReveal(false);
    setError(null);
    setEditing(!currentKey);
  };

  return (
    <div
      className={cn("border-border/60 bg-card flex flex-col gap-2 rounded-lg border px-3 py-2.5")}
    >
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={16} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {currentKey ? (
          <Badge
            variant="outline"
            className="border-diff-added/40 bg-diff-added/10 text-diff-added ml-1 h-4 gap-1 px-1.5 text-[10px]"
          >
            <CircleCheck size={9} strokeWidth={2} />
            Configured
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="text-muted-foreground hover:text-foreground ml-auto cursor-pointer text-[10.5px] underline-offset-2 hover:underline"
        >
          Get key
        </button>
      </div>

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="relative">
            <Input
              type={reveal ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={provider.keyPrefix ? `${provider.keyPrefix}…` : "Paste API key"}
              value={value}
              disabled={saving}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="h-8 pr-8 font-mono text-[11.5px]"
            />
            <RevealKeyButton reveal={reveal} onToggle={() => setReveal((v) => !v)} />
          </div>
          {error ? <p className="text-destructive text-[10.5px]">{error}</p> : null}
          <div className="flex justify-end gap-1.5">
            {currentKey ? (
              <Button
                size="sm"
                variant="outline"
                onClick={cancel}
                disabled={saving}
                className="h-8 px-2 text-[11px]"
              >
                Cancel
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={saving}
              className="h-8 gap-1 px-2 text-[11px]"
            >
              {saving ? <Spinner className="size-3" /> : null}
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="bg-muted/40 text-muted-foreground flex-1 truncate rounded px-2 py-1 font-mono text-[11px]">
            {maskKey(currentKey ?? "")}
          </code>
          <IconTooltip label="Replace" side="top">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setEditing(true)}
              aria-label="Replace"
              className="size-7"
            >
              <Pencil size={12} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
          <IconTooltip label="Remove" side="top">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void onClear()}
              aria-label="Remove"
              className={cn(DESTRUCTIVE_ACTION, "size-7")}
            >
              <X size={12} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        </div>
      )}
    </div>
  );
}
