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

/**
 * The same hover, in the pane header's quieter vocabulary. A pane header's own
 * buttons (grip / float / gear / close) are raw `<button>`s that hover to
 * `bg-muted`; an extension's `<Button variant="ghost">` sitting among them needs
 * the `dark:` twin spelled out for exactly the reason above, or dark mode gives
 * it `muted/50` and it hovers a shade paler than every button beside it.
 */
export const PANE_HEADER_HOVER =
  "hover:bg-muted hover:text-foreground dark:hover:bg-muted dark:hover:text-foreground";

/** Accent highlight for an open dropdown trigger (e.g. the SSH menu), light + dark. */
export const TOOLBAR_EXPANDED =
  "aria-expanded:bg-accent aria-expanded:text-accent-foreground dark:aria-expanded:bg-accent dark:aria-expanded:text-accent-foreground";

/** Accent fill for a toggle button's active state (markdown preview, word wrap). */
export const TOOLBAR_ACTIVE = "bg-accent text-accent-foreground";

/**
 * Delete / remove icon buttons (trash glyphs, and the close X on a workspace or
 * one of its tabs). Red AT REST, not only on hover: a destructive action has to
 * be findable - and avoidable - before the pointer is on it.
 *
 * The red never changes shade - hover only lays down a faint destructive wash.
 *
 * BOTH colour rules are important (`!`), and the glyph needs its own: these
 * buttons sit inside rows that repaint every descendant on hover, such as a
 * `DropdownMenuItem`'s `focus:**:text-accent-foreground` (the delete-branch and
 * delete-host rows) or a sidebar row's `hover:text-accent-foreground`. Those
 * rules paint the SVG element itself at a specificity a plain
 * `hover:text-destructive` cannot beat, so making only the button red leaves the
 * glyph turning grey the moment the pointer enters the row. Importance beats
 * specificity, which is what lets a nested delete button opt out of its row.
 *
 * Import it; never re-type the string.
 */
export const DESTRUCTIVE_ACTION =
  "text-destructive! [&_svg]:text-destructive! hover:bg-destructive/10 dark:hover:bg-destructive/10";
