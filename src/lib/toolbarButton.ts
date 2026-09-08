/**
 * Shared class strings for icon buttons in the toolbar, pane headers and panel
 * headers. Import them; never re-type one.
 *
 * Every `dark:` variant below is spelled out on purpose. These buttons are
 * shadcn `<Button variant="ghost">`, which ships `dark:hover:bg-muted/50` and
 * `dark:aria-expanded:bg-muted/50`, and `tailwind-merge` keys conflicts by the
 * FULL modifier set - so a bare `hover:bg-accent` never strips the `dark:hover:`
 * one, and dark mode silently kept the dull muted gray. Raw `<button>` controls
 * (WindowControls) carry no ghost variant and need none of this.
 */

/** Accent hover for a toolbar icon button. */
export const TOOLBAR_HOVER =
  "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent dark:hover:text-accent-foreground";

/** The same, in the pane header's quieter vocabulary, so an extension's ghost
 *  button hovers like the raw grip / float / gear buttons beside it. */
export const PANE_HEADER_HOVER =
  "hover:bg-muted hover:text-foreground dark:hover:bg-muted dark:hover:text-foreground";

/** Accent highlight for an open dropdown trigger (e.g. the SSH menu). */
export const TOOLBAR_EXPANDED =
  "aria-expanded:bg-accent aria-expanded:text-accent-foreground dark:aria-expanded:bg-accent dark:aria-expanded:text-accent-foreground";

/**
 * A panel-header toggle that is currently on (the file tree's Search and
 * Search-in-files buttons).
 *
 * A coloured glyph, not an accent FILL: in a dense 32 px header row beside half
 * a dozen other icon buttons, a filled pill reads as a different KIND of
 * control. The SVG carries the colour itself so the ghost variant's
 * `hover:text-accent-foreground` cannot grey it out under the pointer.
 */
export const HEADER_TOGGLE_ACTIVE =
  "text-primary [&_svg]:text-primary hover:text-primary dark:hover:text-primary hover:bg-primary/10 dark:hover:bg-primary/10";

/** The resting half of the pair; import both. */
export const HEADER_TOGGLE_IDLE = "text-muted-foreground hover:text-foreground";

/**
 * Delete / remove icon buttons (trash glyphs, the close X on a workspace or
 * tab). Red AT REST, not only on hover: a destructive action has to be
 * findable, and avoidable, before the pointer is on it. Hover only adds a faint
 * wash; the red never changes shade.
 *
 * Both `!` rules matter, and the glyph needs its own. These sit inside rows
 * that repaint every descendant on hover - a `DropdownMenuItem`'s
 * `focus:**:text-accent-foreground`, a sidebar row's
 * `hover:text-accent-foreground` - at a specificity a plain
 * `hover:text-destructive` cannot beat, so colouring only the button leaves the
 * glyph turning grey as the pointer enters the row. Importance beats
 * specificity, which is how a nested delete button opts out of its row.
 */
export const DESTRUCTIVE_ACTION =
  "text-destructive! [&_svg]:text-destructive! hover:bg-destructive/10 dark:hover:bg-destructive/10";
