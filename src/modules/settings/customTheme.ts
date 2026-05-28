/**
 * Custom theme runtime applier.
 *
 * Persisted shape lives in `store.ts` (`Preferences.customTheme`). When
 * enabled, this module overrides the CSS variables on `:root` and renders a
 * fixed-position background image div behind the app surfaces.
 *
 * Stays compatible with the existing `brandColor` flow. When `customTheme`
 * is disabled, nothing is overridden and the brand color path keeps owning
 * `--primary` / `--ring` / `--accent`.
 */

export type ThemeColors = {
  /** App-wide canvas (`--background`). */
  background: string;
  /** Default text color (`--foreground`). */
  foreground: string;
  /** Card / panel surface (`--card`). */
  card: string;
  /** Card / panel text (`--card-foreground`). */
  cardForeground: string;
  /** Popover surface (`--popover`). */
  popover: string;
  /** Popover text (`--popover-foreground`). */
  popoverForeground: string;
  /** Buttons + accents (`--primary`). Layered with brandColor; this wins. */
  button: string;
  /** Button text (`--primary-foreground`). */
  buttonForeground: string;
  /** Subtle surface (`--secondary`). */
  secondary: string;
  /** Subtle surface text (`--secondary-foreground`). */
  secondaryForeground: string;
  /** Muted text + surface (`--muted` / `--muted-foreground`). */
  muted: string;
  mutedForeground: string;
  /** Soft accent fill for popovers / dropdowns / active tab (`--accent`). */
  accent: string;
  accentForeground: string;
  /** Destructive (`--destructive`). */
  destructive: string;
  /** Default border color across panels (`--border`). */
  border: string;
  /** Input field border (`--input`). Also the button outline base. */
  input: string;
  /** Button border (visible 1px around buttons). */
  buttonBorder: string;
  /** Focus bar / focus ring on tab and inputs (`--ring`, also `::after` on active tab). */
  ring: string;
  /** Sidebar surface. */
  sidebar: string;
  sidebarForeground: string;
  /** Sidebar border line. */
  sidebarBorder: string;
  /** Selected workspace / selected file row background (`--sidebar-accent`). */
  sidebarAccent: string;
  /** Text on selected workspace / file row. */
  sidebarAccentForeground: string;
  /** Icon color when the AI / extension is actively working (spinner). */
  iconWorking: string;
  /** Icon color in idle state. */
  iconIdle: string;
  /** Icon color when blocked / awaiting approval. */
  iconBlocked: string;
  /** Semantic green for diff additions, "+N" stats, success indicators. */
  diffAdded: string;
  /** Semantic red for diff removals, "-N" stats. Distinct from `destructive`
   *  which targets actionable danger UI (delete buttons, error text). */
  diffRemoved: string;
  /** Semantic sky/cyan for "info" pills, renamed/copied SCM rows, neutral
   *  status notifications. */
  info: string;
  /**
   * Focus / accent stripe color painted on the active tab in the top
   * tab bar, per tab kind. The stripe is the 3px vertical bar near the
   * left edge of the active tab; it also signals which kind of content
   * lives inside (terminal vs editor vs preview).
   */
  tabAccentTerminal: string;
  tabAccentSsh: string;
  tabAccentEditor: string;
  tabAccentPreview: string;
  tabAccentAiDiff: string;
  tabAccentGitDiff: string;
  /** Color of the drag-to-resize divider between split panes. */
  resizeHandle: string;
  /**
   * Full ANSI 16-colour palette painted by the terminal. The first eight
   * are the "standard" colours; the latter eight are the "bright" set.
   * xterm.js consumes these as `theme.black`, `theme.red`, ...,
   * `theme.brightWhite`. Themable so each preset can ship a matched
   * terminal palette instead of inheriting a generic one.
   */
  ansiBlack: string;
  ansiRed: string;
  ansiGreen: string;
  ansiYellow: string;
  ansiBlue: string;
  ansiMagenta: string;
  ansiCyan: string;
  ansiWhite: string;
  ansiBrightBlack: string;
  ansiBrightRed: string;
  ansiBrightGreen: string;
  ansiBrightYellow: string;
  ansiBrightBlue: string;
  ansiBrightMagenta: string;
  ansiBrightCyan: string;
  ansiBrightWhite: string;
};

