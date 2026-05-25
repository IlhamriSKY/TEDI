import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  loadPreferences,
  onPreferencesChange,
  setTheme as persistTheme,
  type ThemePref,
} from "@/modules/settings/store";
import { applyBrandColor, applyBrandColorFastPath } from "@/modules/settings/brandColor";
import {
  applyCustomTheme,
  normalizeCustomTheme,
  type CustomTheme,
} from "@/modules/settings/customTheme";
import { DEFAULT_CUSTOM_THEME } from "@/modules/settings/themePresets";

export type Theme = ThemePref;

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

// Synchronous fast-path so the initial paint isn't unstyled. The persistent
// preference (in tauri-plugin-store) overwrites this on mount; we keep a
// localStorage shadow of the *last applied* theme just for first-paint fidelity.
const FAST_PATH_KEY = "tedi-ui-theme-shadow";

function readFastTheme(fallback: Theme): Theme {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(FAST_PATH_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : fallback;
}

function writeFastTheme(t: Theme): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, t);
  } catch {
    // ignore
  }
}

export function ThemeProvider({ children, defaultTheme = "system" }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => readFastTheme(defaultTheme));
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Track the latest known custom-theme state so brand/theme toggles can
  // re-resolve which layer should be active without re-fetching the store.
  const customStateRef = useRef<{ enabled: boolean; theme: CustomTheme | null }>({
    enabled: false,
    theme: null,
  });

  const reconcileLayers = useCallback((brand: string) => {
    if (customStateRef.current.enabled && customStateRef.current.theme) {
      applyCustomTheme(customStateRef.current.theme);
    } else {
      // Order matters: clear any leftover custom-theme overrides first so
      // `clearCssVars()` does not wipe the `--primary` / `--ring` / `--accent`
      // values that `applyBrandColor` is about to set.
      applyCustomTheme(null);
      applyBrandColor(brand);
    }
  }, []);

  // Hydrate from the persistent store (cross-window source of truth).
  useEffect(() => {
    let alive = true;
    loadPreferences()
      .then((p) => {
        if (!alive) return;
        setThemeState(p.theme);
        writeFastTheme(p.theme);
        customStateRef.current = {
          enabled: p.customThemeEnabled,
          theme: p.customTheme,
        };
        reconcileLayers(p.brandColor);
      })
      .catch((err) => {
        console.error("ThemeProvider: loadPreferences failed", err);
      });
    const unlistenP = onPreferencesChange((key, value) => {
      if (key === "theme" && (value === "system" || value === "light" || value === "dark")) {
        setThemeState(value);
        writeFastTheme(value);
      } else if (key === "brandColor" && typeof value === "string") {
        reconcileLayers(value);
      } else if (key === "customThemeEnabled" && typeof value === "boolean") {
        customStateRef.current = { ...customStateRef.current, enabled: value };
        // Re-read brand from the store snapshot only when we need to fall back.
        loadPreferences()
          .then((p) => reconcileLayers(p.brandColor))
          .catch((err) => console.error("ThemeProvider: enable-toggle reload failed", err));
      } else if (key === "customTheme" && value && typeof value === "object") {
        const normalized = normalizeCustomTheme(value, DEFAULT_CUSTOM_THEME);
        customStateRef.current = {
          ...customStateRef.current,
          theme: normalized,
        };
        if (customStateRef.current.enabled) applyCustomTheme(normalized);
      }
    });
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [reconcileLayers]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "dark" | "light" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
    // Accent derivation differs per mode, so re-apply on theme flips. When a
    // custom theme is active it owns the palette and wins; otherwise fall
    // back to the cached brand hex (cheaper than re-hitting the store).
    if (customStateRef.current.enabled && customStateRef.current.theme) {
      applyCustomTheme(customStateRef.current.theme);
    } else {
      applyBrandColorFastPath();
    }
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    writeFastTheme(next);
    void persistTheme(next);
  }, []);

  const value = useMemo<ThemeProviderState>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a <ThemeProvider>");
  return ctx;
}
