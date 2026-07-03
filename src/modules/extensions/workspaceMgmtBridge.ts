/**
 * Runtime bridge that lets a permitted extension CREATE a workspace and SWITCH
 * the active one. App.tsx wires the live callbacks (which reach the workspaces
 * store + the switch orchestration) so `host.ts` never imports React. Mirrors
 * `sshBridge.ts`. (Distinct from `workspaceBridge.ts`, which is the file-open
 * bridge for `ctx.ui.mountFolderTree`.)
 *
 * Why the remote-access extension needs this: the browser mirror shows the
 * desktop's workspaces, and a terminal opened from the browser is ADOPTED into
 * whichever workspace is ACTIVE on the desktop (see useAdoptDaemonSessions). So
 * to let the web pick a target workspace (or make a new one) the extension asks
 * the host to switch/create the active workspace FIRST; the terminal the browser
 * then opens (via the native agent) is adopted into that now-active workspace.
 * Switching to a freshly-created empty workspace auto-seeds a default terminal
 * tab, so a "new workspace" shows up in the mirror without any extra open.
 *
 * SECURITY: only a workspace id / name ever crosses this bridge; it manipulates
 * UI state (which workspace is shown). The actual shell spawn stays on the
 * existing, separately-gated open path. `null` until App mounts; calls before
 * that no-op.
 */

export type CreateWorkspaceFn = (
  name: string,
) => Promise<{ ok: boolean; wsId?: string; error?: string }>;
export type SetActiveWorkspaceFn = (wsId: string) => Promise<{ ok: boolean; error?: string }>;

let creator: CreateWorkspaceFn | null = null;
let activator: SetActiveWorkspaceFn | null = null;

export function setWorkspaceMgmtBridge(
  create: CreateWorkspaceFn | null,
  setActive: SetActiveWorkspaceFn | null,
): void {
  creator = create;
  activator = setActive;
}

export async function createWorkspace(
  name: string,
): Promise<{ ok: boolean; wsId?: string; error?: string }> {
  if (!creator) {
    console.warn("[extensions] createWorkspace called before App wired the bridge; ignoring");
    return { ok: false, error: "workspace bridge not ready" };
  }
  return creator(name);
}

export async function setActiveWorkspace(
  wsId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!activator) {
    console.warn("[extensions] setActiveWorkspace called before App wired the bridge; ignoring");
    return { ok: false, error: "workspace bridge not ready" };
  }
  return activator(wsId);
}