type ThemeBackground = {
  /** When false, the background image is not painted. */
  enabled: boolean;
  /**
   * Original path or URL of the image, kept for display in the UI
   * ("Background: /Users/.../wall.png" or "https://..."). Loading uses
   * `dataUrl`.
   */
  path: string;
  /**
   * Image source as a CSS-valid URL. Either a `data:image/...;base64,...`
   * blob (from the file picker) or an `http(s)://` URL (from the URL
   * import). Empty string when no wallpaper is set.
   */
  dataUrl: string;
  /** Gaussian blur on the wallpaper (0..40 px). */
  blur: number;
  /**
   * How opaque the terminal + code editor + diff surface remain on top of
   * the wallpaper (0..1). 1 = fully solid (image hidden in those panes),
   * 0 = fully transparent (image fully visible behind text). Default 0.85.
   */
  surfaceOpacity: number;
  /**
   * Dark overlay strength painted on top of the wallpaper (0..1). 0 = no
   * overlay, 1 = fully black. Higher values darken the image so light
   * text reads better over a busy picture.
   */
  darken: number;
};

export type CustomTheme = {
  /** User-visible name (preset id, or "Custom"). */
  name: string;
  /** Color set applied when the resolved theme is light. */
  light: ThemeColors;
  /** Color set applied when the resolved theme is dark. */
  dark: ThemeColors;
  background: ThemeBackground;
};

const THEME_FILE_VERSION = 1;

type ThemeFileV1 = {
  $schema?: "tedi-theme";
  version: typeof THEME_FILE_VERSION;
} & CustomTheme;

const BG_ELEMENT_ID = "tedi-bg-layer";

/**
 * Mapping of `ThemeColors` keys to the CSS variables they drive.
 * Multiple variables can be backed by a single token (e.g. `button` writes
 * both `--primary` and `--sidebar-primary`).
 */
const COLOR_VAR_MAP: Record<keyof ThemeColors, readonly string[]> = {
  background: ["--background"],
  foreground: ["--foreground"],
  card: ["--card"],
  cardForeground: ["--card-foreground"],
  popover: ["--popover"],
  popoverForeground: ["--popover-foreground"],
  button: ["--primary", "--sidebar-primary"],
  buttonForeground: ["--primary-foreground", "--sidebar-primary-foreground"],
  secondary: ["--secondary"],
  secondaryForeground: ["--secondary-foreground"],
  muted: ["--muted"],
  mutedForeground: ["--muted-foreground"],
  accent: ["--accent"],
  accentForeground: ["--accent-foreground"],
  destructive: ["--destructive"],
  border: ["--border"],
  input: ["--input"],
  buttonBorder: ["--tedi-button-border"],
  ring: ["--ring", "--sidebar-ring"],
  sidebar: ["--sidebar"],
  sidebarForeground: ["--sidebar-foreground"],
  sidebarBorder: ["--sidebar-border"],
  sidebarAccent: ["--sidebar-accent"],
  sidebarAccentForeground: ["--sidebar-accent-foreground"],
  iconWorking: ["--tedi-icon-working"],
  iconIdle: ["--tedi-icon-idle"],
  iconBlocked: ["--tedi-icon-blocked"],
  diffAdded: ["--tedi-diff-added"],
  diffRemoved: ["--tedi-diff-removed"],
  info: ["--tedi-info"],
  tabAccentTerminal: ["--tedi-tab-terminal"],
  tabAccentSsh: ["--tedi-tab-ssh"],
  tabAccentEditor: ["--tedi-tab-editor"],
  tabAccentPreview: ["--tedi-tab-preview"],
  tabAccentAiDiff: ["--tedi-tab-ai-diff"],
  tabAccentGitDiff: ["--tedi-tab-git-diff"],
  resizeHandle: ["--tedi-resize-handle"],
  ansiBlack: ["--tedi-ansi-black"],
  ansiRed: ["--tedi-ansi-red"],
  ansiGreen: ["--tedi-ansi-green"],
  ansiYellow: ["--tedi-ansi-yellow"],
  ansiBlue: ["--tedi-ansi-blue"],
  ansiMagenta: ["--tedi-ansi-magenta"],
  ansiCyan: ["--tedi-ansi-cyan"],
  ansiWhite: ["--tedi-ansi-white"],
  ansiBrightBlack: ["--tedi-ansi-bright-black"],
  ansiBrightRed: ["--tedi-ansi-bright-red"],
  ansiBrightGreen: ["--tedi-ansi-bright-green"],
  ansiBrightYellow: ["--tedi-ansi-bright-yellow"],
  ansiBrightBlue: ["--tedi-ansi-bright-blue"],
  ansiBrightMagenta: ["--tedi-ansi-bright-magenta"],
  ansiBrightCyan: ["--tedi-ansi-bright-cyan"],
  ansiBrightWhite: ["--tedi-ansi-bright-white"],
};

