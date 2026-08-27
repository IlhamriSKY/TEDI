import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  DEFAULT_MODEL_ID,
  LMSTUDIO_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
  tryGetModel,
  type AutocompleteProviderId,
  type DynamicModelId,
  type OpenAICompatibleInstance,
  type ProviderId,
} from "@/modules/ai/config";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import { normalizeCustomTheme, type CustomTheme } from "./customTheme";
import {
  DEFAULT_TERMINAL_PALETTE,
  DEFAULT_TERMINAL_THEME_ID,
  normalizeTerminalPalette,
  TERMINAL_THEME_MODES,
  type TerminalPalette,
  type TerminalThemeMode,
} from "./terminalPalette";
import { withSubagentsDisabled } from "@/modules/ai/tools/catalog";
import { DEFAULT_CONTENT_FONT_ID, isValidContentFontId } from "@/lib/fonts";
import {
  DEFAULT_SEARCH_ENGINE_ID,
  SEARCH_ENGINES,
  searchEngineById,
  type SearchEngineId,
} from "./searchEngines";
import { DEFAULT_CUSTOM_THEME } from "./themePresets";

const THEME_PREFS = ["system", "light", "dark"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

const APPROVAL_MODES = ["ask", "semi", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

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

/**
 * One entry in the terminal's "Additional PATH" list. `enabled: false` keeps
 * the directory in the list (so the user can flip it back on) but excludes it
 * from the PATH the Rust PTY layer assembles at spawn.
 */
export type TerminalPathEntry = { path: string; enabled: boolean };

/**
 * Normalize a user-entered PATH directory before persisting: trim whitespace,
 * then strip one surrounding pair of double quotes. Windows Explorer's "Copy as
 * path" (Shift+Right-click) yields `"C:\Tools\bin"` with literal quotes; left
 * as-is the entry becomes a directory literally named with quotes and silently
 * never resolves. Cleaning on write keeps the stored value matching what the
 * editor displays.
 */
export function cleanTerminalPath(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

export type Preferences = {
  theme: ThemePref;
  defaultModelId: DynamicModelId;
  /** Provider for `defaultModelId`. Disambiguates ids shared across providers. Persisted for cold-boot restore. */
  defaultProviderId: ProviderId | null;
  editorTheme: EditorThemeId;
  /**
   * Content font family id, applied to BOTH the terminal and the code editor.
   * One of `CONTENT_FONT_OPTIONS` (lib/fonts). The chosen family is prepended to
   * the safe fallback chain, so an uninstalled font degrades gracefully.
   */
  fontFamily: string;
  /**
   * Base code-editor font size in px, before content zoom. The terminal keeps
   * its own `terminalFontSize`; this is the editor/diff equivalent.
   */
  editorFontSize: number;
  /**
   * Terminal theme mode. "follow-app" (default) mirrors the app theme so the
   * terminal matches the chrome with zero visual change; "custom" applies
   * `terminalCustomPalette` and is fully independent of the app theme. The
   * terminal reads its own `--tedi-term-*` CSS vars either way.
   */
  terminalThemeMode: TerminalThemeMode;
  /**
   * Selected terminal preset id, or "custom" once the palette is hand-edited.
   * Drives which preset chip is highlighted in Settings -> Terminal. The actual
   * colours applied in "custom" mode live in `terminalCustomPalette`.
   */
  terminalThemeId: string;
  /** Terminal palette applied when `terminalThemeMode === "custom"`. */
  terminalCustomPalette: TerminalPalette;
  customInstructions: string;
  // Sub-agents used to have a master on/off here. They are now switched in the
  // tool picker like every other tool, so there is one switch instead of two
  // that could disagree. `loadPreferences` migrates an old `false` into
  // `disabledTools`.
  /** Plain-chat mode. On sends a one-line system prompt and NO tools, and skips
   *  the project memory, .tedi/memory, MCP, and per-turn <env> loads
   *  entirely. The agent prompt plus ~77 tool schemas cost ~12K input tokens on
   *  every message, so a "hi" is priced like a code task; this is the off
   *  switch for turns that are just conversation. Off = the full agent. */
  chatMode: boolean;
  /** Model-facing names of tools the user switched OFF in the tool picker.
   *  Stores what is DISABLED, not what is enabled, so a tool added by an app
   *  update (or by installing an MCP server / extension) is on by default
   *  instead of silently missing until the user goes looking for it. */
  disabledTools: string[];
  /** Debug capture: when on, every request sent to the provider/API (system
   *  prompt, messages, model, params, tool list) is snapshotted in-memory so it
   *  can be inspected and downloaded as JSON from the chat. Off = no capture. */
  debugEnabled: boolean;
  autostart: boolean;
  restoreWindowState: boolean;
  autocompleteEnabled: boolean;
  autocompleteProvider: AutocompleteProviderId;
  autocompleteModelId: string;
  lmstudioBaseURL: string;
  /**
   * Base URL for the FIRST (legacy / default) OpenAI-compatible endpoint. Kept
   * as a top-level field for backward compatibility: older builds and the
   * runtime fallback still read it. New code should prefer
   * `openaiCompatibleInstances[0]`, which mirrors this value for the default
   * instance. Migration keeps the two in sync.
   */
  openaiCompatibleBaseURL: string;
  /**
   * All configured OpenAI-compatible endpoints. Each entry is
   * `{ id, label, baseURL }`; its API key lives in the OS keychain under
   * `openai-compatible-api-key[:<id>]`. The first instance has the reserved id
   * `"default"` and mirrors `openaiCompatibleBaseURL` for back-compat. Empty
   * only on a brand-new install with no openai-compatible endpoint configured.
   */
  openaiCompatibleInstances: OpenAICompatibleInstance[];
  vimMode: boolean;
  lineWrap: boolean;
  /** Show the code editor minimap. Default true. */
  showMinimap: boolean;
  /** Render the coding font's ligatures in the editor (`=>` as an arrow, `!=`
   *  as `≠`). Default true, which is what an unset `font-variant-ligatures`
   *  already did - the pref exists so the fused glyphs can be turned off. */
  editorLigatures: boolean;
  terminalWebglEnabled: boolean;
  terminalFontSize: number;
  /**
   * Max scrollback lines kept per terminal (xterm `scrollback`). Lower = lighter
   * memory per leaf, since fewer history rows are retained (each row is roughly
   * cols x ~16 B). Works like a CMD screen-buffer height cap: scroll back at
   * most this many lines. Default 1000; editable in Settings -> General.
   */
  terminalScrollback: number;
  /**
   * Extra directories prepended to the interactive terminal shell's PATH at
   * spawn. Each entry can be individually enabled/disabled. Lets commands that
   * live outside the OS PATH (e.g. a Laragon `composer`, a portable toolchain)
   * resolve in TEDI's terminal without editing the system PATH. Read directly
   * by the Rust PTY layer from this settings file, so edits apply to newly
   * opened terminals without a daemon restart; existing terminals keep their
   * original PATH. Empty by default.
   */
  terminalEnvPath: TerminalPathEntry[];
  showHiddenFiles: boolean;
  /**
   * Fold the status bar's right cluster down to what you glance at: the update
   * prompt, the AI usage meters and the AI panel button. Everything else (zoom,
   * the other status icons, the action + panel-toggle groups) hides until it is
   * switched back off. Default false.
   */
  statusBarCompact: boolean;
  /** Show the Source Control panel. Default true. */
  showSourceControl: boolean;
  /**
   * Mount Source Control in the right slot (next to AI sidebar / extension
   * right panels) instead of as a sidebar pane on the left. Default false.
   * When true, the left sidebar drops the SCM pane and a status-bar button
   * toggles the right-slot SCM panel.
   */
  sourceControlInRightPanel: boolean;
  /**
   * Mount the SSH (Remote) file explorer in the right slot instead of as a
   * sidebar pane on the left. Default false. When true, the left sidebar drops
   * the SSH pane and a status-bar button toggles the right-slot SSH panel.
   * Mirrors `sourceControlInRightPanel`.
   */
  sshInRightPanel: boolean;
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
  /**
   * UI zoom for the application chrome only: header / tabs, sidebar, side
   * panels, status bar, and portaled overlays (dialogs, menus, command
   * palette). 1.0 = 100%. Applied as CSS `zoom` on `document.body`; the
   * workspace pane counter-zooms back to 1 so terminal / editor / preview keep
   * native resolution and their own `contentZoom`. Driven by the
   * Settings -> General "UI zoom" slider, not the keyboard shortcuts.
   */
  uiZoom: number;
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
   * Custom AI-CLI notification sounds as `data:audio/...;base64,…` URLs. Empty
   * string = use the built-in synthesized beep. `aiBlockingSound` plays when an
   * AI CLI needs approval; `aiCompletionSound` when it finishes. Stored inline
   * (capped at MAX_SOUND_DATA_URL_LEN) so a custom sound needs no extra files or
   * filesystem permissions; the upload UI rejects larger files up front.
   */
  aiBlockingSound: string;
  aiCompletionSound: string;
  /**
   * Brand color as 6-digit hex (`#RRGGBB`). Drives `--primary`, `--ring`,
   * `--sidebar-primary`, `--sidebar-ring`, and a derived `--accent`.
   * Default `#0057fe` (TEDI logo blue).
   */
  brandColor: string;
  /**
   * Custom theme overrides. When `customThemeEnabled` is true, the full color
   * token set (and background image) in `customTheme` is applied on top of
   * the base CSS variables. When false, only the brand color applies and
   * the base palette wins.
   */
  customThemeEnabled: boolean;
  customTheme: CustomTheme;
  /**
   * Whole-app transparency (0..1). The OS window is already transparent, so
   * lowering this fades EVERY surface (editor, terminal, SSH, diff, panels,
   * menus, extensions) toward the wallpaper image — or the desktop when no
   * image is set. 0 = fully see-through, 1 = solid (default). Main window
   * only; the settings window stays solid for readability.
   */
  appOpacity: number;
  /**
   * Default search engine for the browser address bar. Typing a non-URL term
   * (e.g. "youtube") runs it as a query through this engine instead of failing
   * to navigate. See `searchEngines.ts`.
   */
  searchEngine: SearchEngineId;
  /**
   * Open a detected dev-server url in a background preview tab instead of only
   * lighting the toolbar button. Covers both sources: the url the project
   * declares (found running at open time) and one a terminal prints, so
   * `npm run dev` and `php artisan serve` behave the same. Always restricted to
   * this machine. Default false: opening tabs should be asked for.
   */
  autoOpenProjectUrl: boolean;
  /**
   * User-saved theme presets. Appear in the Theme settings preset grid
   * alongside the built-in `THEME_PRESETS`. The user "saves" the current
   * custom-theme state as a preset (with a chosen name); subsequent
   * tweaks to the live theme don't update the preset until they save
   * again. Items can be deleted individually.
   */
  userThemePresets: CustomTheme[];
  /**
   * Global "format on save" toggle. When true and the document's language
   * has a configured formatter, save runs the formatter first. Per-language
   * overrides live on `formatters[lang].formatOnSave` and beat the global.
   */
  formatOnSave: boolean;
  /**
   * Per-language formatter configuration. Key is the editor language id
   * (`javascript`, `python`, `rust`, …) — see `editor/lib/formatters/lang.ts`.
   * `type: "builtin"` uses bundled Prettier (only languages Prettier
   * supports — see `BUILTIN_LANGUAGES`). `type: "external"` shells out to
   * `command` + `args`; `${file}` in args is replaced with a temp-file
   * path containing the buffer (the formatter must write back to the same
   * path), otherwise the buffer is piped via stdin and stdout is the
   * formatted output. `type: "none"` skips formatting for that language.
   */
  formatters: Record<string, FormatterConfig>;
};

export type FormatterConfig = {
  type: "builtin" | "external" | "none";
  /** External: program name (resolved via PATH) or absolute path. */
  command?: string;
  /** External: argv. `${file}` is substituted with a temp-file path. */
  args?: string[];
  /** Per-language override of `formatOnSave`. Undefined = use the global. */
  formatOnSave?: boolean;
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

/**
 * Max raw size of an uploaded notification sound. ~1 MB keeps the inline
 * data-URL approach sane; the upload UI rejects larger files with a message.
 */
export const MAX_SOUND_BYTES = 1024 * 1024;
/** Backstop on a stored data URL (~1 MB file -> ~1.37 MB base64), in chars. */
const MAX_SOUND_DATA_URL_LEN = 1_500_000;

/**
 * Accept only an audio data URL under the size cap; anything else (wrong scheme,
 * non-audio MIME, oversized, corrupt) coerces to "" so playback falls back to
 * the built-in synthesized beep. Applied on both read and write.
 */
export function normalizeSoundData(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v) return "";
  if (!/^data:audio\/[\w.+-]+;base64,/i.test(v)) return "";
  if (v.length > MAX_SOUND_DATA_URL_LEN) return "";
  return v;
}

const STORE_PATH = "tedi-settings.json";
const KEY_THEME = "theme";
const KEY_DEFAULT_MODEL = "defaultModelId";
const KEY_DEFAULT_PROVIDER = "defaultProviderId";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_FONT_FAMILY = "fontFamily";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_TERMINAL_THEME_MODE = "terminalThemeMode";
const KEY_TERMINAL_THEME_ID = "terminalThemeId";
const KEY_TERMINAL_CUSTOM_PALETTE = "terminalCustomPalette";
const KEY_CUSTOM_INSTRUCTIONS = "customInstructions";
/** Removed preference, read once so an existing `false` can be migrated into
 *  `disabledTools`, then deleted. See `loadPreferences`. */
const LEGACY_KEY_SUBAGENTS_ENABLED = "subagentsEnabled";
const KEY_CHAT_MODE = "chatMode";
const KEY_DISABLED_TOOLS = "disabledTools";
const KEY_DEBUG_ENABLED = "debugEnabled";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";
const KEY_AUTOCOMPLETE_ENABLED = "autocompleteEnabled";
const KEY_AUTOCOMPLETE_PROVIDER = "autocompleteProvider";
const KEY_AUTOCOMPLETE_MODEL = "autocompleteModelId";
const KEY_LMSTUDIO_BASE_URL = "lmstudioBaseURL";
const KEY_OPENAI_COMPATIBLE_BASE_URL = "openaiCompatibleBaseURL";
const KEY_OPENAI_COMPATIBLE_INSTANCES = "openaiCompatibleInstances";
const KEY_VIM_MODE = "vimMode";
const KEY_LINE_WRAP = "lineWrap";
const KEY_SHOW_MINIMAP = "showMinimap";
const KEY_EDITOR_LIGATURES = "editorLigatures";
const KEY_TERMINAL_WEBGL_ENABLED = "terminalWebglEnabled";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_TERMINAL_ENV_PATH = "terminalEnvPath";
const KEY_SHOW_HIDDEN_FILES = "showHiddenFiles";
const KEY_STATUS_BAR_COMPACT = "statusBarCompact";
const KEY_SHOW_SOURCE_CONTROL = "showSourceControl";
const KEY_SOURCE_CONTROL_IN_RIGHT_PANEL = "sourceControlInRightPanel";
const KEY_SSH_IN_RIGHT_PANEL = "sshInRightPanel";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EXTENSION_SHORTCUTS = "extensionShortcuts";
const KEY_PINNED_MODELS = "pinnedModelIds";
const KEY_APPROVAL_MODE = "approvalMode";
const KEY_LAST_MODEL = "lastModelId";
const KEY_LAST_PROVIDER = "lastProviderId";
const KEY_CONTENT_ZOOM = "contentZoom";
const KEY_UI_ZOOM = "uiZoom";
const KEY_AI_NOTIFICATIONS_ENABLED = "aiNotificationsEnabled";
const KEY_AI_BLOCKING_SOUND = "aiBlockingSound";
const KEY_AI_COMPLETION_SOUND = "aiCompletionSound";
const KEY_BRAND_COLOR = "brandColor";
const KEY_CUSTOM_THEME_ENABLED = "customThemeEnabled";
const KEY_CUSTOM_THEME = "customTheme";
const KEY_APP_OPACITY = "appOpacity";
const KEY_SEARCH_ENGINE = "searchEngine";
const KEY_AUTO_OPEN_PROJECT_URL = "autoOpenProjectUrl";
const KEY_USER_THEME_PRESETS = "userThemePresets";
const KEY_FORMAT_ON_SAVE = "formatOnSave";
const KEY_FORMATTERS = "formatters";

export const CONTENT_ZOOM_DEFAULT = 1.0;
export const CONTENT_ZOOM_MIN = 0.5;
export const CONTENT_ZOOM_MAX = 3.0;
export const CONTENT_ZOOM_STEP = 0.1;

export const UI_ZOOM_DEFAULT = 1.0;
export const UI_ZOOM_MIN = 0.5;
export const UI_ZOOM_MAX = 2.0;
export const UI_ZOOM_STEP = 0.1;

export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const EDITOR_FONT_SIZE_DEFAULT = 13;
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 28;
export const EDITOR_FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20] as const;

export const APP_OPACITY_DEFAULT = 1;
// 0 = fully transparent (app dissolves into the wallpaper / desktop), 1 = solid.
export const APP_OPACITY_MIN = 0;
export const APP_OPACITY_MAX = 1;
export const APP_OPACITY_STEP = 0.05;

export const TERMINAL_FONT_SIZES = [10, 12, 13, 14, 15, 16, 18, 20, 22, 24] as const;

// Lighter default than the old hard-coded 5000: ~1000 lines x 80 cols x ~16 B
// is roughly 1.2 MB per leaf vs ~6 MB, a big win when many terminals are open.
export const TERMINAL_SCROLLBACK_DEFAULT = 1000;
export const TERMINAL_SCROLLBACK_MIN = 100;
export const TERMINAL_SCROLLBACK_MAX = 100_000;
// Choices offered in the Settings dropdown. 200 mirrors a CMD-style tight cap.
export const TERMINAL_SCROLLBACK_OPTIONS = [200, 500, 1000, 2500, 5000, 10000] as const;

// Sub-agent (run_subagent / run_subagents) backstops. Sub-agents are user-gated
// to ON/OFF only; the AI picks every number per call - defaulting to *_DEFAULT
// when it omits a param, clamped to *_MAX (the hard backstop it can't exceed).
export const SUBAGENT_MAX_CONCURRENCY_DEFAULT = 3;
export const SUBAGENT_MAX_CONCURRENCY_MAX = 8;

// Sub-agents have no step cap (they run a task to completion); the budget lives
// in runSubagent as a runaway backstop, not a user/AI-facing knob.

export const SUBAGENT_MAX_TASKS_MAX = 16;

export const SUBAGENT_SUMMARY_KB_DEFAULT = 16;
export const SUBAGENT_SUMMARY_KB_MAX = 48;

/**
 * First-install formatter defaults. Languages Prettier supports get
 * `builtin`; everything else stays unset so the file extension simply has
 * no formatter until the user configures one. Users can still flip a
 * `builtin` language to `external` to override.
 *
 * Must be declared before `DEFAULT_PREFERENCES` references it, otherwise
 * the const sits in the TDZ during DEFAULT_PREFERENCES initialization.
 */
export const DEFAULT_FORMATTERS: Record<string, FormatterConfig> = {
  javascript: { type: "builtin" },
  typescript: { type: "builtin" },
  jsx: { type: "builtin" },
  tsx: { type: "builtin" },
  json: { type: "builtin" },
  jsonc: { type: "builtin" },
  css: { type: "builtin" },
  scss: { type: "builtin" },
  less: { type: "builtin" },
  html: { type: "builtin" },
  yaml: { type: "builtin" },
  markdown: { type: "builtin" },
  graphql: { type: "builtin" },
  vue: { type: "builtin" },
};

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  defaultModelId: DEFAULT_MODEL_ID,
  defaultProviderId: tryGetModel(DEFAULT_MODEL_ID)?.provider ?? null,
  editorTheme: "atomone",
  fontFamily: DEFAULT_CONTENT_FONT_ID,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  terminalThemeMode: "follow-app",
  terminalThemeId: DEFAULT_TERMINAL_THEME_ID,
  terminalCustomPalette: DEFAULT_TERMINAL_PALETTE,
  customInstructions: "",
  chatMode: false,
  disabledTools: [],
  debugEnabled: false,
  autostart: false,
  restoreWindowState: true,
  autocompleteEnabled: false,
  autocompleteProvider: "cerebras",
  autocompleteModelId: DEFAULT_AUTOCOMPLETE_MODEL.cerebras,
  lmstudioBaseURL: LMSTUDIO_DEFAULT_BASE_URL,
  openaiCompatibleBaseURL: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  openaiCompatibleInstances: [],
  vimMode: false,
  lineWrap: false,
  showMinimap: true,
  editorLigatures: true,
  terminalWebglEnabled: true,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  terminalEnvPath: [],
  showHiddenFiles: false,
  statusBarCompact: false,
  showSourceControl: true,
  sourceControlInRightPanel: false,
  sshInRightPanel: false,
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  extensionShortcuts: {} as Record<string, KeyBinding[]>,
  pinnedModelIds: [],
  approvalMode: "ask",
  lastModelId: null,
  lastProviderId: null,
  contentZoom: CONTENT_ZOOM_DEFAULT,
  uiZoom: UI_ZOOM_DEFAULT,
  aiNotificationsEnabled: true,
  aiBlockingSound: "",
  aiCompletionSound: "",
  brandColor: BRAND_COLOR_DEFAULT,
  customThemeEnabled: false,
  customTheme: DEFAULT_CUSTOM_THEME,
  appOpacity: APP_OPACITY_DEFAULT,
  searchEngine: DEFAULT_SEARCH_ENGINE_ID,
  autoOpenProjectUrl: false,
  userThemePresets: [],
  formatOnSave: false,
  formatters: DEFAULT_FORMATTERS,
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange is a store://change broadcast delivered to every window
// (including the writer). The settings page is a separate webview, so the
// broadcast covers cross-window listeners. We still mirror every setter
// through a Tauri event so listeners that only attach the event path also see
// the change; `source` lets the writing window dedupe its own self-delivered
// event (Tauri v2 self-delivers emit()) and handle it via onChange only.
const PREFS_CHANGED_EVENT = "tedi://prefs-changed";

// Label of the webview that performed a write. Used to ignore the
// self-delivered PREFS_CHANGED_EVENT in the writing window (the store.onChange
// broadcast already covers it there), while OTHER windows still react once.
const SELF_LABEL = getCurrentWebviewWindow().label;

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await Promise.all([store.save(), emit(PREFS_CHANGED_EVENT, { key, value, source: SELF_LABEL })]);
}

/**
 * Carry a removed `subagentsEnabled: false` over to the tool picker, which is
 * now the only switch. Without this, dropping the preference would silently turn
 * sub-agents back ON for anyone who had deliberately turned them off.
 *
 * Deleting the legacy key is what makes it one-time: leave it and re-enabling
 * the tools in the picker would be undone on the next load. The write is
 * fire-and-forget - the returned value already reflects it, so a failure only
 * means the migration runs again next boot, which is why it must not reject.
 */
function migrateSubagentsPref(map: Map<string, unknown>, disabledTools: string[]): string[] {
  if (map.get(LEGACY_KEY_SUBAGENTS_ENABLED) !== false) return disabledTools;
  const merged = withSubagentsDisabled(disabledTools);
  void (async () => {
    await store.set(KEY_DISABLED_TOOLS, merged);
    await store.delete(LEGACY_KEY_SUBAGENTS_ENABLED);
    await store.save();
  })().catch(() => {
    // Retried on the next load; a boot must not fail over a preference write.
  });
  return merged;
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
    fontFamily: (() => {
      const v = get<string>(KEY_FONT_FAMILY);
      return isValidContentFontId(v) ? v : DEFAULT_CONTENT_FONT_ID;
    })(),
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    terminalThemeMode:
      get<TerminalThemeMode>(KEY_TERMINAL_THEME_MODE) === "custom" ? "custom" : "follow-app",
    terminalThemeId: get<string>(KEY_TERMINAL_THEME_ID) ?? DEFAULT_PREFERENCES.terminalThemeId,
    terminalCustomPalette: normalizeTerminalPalette(
      get<unknown>(KEY_TERMINAL_CUSTOM_PALETTE),
      DEFAULT_PREFERENCES.terminalCustomPalette,
    ),
    customInstructions:
      get<string>(KEY_CUSTOM_INSTRUCTIONS) ?? DEFAULT_PREFERENCES.customInstructions,
    chatMode: get<boolean>(KEY_CHAT_MODE) ?? DEFAULT_PREFERENCES.chatMode,
    disabledTools: migrateSubagentsPref(
      map,
      (get<unknown>(KEY_DISABLED_TOOLS) as string[] | undefined)?.filter(
        (t): t is string => typeof t === "string",
      ) ?? DEFAULT_PREFERENCES.disabledTools,
    ),
    debugEnabled: get<boolean>(KEY_DEBUG_ENABLED) ?? DEFAULT_PREFERENCES.debugEnabled,
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
    openaiCompatibleInstances: normalizeOpenAICompatibleInstances(
      get<unknown>(KEY_OPENAI_COMPATIBLE_INSTANCES),
      get<string>(KEY_OPENAI_COMPATIBLE_BASE_URL),
    ),
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    lineWrap: get<boolean>(KEY_LINE_WRAP) ?? DEFAULT_PREFERENCES.lineWrap,
    showMinimap: get<boolean>(KEY_SHOW_MINIMAP) ?? DEFAULT_PREFERENCES.showMinimap,
    editorLigatures: get<boolean>(KEY_EDITOR_LIGATURES) ?? DEFAULT_PREFERENCES.editorLigatures,
    terminalWebglEnabled:
      get<boolean>(KEY_TERMINAL_WEBGL_ENABLED) ?? DEFAULT_PREFERENCES.terminalWebglEnabled,
    terminalFontSize: get<number>(KEY_TERMINAL_FONT_SIZE) ?? DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ?? DEFAULT_PREFERENCES.terminalScrollback,
    ),
    terminalEnvPath: normalizeTerminalPathEntries(get<unknown>(KEY_TERMINAL_ENV_PATH)),
    showHiddenFiles: get<boolean>(KEY_SHOW_HIDDEN_FILES) ?? DEFAULT_PREFERENCES.showHiddenFiles,
    statusBarCompact: get<boolean>(KEY_STATUS_BAR_COMPACT) ?? DEFAULT_PREFERENCES.statusBarCompact,
    showSourceControl:
      get<boolean>(KEY_SHOW_SOURCE_CONTROL) ?? DEFAULT_PREFERENCES.showSourceControl,
    sourceControlInRightPanel:
      get<boolean>(KEY_SOURCE_CONTROL_IN_RIGHT_PANEL) ??
      DEFAULT_PREFERENCES.sourceControlInRightPanel,
    sshInRightPanel: get<boolean>(KEY_SSH_IN_RIGHT_PANEL) ?? DEFAULT_PREFERENCES.sshInRightPanel,
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
    uiZoom: clampUiZoom(get<number>(KEY_UI_ZOOM) ?? DEFAULT_PREFERENCES.uiZoom),
    aiNotificationsEnabled:
      get<boolean>(KEY_AI_NOTIFICATIONS_ENABLED) ?? DEFAULT_PREFERENCES.aiNotificationsEnabled,
    aiBlockingSound: normalizeSoundData(get<string>(KEY_AI_BLOCKING_SOUND)),
    aiCompletionSound: normalizeSoundData(get<string>(KEY_AI_COMPLETION_SOUND)),
    brandColor: normalizeBrandColor(get<string>(KEY_BRAND_COLOR)),
    customThemeEnabled:
      get<boolean>(KEY_CUSTOM_THEME_ENABLED) ?? DEFAULT_PREFERENCES.customThemeEnabled,
    customTheme: normalizeCustomTheme(
      get<unknown>(KEY_CUSTOM_THEME),
      DEFAULT_PREFERENCES.customTheme,
    ),
    appOpacity: clampOpacity(get<number>(KEY_APP_OPACITY) ?? DEFAULT_PREFERENCES.appOpacity),
    searchEngine: searchEngineById(get<string>(KEY_SEARCH_ENGINE)).id,
    autoOpenProjectUrl:
      get<boolean>(KEY_AUTO_OPEN_PROJECT_URL) ?? DEFAULT_PREFERENCES.autoOpenProjectUrl,
    userThemePresets: (() => {
      const raw = get<unknown>(KEY_USER_THEME_PRESETS);
      if (!Array.isArray(raw)) return DEFAULT_PREFERENCES.userThemePresets;
      // Normalise each entry through `normalizeCustomTheme` so a corrupt
      // / partial preset doesn't crash the settings page on load.
      return raw.flatMap((entry) => {
        const p = normalizeCustomTheme(entry, DEFAULT_PREFERENCES.customTheme);
        return typeof p.name === "string" && p.name.length > 0 ? [p] : [];
      });
    })(),
    formatOnSave: get<boolean>(KEY_FORMAT_ON_SAVE) ?? DEFAULT_PREFERENCES.formatOnSave,
    formatters: normalizeFormatters(get<unknown>(KEY_FORMATTERS)),
  };
}

