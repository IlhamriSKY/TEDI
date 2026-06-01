import { useChatStore } from "@/modules/ai";
import { useRightPanelStore } from "@/modules/extensions";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import type { useRightPanelStore as useRightPanelStoreType } from "@/modules/extensions";
import { useEffect } from "react";

type RightPanelActive = ReturnType<typeof useRightPanelStoreType.getState>["active"];

/**
 * Mutual-exclusion coordinator for the shared ~22% right slot.
 *
 * Right-panel, SCM right panel, and AI sidebar all want the same slot, so
 * opening one closes the others. Each effect reacts to one trigger and reads
 * the others via `getState()`, avoiding ping-pong. The fourth effect closes
 * the SCM right panel when the relevant prefs flip off.
 *
 * Caller passes the live trigger values (kept in App for render use); the
 * stores are read here directly.
 */
export function useRightPanelExclusion(
  rightPanelActive: RightPanelActive,
  panelOpen: boolean,
  scmRightOpen: boolean,
  sourceControlInRightPanel: boolean,
  showSourceControl: boolean,
  closeScmRight: () => void,
): void {
  useEffect(() => {
    if (rightPanelActive) {
      if (useChatStore.getState().panelOpen) useChatStore.getState().closePanel();
      if (useScmRightPanelStore.getState().open) useScmRightPanelStore.getState().closePanel();
    }
  }, [rightPanelActive]);
  useEffect(() => {
    if (panelOpen) {
      if (useRightPanelStore.getState().active) useRightPanelStore.getState().close();
      if (useScmRightPanelStore.getState().open) useScmRightPanelStore.getState().closePanel();
    }
  }, [panelOpen]);
  useEffect(() => {
    if (scmRightOpen) {
      if (useChatStore.getState().panelOpen) useChatStore.getState().closePanel();
      if (useRightPanelStore.getState().active) useRightPanelStore.getState().close();
    }
  }, [scmRightOpen]);

  // Close the SCM right panel when the user disables either the master
  // "Show Source Control" toggle or the "in right panel" pref. Otherwise a
  // stale open state could re-render an empty slot after the pref flips.
  useEffect(() => {
    if ((!sourceControlInRightPanel || !showSourceControl) && scmRightOpen) {
      closeScmRight();
    }
  }, [sourceControlInRightPanel, showSourceControl, scmRightOpen, closeScmRight]);
}
