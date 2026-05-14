import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import type { UpdaterState } from "../lib/useUpdater";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: UpdaterState;
  onInstall: () => void;
  onRelaunch: () => void;
};

type DistroKey = "arch" | "debian" | "fedora";

function distroCommand(key: DistroKey, version: string): string {
  switch (key) {
    case "arch":
      return "yay -S terax-bin";
    case "debian":
      return `sudo apt install ./TEDI_${version}_amd64.deb`;
    case "fedora":
      return `sudo dnf install ./TEDI-${version}-1.x86_64.rpm`;
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

const DISTROS: { key: DistroKey; label: string }[] = [
  { key: "arch", label: "Arch" },
  { key: "debian", label: "Debian / Ubuntu" },
  { key: "fedora", label: "Fedora / RHEL" },
];

export function UpdaterDialog({
  open,
  onOpenChange,
  state,
  onInstall,
  onRelaunch,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [distro, setDistro] = useState<DistroKey>("arch");
  const manualVersion = state.kind === "manual-available" ? state.version : "";
  const activeCommand = distroCommand(distro, manualVersion);

  const copyCommand = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(activeCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

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

          {state.kind === "manual-available" && (
            <>
              <p className="text-muted-foreground">
                You're on{" "}
                <span className="font-medium text-foreground">
                  v{state.currentVersion}
                </span>{" "}
                — v
                <span className="font-medium text-foreground">
                  {state.version}
                </span>{" "}
                is available. Pick your distro and run the command, or grab the
                package from GitHub.
              </p>
              <div className="flex gap-1 rounded-md bg-muted/40 p-1">
                {DISTROS.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => setDistro(d.key)}
                    className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
                      distro === d.key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[12px]">
                <span className="flex-1 select-all">$ {activeCommand}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => void copyCommand()}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
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
          {state.kind === "manual-available" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Later
              </Button>
              <Button onClick={() => void openUrl(state.releaseUrl)}>
                Download package
              </Button>
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
    case "manual-available":
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
