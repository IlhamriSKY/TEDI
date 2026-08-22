import { create } from "zustand";
import { slugify } from "@/lib/utils";
import { normalizeCustomTheme } from "./customTheme";
import {
  consumePendingPresetRequest,
  DEFAULT_PREFERENCES,
  loadPreferences,
  onPreferencesChange,
  setCustomTheme,
  setCustomThemeEnabled,
  setSourceControlInRightPanel,
  setSshInRightPanel,
  type Preferences,
} from "./store";
import { THEME_PRESETS } from "./themePresets";

type State = Preferences & {
  hydrated: boolean;
  /** Subscribe and hydrate. Idempotent; safe to call from multiple windows. */
  init: () => Promise<void>;
};

let initialized = false;

/**
 * Honour a `customThemePresetRequest` written by `tedi theme set <id>`.
 * Looks up the preset, swaps it in, enables custom theme, and clears the
 * request flag so the request is one-shot. Failures (unknown id, IO) are
 * logged and swallowed so a malformed CLI write does not block boot.
 */
async function applyPendingPresetRequest(): Promise<void> {
  try {
    const id = await consumePendingPresetRequest();
    if (!id) return;
    const preset = THEME_PRESETS.find((p) => slugify(p.name) === id);
    if (!preset) {
      console.warn(`Pending theme preset "${id}" is not in the preset list; ignoring.`);
      return;
    }
    await setCustomTheme(preset);
    await setCustomThemeEnabled(true);
  } catch (err) {
    console.warn("Failed to apply pending preset request", err);
  }
}

export const usePreferencesStore = create<State>((set) => ({
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  init: async () => {
    if (initialized) return;
    initialized = true;
    // Apply any `tedi theme set <id>` request before loading the snapshot
    // so the freshly applied preset is what hydrates state.
    await applyPendingPresetRequest();
    const prefs = await loadPreferences();
    set({ ...prefs, hydrated: true });
    void onPreferencesChange((key, value) => {
      if (key === "customTheme") {
        const normalized = normalizeCustomTheme(value, DEFAULT_PREFERENCES.customTheme);
        set({ customTheme: normalized });
        return;
      }
      set({ [key]: value } as Partial<State>);
    });
  },
}));

/**
 * Move Source Control / Remote between the two columns.
 *
 * The preference is what decides which column renders the section, and it is
 * PERSISTED over IPC: `writePref` awaits a Tauri store write and then emits, so
 * this store only learns the new value when that echo comes back, several ticks
 * later. The right column's open flag, meanwhile, is a plain synchronous zustand
 * set. For those few ticks the app therefore saw "open on the right" together
 * with "not docked right" - which is precisely the state `useRightPanelExclusion`
 * exists to clean up. It closed the panel that had just been opened, and once the
 * echo finally landed the sidebar dropped the section as well, so Source Control
 * ended up in NEITHER column until the user found its status-bar icon.
 *
 * Writing this store FIRST closes that window. The persisted write still happens;
 * its echo then sets the same value and is a no-op.
 */
export function setColumnPlacement(section: "scm" | "ssh", inRightPanel: boolean): void {
  if (section === "scm") {
    usePreferencesStore.setState({ sourceControlInRightPanel: inRightPanel });
    void setSourceControlInRightPanel(inRightPanel);
    return;
  }
  usePreferencesStore.setState({ sshInRightPanel: inRightPanel });
  void setSshInRightPanel(inRightPanel);
}
