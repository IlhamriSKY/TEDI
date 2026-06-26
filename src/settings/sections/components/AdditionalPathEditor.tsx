import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IS_WINDOWS } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  cleanTerminalPath,
  setTerminalEnvPath,
  type TerminalPathEntry,
} from "@/modules/settings/store";
import {
  Add01Icon,
  AlertCircleIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SettingsAccordion } from "../../components/SettingsAccordion";

/**
 * Editor for the terminal's "Additional PATH" list. Each row is an explicit
 * entry the user adds via the input + Add button, with a button to remove it.
 * A folder in the list is active; remove it to deactivate. Writes persist
 * immediately (no commit-on-blur) so it is always clear when a change took
 * effect. The Rust PTY layer reads the entries from the settings file at spawn.
 *
 * Each row also auto-probes its folder (`terminal_probe_path`): it flags a
 * missing folder and shows the versions of known dev tools found there
 * (composer, php, node, …) so the user gets immediate confirmation a path is
 * wired up correctly instead of having to open a terminal and run `--version`.
 */
// Thin persist wrapper: writes go straight to the settings store and any
// failure is logged the same way. At module scope so it isn't reallocated each
// render and doesn't pretend to close over component state.
const persist = (next: TerminalPathEntry[]) =>
  void setTerminalEnvPath(next).catch((e) =>
    console.error("terminal additional PATH update failed", e),
  );

// Dedup key: collapse forward slashes to backslash + case-fold on Windows, and
// drop a trailing separator everywhere, so `C:/Tools/`, `C:\Tools` and
// `c:\tools` are all treated as the same directory.
const normDir = (p: string) => {
  const slashed = IS_WINDOWS ? p.replace(/\//g, "\\") : p;
  const noTrail = slashed.replace(/[\\/]+$/, "");
  return IS_WINDOWS ? noTrail.toLowerCase() : noTrail;
};
const sameDir = (a: string, b: string) => normDir(a) === normDir(b);

type ToolVersion = { tool: string; version: string; exe: string; subdir: string };
type PathProbeResult = { isDir: boolean; tools: ToolVersion[] };
type ProbeState = { loading: boolean; result?: PathProbeResult; failed?: boolean };

export function AdditionalPathEditor() {
  const entries = usePreferencesStore((s) => s.terminalEnvPath);
  const [draft, setDraft] = useState("");
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  // Auto-probe every folder whenever the list changes. Pass the whole list as
  // PATH context so a wrapper (composer.bat -> php) resolves its sibling tools.
  useEffect(() => {
    let cancelled = false;
    const dirs = entries.filter((e) => e.enabled !== false).map((e) => e.path);
    const paths = Array.from(new Set(entries.map((e) => e.path)));

    // Reset to loading but keep any prior result so a re-check doesn't flash the
    // badge back to empty; drop probe state for paths no longer present.
    setProbes((prev) => {
      const next: Record<string, ProbeState> = {};
      for (const p of paths) next[p] = { loading: true, result: prev[p]?.result };
      return next;
    });
    if (paths.length === 0) return;

    const handle = setTimeout(() => {
      void (async () => {
        const settled = await Promise.all(
          paths.map(async (p): Promise<readonly [string, ProbeState]> => {
            try {
              const result = await invoke<PathProbeResult>("terminal_probe_path", {
                path: p,
                extraDirs: dirs,
              });
              return [p, { loading: false, result }];
            } catch {
              return [p, { loading: false, failed: true }];
            }
          }),
        );
        if (cancelled) return;
        setProbes((prev) => {
          const next = { ...prev };
          for (const [p, state] of settled) next[p] = state;
          return next;
        });
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [entries]);

  const addEntry = () => {
    const path = cleanTerminalPath(draft);
    if (!path) return;
    if (!entries.some((e) => sameDir(e.path, path))) {
      persist([...entries, { path, enabled: true }]);
    }
    setDraft("");
  };

  const removeEntry = (index: number) => persist(entries.filter((_, i) => i !== index));

  return (
    <SettingsAccordion
      title="Additional PATH"
      description={
        <>
          Extra folders prepended to the terminal's PATH. Run tools that aren't on your system PATH
          (e.g. a Laragon <code className="text-foreground">composer</code>) without editing your OS
          environment variables.
        </>
      }
      summary={
        entries.length > 0 ? `${entries.length} folder${entries.length === 1 ? "" : "s"}` : "None"
      }
    >
      <div className="flex flex-col gap-3">
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
                className="border-border/50 bg-background/40 flex items-center gap-2 rounded-md border py-1.5 pr-1.5 pl-2.5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-[11.5px]" title={entry.path}>
                    {entry.path}
                  </span>
                  <ProbeStatus state={probes[entry.path]} />
                </div>
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
    </SettingsAccordion>
  );
}

/**
 * The per-row second line: a loading hint, a "folder not found" / "no tools"
 * warning, or the detected tools with their versions. Keeps showing a prior
 * result while a re-check is in flight so the badge doesn't flicker.
 */
function ProbeStatus({ state }: { state?: ProbeState }) {
  if (!state || (state.loading && !state.result)) {
    return (
      <span className="text-muted-foreground/70 flex items-center gap-1 text-[10px]">
        <HugeiconsIcon icon={Loading03Icon} size={11} strokeWidth={2} className="animate-spin" />
        Checking folder…
      </span>
    );
  }

  const result = state.result;
  if (state.failed || !result) {
    return (
      <span className="text-muted-foreground/60 text-[10px]">Couldn't check this folder.</span>
    );
  }

  if (!result.isDir) {
    return (
      <span className="text-destructive/90 flex items-center gap-1 text-[10px]">
        <HugeiconsIcon icon={CancelCircleIcon} size={11} strokeWidth={2} className="shrink-0" />
        Folder not found
      </span>
    );
  }

  if (result.tools.length === 0) {
    return (
      <span className="text-icon-working flex items-center gap-1 text-[10px]">
        <HugeiconsIcon icon={AlertCircleIcon} size={11} strokeWidth={2} className="shrink-0" />
        Folder exists, no known tools detected
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-1 text-[10px]">
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        size={11}
        strokeWidth={2}
        className="text-diff-added shrink-0"
      />
      {result.tools.map((t) => (
        <span key={t.tool} className="bg-muted/60 rounded px-1 py-px font-mono text-[9.5px]">
          {t.tool}
          {t.version ? (
            <span className="text-muted-foreground"> {t.version}</span>
          ) : (
            <span className="text-muted-foreground/60"> (detected)</span>
          )}
          {t.subdir ? <span className="text-muted-foreground/50"> · {t.subdir}</span> : null}
        </span>
      ))}
    </span>
  );
}
