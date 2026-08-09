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

/** Sentinel `extensionId` used in `useRightPanelStore` to host a BUILT-IN sidebar
 *  section (Files / Workspaces) in the shared right slot, so it flows through the
 *  same mutual-exclusion + status-bar-toggle machinery as an extension's movable
 *  sections without being a real extension. Its placement key is the plain
 *  built-in key ("files" / "workspaces"), matching AppSidebar's `BUILTIN_KEYS`. */
export const BUILTIN_SECTION_EXT = "__builtin__";

/** Built-in sidebar sections the user can dock to the right slot, mirroring the
 *  extension sections that opt in via `movableToRight`. `id` is both the
 *  AppSidebar section key and the placement key.
 *  Files is movable again: the right column STACKS its surfaces now, so the
 *  primary tree no longer contests the slot with the Secondary Folder Tree
 *  extension, and the built-in `__section__:` guard that used to close it on
 *  dock is fixed (see useExtensionPanelDefaults). */
export const MOVABLE_BUILTIN_SECTIONS = [
  { id: "files", title: "Files" },
  { id: "workspaces", title: "Workspaces" },
] as const;
export type BuiltinSectionId = (typeof MOVABLE_BUILTIN_SECTIONS)[number]["id"];

/**
 * Drag-to-undock. Only a section that was DOCKED here can go back: its stack key
 * is `xp:<extensionId>:__section__:<sectionId>`, and the placement key to clear
 * is the plain built-in id for a built-in, or `xsec:<ext>:<id>` for an
 * extension's. A manifest right-panel (the API Client, the secondary folder
 * tree) has no left-sidebar home to return to, so it answers null and stays.
 *
 * Known limit: dragging INTO an empty right column is not possible - this whole
 * component renders nothing when it holds no sections, so there is no box to
 * aim at. The header's move button still covers that case. Add a persistent
 * drop strip only if people actually hit it.
 */
export function undockTarget(
  key: string,
): { extensionId: string; panelId: string; placement: string } | null {
  // The right column keys a docked BUILT-IN section by its plain id, not by the
  // `xp:` shape everything else uses (AppRightSlot special-cases Files and
  // Workspaces so it can render the React panel directly). Missing this made the drag
  // work left-to-right and not back: `moveRight` was reachable, `moveLeft` was
  // not, for the one section most likely to be dragged.
  if (MOVABLE_BUILTIN_SECTIONS.some((s) => s.id === key)) {
    return { extensionId: BUILTIN_SECTION_EXT, panelId: sectionPanelId(key), placement: key };
  }
  if (!key.startsWith("xp:")) return null;
  const rest = key.slice(3);
  const cut = rest.indexOf(":");
  if (cut < 0) return null;
  const extensionId = rest.slice(0, cut);
  const panelId = rest.slice(cut + 1);
  const sectionId = parseSectionPanelId(panelId);
  if (!sectionId) return null;
  return {
    extensionId,
    panelId,
    placement:
      extensionId === BUILTIN_SECTION_EXT ? sectionId : sidebarSectionKey(extensionId, sectionId),
  };
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
