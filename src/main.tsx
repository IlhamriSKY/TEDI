import "./lib/tauri-browser-shim";

import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { applyBrandColorFastPath } from "@/modules/settings/brandColor";
import { applyCustomThemeFastPath } from "@/modules/settings/customTheme";
import { applyAppOpacityFastPath } from "@/modules/settings/appOpacity";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

applyBrandColorFastPath();
// Custom theme overrides brand color when active. Run after the brand fast
// path so its CSS variables win on first paint.
applyCustomThemeFastPath();
// Whole-app glass: fade the canvas toward the desktop on first paint so there
// is no opaque flash before hydration re-applies the stored value.
applyAppOpacityFastPath();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

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