const FAST_PATH_KEY = "tedi-custom-theme-shadow";

function readShadow(): CustomTheme | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FAST_PATH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Accept either the new shape (`light`/`dark`) or the legacy single-mode
    // `colors` payload. The fast-path applier resolves the variant later.
    const obj = parsed as Record<string, unknown>;
    if (obj.light || obj.dark || obj.colors) return parsed as CustomTheme;
    return null;
  } catch {
    return null;
  }
}

function writeShadow(theme: CustomTheme | null): void {
  try {
    if (!theme) {
      window.localStorage.removeItem(FAST_PATH_KEY);
      return;
    }
    // Strip multi-MB `data:` blobs from the localStorage shadow. Idle
    // memory stays low (the shadow is read on every boot of the same
    // webview) and `applyCustomTheme` will re-add the dataUrl from the
    // tauri-plugin-store payload once it resolves. URL dataUrls stay
    // since they are tiny (~100 bytes) and let the wallpaper paint on
    // first frame without waiting for the async store load.
    const slim = theme.background.dataUrl.startsWith("data:")
      ? { ...theme, background: { ...theme.background, dataUrl: "" } }
      : theme;
    window.localStorage.setItem(FAST_PATH_KEY, JSON.stringify(slim));
  } catch {
    /* ignore */
  }
}

function ensureBgElement(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById(BG_ELEMENT_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = BG_ELEMENT_ID;
    el.setAttribute("aria-hidden", "true");
    el.style.position = "fixed";
    el.style.inset = "0";
    el.style.zIndex = "-1";
    el.style.pointerEvents = "none";
    el.style.overflow = "hidden";
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.style.backgroundRepeat = "no-repeat";
    document.body.prepend(el);
  }
  return el;
}

function clearCssVars(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const vars of Object.values(COLOR_VAR_MAP)) {
    for (const v of vars) root.style.removeProperty(v);
  }
  // Clean up the canvas base colour; the globals.css default takes over.
  root.style.removeProperty("--tedi-canvas-bg");
}

/**
 * Wallpaper is intentionally main-window only. The Settings window has its
 * own root (`#settings-root`) and we don't want a busy image behind the
 * controls. Colors still apply through the rest of the theme so the
 * settings UI stays in palette.
 */
function isSettingsWindow(): boolean {
  if (typeof document === "undefined") return false;
  return document.getElementById("settings-root") !== null;
}

const BG_MEDIA_ATTR = "data-tedi-bg-media";
const BG_DARKEN_ATTR = "data-tedi-bg-darken";

type BgKind = "image" | "video" | "youtube";

