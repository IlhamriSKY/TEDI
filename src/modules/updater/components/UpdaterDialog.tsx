import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { UpdaterState } from "../lib/useUpdater";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: UpdaterState;
  onInstall: () => void;
  onRelaunch: () => void;
};

export function UpdaterDialog({
  open,
  onOpenChange,
  state,
  onInstall,
  onRelaunch,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titleFor(state)}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-[12px] leading-relaxed">
          {state.kind === "available" && (
            <>
              <p className="text-muted-foreground">
                A new version of TEDI is available.{" "}
                <span className="font-medium text-foreground">
                  v{state.currentVersion}
                </span>{" "}
                →{" "}
                <span className="font-medium text-foreground">
                  v{state.version}
                </span>
                {state.date ? (
                  <span className="text-muted-foreground"> · {state.date}</span>
                ) : null}
              </p>
              {state.notes ? (
                <pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
                  {state.notes}
                </pre>
              ) : null}
            </>
          )}

          {state.kind === "downloading" && (
            <>
              <p className="text-muted-foreground">
                Downloading v{state.version}…
              </p>
              <Progress
                value={
                  state.total && state.total > 0
                    ? Math.min(100, (state.received / state.total) * 100)
                    : undefined
                }
              />
              <p className="text-[11px] text-muted-foreground">
                {formatBytes(state.received)}
                {state.total ? ` / ${formatBytes(state.total)}` : ""}
              </p>
            </>
          )}

          {state.kind === "ready" && (
            <p className="text-muted-foreground">
              v{state.version} is installed. Restart TEDI to apply the update.
            </p>
          )}

          {state.kind === "error" && (
            <p className="text-destructive">{state.message}</p>
          )}
        </div>

        <DialogFooter>
          {state.kind === "available" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Later
              </Button>
              <Button onClick={onInstall}>Download & install</Button>
            </>
          )}
          {state.kind === "downloading" && (
            <Button variant="ghost" disabled>
              Installing…
            </Button>
          )}
          {state.kind === "ready" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Later
              </Button>
              <Button onClick={onRelaunch}>Restart now</Button>
            </>
          )}
          {state.kind === "error" && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function titleFor(state: UpdaterState): string {
  switch (state.kind) {
    case "available":
      return "Update available";
    case "downloading":
      return "Downloading update";
    case "ready":
      return "Update ready";
    case "error":
      return "Update failed";
    default:
      return "Update";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
