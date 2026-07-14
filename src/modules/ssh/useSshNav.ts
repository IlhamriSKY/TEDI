import { useCallback, useEffect, useMemo, useState } from "react";

/** POSIX parent directory. `/` and single-segment paths resolve to `/`. */
function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

type Nav = {
  /** Manually-visited roots. `i === -1` means "follow the terminal cwd". */
  stack: string[];
  i: number;
};

/**
 * Root navigation for the SSH file explorer.
 *
 * The tree normally follows the terminal's cwd (from OSC 7). Once the user
 * navigates - Up, a breadcrumb ancestor, or Back/Forward - it pins to that
 * manual root and stops tracking the shell, so terminal activity can't yank
 * the tree out from under them. Stepping Back past the start of history
 * (`i` -> -1) returns to following the terminal again.
 *
 * History mirrors a browser: a forward branch is discarded when you navigate
 * somewhere new. `sessionId` resets everything, so a reconnect or a switch to
 * a different remote never replays a stale path.
 */
export function useSshNav(followRoot: string | null, sessionId: number | null) {
  const [nav, setNav] = useState<Nav>({ stack: [], i: -1 });

  // New session (or disconnect) drops manual history back to follow-terminal.
  useEffect(() => {
    setNav({ stack: [], i: -1 });
  }, [sessionId]);

  const root = nav.i >= 0 ? nav.stack[nav.i] : followRoot;

  const navTo = useCallback((path: string) => {
    setNav((n) => {
      const cur = n.i >= 0 ? n.stack[n.i] : null;
      if (cur === path) return n; // already here
      const base = n.stack.slice(0, n.i + 1); // drop any forward branch
      return { stack: [...base, path], i: base.length };
    });
  }, []);

  const back = useCallback(() => setNav((n) => (n.i >= 0 ? { ...n, i: n.i - 1 } : n)), []);
  const forward = useCallback(
    () => setNav((n) => (n.i < n.stack.length - 1 ? { ...n, i: n.i + 1 } : n)),
    [],
  );

  const up = useCallback(() => {
    if (!root) return;
    const p = parentDir(root);
    if (p !== root) navTo(p);
  }, [root, navTo]);

  return useMemo(
    () => ({
      /** Effective root the tree should render. Null until the home resolves. */
      root,
      navTo,
      up,
      back,
      forward,
      canBack: nav.i >= 0,
      canForward: nav.i < nav.stack.length - 1,
      canUp: !!root && parentDir(root) !== root,
    }),
    [root, navTo, up, back, forward, nav.i, nav.stack.length],
  );
}
