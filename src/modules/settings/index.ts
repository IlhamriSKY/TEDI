// Thin barrel for the shared settings STATE layer.
//
// Note the deliberate two-folder split (a common source of wrong-file edits):
//   - src/modules/settings/  (this folder) = the store + preferences read by the
//     MAIN window and the AI runtime. Persisted via tauri-plugin-store.
//   - src/settings/          = the Settings UI, which is a SEPARATE Tauri webview
//     (entry src/settings/main.tsx, opened by `open_settings_window`).
//
// UI-internal helpers (customTheme, brandColor, appOpacity, themePresets) are
// imported by deep path where the Settings UI needs them, so they are not
// re-exported here to keep this barrel thin.
export * from "./store";
export * from "./preferences";
export { openSettingsWindow, type SettingsTab } from "./openSettingsWindow";
