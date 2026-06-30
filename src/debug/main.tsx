import "../lib/tauri-browser-shim";

import "../styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/modules/theme";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { applyBrandColorFastPath } from "@/modules/settings/brandColor";
import { applyCustomThemeFastPath } from "@/modules/settings/customTheme";
import { DebugApp } from "./DebugApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

applyBrandColorFastPath();
applyCustomThemeFastPath();

ReactDOM.createRoot(document.getElementById("debug-root") as HTMLElement).render(
  <ThemeProvider>
    <DebugApp />
  </ThemeProvider>,
);

// Reveal after one painted frame - avoids the transparent window-shadow flash
// on Windows/Linux without a wall-clock delay. Two RAFs guarantees at least one
// commit reached the compositor. Mirrors the Settings window.
let shown = false;
const showWindow = () => {
  if (shown) return;
  shown = true;
  getCurrentWindow()
    .show()
    .catch((e) => console.error("debug show failed:", e));
};
requestAnimationFrame(() => requestAnimationFrame(showWindow));
setTimeout(showWindow, 250);
