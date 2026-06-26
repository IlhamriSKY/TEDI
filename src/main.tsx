import "./lib/tauri-browser-shim";

import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { applyBrandColorFastPath } from "@/modules/settings/brandColor";
import { applyCustomThemeFastPath } from "@/modules/settings/customTheme";
import { applyTerminalThemeFastPath } from "@/modules/settings/terminalPalette";
import { applyAppOpacityFastPath } from "@/modules/settings/appOpacity";
import { applyFontFastPath } from "@/lib/fonts";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

applyBrandColorFastPath();
// Custom theme overrides brand color when active. Run after the brand fast
// path so its CSS variables win on first paint.
applyCustomThemeFastPath();
// Terminal theme is independent of the app theme. In "custom" mode this paints
// the saved terminal palette before the first xterm renders; "follow-app" is a
// no-op (the globals.css `--tedi-term-*` defaults already mirror the app).
applyTerminalThemeFastPath();
// Whole-app glass: fade the canvas toward the desktop on first paint so there
// is no opaque flash before hydration re-applies the stored value.
applyAppOpacityFastPath();
// Content font family + editor font size, so the editor paints with the chosen
// font on the first frame instead of swapping after hydrate.
applyFontFastPath();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary
    fallback={(error, reset) => (
      <div className="bg-background text-foreground flex h-screen w-screen flex-col items-center justify-center gap-3 p-6">
        <span className="text-sm font-semibold">TEDI hit an unexpected error.</span>
        <pre className="text-muted-foreground max-h-48 max-w-xl overflow-auto font-mono text-[11px] whitespace-pre-wrap">
          {error.message}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="border-border hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="border-border hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
          >
            Reload
          </button>
        </div>
      </div>
    )}
  >
    <App />
  </ErrorBoundary>,
);

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout - rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
