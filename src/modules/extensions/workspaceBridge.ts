/**
 * Imperative actions extensions can invoke against the active workspace
 * without depending on the tab system. App.tsx sets the bridge at mount
 * and keeps it in sync; the extension subsystem reads from it.
 * Separate from `ctx.app` (read-only state) because these are write paths.
 */
export type ExtensionWorkspaceBridge = {
  /** Opens a file in the editor tab stack. `pin: true` keeps the tab past
   *  the next preview-open; omit for preview semantics. Fires async. */
  openFile(path: string, opts?: { pin?: boolean }): void;
};

let bridge: ExtensionWorkspaceBridge | null = null;

export function setExtensionWorkspaceBridge(next: ExtensionWorkspaceBridge | null): void {
  bridge = next;
}

export function getExtensionWorkspaceBridge(): ExtensionWorkspaceBridge | null {
  return bridge;
}
