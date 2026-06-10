import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setTerminalEnvPath, type TerminalPathEntry } from "@/modules/settings/store";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

/**
 * Editor for the terminal's "Additional PATH" list. Each row is an explicit
 * entry the user adds via the input + Add button, with a per-row switch to
 * enable/disable it and a button to remove it. Writes persist immediately
 * (no commit-on-blur) so it is always clear when a change took effect. The
 * Rust PTY layer reads the enabled entries from the settings file at spawn.
 */
// Thin persist wrapper: writes go straight to the settings store and any
// failure is logged the same way. At module scope so it isn't reallocated each
// render and doesn't pretend to close over component state.
const persist = (next: TerminalPathEntry[]) =>
  void setTerminalEnvPath(next).catch((e) =>
    console.error("terminal additional PATH update failed", e),
  );

// Windows paths compare case-insensitively for dedup; POSIX is exact.
const sameDir = (a: string, b: string) =>
  IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;

export function AdditionalPathEditor() {
  const entries = usePreferencesStore((s) => s.terminalEnvPath);
  const [draft, setDraft] = useState("");

  const addEntry = () => {
    const path = draft.trim();
    if (!path) return;
    if (!entries.some((e) => sameDir(e.path, path))) {
      persist([...entries, { path, enabled: true }]);
    }
    setDraft("");
  };

  const toggleEntry = (index: number, enabled: boolean) =>
    persist(entries.map((e, i) => (i === index ? { ...e, enabled } : e)));

  const removeEntry = (index: number) => persist(entries.filter((_, i) => i !== index));

  return (
    <div className="border-border/60 bg-card/60 flex flex-col gap-3 rounded-lg border px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium">Additional PATH</span>
        <span className="text-muted-foreground text-[10.5px] leading-relaxed">
          Extra folders prepended to the terminal's PATH. Run tools that aren't on your
          system PATH (e.g. a Laragon <code className="text-foreground">composer</code>)
          without editing your OS environment variables. Applies to newly opened terminals.
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addEntry();
            }
          }}
          spellCheck={false}
          placeholder={
            IS_WINDOWS ? "D:\\Ilham\\Project\\laragon\\bin\\composer" : "/opt/tools/bin"
          }
          className="h-9 rounded-lg font-mono text-[11.5px]"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 gap-1.5 px-3 text-[12px]"
          disabled={!draft.trim()}
          onClick={addEntry}
        >
          <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
          Add
        </Button>
      </div>

      {entries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry, index) => (
            <div
              key={`${entry.path}-${index}`}
              className="border-border/50 bg-background/40 flex items-center gap-2.5 rounded-md border py-1.5 pr-1.5 pl-2.5"
            >
              <Switch
                checked={entry.enabled}
                onCheckedChange={(v) => toggleEntry(index, v)}
                aria-label={entry.enabled ? "Disable this folder" : "Enable this folder"}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                  !entry.enabled && "text-muted-foreground/60 line-through",
                )}
                title={entry.path}
              >
                {entry.path}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive size-7 shrink-0"
                onClick={() => removeEntry(index)}
                aria-label="Remove this folder"
              >
                <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={2} />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground/70 text-[10.5px] italic">
          No folders added yet.
        </span>
      )}
    </div>
  );
}