/**
 * Normalise and migrate the persisted OpenAI-compatible instances list.
 *
 * - Drops malformed entries (non-object, missing/empty id or baseURL).
 * - Migration: when the list is absent/empty but a legacy
 *   `openaiCompatibleBaseURL` is present, synthesise the default instance from
 *   it so a user who configured the single endpoint before this change keeps
 *   their base URL (and, via the unsuffixed keychain account, their key).
 * - Always returns the default instance first when present, so it lines up
 *   with the legacy `openaiCompatibleBaseURL` field.
 *
 * Idempotent and safe: re-running on an already-migrated store is a no-op.
 */
function normalizeOpenAICompatibleInstances(
  raw: unknown,
  legacyBaseURL: string | undefined,
): OpenAICompatibleInstance[] {
  const out: OpenAICompatibleInstance[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id.trim() : "";
      const baseURL = typeof e.baseURL === "string" ? e.baseURL.trim() : "";
      if (!id || !baseURL || seen.has(id)) continue;
      const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;
      seen.add(id);
      // Hand-typed model ids. Deduped and trimmed here so a corrupt or
      // duplicated persisted value cannot produce blank picker entries.
      const manualModels = Array.isArray(e.manualModels)
        ? [
            ...new Set(
              e.manualModels
                .filter((m): m is string => typeof m === "string")
                .map((m) => m.trim())
                .filter(Boolean),
            ),
          ]
        : [];
      out.push({ id, label, baseURL, ...(manualModels.length ? { manualModels } : {}) });
    }
  }
  // Migration: nothing persisted yet but a legacy single endpoint exists.
  if (out.length === 0 && legacyBaseURL && legacyBaseURL.trim()) {
    out.push({
      id: OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID,
      label: "OpenAI Compatible",
      baseURL: legacyBaseURL.trim(),
    });
  }
  // Keep the default instance first so it mirrors `openaiCompatibleBaseURL`.
  out.sort((a, b) => {
    if (a.id === OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID) return -1;
    if (b.id === OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID) return 1;
    return 0;
  });
  return out;
}

