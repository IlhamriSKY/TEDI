/**
 * Put keyboard focus back where it was after the window comes forward again.
 *
 * Alt-Tab away and back and the caret that was sitting in the AI prompt is
 * gone: either the webview dropped DOM focus to `<body>`, or a pane that
 * re-attaches on resume called `focus()` on itself and took it. Both end the
 * same way - the next keystroke does not go where the user was typing.
 *
 * Deliberately element-based rather than surface-based: "whatever you were
 * typing in" already covers the AI prompt, the terminal and the editor without
 * enumerating any of them, so a terminal that had the caret gets it back too.
 *
 * The one thing that must always win is the user: raising the window by
 * clicking straight into a pane, or starting to type immediately, is a
 * deliberate choice of where focus goes and is never overridden.
 */

let lastFocused: HTMLElement | null = null;

/** Focus resting on the document itself is not worth remembering. */
function isRestorable(el: Element | null): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el !== document.body &&
    el !== document.documentElement &&
    el.isConnected
  );
}

/**
 * The restore policy, split from the DOM plumbing so it is checkable on its own.
 *
 * `userActed` is the important one: without it this would fight a click that
 * raised the window, yanking the caret out of the pane the user just chose.
 */
export function shouldRestoreFocus(state: {
  /** A pointer or key event arrived after the window regained focus. */
  userActed: boolean;
  /** The remembered element is still in the document. */
  stillConnected: boolean;
  /** The remembered element already holds focus, so there is nothing to do. */
  alreadyFocused: boolean;
}): boolean {
  return !state.userActed && state.stillConnected && !state.alreadyFocused;
}

/** Idempotent: safe to call once per webview entry point. */
export function installFocusRestore(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("blur", () => {
    const active = document.activeElement;
    if (isRestorable(active)) lastFocused = active;
  });

  window.addEventListener("focus", () => {
    const el = lastFocused;
    if (!el) return;

    let userActed = false;
    const markActed = () => {
      userActed = true;
    };
    // Capture phase: register the intent even if something stops propagation.
    window.addEventListener("pointerdown", markActed, { capture: true });
    window.addEventListener("keydown", markActed, { capture: true });

    // Two frames: long enough to let the webview settle its own focus handling
    // AND to let a pane that re-attaches on resume grab focus first, short
    // enough that the user cannot have typed anything into the wrong place.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.removeEventListener("pointerdown", markActed, { capture: true });
        window.removeEventListener("keydown", markActed, { capture: true });
        if (
          shouldRestoreFocus({
            userActed,
            stillConnected: el.isConnected,
            alreadyFocused: document.activeElement === el,
          })
        ) {
          el.focus();
        }
      }),
    );
  });
}
