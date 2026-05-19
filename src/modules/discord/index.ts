import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePreferencesStore } from "@/modules/settings/preferences";

type ActivityPayload = {
  details: string;
  state: string;
};

// Module-level singletons. The hook is mounted once at the App root, but
// we keep these outside the component anyway so the connection survives a
// hypothetical hot-reload remount without leaking a second Discord client.

let connected = false;
/** The most recently requested payload. Whoever drains the queue picks it
 *  up; older payloads in flight get superseded silently. */
let pendingPayload: ActivityPayload | null = null;
/** Set while `drain()` is running so concurrent `schedulePush` calls
 *  short-circuit instead of starting a parallel drain. */
let draining = false;
/** Timer for the next retry attempt when Discord isn't reachable. */
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by `teardown()` so any in-flight `drain()` knows to bail out
 *  instead of re-arming a retry against a torn-down session. Without this,
 *  a user toggling off while a connect attempt was in flight could leave a
 *  ghost retry timer that reconnects them later behind their back. */
let sessionGen = 0;

const RETRY_DELAY_MS = 15_000;

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(payload: ActivityPayload): void {
  // Don't stack retry timers - the latest pending payload wins anyway, so
  // re-arming would just cause redundant attempts. If a retry is already
  // pending it will pick up whatever `pendingPayload` looks like when it
  // fires.
  if (retryTimer !== null) return;
  // Keep the failed payload around so the retry has something to send if
  // no newer push arrives in the meantime.
  if (pendingPayload === null) pendingPayload = payload;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drain();
  }, RETRY_DELAY_MS);
}

async function ensureConnected(): Promise<boolean> {
  if (connected) return true;
  try {
    await invoke("discord_rpc_connect");
    connected = true;
    return true;
  } catch {
    return false;
  }
}

async function sendUpdate(payload: ActivityPayload): Promise<boolean> {
  try {
    await invoke("discord_rpc_update", { payload });
    return true;
  } catch {
    // Pipe died (Discord closed mid-session) or serialization error.
    // Drop the client so the next push tries a fresh connect.
    connected = false;
    await invoke("discord_rpc_disconnect").catch(() => undefined);
    return false;
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  const myGen = sessionGen;
  try {
    while (pendingPayload !== null) {
      const next = pendingPayload;
      pendingPayload = null;
      const ok = await ensureConnected();
      if (myGen !== sessionGen) return; // teardown happened mid-await
      if (!ok) {
        scheduleRetry(next);
        return;
      }
      const sent = await sendUpdate(next);
      if (myGen !== sessionGen) return;
      if (!sent) {
        scheduleRetry(next);
        return;
      }
      // If a newer payload arrived while we were awaiting, loop picks it up.
    }
  } finally {
    draining = false;
  }
}

function schedulePush(payload: ActivityPayload): void {
  pendingPayload = payload;
  // If a retry is already armed, the timer will pick up `pendingPayload`
  // when it fires - kicking off a fresh drain here would just spam the
  // Tauri command with a doomed connect attempt every time the user
  // switches files while Discord is closed.
  if (retryTimer !== null) return;
  void drain();
}

async function teardown(): Promise<void> {
  sessionGen += 1;
  clearRetry();
  pendingPayload = null;
  if (connected) {
    connected = false;
    await invoke("discord_rpc_disconnect").catch(() => undefined);
  }
}

function folderName(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function buildPayload(input: {
  workspaceCwd: string | null;
  activeFileName: string | null;
  terminalCount: number;
}): ActivityPayload {
  const folder = folderName(input.workspaceCwd);
  const details = folder ? `Working in ${folder}` : "Idle";

  let state = "";
  if (input.activeFileName) {
    state = `Editing ${input.activeFileName}`;
  } else if (input.terminalCount > 0) {
    state = `${input.terminalCount} terminal${input.terminalCount === 1 ? "" : "s"} open`;
  }
  return { details, state };
}

export type DiscordPresenceInput = {
  workspaceCwd: string | null;
  activeFileName: string | null;
  terminalCount: number;
};

/**
 * React hook: keeps Discord Rich Presence in sync with the supplied app
 * state. Connection is opened lazily when `discordRpcEnabled` flips on,
 * and torn down when the preference flips off or the component unmounts.
 */
export function useDiscordRichPresence(input: DiscordPresenceInput): void {
  const enabled = usePreferencesStore((s) => s.discordRpcEnabled);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const { workspaceCwd, activeFileName, terminalCount } = input;

  useEffect(() => {
    if (!hydrated) return;
    if (!enabled) {
      void teardown();
      return;
    }
    schedulePush(buildPayload({ workspaceCwd, activeFileName, terminalCount }));
  }, [enabled, hydrated, workspaceCwd, activeFileName, terminalCount]);

  useEffect(() => {
    return () => {
      void teardown();
    };
  }, []);
}
