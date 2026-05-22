import { IS_LINUX } from "@/lib/platform";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

export const GITHUB_REPO = "IlhamriSKY/TEDI";
export const GITHUB_LATEST_RELEASE = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface ManualUpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  releaseUrl: string;
}

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "available";
      version: string;
      currentVersion: string;
      notes: string | null;
      date: string | null;
    }
  | {
      kind: "manual-available";
      version: string;
      currentVersion: string;
      notes: string | null;
      releaseUrl: string;
    }
  | {
      kind: "downloading";
      version: string;
      received: number;
      total: number | null;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
}

export function isNewerVersion(remote: string, current: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Linux manual update flow. Bundler can't apply deb/rpm in-place, so we
 *  surface the latest GitHub release. Returns null when on the latest. */
export async function fetchLinuxRelease(): Promise<ManualUpdateInfo | null> {
  const [current, res] = await Promise.all([
    getVersion(),
    fetch(GITHUB_LATEST_RELEASE, {
      headers: { Accept: "application/vnd.github+json" },
    }),
  ]);
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    body?: string;
    html_url: string;
  };
  const remote = data.tag_name.replace(/^v/, "");
  if (!isNewerVersion(remote, current)) return null;
  return {
    version: remote,
    currentVersion: current,
    notes: data.body ?? null,
    releaseUrl: data.html_url,
  };
}

export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ kind: "idle" });
  const updateRef = useRef<Update | null>(null);
  // Bumped on every `tedi --update` request. UpdaterPill watches this.
  const [forceOpenSeq, setForceOpenSeq] = useState(0);

  const reset = useCallback(() => {
    updateRef.current = null;
    setState({ kind: "idle" });
  }, []);

  const checkForUpdate = useCallback(async (): Promise<boolean> => {
    setState({ kind: "checking" });
    try {
      if (IS_LINUX) {
        const info = await fetchLinuxRelease();
        if (!info) {
          setState({ kind: "idle" });
          return false;
        }
        updateRef.current = null;
        setState({
          kind: "manual-available",
          version: info.version,
          currentVersion: info.currentVersion,
          notes: info.notes,
          releaseUrl: info.releaseUrl,
        });
        return true;
      }
      const update = await check();
      if (!update) {
        setState({ kind: "idle" });
        return false;
      }
      updateRef.current = update;
      setState({
        kind: "available",
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? null,
        date: update.date ?? null,
      });
      return true;
    } catch (e) {
      setState({ kind: "error", message: stringifyError(e) });
      return false;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    let received = 0;
    let total: number | null = null;
    setState({ kind: "downloading", version: update.version, received: 0, total: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setState({
            kind: "downloading",
            version: update.version,
            received: 0,
            total,
          });
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setState({
            kind: "downloading",
            version: update.version,
            received,
            total,
          });
        } else if (event.event === "Finished") {
          setState({ kind: "ready", version: update.version });
        }
      });
    } catch (e) {
      setState({ kind: "error", message: stringifyError(e) });
    }
  }, []);

  const relaunchApp = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: stringifyError(e) });
    }
  }, []);

  const stateKindRef = useRef(state.kind);
  stateKindRef.current = state.kind;

  // First check 8s after mount so it doesn't compete with PTY spawns and AI
  // hydration. One-shot. Skip if we've already moved out of idle (cli drain
  // or trigger event fired first).
  useEffect(() => {
    const first = window.setTimeout(() => {
      if (stateKindRef.current === "idle") {
        void checkForUpdate();
      }
    }, 8_000);
    return () => window.clearTimeout(first);
  }, [checkForUpdate]);

  // `tedi --update`: drain startup flag once and re-fire on single-instance forwards.
  // Both paths force the dialog and skip the 8s delay.
  const updateFlagDrainedRef = useRef(false);
  useEffect(() => {
    if (updateFlagDrainedRef.current) return;
    updateFlagDrainedRef.current = true;
    void invoke<boolean>("cli_take_initial_update_request").then((requested) => {
      if (requested) {
        setForceOpenSeq((n) => n + 1);
        void checkForUpdate();
      }
    });
  }, [checkForUpdate]);

  useEffect(() => {
    const unlistenP = listen<unknown>("tedi:trigger-update", () => {
      setForceOpenSeq((n) => n + 1);
      void checkForUpdate();
    });
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, [checkForUpdate]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const k = stateKindRef.current;
      if (k === "idle" || k === "error") {
        void checkForUpdate();
      }
    }, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [checkForUpdate]);

  return {
    state,
    checkForUpdate,
    downloadAndInstall,
    relaunchApp,
    reset,
    forceOpenSeq,
  };
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
