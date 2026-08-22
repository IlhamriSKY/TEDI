/**
 * One routing table for "which column does this section live in".
 *
 * A section can change columns two ways - the move button on its own header, or
 * dragging its grip across - and each route used to be wired on its own. That is
 * why Source Control and Remote had the buttons but could not be dragged, and
 * the AI panel had neither. Both routes call these now, so anything that can
 * move one way can move the other.
 *
 * Three stores back the placement, for historical reasons, and this module is
 * where that is absorbed:
 *   - Files / Workspaces / AI / extension sections: `sidebarPlacementStore`
 *     (plus `rightPanelStore` for the live open state in the column)
 *   - Source Control: the `sourceControlInRightPanel` preference + `scmRightPanelStore`
 *   - Remote: the `sshInRightPanel` preference + `sshRightPanelStore`
 *
 * A LEFT key is a sidebar section key ("files", "ai", `xsec:<ext>:<id>`); a
 * RIGHT key is the right column's own ("files", "ai", `xp:<ext>:<panelId>`).
 * `dockRight` takes the former, `dockLeft` the latter.
 */
import {
  BUILTIN_SECTION_EXT,
  sectionPanelId,
  undockTarget,
  useRightPanelStore,
  useSidebarPlacementStore,
} from "@/modules/extensions";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import { setColumnPlacement } from "@/modules/settings/preferences";
import { useSshRightPanelStore } from "@/modules/ssh/sshRightPanelStore";
import { revealColumn } from "@/lib/sectionDrag";

/** Built-ins that may sit in either column, under the SAME key on both sides. */
const DUAL_COLUMN_BUILTINS = ["files", "workspaces", "scm", "ssh", "ai"] as const;

function isDualColumnBuiltin(key: string): boolean {
  return (DUAL_COLUMN_BUILTINS as readonly string[]).includes(key);
}

/** Splits a sidebar section key (`xsec:<extensionId>:<sectionId>`). Mirrors
 *  `sidebarSectionKey`, which builds it. */
function parseExtSectionKey(key: string): { extensionId: string; sectionId: string } | null {
  if (!key.startsWith("xsec:")) return null;
  const rest = key.slice(5);
  const cut = rest.indexOf(":");
  if (cut < 0) return null;
  return { extensionId: rest.slice(0, cut), sectionId: rest.slice(cut + 1) };
}

/**
 * May this LEFT-column section move right? `extMovableToRight` answers for an
 * extension section, whose opt-in lives in its manifest and is only known to the
 * component holding the registry.
 */
export function canDockRight(key: string, extMovableToRight: (key: string) => boolean): boolean {
  return isDualColumnBuiltin(key) || extMovableToRight(key);
}

/** May this RIGHT-column section move left? A manifest right-panel (the API
 *  client, a secondary tree) has no sidebar home, so it answers false and
 *  stays put. */
export function canDockLeft(key: string): boolean {
  return isDualColumnBuiltin(key) || undockTarget(key) !== null;
}

/** Hand a left-sidebar section to the right column. No-op for a key that
 *  `canDockRight` rejects. */
export function dockRight(key: string): void {
  // Every route ends here, so this is the one place that has to ask the
  // destination to show itself. Without it, moving a section into a column that
  // is minimized shut makes it vanish with no feedback at all.
  revealColumn("right");
  switch (key) {
    case "scm":
      setColumnPlacement("scm", true);
      useScmRightPanelStore.getState().openPanel();
      return;
    case "ssh":
      setColumnPlacement("ssh", true);
      useSshRightPanelStore.getState().openPanel();
      return;
    // The AI panel's open/closed state is the chat store's `panelOpen`, shared
    // by both columns, so placement is all there is to move.
    case "ai":
      useSidebarPlacementStore.getState().moveRight("ai");
      return;
    case "files":
    case "workspaces":
      useSidebarPlacementStore.getState().moveRight(key);
      useRightPanelStore.getState().open(BUILTIN_SECTION_EXT, sectionPanelId(key));
      return;
  }
  const ext = parseExtSectionKey(key);
  if (!ext) return;
  useSidebarPlacementStore.getState().moveRight(key);
  useRightPanelStore.getState().open(ext.extensionId, sectionPanelId(ext.sectionId));
}

/** Hand a right-column section back to the left sidebar. No-op for a key that
 *  `canDockLeft` rejects. */
export function dockLeft(key: string): void {
  revealColumn("left");
  switch (key) {
    case "scm":
      setColumnPlacement("scm", false);
      useScmRightPanelStore.getState().closePanel();
      return;
    case "ssh":
      setColumnPlacement("ssh", false);
      useSshRightPanelStore.getState().closePanel();
      return;
    case "ai":
      useSidebarPlacementStore.getState().moveLeft("ai");
      return;
  }
  const target = undockTarget(key);
  if (!target) return;
  useSidebarPlacementStore.getState().moveLeft(target.placement);
  useRightPanelStore.getState().close(target.extensionId, target.panelId);
}
