import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useRef, useState } from "react";

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
      kind: "downloading";
      version: string;
      received: number;
      total: number | null;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ kind: "idle" });
  const updateRef = useRef<Update | null>(null);

  const reset = useCallback(() => {
    updateRef.current = null;
    setState({ kind: "idle" });
  }, []);

  const checkForUpdate = useCallback(async (): Promise<boolean> => {
    setState({ kind: "checking" });
    try {
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

  useEffect(() => {
    // First check 8s after mount so it doesn't compete with PTY spawns + AI
    // hydration on cold start.
    const first = window.setTimeout(() => {
      void checkForUpdate();
    }, 8_000);
    const interval = window.setInterval(() => {
      // Don't restart a check that's already mid-flight or actively installing.
      if (state.kind === "idle" || state.kind === "error") {
        void checkForUpdate();
      }
    }, CHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
    // checkForUpdate is stable; state.kind read inside the interval needs the
    // freshest value, so we re-arm the interval on state transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  return {
    state,
    checkForUpdate,
    downloadAndInstall,
    relaunchApp,
    reset,
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
