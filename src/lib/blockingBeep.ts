// Two-tone Web Audio beep for AI CLI transitions into "blocking" (waiting
// for approval). No external asset, no media permission prompt. A user can
// override each sound with an uploaded file (Settings -> General -> Notifications);
// the custom sound is a `data:audio/...` URL read from preferences.

import { usePreferencesStore } from "@/modules/settings/preferences";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

function playToneSequence(freqs: Array<[number, number]>, gain = 0.15): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  const now = c.currentTime;
  let cursor = 0;
  for (const [freq, dur] of freqs) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, now + cursor);
    g.gain.setValueAtTime(0, now + cursor);
    g.gain.linearRampToValueAtTime(gain, now + cursor + 0.01);
    g.gain.linearRampToValueAtTime(0, now + cursor + dur);
    o.connect(g).connect(c.destination);
    o.start(now + cursor);
    o.stop(now + cursor + dur + 0.02);
    cursor += dur + 0.02;
  }
}

/** Rising two-tone: the built-in "needs approval" sound. */
function synthBlockingBeep(): void {
  playToneSequence([
    [880, 0.12],
    [1320, 0.12],
  ]);
}

/** Falling two-tone for task complete. Softer than the blocking beep. */
function synthCompletionBeep(): void {
  playToneSequence(
    [
      [1320, 0.1],
      [880, 0.14],
    ],
    0.1,
  );
}

/**
 * Play a user-uploaded sound from a `data:audio/...` URL. Returns false only
 * when the element can't be constructed, so the caller falls back to the synth
 * beep; a later async play() rejection (autoplay policy, decode error) is
 * swallowed and does NOT fall back, to avoid a doubled sound.
 */
function playCustomSound(dataUrl: string): boolean {
  try {
    const audio = new Audio(dataUrl);
    audio.volume = 0.9;
    void audio.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Rising attention sound: the user's custom approval sound if set, else the
 * built-in beep. Plays when an AI CLI transitions into "blocking".
 */
export function playBlockingBeep(): void {
  const custom = usePreferencesStore.getState().aiBlockingSound;
  if (custom && playCustomSound(custom)) return;
  synthBlockingBeep();
}

/**
 * Completion sound: the user's custom finished sound if set, else the built-in
 * beep. Plays when an AI CLI returns to idle after working.
 */
export function playCompletionBeep(): void {
  const custom = usePreferencesStore.getState().aiCompletionSound;
  if (custom && playCustomSound(custom)) return;
  synthCompletionBeep();
}

/**
 * Preview a notification sound from a LOCAL value (not the store), so the
 * Settings UI can play exactly what the user just picked without waiting for the
 * async pref write to round-trip. An empty `dataUrl` previews the built-in beep.
 */
export function previewNotificationSound(kind: "blocking" | "completion", dataUrl: string): void {
  if (dataUrl && playCustomSound(dataUrl)) return;
  if (kind === "blocking") synthBlockingBeep();
  else synthCompletionBeep();
}
