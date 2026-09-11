/**
 * Layout maths for the chat's prompt rail (see `PromptRail` in AiChat.tsx): the
 * column of marks down the right edge, one per user prompt, that jumps back to
 * one when clicked.
 *
 * Split out from the component because it is the part that has to hold up
 * across every pane size TEDI can produce - a full-height sidebar, a quarter of
 * a four-way split, a small canvas window - against a session of any length.
 * Pure, so `scripts/ai/prompt-rail-verify.ts` can sweep it.
 */

/** Share of the chat's height the rail may span, centred on it. */
export const RAIL_SHARE = 0.55;
/** Row height of one mark. Marks pack tighter as prompts pile up, between these. */
export const PITCH_MAX = 10;
export const PITCH_MIN = 4;
/** A band shorter than this reads as noise rather than a rail, so it hides. */
export const RAIL_MIN_PX = 36;

export type RailFit = {
  /** Height the rail may span, in px. */
  room: number;
  /** Height of one mark's row, in px. */
  pitch: number;
  /** Whether to draw the rail at all. */
  visible: boolean;
  /** Whether the marks overflow the band, so the rail scrolls to follow the lit
   *  one. Only reachable once the pitch has bottomed out at PITCH_MIN. */
  scrolls: boolean;
};

/** How the rail lays out in a chat viewport `viewport` px tall holding `count`
 *  user prompts. */
export function fitRail(viewport: number, count: number): RailFit {
  const room = Math.max(0, viewport) * RAIL_SHARE;
  // Each mark gets an equal share of the band, clamped: a short chat must not
  // spread three marks down the whole side, and a long one must leave every
  // mark a row big enough to aim at.
  const pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, room / Math.max(count, 1)));
  return {
    room,
    pitch,
    // One prompt is not a navigator, and a pane this short has nowhere to put one.
    visible: count >= 2 && room >= RAIL_MIN_PX,
    scrolls: pitch * count > room,
  };
}
