import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  WIDE_DIALOG_WIDTH,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useDebugStore } from "../store/debugStore";

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fileStamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/**
 * Debug button shown in the AI input bar only when Settings -> Agents ->
 * Advanced & debugging -> Debug is on. Opens a viewer of every request TEDI
 * sent to the provider this session (system prompt, messages, model, params,
 * tools), each downloadable as JSON.
 */
export function DebugRequestViewer() {
  const enabled = usePreferencesStore((s) => s.debugEnabled);
  const captures = useDebugStore((s) => s.captures);
  const clear = useDebugStore((s) => s.clear);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => captures.find((c) => c.id === selectedId) ?? captures[0] ?? null,
    [captures, selectedId],
  );

  if (!enabled) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 shrink-0 px-2 text-[11px]"
        onClick={() => setOpen(true)}
        title="Inspect requests sent to the provider"
      >
        Debug{captures.length ? ` · ${captures.length}` : ""}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            "flex max-h-[90vh] flex-col gap-4 overflow-hidden",
            WIDE_DIALOG_WIDTH,
          )}
        >
          <DialogHeader>
            <DialogTitle className="text-[14px]">
              Debug · requests sent to provider
            </DialogTitle>
          </DialogHeader>

          {captures.length === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-[12px]">
              No requests captured yet. Send a message with Debug on, then reopen this.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              {/* Left: capture list */}
              <ul className="border-border/60 w-64 shrink-0 space-y-1 overflow-y-auto border-r pr-2">
                {captures.map((c) => {
                  const active = selected?.id === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(c.id)}
                        className={cn(
                          "flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors",
                          active
                            ? "border-foreground/30 bg-accent"
                            : "border-border/50 hover:bg-accent/40",
                        )}
                      >
                        <span className="truncate text-[11.5px] font-medium">
                          {c.kind === "subagent" ? `subagent · ${c.subagentType ?? "?"}` : "main agent"}
                        </span>
                        <span className="text-muted-foreground truncate font-mono text-[10px]">
                          {c.model.id} · {new Date(c.at).toLocaleTimeString()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* Right: selected capture JSON */}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {selected ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground truncate font-mono text-[11px]">
                        {selected.model.provider} · {selected.model.id}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        onClick={() =>
                          downloadJson(`tedi-request-${fileStamp(selected.at)}.json`, selected)
                        }
                      >
                        Download .json
                      </Button>
                    </div>
                    <pre className="border-border/60 bg-muted/30 min-h-0 flex-1 overflow-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                      {JSON.stringify(selected, null, 2)}
                    </pre>
                  </>
                ) : null}
              </div>
            </div>
          )}

          <DialogFooter className="grid grid-cols-1 gap-2 border-t border-border/50 pt-4 sm:grid-cols-3">
            <Button
              variant="outline"
              className="h-9 w-full"
              disabled={captures.length === 0}
              onClick={() => downloadJson(`tedi-requests-all.json`, captures)}
            >
              Download all
            </Button>
            <Button
              variant="outline"
              className="h-9 w-full"
              disabled={captures.length === 0}
              onClick={() => {
                clear();
                setSelectedId(null);
              }}
            >
              Clear
            </Button>
            <Button className="h-9 w-full" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
