//! Extension manifest schema (Rust side).
//!
//! Mirrors the zod schema on the frontend. Kept intentionally small for v1:
//! id, name, version, optional metadata + permissions + contribution
//! declarations. The frontend re-validates after `ext_read_manifest`
//! because it has richer typing for `contributes.*`.

use serde::{Deserialize, Serialize};

/// kebab-case / dotted id, scoped by publisher. Examples:
///   - `acme.my-integration`
///   - `ilhamrisky.dracula-theme`
///
/// Constraints enforced here: ASCII, lower, dot/dash/underscore, no
/// leading dot, length 3-64. Validation runs on every install so a
/// hostile zip can't escape `<root>/<id>/` via something like `../evil`.
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.len() < 3 || id.len() > 64 {
        return Err("manifest.id must be 3-64 chars".into());
    }
    if id.starts_with('.') || id.ends_with('.') {
        return Err("manifest.id must not start or end with a dot".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err(
            "manifest.id may only contain lowercase letters, digits, dot, dash, underscore"
                .into(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    /// Path to the JS entry point, relative to the extension root. Optional
    /// because some packs (themes, snippets) are pure-declarative.
    #[serde(default)]
    pub main: Option<String>,
    /// Glob-style permission strings - validated at runtime by the host API.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Free-form JSON; the frontend zod schema validates the inner shape.
    #[serde(default)]
    pub contributes: serde_json::Value,
    #[serde(default)]
    pub engines: Option<Engines>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engines {
    /// Semver requirement, e.g. `">=0.2.6"`. Optional - missing means "any".
    #[serde(default)]
    pub tedi: Option<String>,
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let m: Manifest =
            serde_json::from_str(text).map_err(|e| format!("manifest parse error: {e}"))?;
        validate_id(&m.id)?;
        if m.name.trim().is_empty() {
            return Err("manifest.name is required".into());
        }
        if m.version.trim().is_empty() {
            return Err("manifest.version is required".into());
        }
        Ok(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_id() {
        assert!(validate_id("../evil").is_err());
        assert!(validate_id(".foo").is_err());
        assert!(validate_id("Foo").is_err());
        assert!(validate_id("ok-id").is_ok());
        assert!(validate_id("acme.my-integration").is_ok());
    }
}
