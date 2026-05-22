import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { IS_LINUX } from "@/lib/platform";
import { fetchLinuxRelease } from "@/modules/updater/lib/useUpdater";
import { Download04Icon, GithubIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const REPO_URL = "https://github.com/IlhamriSKY/TEDI";
const UPSTREAM_URL = "https://github.com/crynta/terax-ai";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  freebsd: "FreeBSD",
};

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; checkedAt: number }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; received: number; total: number | null }
  | { kind: "ready"; version: string }
  | { kind: "manual-available"; version: string; releaseUrl: string }
  | { kind: "error"; message: string };

export function AboutSection() {
  const [version, setVersion] = useState("");
  const [name, setName] = useState("TEDI");
  const [build, setBuild] = useState("");
  const [checkState, setCheckState] = useState<CheckState>({ kind: "idle" });
  // Held in a ref, not state. The Update handle is non-serialisable and bound
  // to the plugin's native side; putting it in state would trigger structuredClone
  // on every render and break the download callback.
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    void getVersion().then(setVersion);
    void getName().then(setName);
    try {
      const p = platform();
      const a = arch();
      const platformLabel = PLATFORM_LABEL[p] ?? p;
      setBuild(`${platformLabel} · ${a}`);
    } catch {
      setBuild("");
    }
  }, []);

  const onCheck = () => {
    void runCheck(setCheckState, updateRef);
  };
  const onInstall = () => {
    void runDownload(setCheckState, updateRef);
  };
  const onRestart = () => {
    void relaunch().catch((e) => {
      setCheckState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });
  };

  const busy = checkState.kind === "checking" || checkState.kind === "downloading";

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="About" description="" />

      <div className="border-border/60 bg-card/60 flex items-center gap-4 rounded-xl border p-5">
        <img src="/icon.png" alt="" className="size-12" draggable={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold tracking-tight">{name}</span>
          <span className="text-muted-foreground text-[11px]">
            Terminal Environment & Development Infrastructure
          </span>
          <span className="text-muted-foreground mt-1 font-mono text-[11px]">
            v{version || "-"}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[12px]">
        <dt className="text-muted-foreground">Build</dt>
        <dd className="font-mono text-[11.5px]">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>

        <dt className="text-muted-foreground">Bundle ID</dt>
        <dd className="font-mono text-[11.5px]">id.ilhamrisky.tedi</dd>

        <dt className="text-muted-foreground">License</dt>
        <dd>Apache 2.0</dd>

        <dt className="text-muted-foreground">Source code</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(REPO_URL)}
            className="hover:text-foreground inline-flex cursor-pointer items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            IlhamriSKY/TEDI
          </button>
        </dd>

        <dt className="text-muted-foreground">Built on</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(UPSTREAM_URL)}
            className="hover:text-foreground inline-flex cursor-pointer items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            crynta/terax-ai
          </button>
        </dd>
      </dl>

      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[11px]">{updaterMessage(checkState)}</p>

        {checkState.kind === "downloading" ? (
          <div className="flex flex-col gap-1.5">
            <Progress
              value={
                checkState.total && checkState.total > 0
                  ? Math.min(100, (checkState.received / checkState.total) * 100)
                  : undefined
              }
            />
            <span className="text-muted-foreground text-[11px]">
              {formatBytes(checkState.received)}
              {checkState.total ? ` / ${formatBytes(checkState.total)}` : ""}
            </span>
          </div>
        ) : null}

        {checkState.kind === "available" && checkState.notes ? (
          <pre className="border-border/60 bg-muted/40 max-h-32 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap">
            {checkState.notes}
          </pre>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onCheck} disabled={busy} className="gap-1.5">
            {checkState.kind === "checking" ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            )}
            Check for updates
          </Button>

          {checkState.kind === "available" ? (
            <Button size="sm" onClick={onInstall} className="gap-1.5">
              <HugeiconsIcon icon={Download04Icon} size={12} strokeWidth={1.75} />
              Download & install v{checkState.version}
            </Button>
          ) : null}

          {checkState.kind === "manual-available" ? (
            <Button
              size="sm"
              onClick={() => void openUrl(checkState.releaseUrl)}
              className="gap-1.5"
            >
              <HugeiconsIcon icon={Download04Icon} size={12} strokeWidth={1.75} />
              Download v{checkState.version}
            </Button>
          ) : null}

          {checkState.kind === "ready" ? (
            <Button size="sm" onClick={onRestart} className="gap-1.5">
              <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
              Restart to apply v{checkState.version}
            </Button>
          ) : null}

          <Button
            variant="outline"
            size="sm"
            onClick={() => void openUrl(REPO_URL)}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            View on GitHub
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void openUrl(`${REPO_URL}/issues/new`)}>
            Report an issue
          </Button>
        </div>
      </div>
    </div>
  );
}

async function runCheck(set: (s: CheckState) => void, ref: React.RefObject<Update | null>) {
  set({ kind: "checking" });
  ref.current = null;
  try {
    if (IS_LINUX) {
      const info = await fetchLinuxRelease();
      if (info) {
        set({
          kind: "manual-available",
          version: info.version,
          releaseUrl: info.releaseUrl,
        });
      } else {
        set({ kind: "uptodate", checkedAt: Date.now() });
      }
      return;
    }
    const update = await check();
    if (update) {
      ref.current = update;
      set({ kind: "available", version: update.version, notes: update.body ?? null });
    } else {
      set({ kind: "uptodate", checkedAt: Date.now() });
    }
  } catch (e) {
    set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

async function runDownload(set: (s: CheckState) => void, ref: React.RefObject<Update | null>) {
  const update = ref.current;
  if (!update) return;
  let received = 0;
  let total: number | null = null;
  set({ kind: "downloading", version: update.version, received: 0, total: null });
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        set({ kind: "downloading", version: update.version, received: 0, total });
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        set({ kind: "downloading", version: update.version, received, total });
      } else if (event.event === "Finished") {
        set({ kind: "ready", version: update.version });
      }
    });
  } catch (e) {
    set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

function updaterMessage(state: CheckState): string {
  switch (state.kind) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `v${state.version} is available - download & install below.`;
    case "downloading":
      return `Downloading v${state.version}…`;
    case "ready":
      return `v${state.version} is installed. Restart TEDI to apply.`;
    case "manual-available":
      return `v${state.version} is available - install manually via your package manager.`;
    case "uptodate":
      return "You're on the latest version. Auto-update checks every 6 hours.";
    case "error":
      return `Couldn't update: ${state.message}`;
    default:
      return "Auto-update checks GitHub Releases every 6 hours.";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
