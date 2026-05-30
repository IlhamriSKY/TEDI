/**
 * Shared hover / open / active styling for the top toolbar icon buttons
 * (Header, inline Search, SSH menu, extension header items) so every one of
 * them picks up the active theme's `--accent` identically.
 *
 * Why this exists: these buttons are shadcn `<Button variant="ghost">`, and the
 * ghost variant ships `dark:hover:bg-muted/50` + `dark:aria-expanded:bg-muted/50`.
 * `tailwind-merge` keys conflicts by the *full* modifier set, so a bare
 * `hover:bg-accent` never strips the `dark:hover:` one - in dark mode the
 * intended accent hover silently lost to a dull muted gray. Spelling out the
 * `dark:` variants here makes the accent state win in BOTH light and dark, and
 * keeps every toolbar button in lockstep (import the constant, never re-type the
 * string). Raw `<button>` toolbar controls (WindowControls) don't carry the
 * ghost variant and so don't need this.
 */

/** Accent hover that also wins in dark mode (beats the ghost `dark:hover:bg-muted/50`). */
export const TOOLBAR_HOVER =
  "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent dark:hover:text-accent-foreground";

/** Accent highlight for an open dropdown trigger (e.g. the SSH menu), light + dark. */
export const TOOLBAR_EXPANDED =
  "aria-expanded:bg-accent aria-expanded:text-accent-foreground dark:aria-expanded:bg-accent dark:aria-expanded:text-accent-foreground";

/** Accent fill for a toggle button's active state (markdown preview, word wrap). */
export const TOOLBAR_ACTIVE = "bg-accent text-accent-foreground";
