import "../styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/modules/theme";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { SettingsApp } from "./SettingsApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

ReactDOM.createRoot(document.getElementById("settings-root") as HTMLElement).render(
  <ThemeProvider>
    <SettingsApp />
  </ThemeProvider>,
);

// Reveal after one painted frame - avoids the transparent window-shadow flash
// on Windows/Linux without the old 500ms wall-clock delay. Two RAFs guarantees
// at least one commit has reached the compositor.
let shown = false;
const showWindow = () => {
  if (shown) return;
  shown = true;
  getCurrentWindow()
    .show()
    .catch((e) => console.error("settings show failed:", e));
};
requestAnimationFrame(() => requestAnimationFrame(showWindow));
// Safety net if the tab is backgrounded before the second RAF fires.
setTimeout(showWindow, 250);

// Mono font is only used by a handful of inputs/labels - load it after the
// first paint so it doesn't block the initial render of the settings shell.
// Browser falls back to the CSS chain (SFMono/Menlo/monospace) until ready.
setTimeout(() => {
  void import("@fontsource/jetbrains-mono/400.css");
  void import("@fontsource/jetbrains-mono/700.css");
}, 0);
