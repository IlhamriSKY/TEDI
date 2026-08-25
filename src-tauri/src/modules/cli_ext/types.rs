//! Data shapes shared across the `tedi ext` CLI: the registry document
//! deserialized from the public registry endpoint and the joined
//! manifest + state row used by the installed-list views.

#[derive(serde::Deserialize)]
pub(super) struct RegistryDoc {
    #[serde(default)]
    pub(super) official: Vec<RegistryEntry>,
    #[serde(default)]
    pub(super) unofficial: Vec<RegistryEntry>,
}

#[derive(serde::Deserialize, Clone)]
pub(super) struct RegistryEntry {
    pub(super) id: String,
    #[serde(default)]
    pub(super) publisher: String,
    #[serde(default)]
    pub(super) description: String,
    pub(super) repository: String,
    #[serde(default)]
    pub(super) license: String,
}

/// One row of the Installed list, joining manifest + state. Sorted by name
/// at construction time so picker / printer share order.
pub(super) struct InstalledRow {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) version: String,
    pub(super) enabled: bool,
    pub(super) source: String,
    pub(super) latest: Option<String>,
}
