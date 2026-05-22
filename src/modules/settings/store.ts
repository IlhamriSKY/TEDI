import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  DEFAULT_MODEL_ID,
  LMSTUDIO_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  tryGetModel,
  type AutocompleteProviderId,
  type DynamicModelId,
  type ProviderId,
} from "@/modules/ai/config";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";

export type ThemePref = "system" | "light" | "dark";

export type ApprovalMode = "ask" | "semi" | "yolo";

export const EDITOR_THEMES = [
  "atomone",
  "aura",
  "copilot",
  "github-dark",
  "github-light",
  "nord",
  "tokyo-night",
  "xcode-dark",
  "xcode-light",
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  nord: "Nord",
  "tokyo-night": "Tokyo Night",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};

export type Preferences = {
  theme: ThemePref;
  defaultModelId: DynamicModelId;
  /** Provider for `defaultModelId`. Disambiguates ids shared across providers. Persisted for cold-boot restore. */
  defaultProviderId: ProviderId | null;
  editorTheme: EditorThemeId;
  customInstructions: string;
  autostart: boolean;
  restoreWindowState: boolean;
  autocompleteEnabled: boolean;
  autocompleteProvider: AutocompleteProviderId;
  autocompleteModelId: string;
  lmstudioBaseURL: string;
  openaiCompatibleBaseURL: string;
  vimMode: boolean;
  lineWrap: boolean;
  /** Show the code editor minimap. Default true. */
  showMinimap: boolean;
  terminalWebglEnabled: boolean;
  terminalFontSize: number;
  showHiddenFiles: boolean;
  /** Show the Source Control panel. Default true. */
  showSourceControl: boolean;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  /**
   * User overrides for extension keybindings. Keyed by command id from
   * `contributes.keybindings[].command`. Empty array means cleared; absent
   * entry means use the manifest default.
   */
  extensionShortcuts: Record<string, KeyBinding[]>;
  /**
   * Zoom for content surfaces only: terminal (xterm `fontSize`) and code
   * editor/diff (CodeMirror via `--content-zoom`). 1.0 = 100%. Scoped this
   * way because window-wide CSS `zoom` breaks xterm's glyph positioning.
   * Driven by the `view.zoomIn` / `view.zoomOut` / `view.zoomReset` shortcuts.
   */
  contentZoom: number;
  /** Pinned model ids. Shown as "Pinned" at the top of the AI model dropdown. Newest first. */
  pinnedModelIds: string[];
  /**
   * Approval mode for AI tool calls.
   * "ask": every mutating tool needs approval (default).
   * "semi": file edits need approval; shell commands auto-approve.
   * "yolo": all tools auto-approve.
   */
  approvalMode: ApprovalMode;
  /** Last model picked via the chat dropdown. Restored on boot. Null until first pick. */
  lastModelId: DynamicModelId | null;
  /** Provider for `lastModelId` at pick time. Persisted for cold-boot restore. */
  lastProviderId: string | null;
  /** Toast and beep on AI CLI state transitions. Default on. Per-tab badge still updates when off. */
  aiNotificationsEnabled: boolean;
  /**
   * Brand color as 6-digit hex (`#RRGGBB`). Drives `--primary`, `--ring`,
   * `--sidebar-primary`, `--sidebar-ring`, and a derived `--accent`.
   * Default `#0057fe` (TEDI logo blue).
   */
  brandColor: string;
};

export const BRAND_COLOR_DEFAULT = "#0057fe";
const HEX6_RE = /^#([0-9a-f]{6})$/i;

export function normalizeBrandColor(value: string | undefined | null): string {
  if (!value) return BRAND_COLOR_DEFAULT;
  const trimmed = value.trim();
  if (HEX6_RE.test(trimmed)) return `#${trimmed.slice(1).toLowerCase()}`;
  // Accept 3-digit hex (#abc -> #aabbcc).
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1].toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return BRAND_COLOR_DEFAULT;
}

const STORE_PATH = "tedi-settings.json";
const KEY_THEME = "theme";
const KEY_DEFAULT_MODEL = "defaultModelId";
const KEY_DEFAULT_PROVIDER = "defaultProviderId";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_CUSTOM_INSTRUCTIONS = "customInstructions";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";
const KEY_AUTOCOMPLETE_ENABLED = "autocompleteEnabled";
const KEY_AUTOCOMPLETE_PROVIDER = "autocompleteProvider";
const KEY_AUTOCOMPLETE_MODEL = "autocompleteModelId";
const KEY_LMSTUDIO_BASE_URL = "lmstudioBaseURL";
const KEY_OPENAI_COMPATIBLE_BASE_URL = "openaiCompatibleBaseURL";
const KEY_VIM_MODE = "vimMode";
const KEY_LINE_WRAP = "lineWrap";
const KEY_SHOW_MINIMAP = "showMinimap";
const KEY_TERMINAL_WEBGL_ENABLED = "terminalWebglEnabled";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_SHOW_HIDDEN_FILES = "showHiddenFiles";
const KEY_SHOW_SOURCE_CONTROL = "showSourceControl";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EXTENSION_SHORTCUTS = "extensionShortcuts";
const KEY_PINNED_MODELS = "pinnedModelIds";
const KEY_APPROVAL_MODE = "approvalMode";
const KEY_LAST_MODEL = "lastModelId";
const KEY_LAST_PROVIDER = "lastProviderId";
const KEY_CONTENT_ZOOM = "contentZoom";
const KEY_AI_NOTIFICATIONS_ENABLED = "aiNotificationsEnabled";
const KEY_BRAND_COLOR = "brandColor";

