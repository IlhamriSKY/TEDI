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
  _writePreference,
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
/**
 * Reading and writing preferences ON BEHALF OF AN AGENT - ONE definition, two
 * transports.
 *
 * An outside AI CLI reaches these through `window.__tedi` over the DevTools
 * socket (gated on `TEDI_DEBUG_PORT`, merged never assigned - see
 * `shortcuts/lib/commandRegistry.ts`); TEDI's own agent calls them directly from
 * `ai/tools/tedi.ts`, in the same realm, with no socket and no port.
 *
 * That split is the answer to "why doesn't the built-in agent just use the MCP
 * server". It would have to spawn node, connect back over CDP to the very page
 * it is running in, and would stop working whenever the automation port is off -
 * which is the default. The duplication worth removing is the DEFINITION, not
 * the transport, and this is where it stops being duplicated.
 *
 * Settings were the largest blind spot in the surface. The Settings page is a
 * SEPARATE webview, so no tool driving the main window could read or click
 * anything in it, and "change the theme" was undrivable. Going through the store
 * instead of that window sidesteps the problem entirely: a write here broadcasts
 * over `tedi://prefs-changed`, so the Settings window updates live whether it is
 * open or not.
 *
 * The read is from the hydrated zustand state, not `loadPreferences()`: it is
 * already in memory (no IPC), and it is what the app is ACTUALLY using, which is
 * the question being asked. `hydrated`/`init` are dropped - they describe this
 * store, not the user's configuration.
 *
 * NO SECRETS PASS THROUGH HERE. API keys live in the OS keyring via
 * `secrets_*` (see `src-tauri/src/modules/secrets.rs`), never in this store, so
 * a full dump carries none. Keep it that way if a key-shaped preference is ever
 * added.
 */
export function readSettings(): Record<string, unknown> {
  const { hydrated: _h, init: _i, ...prefs } = usePreferencesStore.getState();
  return prefs;
}

/**
 * Write one preference. Resolves to `true`, or to the ERROR STRING rather than
 * throwing: an unknown key and a wrong type are both the caller being wrong
 * about the world, and both consumers read a sentence better than a rejection -
 * the MCP driver because it is reading the result of an injected expression, the
 * built-in agent because a sentence is what it feeds back to the model.
 */
export async function writeSetting(key: string, value: unknown): Promise<true | string> {
  try {
    await _writePreference(key, value);
    return true;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

if (typeof window !== "undefined") {
  const w = window as unknown as {
    __TEDI_AUTOMATION__?: boolean;
    __tedi?: Record<string, unknown>;
  };
  if (w.__TEDI_AUTOMATION__) {
    w.__tedi = { ...w.__tedi, settings: readSettings, setSetting: writeSetting };
  }
}

export function setColumnPlacement(section: "scm" | "ssh", inRightPanel: boolean): void {
  if (section === "scm") {
    usePreferencesStore.setState({ sourceControlInRightPanel: inRightPanel });
    void setSourceControlInRightPanel(inRightPanel);
    return;
  }
  usePreferencesStore.setState({ sshInRightPanel: inRightPanel });
  void setSshInRightPanel(inRightPanel);
}
