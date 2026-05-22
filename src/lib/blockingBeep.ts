// Two-tone Web Audio beep for AI CLI transitions into "blocking" (waiting
// for approval). No external asset, no media permission prompt.

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

/** Rising two-tone. Plays when AI blocks for approval. */
export function playBlockingBeep(): void {
  playToneSequence([
    [880, 0.12],
    [1320, 0.12],
  ]);
}

/** Falling two-tone for task complete. Softer than the blocking beep. */
export function playCompletionBeep(): void {
  playToneSequence(
    [
      [1320, 0.1],
      [880, 0.14],
    ],
    0.1,
  );
}
