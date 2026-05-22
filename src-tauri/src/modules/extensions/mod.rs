//! Extension subsystem.
//!
//! Extensions live at `app_data_dir/extensions/<id>/` and are loaded by the
//! frontend via `convertFileSrc` + dynamic `import()`. Rust owns install
//! (zip extract, URL download, GitHub release fetch), manifest parsing, and
//! a small persisted state file (`enabled`, install source, install date).
//! The frontend owns activation, the host API (`window.tedi.*`), and the
//! contribution registries.
//!
//! Security: `zip` extraction rejects entries whose `enclosed_name()` escapes
//! the destination root. Asset reads canonicalize and re-anchor against the
//! extension root. Install size capped at `MAX_INSTALL_BYTES`. HTTP
//! downloads only follow `https://`.

pub mod commands;
pub mod install;
pub mod manifest;
pub mod state;

pub use commands::ExtensionsState;