export const CONTENT_ZOOM_DEFAULT = 1.0;
export const CONTENT_ZOOM_MIN = 0.5;
export const CONTENT_ZOOM_MAX = 3.0;
export const CONTENT_ZOOM_STEP = 0.1;

export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [10, 12, 13, 14, 15, 16, 18, 20, 22, 24] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  defaultModelId: DEFAULT_MODEL_ID,
  defaultProviderId: tryGetModel(DEFAULT_MODEL_ID)?.provider ?? null,
  editorTheme: "atomone",
  customInstructions: "",
  autostart: false,
  restoreWindowState: true,
  autocompleteEnabled: false,
  autocompleteProvider: "cerebras",
  autocompleteModelId: DEFAULT_AUTOCOMPLETE_MODEL.cerebras,
  lmstudioBaseURL: LMSTUDIO_DEFAULT_BASE_URL,
  openaiCompatibleBaseURL: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  vimMode: false,
  lineWrap: false,
  showMinimap: true,
  terminalWebglEnabled: true,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  showHiddenFiles: false,
  showSourceControl: true,
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  extensionShortcuts: {} as Record<string, KeyBinding[]>,
  pinnedModelIds: [],
  approvalMode: "ask",
  lastModelId: null,
  lastProviderId: null,
  contentZoom: CONTENT_ZOOM_DEFAULT,
  aiNotificationsEnabled: true,
  brandColor: BRAND_COLOR_DEFAULT,
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange only fires in the writing process. The settings page is
// a separate webview, so mirror every setter through a Tauri event for
// cross-window listeners.
const PREFS_CHANGED_EVENT = "tedi://prefs-changed";

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip. Per-key fetches were the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    defaultModelId: get<DynamicModelId>(KEY_DEFAULT_MODEL) ?? DEFAULT_PREFERENCES.defaultModelId,
    defaultProviderId:
      get<ProviderId | null>(KEY_DEFAULT_PROVIDER) ?? DEFAULT_PREFERENCES.defaultProviderId,
    editorTheme: get<EditorThemeId>(KEY_EDITOR_THEME) ?? DEFAULT_PREFERENCES.editorTheme,
    customInstructions:
      get<string>(KEY_CUSTOM_INSTRUCTIONS) ?? DEFAULT_PREFERENCES.customInstructions,
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState: get<boolean>(KEY_RESTORE_WINDOW) ?? DEFAULT_PREFERENCES.restoreWindowState,
    autocompleteEnabled:
      get<boolean>(KEY_AUTOCOMPLETE_ENABLED) ?? DEFAULT_PREFERENCES.autocompleteEnabled,
    autocompleteProvider:
      get<AutocompleteProviderId>(KEY_AUTOCOMPLETE_PROVIDER) ??
      DEFAULT_PREFERENCES.autocompleteProvider,
    autocompleteModelId:
      get<string>(KEY_AUTOCOMPLETE_MODEL) ?? DEFAULT_PREFERENCES.autocompleteModelId,
    lmstudioBaseURL: get<string>(KEY_LMSTUDIO_BASE_URL) ?? DEFAULT_PREFERENCES.lmstudioBaseURL,
    openaiCompatibleBaseURL:
      get<string>(KEY_OPENAI_COMPATIBLE_BASE_URL) ?? DEFAULT_PREFERENCES.openaiCompatibleBaseURL,
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    lineWrap: get<boolean>(KEY_LINE_WRAP) ?? DEFAULT_PREFERENCES.lineWrap,
    showMinimap: get<boolean>(KEY_SHOW_MINIMAP) ?? DEFAULT_PREFERENCES.showMinimap,
    terminalWebglEnabled:
      get<boolean>(KEY_TERMINAL_WEBGL_ENABLED) ?? DEFAULT_PREFERENCES.terminalWebglEnabled,
    terminalFontSize: get<number>(KEY_TERMINAL_FONT_SIZE) ?? DEFAULT_PREFERENCES.terminalFontSize,
    showHiddenFiles: get<boolean>(KEY_SHOW_HIDDEN_FILES) ?? DEFAULT_PREFERENCES.showHiddenFiles,
    showSourceControl:
      get<boolean>(KEY_SHOW_SOURCE_CONTROL) ?? DEFAULT_PREFERENCES.showSourceControl,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ?? DEFAULT_PREFERENCES.shortcuts,
    extensionShortcuts:
      get<Record<string, KeyBinding[]>>(KEY_EXTENSION_SHORTCUTS) ??
      DEFAULT_PREFERENCES.extensionShortcuts,
    pinnedModelIds: get<string[]>(KEY_PINNED_MODELS) ?? DEFAULT_PREFERENCES.pinnedModelIds,
    approvalMode: get<ApprovalMode>(KEY_APPROVAL_MODE) ?? DEFAULT_PREFERENCES.approvalMode,
    lastModelId: get<DynamicModelId | null>(KEY_LAST_MODEL) ?? DEFAULT_PREFERENCES.lastModelId,
    lastProviderId: get<string | null>(KEY_LAST_PROVIDER) ?? DEFAULT_PREFERENCES.lastProviderId,
    contentZoom: clampZoom(get<number>(KEY_CONTENT_ZOOM) ?? DEFAULT_PREFERENCES.contentZoom),
    aiNotificationsEnabled:
      get<boolean>(KEY_AI_NOTIFICATIONS_ENABLED) ?? DEFAULT_PREFERENCES.aiNotificationsEnabled,
    brandColor: normalizeBrandColor(get<string>(KEY_BRAND_COLOR)),
  };
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return CONTENT_ZOOM_DEFAULT;
  return Math.min(CONTENT_ZOOM_MAX, Math.max(CONTENT_ZOOM_MIN, value));
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setDefaultModel(value: DynamicModelId, provider?: ProviderId): Promise<void> {
  await writePref(KEY_DEFAULT_MODEL, value);
  // Pair provider with id so boot restore picks the right entry when two
  // providers ship the same id. Falls back to the static registry, then null
  // (then to chat.selectedProvider at restore).
  const resolved = provider ?? tryGetModel(value)?.provider ?? null;
  await writePref(KEY_DEFAULT_PROVIDER, resolved);
}

