//! Names of Tauri events the Rust process EMITS to the webview.
//!
//! Mirror of the `IPC_EVENTS` constants in `src/lib/ipc.ts`. A typo on either
//! side just makes the listener never fire (silent), so both sides reference a
//! single named constant instead of a bare string literal.

/// Rust -> Settings webview: focus a settings tab (payload: tab id string).
pub const SETTINGS_TAB: &str = "tedi:settings-tab";

/// Rust -> main window: open a path passed to the `tedi` CLI (single-instance forward).
pub const OPEN_CLI_TARGET: &str = "tedi:open-cli-target";

/// Rust -> main window: the `tedi --update` shim asks the UI to start updating.
pub const TRIGGER_UPDATE: &str = "tedi:trigger-update";

/// Rust -> main window: run a command registry id passed to `tedi cmd <id>`
/// (single-instance forward). Lets external tooling drive the running window
/// without the `TEDI_DEBUG_PORT` DevTools channel, which cannot be turned on
/// after launch (WebView2 fixes its browser arguments at environment creation).
pub const RUN_COMMAND: &str = "tedi:run-command";