/**
 * Coerce a persisted value into a clean `TerminalPathEntry[]`: trims paths,
 * drops blanks, and defaults `enabled` to true. Tolerates the legacy shape
 * (a plain `string[]`) so an early value written before per-entry toggles is
 * migrated rather than lost. A corrupt or absent value yields `[]` so the
 * terminal still spawns with the inherited PATH.
 */
function normalizeTerminalPathEntries(raw: unknown): TerminalPathEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TerminalPathEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const path = cleanTerminalPath(item);
      if (path) out.push({ path, enabled: true });
      continue;
    }
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const path = typeof rec.path === "string" ? cleanTerminalPath(rec.path) : "";
      if (!path) continue;
      out.push({ path, enabled: rec.enabled !== false });
    }
  }
  return out;
}

function normalizeFormatters(raw: unknown): Record<string, FormatterConfig> {
  if (!raw || typeof raw !== "object") return DEFAULT_PREFERENCES.formatters;
  const out: Record<string, FormatterConfig> = {};
  for (const [lang, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const type = v.type;
    if (type !== "builtin" && type !== "external" && type !== "none") continue;
    const cfg: FormatterConfig = { type };
    if (typeof v.command === "string") cfg.command = v.command;
    if (Array.isArray(v.args) && v.args.every((x) => typeof x === "string")) {
      cfg.args = v.args as string[];
    }
    if (typeof v.formatOnSave === "boolean") cfg.formatOnSave = v.formatOnSave;
    out[lang] = cfg;
  }
  // Merge with defaults so a wiped or partial store still surfaces the
  // builtin coverage. User-set entries (including explicit "none") win.
  return { ...DEFAULT_PREFERENCES.formatters, ...out };
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return CONTENT_ZOOM_DEFAULT;
  return Math.min(CONTENT_ZOOM_MAX, Math.max(CONTENT_ZOOM_MIN, value));
}

export function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(TERMINAL_SCROLLBACK_MAX, Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)));
}

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)));
}