export async function setEditorTheme(value: EditorThemeId): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

export async function setCustomInstructions(value: string): Promise<void> {
  await writePref(KEY_CUSTOM_INSTRUCTIONS, value);
}

export async function setAutostart(value: boolean): Promise<void> {
  await writePref(KEY_AUTOSTART, value);
}

export async function setRestoreWindowState(value: boolean): Promise<void> {
  await writePref(KEY_RESTORE_WINDOW, value);
}

export async function setAutocompleteEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_ENABLED, value);
}

export async function setAutocompleteProvider(value: AutocompleteProviderId): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_PROVIDER, value);
}

export async function setAutocompleteModelId(value: string): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_MODEL, value);
}

export async function setLmstudioBaseURL(value: string): Promise<void> {
  await writePref(KEY_LMSTUDIO_BASE_URL, value);
}

export async function setOpenAICompatibleBaseURL(value: string): Promise<void> {
  await writePref(KEY_OPENAI_COMPATIBLE_BASE_URL, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export async function setLineWrap(value: boolean): Promise<void> {
  await writePref(KEY_LINE_WRAP, value);
}

export async function setShowMinimap(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_MINIMAP, value);
}

export async function setTerminalWebglEnabled(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_WEBGL_ENABLED, value);
}

export async function setShowHiddenFiles(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN_FILES, value);
}

export async function setShowSourceControl(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_SOURCE_CONTROL, value);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)))
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

export async function setShortcuts(value: Record<ShortcutId, KeyBinding[]> | {}): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export async function resetShortcuts(): Promise<void> {
  await writePref(KEY_SHORTCUTS, DEFAULT_PREFERENCES.shortcuts);
}

export async function setExtensionShortcuts(
  value: Record<string, KeyBinding[]> | {},
): Promise<void> {
  await writePref(KEY_EXTENSION_SHORTCUTS, value);
}

export async function resetExtensionShortcuts(): Promise<void> {
  await writePref(KEY_EXTENSION_SHORTCUTS, DEFAULT_PREFERENCES.extensionShortcuts);
}

export async function setPinnedModelIds(value: string[]): Promise<void> {
  await writePref(KEY_PINNED_MODELS, value);
}

export async function setApprovalMode(value: ApprovalMode): Promise<void> {
  await writePref(KEY_APPROVAL_MODE, value);
}

export async function setLastModelId(value: DynamicModelId | null): Promise<void> {
  await writePref(KEY_LAST_MODEL, value);
}

export async function setLastProviderId(value: string | null): Promise<void> {
  await writePref(KEY_LAST_PROVIDER, value);
}

