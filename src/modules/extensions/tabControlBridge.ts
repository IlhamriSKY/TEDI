/**
 * Runtime bridge that lets a permitted extension PIN or RENAME a mirrored
 * terminal tab. App.tsx wires the live callbacks (which reach `useTabs`), so
 * `host.ts` never imports React. Mirrors `workspaceMgmtBridge.ts`.
 *
 * Why the remote-access extension needs this: the browser mirror is meant to
 * offer the same tab controls the desktop does, and both of these are
 * host-authoritative. A rename done only in the browser would be overwritten on
 * the next `tabmeta` frame (the desktop's title wins by design, see
 * useAppContextBridge), and a pin only affects tab ORDER, which the desktop
 * owns. So the browser asks the host to do it and reads the result back.
 *
 * Terminals are addressed the way the mirror already addresses them: the daemon
 * `ptyId` for a local terminal, `ssh:<sessionId>` for an SSH one. That is the
 * exact key `AppContextSnapshot.terminals[].ptyId` publishes, so an extension
 * can act on anything it can see and nothing it cannot.
 *
 * SECURITY: only a terminal key and a display string ever cross this bridge. It
 * moves a tab in the strip and relabels it; it cannot spawn, write to, or read
 * from a PTY. `null` until App mounts; calls before that no-op.
 */

export type PinTabFn = (key: string, pinned: boolean) => Promise<{ ok: boolean; error?: string }>;
export type RenameTabFn = (
  key: string,
  title: string | null,
) => Promise<{ ok: boolean; error?: string }>;

let pinner: PinTabFn | null = null;
let renamer: RenameTabFn | null = null;

export function setTabControlBridge(pin: PinTabFn | null, rename: RenameTabFn | null): void {
  pinner = pin;
  renamer = rename;
}

export async function pinTab(
  key: string,
  pinned: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!pinner) {
    console.warn("[extensions] pinTab called before App wired the bridge; ignoring");
    return { ok: false, error: "tab bridge not ready" };
  }
  return pinner(key, pinned);
}

export async function renameTab(
  key: string,
  title: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!renamer) {
    console.warn("[extensions] renameTab called before App wired the bridge; ignoring");
    return { ok: false, error: "tab bridge not ready" };
  }
  return renamer(key, title);
}