function clampUiZoom(value: number): number {
  if (!Number.isFinite(value)) return UI_ZOOM_DEFAULT;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, value));
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return APP_OPACITY_DEFAULT;
  return Math.min(APP_OPACITY_MAX, Math.max(APP_OPACITY_MIN, value));
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setAppOpacity(value: number): Promise<void> {
  await writePref(KEY_APP_OPACITY, clampOpacity(value));
}

export async function setSearchEngine(value: SearchEngineId): Promise<void> {
  await writePref(KEY_SEARCH_ENGINE, value);
}

export async function setAutoOpenProjectUrl(value: boolean): Promise<void> {
  await writePref(KEY_AUTO_OPEN_PROJECT_URL, value);
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

export async function setFontFamily(value: string): Promise<void> {
  await writePref(KEY_FONT_FAMILY, isValidContentFontId(value) ? value : DEFAULT_CONTENT_FONT_ID);
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}

export async function setTerminalThemeMode(value: TerminalThemeMode): Promise<void> {
  await writePref(KEY_TERMINAL_THEME_MODE, value);
}

export async function setTerminalThemeId(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_THEME_ID, value);
}

export async function setTerminalCustomPalette(value: TerminalPalette): Promise<void> {
  await writePref(KEY_TERMINAL_CUSTOM_PALETTE, value);
}