/** Classify a background source so a video/YouTube renders in-app (a `<video>`
 *  / embed `<iframe>`) instead of a static image. Rendering video inside the
 *  webview is the only way it survives transparency: a video on the *desktop*
 *  behind a transparent window goes black (Windows Multi-Plane Overlay). */
function detectBgKind(src: string): BgKind {
  const s = src.trim();
  if (/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)/i.test(s)) return "youtube";
  if (/^data:video\//i.test(s) || /\.(mp4|webm|ogg|ogv|mov|m4v)(?:[?#]|$)/i.test(s)) return "video";
  return "image";
}

/** Build a looping, muted, chrome-free YouTube embed URL for a wallpaper. */
function youtubeEmbedUrl(src: string): string | null {
  const m = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
  if (!m) return null;
  const id = m[1];
  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    controls: "0",
    loop: "1",
    playlist: id,
    modestbranding: "1",
    playsinline: "1",
    rel: "0",
    iv_load_policy: "3",
  });
  return `https://www.youtube.com/embed/${id}?${params.toString()}`;
}

/** Darken overlay on top of the media so light text stays readable. */
function setDarkenOverlay(el: HTMLElement, darken: number): void {
  let overlay = el.querySelector<HTMLElement>(`[${BG_DARKEN_ATTR}]`);
  if (darken <= 0) {
    overlay?.remove();
    return;
  }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.setAttribute(BG_DARKEN_ATTR, "");
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    el.appendChild(overlay);
  }
  overlay.style.background = `rgba(0,0,0,${darken})`;
}

/**
 * Paint (or clear) the wallpaper layer behind the app. Supports a static
 * image, a looping video (`.mp4`/`.webm`/...), or a YouTube URL (embedded,
 * muted, looping). Independent of the colour theme: it shows whenever a source
 * is set, regardless of `customThemeEnabled`. Transparency itself is the single
 * "App opacity" control; the translucent surfaces reveal this layer (or the
 * desktop when none is set). Settings window opts out.
 */
