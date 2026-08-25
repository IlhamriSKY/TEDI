//! Preview module: an in-app web preview that can render any public site.
//!
//! Four cooperating pieces, split into submodules:
//!
//! * [`proxy`] - the `tedi-frame://localhost/?u=<base64url>` async URI-scheme
//!   protocol. Strips X-Frame-Options / CSP frame-ancestors and rewrites
//!   subresource references so an iframe can embed sites that would otherwise
//!   refuse to load. [`register`] wires it into the Tauri builder; [`SCHEME`]
//!   is the scheme name.
//! * [`embed`] - the `preview_embed_*` Tauri commands that drive a real native
//!   child webview docked over the tab content (a true browser, bypassing the
//!   iframe proxy), plus `preview_resolve_favicon` for live favicon lookup.
//! * [`browser_ext`] - install / list / toggle unpacked Chrome extensions the
//!   embedded pane loads (an ad blocker, for instance). WebView2 only.
//! * [`util`] - shared HTML / JS string-escaping helpers.

mod browser_ext;
mod embed;
mod proxy;
mod util;

// Glob re-exports so every `modules::preview::*` path still resolves, including
// the hidden `__cmd__*` / `__tauri_command_name_*` items the `#[tauri::command]`
// macro emits next to each command - `tauri::generate_handler!` references those
// as `preview::__cmd__<name>`, and a glob (unlike a named re-export) carries them
// across the module boundary.
pub use browser_ext::*;
pub use embed::*;
pub use proxy::*;