export async function setCustomInstructions(value: string): Promise<void> {
  await writePref(KEY_CUSTOM_INSTRUCTIONS, value);
}

export async function setChatMode(value: boolean): Promise<void> {
  await writePref(KEY_CHAT_MODE, value);
}

export async function setDisabledTools(value: string[]): Promise<void> {
  await writePref(KEY_DISABLED_TOOLS, [...new Set(value)].sort());
}

export async function setDebugEnabled(value: boolean): Promise<void> {
  await writePref(KEY_DEBUG_ENABLED, value);
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

/**
 * Persist the full list of OpenAI-compatible endpoints. Also mirrors the
 * default instance's base URL into the legacy `openaiCompatibleBaseURL` field
 * so the runtime fallback and older code paths keep resolving the first
 * endpoint. Both writes go through `writePref`, so cross-window listeners and
 * the on-disk store stay consistent.
 */
export async function setOpenAICompatibleInstances(
  value: OpenAICompatibleInstance[],
): Promise<void> {
  await writePref(KEY_OPENAI_COMPATIBLE_INSTANCES, value);
  const def = value.find((i) => i.id === OPENAI_COMPATIBLE_LEGACY_INSTANCE_ID) ?? value[0];
  if (def && def.baseURL) {
    await writePref(KEY_OPENAI_COMPATIBLE_BASE_URL, def.baseURL);
  }
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

export async function setEditorLigatures(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_LIGATURES, value);
}

export async function setTerminalWebglEnabled(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_WEBGL_ENABLED, value);
}

