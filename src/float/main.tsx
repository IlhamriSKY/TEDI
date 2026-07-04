import "../lib/tauri-browser-shim";

import "@xterm/xterm/css/xterm.css";
import "../styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/modules/theme";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { applyBrandColorFastPath } from "@/modules/settings/brandColor";
import { applyCustomThemeFastPath } from "@/modules/settings/customTheme";
import { applyTerminalThemeFastPath } from "@/modules/settings/terminalPalette";
import { applyFontFastPath } from "@/lib/fonts";
import { FloatApp } from "./FloatApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

applyBrandColorFastPath();
applyCustomThemeFastPath();
applyTerminalThemeFastPath();
applyFontFastPath();

ReactDOM.createRoot(document.getElementById("float-root") as HTMLElement).render(
  <ThemeProvider>
    <FloatApp />
  </ThemeProvider>,
);

let shown = false;
const showWindow = () => {
  if (shown) return;
  shown = true;
  getCurrentWindow()
    .show()
    .catch((e) => console.error("float show failed:", e));
};
requestAnimationFrame(() => requestAnimationFrame(showWindow));
setTimeout(showWindow, 250);
