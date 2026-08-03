import { useEffect } from "react";

/**
 * Housekeeping for the right column's docked panels.
 *
 * There is no mutual exclusion any more: the column stacks its surfaces (see
 * `AppRightSlot`), so opening Source Control no longer closes the AI panel.
 * What remains is closing a docked panel when the preference that put it there
 * flips off, which nothing else watches.
 */
export function useRightPanelExclusion(
  scmRightOpen: boolean,
  sourceControlInRightPanel: boolean,
  showSourceControl: boolean,
  closeScmRight: () => void,
  sshRightOpen: boolean,
  sshInRightPanel: boolean,
  hasAnySshLeaf: boolean,
  closeSshRight: () => void,
): void {
  // Close the SCM right panel when the user disables either the master
  // "Show Source Control" toggle or the "in right panel" pref. Otherwise a
  // stale open state could re-render an empty slot after the pref flips.
  useEffect(() => {
    if ((!sourceControlInRightPanel || !showSourceControl) && scmRightOpen) {
      closeScmRight();
    }
  }, [sourceControlInRightPanel, showSourceControl, scmRightOpen, closeScmRight]);

  // Close the SSH right panel when it's un-docked from the right or the last
  // SSH leaf disconnects (the sidebar hides SSH the same way, on !hasAnySshLeaf).
  useEffect(() => {
    if ((!sshInRightPanel || !hasAnySshLeaf) && sshRightOpen) {
      closeSshRight();
    }
  }, [sshInRightPanel, hasAnySshLeaf, sshRightOpen, closeSshRight]);
}