export async function setShowHiddenFiles(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN_FILES, value);
}

export async function setStatusBarCompact(value: boolean): Promise<void> {
  await writePref(KEY_STATUS_BAR_COMPACT, value);
}

export async function setShowSourceControl(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_SOURCE_CONTROL, value);
}

export async function setSourceControlInRightPanel(value: boolean): Promise<void> {
  await writePref(KEY_SOURCE_CONTROL_IN_RIGHT_PANEL, value);
}

export async function setSshInRightPanel(value: boolean): Promise<void> {
  await writePref(KEY_SSH_IN_RIGHT_PANEL, value);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)))
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

/**
 * Persist the extra terminal PATH directories. Entries are trimmed and blanks
 * dropped before saving so the Rust PTY layer reads a clean list. Takes effect
 * on newly opened terminals.
 */
export async function setTerminalEnvPath(value: TerminalPathEntry[]): Promise<void> {
  const cleaned = value
    .map((e) => ({ path: cleanTerminalPath(e.path), enabled: e.enabled !== false }))
    .filter((e) => e.path.length > 0);
  await writePref(KEY_TERMINAL_ENV_PATH, cleaned);
}

export async function setShortcuts(value: Record<ShortcutId, KeyBinding[]> | {}): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export async function setExtensionShortcuts(
  value: Record<string, KeyBinding[]> | {},
): Promise<void> {
  await writePref(KEY_EXTENSION_SHORTCUTS, value);
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

export async function setUiZoom(value: number): Promise<void> {
  await writePref(KEY_UI_ZOOM, clampUiZoom(value));
}

export async function setAiNotificationsEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AI_NOTIFICATIONS_ENABLED, value);
}

/** Persist (or clear, with "") the custom "needs approval" notification sound. */
export async function setAiBlockingSound(value: string): Promise<void> {
  await writePref(KEY_AI_BLOCKING_SOUND, normalizeSoundData(value));
}

/** Persist (or clear, with "") the custom "task finished" notification sound. */
export async function setAiCompletionSound(value: string): Promise<void> {
  await writePref(KEY_AI_COMPLETION_SOUND, normalizeSoundData(value));
}

export async function setCustomThemeEnabled(value: boolean): Promise<void> {
  await writePref(KEY_CUSTOM_THEME_ENABLED, value);
}

export async function setCustomTheme(value: CustomTheme): Promise<void> {
  await writePref(KEY_CUSTOM_THEME, value);
}

export async function setUserThemePresets(value: CustomTheme[]): Promise<void> {
  await writePref(KEY_USER_THEME_PRESETS, value);
}

export async function setFormatOnSave(value: boolean): Promise<void> {
  await writePref(KEY_FORMAT_ON_SAVE, value);
}

export async function setFormatters(value: Record<string, FormatterConfig>): Promise<void> {
  await writePref(KEY_FORMATTERS, value);
}

/**
 * Patches a single language's formatter entry. Caller supplies the
 * current `formatters` map (typically `usePreferencesStore.getState().formatters`
 * so the diff reflects in-memory state, not stale disk state). Pass
 * `null` to delete the entry.
 */
export async function patchFormatter(
  current: Record<string, FormatterConfig>,
  language: string,
  config: FormatterConfig | null,
): Promise<void> {
  const next = { ...current };
  if (config === null) {
    delete next[language];
  } else {
    next[language] = config;
  }
  await setFormatters(next);
}

/**
 * Pending preset id written by `tedi theme set <id>` (CLI). Read + drained
 * once at app boot so the request is applied exactly once. Not exposed to
 * extensions and not part of the typed `Preferences` shape.
 */
const KEY_THEME_PRESET_REQUEST = "customThemePresetRequest";

export async function consumePendingPresetRequest(): Promise<string | null> {
  const id = (await store.get<unknown>(KEY_THEME_PRESET_REQUEST)) ?? null;
  if (typeof id !== "string" || id.length === 0) {
    if (id !== null) {
      // Corrupt value - drop it.
      await store.delete(KEY_THEME_PRESET_REQUEST);
      await store.save();
    }
    return null;
  }
  await store.delete(KEY_THEME_PRESET_REQUEST);
  await store.save();
  return id;
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
    throw new Error(`settings._writeAny can only write namespaced extension keys, got "${key}"`);
  }
  await writePref(key, value);
}

/**
 * Port the automation channel (DevTools + `window.__tedi`) listens on at the
 * NEXT launch, or 0 for off. Written by the Install MCP flow.
 *
 * Not a member of `Preferences`, and that is the point: `_writePreference`
 * allow-lists on `DEFAULT_PREFERENCES`, so the MCP `set_setting` tool cannot
 * reach this key and a driving agent cannot make its own access permanent.
 * Rust reads the same key straight off disk at startup
 * (`src-tauri/src/modules/automation.rs`) - WebView2 fixes its browser arguments
 * when it creates its environment, so this can only ever take effect on a
 * restart, never on the running window.
 */
const KEY_AUTOMATION_PORT = "automationPort";

export async function getAutomationPort(): Promise<number> {
  return (await store.get<number>(KEY_AUTOMATION_PORT)) ?? 0;
}

