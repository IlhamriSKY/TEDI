//! Registry fetch + display, the on-disk installed-extension scan, and the
//! cross-reference lookups that join registry entries to local installs.

use std::fs;

use crate::modules::cli_paint::{
    paint_dim, paint_installed, paint_official, paint_unofficial, paint_update_hint,
};
use crate::modules::extensions::commands::read_installed_manifest;
use crate::modules::extensions::github;
use crate::modules::extensions::state::load as load_state;

use super::helpers::extensions_root;
use super::types::{InstalledRow, RegistryDoc, RegistryEntry};

/// Public extension registry. Shape:
/// `{ official: [{id,name,publisher,description,repository,icon,license}], unofficial: [...] }`.
pub(super) const REGISTRY_URL: &str = "https://tedi.ilhamriski.com/extensions/";

pub(super) fn fetch_registry(runtime: &tokio::runtime::Runtime) -> Result<RegistryDoc, String> {
    let json = runtime.block_on(github::http_get_text(REGISTRY_URL))?;
    serde_json::from_str(&json).map_err(|e| format!("parse registry JSON: {e}"))
}

/// Walk `<extensions_root>/` + `state.json` and build a sorted-by-name list
/// of installed extensions. Skips staging/trash directories and entries
/// whose manifest fails to parse.
pub(super) fn load_installed_rows() -> Result<Vec<InstalledRow>, String> {
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let state = load_state(&state_path);
    let mut rows: Vec<InstalledRow> = Vec::new();
    let dir_iter = match fs::read_dir(&root) {
        Ok(it) => it,
        Err(e) => return Err(format!("read {}: {e}", root.display())),
    };
    for entry in dir_iter {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let Some(manifest) = read_installed_manifest(&path) else {
            continue;
        };
        let st = state.entries.get(&manifest.id);
        rows.push(InstalledRow {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            enabled: st.map(|s| s.enabled).unwrap_or(true),
            source: st
                .map(|s| s.source.clone())
                .unwrap_or_else(|| "local".into()),
            latest: st.and_then(|s| s.latest_version.clone()),
        });
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rows)
}

/// Build a "not in registry" error listing the ids the user could have meant.
pub(super) fn registry_not_found_msg(reference: &str, doc: &RegistryDoc) -> String {
    let ids: Vec<&str> = doc
        .official
        .iter()
        .chain(doc.unofficial.iter())
        .map(|e| e.id.as_str())
        .collect();
    if ids.is_empty() {
        format!(
            "`{reference}` is not a file or owner/repo, and the registry at \
             {REGISTRY_URL} is empty"
        )
    } else {
        format!(
            "`{reference}` is not a file or owner/repo, and not in the registry.\n\
             Available ids: {}\n\
             Registry: {REGISTRY_URL}",
            ids.join(", ")
        )
    }
}

pub(super) fn print_registry_groups(
    doc: &RegistryDoc,
    rows: &[InstalledRow],
    by_id: &std::collections::HashMap<String, usize>,
    by_repo: &std::collections::HashMap<String, usize>,
) {
    if !doc.official.is_empty() {
        println!("{}", paint_official("OFFICIAL"));
        for e in &doc.official {
            print_registry_row(e, find_installed_for(e, rows, by_id, by_repo));
        }
    }
    if !doc.unofficial.is_empty() {
        if !doc.official.is_empty() {
            println!();
        }
        println!("{}", paint_unofficial("UNOFFICIAL"));
        for e in &doc.unofficial {
            print_registry_row(e, find_installed_for(e, rows, by_id, by_repo));
        }
    }
}

pub(super) fn print_registry_row(e: &RegistryEntry, installed: Option<&InstalledRow>) {
    let license = if e.license.is_empty() {
        "-"
    } else {
        e.license.as_str()
    };
    let status = installed_status(installed);
    println!(
        "  {:<28}  {} {:<18}  {}{status}",
        e.id,
        paint_dim("by"),
        e.publisher,
        paint_dim(license),
    );
    if !e.description.is_empty() {
        println!("    {}", paint_dim(&e.description));
    }
}

pub(super) fn registry_label(
    e: &RegistryEntry,
    group: &str,
    installed: Option<&InstalledRow>,
) -> String {
    let tag = if group == "official" {
        paint_official(&format!("[{group}]"))
    } else {
        paint_unofficial(&format!("[{group}]"))
    };
    let status = installed_status(installed);
    if e.description.is_empty() {
        format!("{tag} {}{status}", e.id)
    } else {
        format!(
            "{tag} {} {}{status}",
            e.id,
            paint_dim(&format!("- {}", e.description))
        )
    }
}

/// Render the inline "installed / update available" suffix for registry rows.
/// Returns an empty string when the entry is not installed locally - keeps
/// the bare-registry layout identical for fresh systems.
pub(super) fn installed_status(row: Option<&InstalledRow>) -> String {
    match row {
        Some(r) => match &r.latest {
            Some(latest) if latest != &r.version => format!(
                "  {}",
                paint_update_hint(&format!("[update v{} -> v{}]", r.version, latest))
            ),
            _ => format!(
                "  {}",
                paint_installed(&format!("[installed v{}]", r.version))
            ),
        },
        None => String::new(),
    }
}

/// Build the installed-row vector once plus two indices: by manifest id (the
/// primary match) and by lower-cased `github:<owner/repo>` source (a fallback
/// for registries whose id drifted from the published manifest id).
pub(super) fn build_installed_lookups() -> (
    Vec<InstalledRow>,
    std::collections::HashMap<String, usize>,
    std::collections::HashMap<String, usize>,
) {
    let rows = load_installed_rows().unwrap_or_default();
    let mut by_id: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut by_repo: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        by_id.insert(r.id.clone(), i);
        if let Some(s) = r.source.strip_prefix("github:") {
            by_repo.insert(s.to_ascii_lowercase(), i);
        }
    }
    (rows, by_id, by_repo)
}

pub(super) fn find_installed_for<'a>(
    e: &RegistryEntry,
    rows: &'a [InstalledRow],
    by_id: &std::collections::HashMap<String, usize>,
    by_repo: &std::collections::HashMap<String, usize>,
) -> Option<&'a InstalledRow> {
    if let Some(&i) = by_id.get(&e.id) {
        return Some(&rows[i]);
    }
    let normalized = github::normalize_owner_repo(&e.repository).ok()?;
    by_repo
        .get(&normalized.to_ascii_lowercase())
        .map(|&i| &rows[i])
}