export function applyBackground(bg: ThemeBackground): void {
  if (typeof document === "undefined") return;

  if (isSettingsWindow()) {
    const existing = document.getElementById(BG_ELEMENT_ID);
    if (existing) existing.remove();
    return;
  }

  const el = ensureBgElement();
  if (!el) return;

  const clearMedia = () => el.querySelectorAll(`[${BG_MEDIA_ATTR}]`).forEach((n) => n.remove());

  if (!bg.enabled || !bg.dataUrl) {
    el.style.display = "none";
    el.style.backgroundImage = "";
    el.style.filter = "";
    clearMedia();
    setDarkenOverlay(el, 0);
    return;
  }

  el.style.display = "block";
  const blur = bg.blur > 0 ? `blur(${Math.max(0, Math.min(40, bg.blur))}px)` : "";
  const darken = Math.max(0, Math.min(1, bg.darken ?? 0));
  const kind = detectBgKind(bg.dataUrl);

  if (kind === "image") {
    clearMedia();
    const safeUrl = bg.dataUrl.replace(/"/g, '\\"');
    const overlay =
      darken > 0 ? `linear-gradient(rgba(0,0,0,${darken}), rgba(0,0,0,${darken})), ` : "";
    el.style.backgroundImage = `${overlay}url("${safeUrl}")`;
    el.style.filter = blur;
    return;
  }

  // Video / YouTube render inside the webview so they survive transparency.
  el.style.backgroundImage = "";
  el.style.filter = "";
  const src = kind === "video" ? bg.dataUrl : (youtubeEmbedUrl(bg.dataUrl) ?? "");
  if (!src) {
    clearMedia();
    el.style.display = "none";
    return;
  }

  // Reuse the element when the source is unchanged so playback doesn't restart
  // on every theme re-apply (mode flip, opacity commit, etc.).
  let media = el.querySelector<HTMLElement>(`[${BG_MEDIA_ATTR}]`);
  if (!media || media.dataset.kind !== kind || media.getAttribute("data-src") !== src) {
    media?.remove();
    if (kind === "video") {
      const v = document.createElement("video");
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.setAttribute("muted", "");
      v.setAttribute("playsinline", "");
      v.src = src;
      v.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;";
      v.dataset.kind = "video";
      v.setAttribute("data-src", src);
      v.setAttribute(BG_MEDIA_ATTR, "");
      el.prepend(v);
      void v.play?.().catch(() => {});
      media = v;
    } else {
      const f = document.createElement("iframe");
      f.src = src;
      f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
      f.setAttribute("frameborder", "0");
      // A 16:9 iframe can't `object-fit`; oversize + centre so it covers the
      // viewport without letterbox bars (overflow clipped by the layer).
      f.style.cssText =
        "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);" +
        "width:max(100vw,calc(100vh*16/9));height:max(100vh,calc(100vw*9/16));" +
        "border:0;pointer-events:none;";
      f.dataset.kind = "youtube";
      f.setAttribute("data-src", src);
      f.setAttribute(BG_MEDIA_ATTR, "");
      el.prepend(f);
      media = f;
    }
  }
  media.style.filter = blur;
  setDarkenOverlay(el, darken);
}

/**
 * Apply a `CustomTheme`'s colours to the document. Pass `null` to clear
 * overrides and let the base CSS variables (and `brandColor`) take over again.
 * The wallpaper image is handled separately by `applyBackground` so it is not
 * tied to whether the custom theme is enabled.
 */
export function applyCustomTheme(theme: CustomTheme | null): void {
  if (typeof document === "undefined") return;
  if (!theme) {
    clearCssVars();
    writeShadow(null);
    return;
  }
  const root = document.documentElement;
  // Pick the variant matching the resolved theme: the `.dark` class on
  // <html> is set by ThemeProvider whenever resolvedTheme flips.
  const isDark = root.classList.contains("dark");
  const colors = isDark ? theme.dark : theme.light;
  for (const key of Object.keys(COLOR_VAR_MAP) as Array<keyof ThemeColors>) {
    const value = colors[key];
    if (!value) continue;
    for (const v of COLOR_VAR_MAP[key]) {
      root.style.setProperty(v, value);
    }
  }
  // Canvas base colour the glass tint mixes against (editor/terminal rgba +
  // the panel tints). Removed by clearCssVars when the custom theme turns off,
  // so the base palette default in globals.css takes over.
  root.style.setProperty("--tedi-canvas-bg", colors.background);
  writeShadow(theme);
}

/**
 * Synchronous fast-path. Call before React mounts so the first paint uses
 * the persisted custom theme instead of the base palette. Lazy-import the
 * default palette to keep this module independent of `themePresets.ts`
 * (the latter imports types from here, so a static import would cycle).
 */
export function applyCustomThemeFastPath(): void {
  const cached = readShadow();
  if (!cached) return;
  // Legacy shadows may still have the old `colors` shape. Normalize against
  // a minimal default so both light + dark variants are present before the
  // applier picks one by class.
  const defaults: CustomTheme = {
    name: "Default",
    light: SAFE_LIGHT_FALLBACK,
    dark: SAFE_DARK_FALLBACK,
    background: {
      enabled: false,
      path: "",
      dataUrl: "",
      blur: 0,
      surfaceOpacity: 0.85,
      darken: 0,
    },
  };
  const normalized = normalizeCustomTheme(cached, defaults);
  applyCustomTheme(normalized);
  // Paint the wallpaper on first frame too (URL images survive the slim
  // shadow; local data: URLs are restored after the async store load).
  applyBackground(normalized.background);
}

/**
 * Minimal fallback palettes baked into this module so the fast-path stays
 * synchronous and doesn't pull in `themePresets.ts` (which has the rich
 * presets and depends on this file's types). Any field missing from a
 * legacy shadow falls back to these.
 */
const SAFE_LIGHT_FALLBACK: ThemeColors = {
  background: "#ffffff",
  foreground: "#1f2328",
  card: "#ffffff",
  cardForeground: "#1f2328",
  popover: "#ffffff",
  popoverForeground: "#1f2328",
  button: "#0057fe",
  buttonForeground: "#ffffff",
  secondary: "#f3f4f6",
  secondaryForeground: "#1f2328",
  muted: "#f3f4f6",
  mutedForeground: "#6b7280",
  accent: "#dbe5ff",
  accentForeground: "#1f2328",
  destructive: "#dc2626",
  border: "#e5e7eb",
  input: "#e5e7eb",
  buttonBorder: "#d1d5db",
  ring: "#0057fe",
  sidebar: "#fafafa",
  sidebarForeground: "#1f2328",
  sidebarBorder: "#e5e7eb",
  sidebarAccent: "#dbe5ff",
  sidebarAccentForeground: "#1f2328",
  iconWorking: "#ca8a04",
  iconIdle: "#059669",
  iconBlocked: "#dc2626",
  diffAdded: "#16a34a",
  diffRemoved: "#dc2626",
  info: "#0284c7",
  tabAccentTerminal: "#10b981",
  tabAccentSsh: "#0ea5e9",
  tabAccentEditor: "#0057fe",
  tabAccentPreview: "#06b6d4",
  tabAccentAiDiff: "#8b5cf6",
  tabAccentGitDiff: "#f59e0b",
  resizeHandle: "#e5e7eb",
  ansiBlack: "#3f3f46",
  ansiRed: "#dc2626",
  ansiGreen: "#16a34a",
  ansiYellow: "#ca8a04",
  ansiBlue: "#2563eb",
  ansiMagenta: "#9333ea",
  ansiCyan: "#0891b2",
  ansiWhite: "#e4e4e7",
  ansiBrightBlack: "#71717a",
  ansiBrightRed: "#ef4444",
  ansiBrightGreen: "#22c55e",
  ansiBrightYellow: "#eab308",
  ansiBrightBlue: "#3b82f6",
  ansiBrightMagenta: "#a855f7",
  ansiBrightCyan: "#06b6d4",
  ansiBrightWhite: "#fafafa",
};

const SAFE_DARK_FALLBACK: ThemeColors = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  card: "#1f1f1f",
  cardForeground: "#cccccc",
  popover: "#1f1f1f",
  popoverForeground: "#cccccc",
  button: "#0057fe",
  buttonForeground: "#ffffff",
  secondary: "#2a2d2e",
  secondaryForeground: "#cccccc",
  muted: "#252526",
  mutedForeground: "#9d9d9d",
  accent: "#0a2870",
  accentForeground: "#ffffff",
  destructive: "#f14c4c",
  border: "#2b2b2b",
  input: "#313131",
  buttonBorder: "#3a3a3a",
  ring: "#0057fe",
  sidebar: "#181818",
  sidebarForeground: "#cccccc",
  sidebarBorder: "#2b2b2b",
  sidebarAccent: "#37373d",
  sidebarAccentForeground: "#ffffff",
  iconWorking: "#facc15",
  iconIdle: "#34d399",
  iconBlocked: "#f87171",
  diffAdded: "#4ade80",
  diffRemoved: "#f87171",
  info: "#38bdf8",
  tabAccentTerminal: "#34d399",
  tabAccentSsh: "#38bdf8",
  tabAccentEditor: "#5b8bff",
  tabAccentPreview: "#22d3ee",
  tabAccentAiDiff: "#a78bfa",
  tabAccentGitDiff: "#fbbf24",
  resizeHandle: "#2b2b2b",
  ansiBlack: "#18181b",
  ansiRed: "#ef4444",
  ansiGreen: "#22c55e",
  ansiYellow: "#eab308",
  ansiBlue: "#3b82f6",
  ansiMagenta: "#a855f7",
  ansiCyan: "#06b6d4",
  ansiWhite: "#e4e4e7",
  ansiBrightBlack: "#52525b",
  ansiBrightRed: "#f87171",
  ansiBrightGreen: "#4ade80",
  ansiBrightYellow: "#facc15",
  ansiBrightBlue: "#60a5fa",
  ansiBrightMagenta: "#c084fc",
  ansiBrightCyan: "#22d3ee",
  ansiBrightWhite: "#fafafa",
};