/**
 * What the MCP server offers a connected AI CLI.
 *
 * `mcpDisabledTools` is a flat list of tool NAMES resolved from the pack
 * switches (`mcpInstall/packs.ts` owns that mapping); `mcpExtensionPacks` is the
 * extension ids whose AI tools are advertised as first-class MCP tools.
 *
 * Both live beside `automationPort` and OUTSIDE `Preferences` for the same
 * reason: `set_setting` allow-lists on `DEFAULT_PREFERENCES`, so a driving agent
 * cannot switch its own capabilities back on. The MCP server reads these
 * straight off disk, like Rust reads the port.
 *
 * Being outside `Preferences` is necessary but was NOT sufficient, and the gap
 * went unnoticed for as long as this comment has existed: `approvalMode`,
 * `disabledTools` and the provider base URLs are all ordinary members of
 * `DEFAULT_PREFERENCES`, so the allow-list waved them straight through. Keeping
 * a key out of `Preferences` only protects that key. `AGENT_DENIED_PREFS` below
 * is the general rule this was a special case of.
 */
const KEY_MCP_DISABLED_TOOLS = "mcpDisabledTools";
const KEY_MCP_EXTENSION_PACKS = "mcpExtensionPacks";

export async function getMcpSurface(): Promise<{ disabledTools: string[]; extensions: string[] }> {
  const [disabledTools, extensions] = await Promise.all([
    store.get<string[]>(KEY_MCP_DISABLED_TOOLS),
    store.get<string[]>(KEY_MCP_EXTENSION_PACKS),
  ]);
  return { disabledTools: disabledTools ?? [], extensions: extensions ?? [] };
}

export async function setMcpSurface(next: {
  disabledTools?: string[];
  extensions?: string[];
}): Promise<void> {
  if (next.disabledTools) await writePref(KEY_MCP_DISABLED_TOOLS, [...new Set(next.disabledTools)]);
  if (next.extensions) await writePref(KEY_MCP_EXTENSION_PACKS, [...new Set(next.extensions)]);
}

export async function setAutomationPort(port: number): Promise<void> {
  await writePref(
    KEY_AUTOMATION_PORT,
    Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
  );
}

/**
 * Write ONE built-in preference by key, for the automation surface a driving
 * agent reaches over MCP (`scripts/mcp/`). The typed setters above stay the
 * route for app code; this exists because a driver has a key and a value, not a
 * function reference, and 50-odd setters behind a hand-written name table would
 * rot the moment a preference is added.
 *
 * `DEFAULT_PREFERENCES` IS the allow-list, so the set can never drift from the
 * real one, and the `typeof` check rejects the realistic junk write (a string
 * where a number belongs). It is deliberately loose about shape beyond that:
 * `loadPreferences()` clamps and normalises every value it reads, so a merely
 * out-of-range write self-heals on the next load rather than persisting damage.
 *
 * Clamping setters (`setAppOpacity`, `setEditorFontSize`) are BYPASSED, which is
 * why the read path doing the clamping matters - it is what makes that safe.
 */
/**
 * Preferences whose value is drawn from a fixed set, and what that set is.
 *
 * `_writePreference` is the one place an AGENT can set a preference by name, and
 * a `typeof` check alone let any string through: `set_setting("theme","default")`
 * returned ok, stored a value no code path accepts, and the UI simply kept
 * rendering the old theme. The tool reported success for a write that did
 * nothing, so the model "fixed" it by guessing another wrong value. Validation
 * at this boundary is what turns that into an error the model can act on.
 *
 * DERIVED, NOT RETYPED: every entry points at the same runtime array the TYPE
 * comes from, so adding an editor theme or a search engine cannot leave this
 * table behind. Only static sets belong here - model and provider ids are drawn
 * from a live catalogue, so an allow-list would reject valid new models.
 */
const ALLOWED_VALUES: Partial<Record<PrefKey, readonly string[]>> = {
  theme: THEME_PREFS,
  approvalMode: APPROVAL_MODES,
  editorTheme: EDITOR_THEMES,
  terminalThemeMode: TERMINAL_THEME_MODES,
  searchEngine: SEARCH_ENGINES.map((e) => e.id),
};

/**
 * Preferences an AGENT may never write, whatever the value.
 *
 * `automationPort` and `mcpDisabledTools` were kept OUT of `Preferences`
 * entirely for this reason (see their comments above), which established the
 * rule but only covered the two keys that happened to be noticed. These are the
 * rest of them: every preference that grants the agent capability, or decides
 * where the agent's credentials are sent.
 *
 * `approvalMode` is the sharpest - `ALLOWED_VALUES` above lists `"yolo"` as a
 * legal value, and `shouldAutoApprove` returns true for EVERY tool in that mode,
 * so one `set_setting` call disarmed every approval card for the rest of the
 * session. `disabledTools` is the same hole one level down: it is the AI tool
 * picker's off-list, read at `agent.ts`, so writing `[]` hands back every tool
 * the user unticked. The three base-URL keys point at the endpoint that receives
 * `Authorization: Bearer <key>` plus the whole conversation. `terminalEnvPath`
 * is prepended to the PATH of every shell TEDI spawns.
 *
 * These stay editable in the Settings UI - a human clicking the toggle is the
 * point. This blocks only the by-name write path a driving agent reaches.
 */
const AGENT_DENIED_PREFS = new Set<PrefKey>([
  "approvalMode",
  "disabledTools",
  "lmstudioBaseURL",
  "openaiCompatibleBaseURL",
  "openaiCompatibleInstances",
  "terminalEnvPath",
]);

export async function _writePreference(key: string, value: unknown): Promise<void> {
  if (!Object.hasOwn(DEFAULT_PREFERENCES, key)) {
    throw new Error(
      `"${key}" is not a preference. Known keys: ${Object.keys(DEFAULT_PREFERENCES).join(", ")}`,
    );
  }
  if (AGENT_DENIED_PREFS.has(key as PrefKey)) {
    throw new Error(
      `"${key}" decides what the agent is allowed to do, or where its credentials go, so it cannot be set from here. Change it in Settings.`,
    );
  }
  const expected = DEFAULT_PREFERENCES[key as keyof Preferences];
  // `null` defaults (defaultProviderId, lastModelId) take whatever they are
  // given; there is nothing to check against.
  if (expected === null) {
    await writePref(key, value);
    return;
  }
  // A string arriving for a non-string preference is COERCED, not rejected. The
  // MCP tool types its `value` as a plain string on purpose (a union `type` is
  // valid JSON Schema but not every AI CLI's schema converter accepts one), and
  // some harnesses stringify every argument regardless. The target type is known
  // here, so the coercion is exact rather than a guess.
  const coerced =
    typeof value === "string" && typeof expected !== "string" ? parseAs(value, expected) : value;
  if (typeof coerced !== typeof expected) {
    throw new Error(
      `"${key}" wants a ${typeof expected}, got ${coerced === null ? "null" : typeof coerced}`,
    );
  }
  const allowed = ALLOWED_VALUES[key as PrefKey];
  if (allowed && !allowed.includes(coerced as string)) {
    throw new Error(`"${key}" must be one of: ${allowed.join(", ")} (got "${String(coerced)}")`);
  }
  await writePref(key, coerced);
}