export async function setContentZoom(value: number): Promise<void> {
  await writePref(KEY_CONTENT_ZOOM, clampZoom(value));
}

export async function setAiNotificationsEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AI_NOTIFICATIONS_ENABLED, value);
}

export async function setBrandColor(value: string): Promise<void> {
  await writePref(KEY_BRAND_COLOR, normalizeBrandColor(value));
}

/**
 * Escape hatch for the extension host. Persists keys without typed setters.
 * Built-ins use the typed setters above; extension keys arrive here via
 * `tedi.settings.set`. Keys must be `ext:<extId>:<key>` to prevent
 * overwriting built-ins. Validation lives here so the rule holds even if a
 * future host bypasses the namespace.
 */
export async function _writeAny(key: string, value: unknown): Promise<void> {
  if (!key.startsWith("ext:")) {
    throw new Error(
      `settings._writeAny can only write namespaced extension keys, got "${key}"`,
    );
  }
  await writePref(key, value);
}

/** Reader for ext-namespaced keys. `loadPreferences()` ignores them. */
export async function _readAny<T = unknown>(key: string): Promise<T | undefined> {
  if (!key.startsWith("ext:")) {
    throw new Error(
      `settings._readAny can only read namespaced extension keys, got "${key}"`,
    );
  }
  const v = await store.get<T>(key);
  return v ?? undefined;
}

/** Subscribe to changes of any key, typed or namespaced. Used by the extension host's `tedi.settings.onChange`. */
export async function _onAnyChange(
  cb: (key: string, value: unknown) => void,
): Promise<UnlistenFn> {
  const unsubLocal = await store.onChange<unknown>((key, value) => cb(key, value));
  const unsubEvent = await listen<{ key: string; value: unknown }>(PREFS_CHANGED_EVENT, (e) => {
    cb(e.payload.key, e.payload.value);
  });
  return () => {
    unsubLocal();
    unsubEvent();
  };
}

export const APPROVAL_MODE_META: Record<ApprovalMode, { label: string; description: string }> = {
  ask: {
    label: "Ask",
    description: "Every mutating tool needs your approval",
  },
  semi: {
    label: "Semi",
    description: "File edits need approval; shell auto-approves",
  },
  yolo: {
    label: "Full Auto",
    description: "All tools auto-approve · no interruptions",
  },
};

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings to main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_DEFAULT_MODEL]: "defaultModelId",
    [KEY_DEFAULT_PROVIDER]: "defaultProviderId",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_CUSTOM_INSTRUCTIONS]: "customInstructions",
    [KEY_AUTOSTART]: "autostart",
    [KEY_RESTORE_WINDOW]: "restoreWindowState",
    [KEY_AUTOCOMPLETE_ENABLED]: "autocompleteEnabled",
    [KEY_AUTOCOMPLETE_PROVIDER]: "autocompleteProvider",
    [KEY_AUTOCOMPLETE_MODEL]: "autocompleteModelId",
    [KEY_LMSTUDIO_BASE_URL]: "lmstudioBaseURL",
    [KEY_OPENAI_COMPATIBLE_BASE_URL]: "openaiCompatibleBaseURL",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_LINE_WRAP]: "lineWrap",
    [KEY_SHOW_MINIMAP]: "showMinimap",
    [KEY_TERMINAL_WEBGL_ENABLED]: "terminalWebglEnabled",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_SHOW_HIDDEN_FILES]: "showHiddenFiles",
    [KEY_SHOW_SOURCE_CONTROL]: "showSourceControl",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_PINNED_MODELS]: "pinnedModelIds",
    [KEY_APPROVAL_MODE]: "approvalMode",
    [KEY_LAST_MODEL]: "lastModelId",
    [KEY_LAST_PROVIDER]: "lastProviderId",
    [KEY_CONTENT_ZOOM]: "contentZoom",
    [KEY_AI_NOTIFICATIONS_ENABLED]: "aiNotificationsEnabled",
    [KEY_BRAND_COLOR]: "brandColor",
  };
  // Same-process writes fire onChange directly. Cross-window writes arrive via the Tauri event from writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
  const unsubEvent = await listen<{ key: string; value: unknown }>(PREFS_CHANGED_EVENT, (e) => {
    const mapped = map[e.payload.key];
    if (mapped) cb(mapped, e.payload.value);
  });
  return () => {
    unsubLocal();
    unsubEvent();
  };
}

// API keys live in the OS keychain, not the prefs store. Broadcast via Tauri event for cross-window listeners.
const KEYS_CHANGED_EVENT = "tedi://ai-keys-changed";

export async function emitKeysChanged(): Promise<void> {
  await emit(KEYS_CHANGED_EVENT);
}

export function onKeysChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(KEYS_CHANGED_EVENT, () => cb());
}