/**
 * Merge a partial / possibly-stale `CustomTheme` payload (e.g. one
 * persisted by an older build that did not yet have all the token keys)
 * with the supplied default. Guarantees every required field is present
 * so consumers like `ThemeSection` and `applyCustomTheme` never see an
 * `undefined` token. Idempotent and side-effect-free.
 */
export function normalizeCustomTheme(loaded: unknown, defaults: CustomTheme): CustomTheme {
  if (!loaded || typeof loaded !== "object") return defaults;
  const obj = loaded as Record<string, unknown>;
  const bg =
    obj.background && typeof obj.background === "object"
      ? (obj.background as Partial<ThemeBackground>)
      : {};
  const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : defaults.name;

  // Legacy single-mode payloads carried a flat `colors` field plus a `mode`
  // hint. Fan them out to both light + dark slots so the runtime always has
  // a variant ready when the resolved theme flips.
  const legacyColors =
    obj.colors && typeof obj.colors === "object" ? (obj.colors as Partial<ThemeColors>) : null;
  const legacyMode = obj.mode === "light" || obj.mode === "dark" ? obj.mode : null;

  const rawLight =
    obj.light && typeof obj.light === "object" ? (obj.light as Partial<ThemeColors>) : null;
  const rawDark =
    obj.dark && typeof obj.dark === "object" ? (obj.dark as Partial<ThemeColors>) : null;

  const lightSource = rawLight ?? (legacyColors && legacyMode === "light" ? legacyColors : null);
  const darkSource = rawDark ?? (legacyColors && legacyMode === "dark" ? legacyColors : null);
  // If only one was supplied (or only legacy), share it across both.
  const lightFinal = lightSource ?? darkSource ?? null;
  const darkFinal = darkSource ?? lightSource ?? null;

  return {
    name,
    light: { ...defaults.light, ...filterStrings(lightFinal ?? {}) },
    dark: { ...defaults.dark, ...filterStrings(darkFinal ?? {}) },
    background: {
      enabled: typeof bg.enabled === "boolean" ? bg.enabled : defaults.background.enabled,
      path: typeof bg.path === "string" ? bg.path : defaults.background.path,
      dataUrl: typeof bg.dataUrl === "string" ? bg.dataUrl : defaults.background.dataUrl,
      blur: clampRange(bg.blur, 0, 40, defaults.background.blur),
      surfaceOpacity: clamp01(bg.surfaceOpacity, defaults.background.surfaceOpacity),
      darken: clamp01(bg.darken, defaults.background.darken),
    },
  };
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function clampRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

/**
 * Validate an imported `.tedi` payload. Throws with a user-readable message
 * when the structure is bad. Lenient with missing/extra keys: fills in
 * defaults from the supplied `fallback` for any field that's absent.
 */
export function parseThemeFile(raw: unknown, fallback: CustomTheme): CustomTheme {
  if (!raw || typeof raw !== "object") throw new Error("Theme file is not a JSON object");
  // Delegate variant + legacy-`colors` + bg field plumbing to the shared
  // normalizer so .tedi parsing stays in lock-step with the runtime store
  // hydration path. Only override `name` (defaults to "Custom" when blank).
  const merged = normalizeCustomTheme(raw, fallback);
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "Custom";
  return { ...merged, name };
}

function filterStrings(obj: Partial<ThemeColors>): Partial<ThemeColors> {
  const out: Partial<ThemeColors> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 0) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** Serialise a theme for `.tedi` export. */
export function serializeThemeFile(theme: CustomTheme): string {
  const payload: ThemeFileV1 = {
    $schema: "tedi-theme",
    version: THEME_FILE_VERSION,
    ...theme,
  };
  return JSON.stringify(payload, null, 2);
}
