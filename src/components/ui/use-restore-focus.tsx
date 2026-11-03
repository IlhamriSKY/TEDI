import { useRef, useState, type RefObject } from "react";

// A render-phase read: by the time an effect could run, an `autoFocus` field inside
// the dialog has already taken focus.
function CaptureFocus({ into }: { into: RefObject<HTMLElement | null> }) {
  useState(() => {
    into.current = document.activeElement as HTMLElement | null;
  });
  return null;
}

/**
 * Radix's modal dialogs hand focus back to their trigger on close. Most of TEDI's
 * are opened by a shortcut and have none, so focus fell on nothing and a terminal
 * took no keys until it was clicked. This returns it to where it was on open. A
 * consumer's `preventDefault` still wins, and when that element is gone (a menu row
 * that opened the dialog) Radix keeps its own behaviour.
 */
export function useRestoreFocus(onCloseAutoFocus?: (e: Event) => void) {
  const from = useRef<HTMLElement | null>(null);
  return {
    captureFocus: <CaptureFocus into={from} />,
    onCloseAutoFocus: (e: Event) => {
      onCloseAutoFocus?.(e);
      const el = from.current;
      if (e.defaultPrevented || !el?.isConnected || el === document.body) return;
      e.preventDefault();
      el.focus();
    },
  };
}
