/**
 * Placement (left sidebar vs right panel) for extension sidebar sections that
 * opt in via `SidebarSection.movableToRight`. Mirrors the Source Control
 * "in right panel" preference, but generic + per-section and persisted to
 * localStorage (the sidebar lives in the main window only).
 *
 * Live open/closed state for a right-placed section still reuses
 * `useRightPanelStore` (active = { extensionId, panelId: sectionPanelId(id) })
 * so the shared right slot's mutual exclusion with the AI sidebar / SCM / other
 * extension panels works for free. What IS persisted here (`rightOpen`) is the
 * section's last open/closed intent in the slot, so a docked section restores
 * that state on the next launch instead of always auto-reopening — see
 * `useDockedSectionAutoOpen`.
 */
import { create } from "zustand";

const LS_KEY = "tedi:sidebar:placement";
const LS_OPEN_KEY = "tedi:sidebar:right-open";

/** Sentinel `panelId` used in `useRightPanelStore` to host a sidebar section
 *  (rather than a manifest right-panel) in the shared right slot. */
const SECTION_PANEL_PREFIX = "__section__:";

export function sectionPanelId(sectionId: string): string {
  return `${SECTION_PANEL_PREFIX}${sectionId}`;
}

/** Returns the sectionId for a section-sentinel panelId, else null. */
export function parseSectionPanelId(panelId: string): string | null {
  return panelId.startsWith(SECTION_PANEL_PREFIX)
    ? panelId.slice(SECTION_PANEL_PREFIX.length)
    : null;
}

/** The stable key for a contributed section (matches AppSidebar's keying). */
export function sidebarSectionKey(extensionId: string, sectionId: string): string {
  return `xsec:${extensionId}:${sectionId}`;
}

type Placement = "left" | "right";

type State = {
  placement: Record<string, Placement>;
  /** Per-section last open/closed intent while docked right, keyed by
   *  `sidebarSectionKey`. Absent = treat as open on first dock; `false` keeps
   *  the section closed across launches instead of auto-reopening. */
  rightOpen: Record<string, boolean>;
};

type Actions = {
  moveRight: (key: string) => void;
  moveLeft: (key: string) => void;
  /** Record the docked section's live open/closed state so the next launch
   *  restores it. Driven by `useDockedSectionAutoOpen`. */
  setRightOpen: (key: string, open: boolean) => void;
};

function load(): Record<string, Placement> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const out: Record<string, Placement> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === "right" || v === "left") out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupt value: default everything to the left sidebar.
  }
  return {};
}

function persist(placement: Record<string, Placement>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(placement));
  } catch {
    // localStorage may be unavailable; placement is non-critical.
  }
}

function loadRightOpen(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_OPEN_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "boolean") out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupt value: treat every docked section as default-open.
  }
  return {};
}

function persistRightOpen(rightOpen: Record<string, boolean>): void {
  try {
    localStorage.setItem(LS_OPEN_KEY, JSON.stringify(rightOpen));
  } catch {
    // localStorage may be unavailable; non-critical.
  }
}

export const useSidebarPlacementStore = create<State & Actions>((set, get) => ({
  placement: load(),
  rightOpen: loadRightOpen(),
  moveRight: (key) => {
    const next = { ...get().placement, [key]: "right" as Placement };
    persist(next);
    // Docking opens the section in the slot, so its restored intent starts open.
    const nextOpen = { ...get().rightOpen, [key]: true };
    persistRightOpen(nextOpen);
    set({ placement: next, rightOpen: nextOpen });
  },
  moveLeft: (key) => {
    const next = { ...get().placement, [key]: "left" as Placement };
    persist(next);
    set({ placement: next });
  },
  setRightOpen: (key, open) => {
    if (get().rightOpen[key] === open) return;
    const next = { ...get().rightOpen, [key]: open };
    persistRightOpen(next);
    set({ rightOpen: next });
  },
}));
