/**
 * Runtime bridge that lets the extension host list the user's saved SSH hosts
 * and open one BY ID. App.tsx wires the live callbacks (which reach React's tab
 * system + the connection store) so `host.ts` never has to import React.
 *
 * SECURITY: the only thing that ever crosses this bridge is a connection `id`
 * (and, outbound, secret-free metadata). The SSH password / private key are
 * NEVER handed across it - the actual `ssh_open` reads them from the OS keychain
 * inside the app's own connect flow (`openSshForSession`). So an extension (and,
 * downstream, the remote browser) can ask to open a saved connection without
 * ever seeing its credentials.
 *
 * `null` until App mounts; calls before that no-op so an early extension
 * activate can't crash.
 */

/** Secret-free projection of a saved SSH connection, safe to hand to an
 *  extension and the remote browser for a connection picker. */
export type SafeSshConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** True only when a server key has been pinned by a prior successful connect.
   *  The remote client may open ONLY pinned connections: a first connect needs
   *  human host-key verification via a desktop dialog, which a web user cannot
   *  safely do, so unpinned hosts are withheld from the remote picker. */
  pinned: boolean;
};

export type ListSshConnectionsFn = () => Promise<SafeSshConnection[]>;
export type OpenSshConnectionFn = (id: string) => Promise<{ ok: boolean; error?: string }>;

let lister: ListSshConnectionsFn | null = null;
let opener: OpenSshConnectionFn | null = null;

/** Close the SSH tab whose live session id is `sessionId` (the runtime id from
 *  `ssh_list_sessions`, i.e. the `ssh:<id>` the browser mirror uses). Returns
 *  true if a matching tab was found and closed. Lets a remote "close tab" tear
 *  down the real desktop tab, not just the underlying SSH session. */
export type CloseSshConnectionFn = (sessionId: number) => boolean;

let closer: CloseSshConnectionFn | null = null;

export function setSshConnectionBridge(
  list: ListSshConnectionsFn | null,
  open: OpenSshConnectionFn | null,
  close: CloseSshConnectionFn | null,
): void {
  lister = list;
  opener = open;
  closer = close;
}

export async function listSshConnections(): Promise<SafeSshConnection[]> {
  if (!lister) {
    console.warn("[extensions] listSshConnections called before App wired the bridge; ignoring");
    return [];
  }
  return lister();
}

export async function openSshConnection(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!opener) {
    console.warn("[extensions] openSshConnection called before App wired the bridge; ignoring");
    return { ok: false, error: "ssh bridge not ready" };
  }
  return opener(id);
}

export function closeSshConnection(sessionId: number): boolean {
  if (!closer) {
    console.warn("[extensions] closeSshConnection called before App wired the bridge; ignoring");
    return false;
  }
  return closer(sessionId);
}