/** One string -> the type `expected` already has. Returns the string unchanged
 *  when it cannot, so the caller's type check is what reports the failure. */
function parseAs(value: string, expected: unknown): unknown {
  if (typeof expected === "boolean") {
    // Not `Boolean(value)`: that makes the string "false" true.
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (typeof expected === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Reader for ext-namespaced keys. `loadPreferences()` ignores them. */
export async function _readAny<T = unknown>(key: string): Promise<T | undefined> {
  if (!key.startsWith("ext:")) {
    throw new Error(`settings._readAny can only read namespaced extension keys, got "${key}"`);
  }
  const v = await store.get<T>(key);
  return v ?? undefined;
}

// Subscribe to raw store-key changes from both same-process writes (store.onChange)
// and cross-window writes (the Tauri event from writePref), with the self-delivered
// event deduped via SELF_LABEL. Shared by _onAnyChange and onPreferencesChange.
async function subscribeRawChanges(cb: (key: string, value: unknown) => void): Promise<UnlistenFn> {
  const [unsubLocal, unsubEvent] = await Promise.all([
    store.onChange<unknown>((key, value) => cb(key, value)),
    listen<{ key: string; value: unknown; source?: string }>(PREFS_CHANGED_EVENT, (e) => {
      // Same-window write: store.onChange already delivered it here, so skip
      // the self-delivered event to avoid firing the callback twice.
      if (e.payload.source === SELF_LABEL) return;
      cb(e.payload.key, e.payload.value);
    }),
  ]);
  return () => {
    unsubLocal();
    unsubEvent();
  };
}

/** Subscribe to changes of any key, typed or namespaced. Used by the extension host's `tedi.settings.onChange`. */
export function _onAnyChange(cb: (key: string, value: unknown) => void): Promise<UnlistenFn> {
  return subscribeRawChanges(cb);
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
  // One entry per PrefKey. `satisfies Record<PrefKey, string>` turns a forgotten
  // key into a COMPILE error instead of a silently-dropped cross-window update -
  // a missing entry here was the documented root cause of the opacity/preset
  // cross-window bugs (appOpacity + userThemePresets were the entries that got
  // dropped). The reverse lookup the listeners need is derived below.
  const prefToStoreKey = {
    theme: KEY_THEME,
    defaultModelId: KEY_DEFAULT_MODEL,
    defaultProviderId: KEY_DEFAULT_PROVIDER,
    editorTheme: KEY_EDITOR_THEME,
    fontFamily: KEY_FONT_FAMILY,
    editorFontSize: KEY_EDITOR_FONT_SIZE,
    terminalThemeMode: KEY_TERMINAL_THEME_MODE,
    terminalThemeId: KEY_TERMINAL_THEME_ID,
    terminalCustomPalette: KEY_TERMINAL_CUSTOM_PALETTE,
    customInstructions: KEY_CUSTOM_INSTRUCTIONS,
    chatMode: KEY_CHAT_MODE,
    disabledTools: KEY_DISABLED_TOOLS,
    debugEnabled: KEY_DEBUG_ENABLED,
    autostart: KEY_AUTOSTART,
    restoreWindowState: KEY_RESTORE_WINDOW,
    autocompleteEnabled: KEY_AUTOCOMPLETE_ENABLED,
    autocompleteProvider: KEY_AUTOCOMPLETE_PROVIDER,
    autocompleteModelId: KEY_AUTOCOMPLETE_MODEL,
    lmstudioBaseURL: KEY_LMSTUDIO_BASE_URL,
    openaiCompatibleBaseURL: KEY_OPENAI_COMPATIBLE_BASE_URL,
    openaiCompatibleInstances: KEY_OPENAI_COMPATIBLE_INSTANCES,
    vimMode: KEY_VIM_MODE,
    lineWrap: KEY_LINE_WRAP,
    showMinimap: KEY_SHOW_MINIMAP,
    editorLigatures: KEY_EDITOR_LIGATURES,
    terminalWebglEnabled: KEY_TERMINAL_WEBGL_ENABLED,
    terminalFontSize: KEY_TERMINAL_FONT_SIZE,
    terminalScrollback: KEY_TERMINAL_SCROLLBACK,
    terminalEnvPath: KEY_TERMINAL_ENV_PATH,
    showHiddenFiles: KEY_SHOW_HIDDEN_FILES,
    statusBarCompact: KEY_STATUS_BAR_COMPACT,
    showSourceControl: KEY_SHOW_SOURCE_CONTROL,
    sourceControlInRightPanel: KEY_SOURCE_CONTROL_IN_RIGHT_PANEL,
    sshInRightPanel: KEY_SSH_IN_RIGHT_PANEL,
    shortcuts: KEY_SHORTCUTS,
    extensionShortcuts: KEY_EXTENSION_SHORTCUTS,
    pinnedModelIds: KEY_PINNED_MODELS,
    approvalMode: KEY_APPROVAL_MODE,
    lastModelId: KEY_LAST_MODEL,
    lastProviderId: KEY_LAST_PROVIDER,
    contentZoom: KEY_CONTENT_ZOOM,
    uiZoom: KEY_UI_ZOOM,
    aiNotificationsEnabled: KEY_AI_NOTIFICATIONS_ENABLED,
    aiBlockingSound: KEY_AI_BLOCKING_SOUND,
    aiCompletionSound: KEY_AI_COMPLETION_SOUND,
    brandColor: KEY_BRAND_COLOR,
    customThemeEnabled: KEY_CUSTOM_THEME_ENABLED,
    customTheme: KEY_CUSTOM_THEME,
    // Written from the Settings window, consumed live by the main window.
    appOpacity: KEY_APP_OPACITY,
    searchEngine: KEY_SEARCH_ENGINE,
    autoOpenProjectUrl: KEY_AUTO_OPEN_PROJECT_URL,
    userThemePresets: KEY_USER_THEME_PRESETS,
    formatOnSave: KEY_FORMAT_ON_SAVE,
    formatters: KEY_FORMATTERS,
  } satisfies Record<PrefKey, string>;
  const map = Object.fromEntries(
    Object.entries(prefToStoreKey).map(([pref, storeKey]) => [storeKey, pref as PrefKey]),
  ) as Record<string, PrefKey>;
  // Same-process writes fire onChange directly. Cross-window writes arrive via the Tauri event from writePref().
  return subscribeRawChanges((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
}

// API keys live in the OS keychain, not the prefs store. Broadcast via Tauri event for cross-window listeners.
const KEYS_CHANGED_EVENT = "tedi://ai-keys-changed";

export async function emitKeysChanged(): Promise<void> {
  await emit(KEYS_CHANGED_EVENT);
}

export function onKeysChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(KEYS_CHANGED_EVENT, () => cb());
}
