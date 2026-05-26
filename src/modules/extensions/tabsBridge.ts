/**
 * Runtime bridge that lets the extension host call into the tab system.
 * App.tsx wires the active `openExtensionTab` callback on every render;
 * `host.ts` reads it from this module so it never has to import React.
 *
 * `null` until App mounts. Calls before that return null (no-op) so a
 * very-early extension activate doesn't crash.
 */

export type OpenExtensionTabOpts = {
  extensionId: string;
  panelId: string;
  title: string;
  icon?: string;
  /** Stable id for dedup; same value focuses the existing tab. */
  reuseKey?: string;
};

export type OpenExtensionTabFn = (opts: OpenExtensionTabOpts) => number | null;

let opener: OpenExtensionTabFn | null = null;

export function setOpenExtensionTab(fn: OpenExtensionTabFn | null): void {
  opener = fn;
}

export function openExtensionTab(opts: OpenExtensionTabOpts): number | null {
  if (!opener) {
    console.warn(
      "[extensions] openExtensionTab called before App wired the bridge; ignoring",
    );
    return null;
  }
  return opener(opts);
}

/** Visibility setter for the left sidebar (file explorer + SCM panel).
 *  App wires the imperative collapse / expand on `sidebarRef`. The optional
 *  `ownerExtensionId` lets App attribute a hide request to an extension so
 *  it can auto-restore the prior visibility when the user switches away
 *  from that extension's tab, and re-hide when they return. Calls without
 *  an owner are treated as a user-driven toggle and clear any pending
 *  restore. */
export type SetSidebarVisibleFn = (visible: boolean, ownerExtensionId?: string) => void;

let sidebarSetter: SetSidebarVisibleFn | null = null;

export function setSidebarSetter(fn: SetSidebarVisibleFn | null): void {
  sidebarSetter = fn;
}

export function setSidebarVisible(visible: boolean, ownerExtensionId?: string): void {
  if (!sidebarSetter) {
    console.warn(
      "[extensions] setSidebarVisible called before App wired the bridge; ignoring",
    );
    return;
  }
  sidebarSetter(visible, ownerExtensionId);
}
