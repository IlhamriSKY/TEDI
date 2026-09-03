//! The `tedi-frame://` proxy scheme.
//!
//! * [`proxy`] - the `tedi-frame://localhost/?u=<base64url>` async URI-scheme
//!   protocol. Strips X-Frame-Options / CSP frame-ancestors and rewrites
//!   subresource references so an iframe can embed sites that would otherwise
//!   refuse to load. [`register`] wires it into the Tauri builder; [`SCHEME`] is
//!   the scheme name. The extension marketplace card renders through it.
//! * [`util`] - shared HTML / JS string-escaping helpers.

mod proxy;
mod util;

pub use proxy::*;
