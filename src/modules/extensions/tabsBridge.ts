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

/**
 * Open the extension panel as a NATIVE split-pane leaf (same frame as
 * terminal/editor/browser — drag handle, icon, title, close — and splittable /
 * joinable) instead of a standalone `kind:"ext"` tab. Reuses the same opts
 * shape; dedups on an existing live pane leaf for the panel.
 */
let paneOpener: OpenExtensionTabFn | null = null;

export function setOpenExtensionPane(fn: OpenExtensionTabFn | null): void {
  paneOpener = fn;
}

export function openExtensionPane(opts: OpenExtensionTabOpts): number | null {
  if (!paneOpener) {
    console.warn(
      "[extensions] openExtensionPane called before App wired the bridge; ignoring",
    );
    return null;
  }
  return paneOpener(opts);
}

/**
 * Lifecycle tone the extension can apply to its tab title. Re-exports the
 * type from `useTabs` so callers (host wrapper + bridge consumers) don't
 * have to import the whole tab module.
 */
import type { ExtensionTabState } from "@/modules/tabs/lib/useTabs";

export type SetExtensionTabStateOpts = {
  extensionId: string;
  panelId: string;
  reuseKey?: string;
  state: ExtensionTabState | null;
  /** Optional new tab/pane title (e.g. "SQL Explorer · mydb"). */
  title?: string;
};

export type SetExtensionTabStateFn = (opts: SetExtensionTabStateOpts) => void;

let tabStateSetter: SetExtensionTabStateFn | null = null;

export function setSetExtensionTabState(fn: SetExtensionTabStateFn | null): void {
  tabStateSetter = fn;
}

export function setExtensionTabState(opts: SetExtensionTabStateOpts): void {
  if (!tabStateSetter) {
    console.warn(
      "[extensions] setExtensionTabState called before App wired the bridge; ignoring",
    );
    return;
  }
  tabStateSetter(opts);
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

/** Visibility setter for the right-side aux column (AI chat + extension
 *  right panel + SCM right panel — three mutually-exclusive surfaces that
 *  share the same slot). App wires a callback that closes whichever of the
 *  three is currently open. Mirrors `setSidebarVisible` for the left rail,
 *  so an extension can give its workspace tab the full width on both sides
 *  without having to reach into individual stores. */
export type SetRightSidebarVisibleFn = (visible: boolean, ownerExtensionId?: string) => void;

let rightSidebarSetter: SetRightSidebarVisibleFn | null = null;

export function setRightSidebarSetter(fn: SetRightSidebarVisibleFn | null): void {
  rightSidebarSetter = fn;
}

export function setRightSidebarVisible(visible: boolean, ownerExtensionId?: string): void {
  if (!rightSidebarSetter) {
    console.warn(
      "[extensions] setRightSidebarVisible called before App wired the bridge; ignoring",
    );
    return;
  }
  rightSidebarSetter(visible, ownerExtensionId);
}
