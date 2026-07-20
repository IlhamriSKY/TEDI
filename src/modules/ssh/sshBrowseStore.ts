import { create } from "zustand";

/**
 * The folder the Remote (SSH) file tree last rooted at, per session.
 *
 * Source Control anchors remote git status on this because the SSH terminal's
 * `$PWD` is the login directory (`$HOME`) until the user `cd`s, and that is
 * almost never a repository - so keying off the shell alone made the panel
 * report "not a git repository" while the tree was plainly showing a project.
 *
 * It still tracks a `cd`: until the user picks a folder, the tree's root IS the
 * terminal's cwd (see `useSshNav`'s follow mode). Once they navigate, the tree
 * pins - and Source Control deliberately follows that same choice.
 *
 * The value deliberately survives the tree unmounting. Both panels are usually
 * live siblings in the left sidebar, but either can be docked to the right slot,
 * where they take turns - and clearing on unmount would drop the anchor back to
 * `$HOME`, the original bug. Reopening the tree republishes immediately, since
 * `useSshNav` starts a fresh mount in follow-terminal mode.
 *
 * The session id is stored alongside so a root from another host is never
 * applied. A store rather than a prop because the two panels have no common
 * parent short of App.
 */
type SshBrowseState = {
  /** Absolute POSIX path of the tree's current root, or null when none. */
  root: string | null;
  /** Session the root belongs to, so a stale root is never read against a
   *  different host. */
  sessionId: number | null;
  set: (sessionId: number | null, root: string | null) => void;
};

export const useSshBrowseStore = create<SshBrowseState>((set) => ({
  root: null,
  sessionId: null,
  set: (sessionId, root) =>
    set((s) => (s.sessionId === sessionId && s.root === root ? s : { sessionId, root })),
}));
