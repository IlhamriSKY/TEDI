//! Headless CLI for `tedi ext <subcmd>` and the `tedi --extension <subcmd>`
//! alias. Short-circuits out of `lib::run` before Tauri boots and runs
//! install/list/update/uninstall against the same `<app_data_dir>/extensions/`
//! directory and `state.json` the GUI uses.
//!
//! Two presentation modes:
//!   - **TUI (default on a TTY)**: ratatui dashboard with Installed /
//!     Registry / Updates tabs. Action subcommands open the dashboard with
//!     the relevant modal pre-filled. Lives in [`crate::modules::cli_ext_tui`].
//!   - **Plain (`--plain` flag or non-TTY)**: `println!`-based output and
//!     stdin prompts. Same shape as v0.2.x for scripts, pipes, and CI.
//!
//! Subcommands:
//!   tedi ext install <ref>       # path | owner/repo | github URL | registry id
//!   tedi ext list                # registry (TUI picker on TTY; table on pipe)
//!   tedi ext list --installed    # locally installed (alias: `tedi ext installed`)
//!   tedi ext update [<id>]       # one id or every github-sourced install
//!   tedi ext uninstall <id>
//!   tedi ext enable <id>
//!   tedi ext disable <id>
//!   tedi ext help
//!
//! Concurrency: `state.json` is also written by the running GUI. There is
//! no file lock; the later writer wins, matching the behaviour two GUI
//! windows already accept. The GUI shows the pre-CLI view until it reloads.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use crate::modules::cli;
use crate::modules::cli_ext_tui;
use crate::modules::extensions::commands as ext_cmd;
use crate::modules::extensions::install::{
    install_from_bytes_with_progress, InstallOutcome, InstallProgress, NoopProgress,
};
use crate::modules::extensions::manifest::{validate_id, Manifest};
use crate::modules::extensions::state::{load as load_state, now_ms, save as save_state};

/// Bundle id from `tauri.conf.json`. Tauri 2's `app_data_dir` returns
/// `<dirs::data_dir()>/<bundle_id>` on every desktop platform, so we can
/// reproduce the path without an `AppHandle`. Keep in sync with the
/// `identifier` field in `tauri.conf.json`.
const BUNDLE_ID: &str = "id.ilhamrisky.tedi";

/// Public extension registry. Shape:
/// `{ official: [{id,name,publisher,description,repository,icon,license}], unofficial: [...] }`.
pub(crate) const REGISTRY_URL: &str = "https://tedi.ilhamriski.com/extensions/";

#[derive(serde::Deserialize, Debug, Clone)]
pub(crate) struct RegistryDoc {
    #[serde(default)]
    pub official: Vec<RegistryEntry>,
    #[serde(default)]
    pub unofficial: Vec<RegistryEntry>,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub(crate) struct RegistryEntry {
    pub id: String,
    #[allow(dead_code)]
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    pub repository: String,
    #[serde(default)]
    pub license: String,
}

/// One row of the Installed list, joining manifest + state. Sorted by name
/// at construction time so TUI/CLI don't have to re-sort.
#[derive(Debug, Clone)]
pub(crate) struct InstalledRow {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub source: String,
    pub latest: Option<String>,
}

impl InstalledRow {
    pub fn has_update(&self) -> bool {
        match &self.latest {
            Some(v) => ext_cmd::compare_versions(&self.version, v) == std::cmp::Ordering::Less,
            None => false,
        }
    }
}

/// One row of the per-extension update check. `has_update` reflects the
/// strict-greater comparison; `message` carries non-applicable reasons
/// (e.g. local source) so callers don't have to re-derive them.
#[derive(Debug, Clone)]
pub(crate) struct UpdateRow {
    pub id: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    /// Echoed `state.source`. Empty when the entry vanished mid-check.
    pub source: String,
    /// Human-readable status. `None` when the row is a normal result.
    /// Used by the TUI/plain renderer to differentiate "non-github source",
    /// "up to date", "check failed: …", etc.
    pub message: Option<String>,
}

/// What the TUI should open when a subcommand is given. The dashboard opens
/// to the relevant tab; install/uninstall/enable/disable land in a confirm
/// modal pre-filled with the argument.
#[derive(Debug, Clone)]
pub(crate) enum InitialFocus {
    Dashboard,
    Installed,
    Registry,
    InstallPrompt { reference: String },
    Updates { filter: Option<String> },
    UninstallConfirm { id: String },
    SetEnabled { id: String, on: bool },
}

/// Scan argv for the `ext` subcommand or `--extension` flag, run it, then
/// `process::exit`. Returns without acting when neither form is present.
pub fn handle_extension_command_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    let Some(mut sub_args) = extract_subcommand(&args) else {
        return;
    };
    cli::attach_parent_console();

    let plain = extract_plain_flag(&mut sub_args);
    let interactive = is_interactive_tty();

    let result = if plain || !interactive {
        run_plain(&sub_args)
    } else {
        // TUI claims stdin/stdout for its alternate screen. The focus tells
        // it which tab/modal to open; plain dispatch arg parsing is reused
        // there for consistency.
        cli_ext_tui::run(focus_for_subcommand(&sub_args))
    };

    let code = match result {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "tedi ext: {e}");
            1
        }
    };
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(code);
}

fn is_interactive_tty() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Returns the args after the action keyword when argv selects the ext CLI.
/// Recognised forms: `tedi ext <action> ...` and `tedi --extension <action> ...`.
fn extract_subcommand(args: &[String]) -> Option<Vec<String>> {
    if args.len() < 2 {
        return None;
    }
    let rest = &args[1..];
    if rest[0] == "ext" {
        return Some(rest[1..].to_vec());
    }
    for (i, a) in rest.iter().enumerate() {
        if a == "--extension" {
            return Some(rest[i + 1..].to_vec());
        }
    }
    None
}

/// Strip a global `--plain` / `-p` flag from anywhere in `args`. Returns
/// true when it was present. Both forms are removed in place so the rest
/// of the dispatcher does not have to re-filter.
fn extract_plain_flag(args: &mut Vec<String>) -> bool {
    let mut hit = false;
    args.retain(|a| {
        let is_plain = a == "--plain" || a == "-p";
        if is_plain {
            hit = true;
        }
        !is_plain
    });
    hit
}

/// Map a parsed subcommand to the TUI's initial focus. Unknown / `help`
/// subcommands open the dashboard.
pub(crate) fn focus_for_subcommand(args: &[String]) -> InitialFocus {
    let Some((action, rest)) = args.split_first() else {
        return InitialFocus::Dashboard;
    };
    match action.as_str() {
        "list" if rest.iter().any(|a| a == "--installed") => InitialFocus::Installed,
        "list" => InitialFocus::Registry,
        "installed" => InitialFocus::Installed,
        "install" => match rest.first() {
            Some(r) => InitialFocus::InstallPrompt {
                reference: r.clone(),
            },
            None => InitialFocus::Registry,
        },
        "update" => InitialFocus::Updates {
            filter: rest.iter().find(|a| !a.starts_with("--")).cloned(),
        },
        "uninstall" => match rest.first() {
            Some(id) => InitialFocus::UninstallConfirm { id: id.clone() },
            None => InitialFocus::Installed,
        },
        "enable" => match rest.first() {
            Some(id) => InitialFocus::SetEnabled {
                id: id.clone(),
                on: true,
            },
            None => InitialFocus::Installed,
        },
        "disable" => match rest.first() {
            Some(id) => InitialFocus::SetEnabled {
                id: id.clone(),
                on: false,
            },
            None => InitialFocus::Installed,
        },
        _ => InitialFocus::Dashboard,
    }
}

fn run_plain(args: &[String]) -> Result<(), String> {
    let (action, rest) = match args.split_first() {
        Some((a, r)) => (a.as_str(), r),
        None => {
            print_help();
            return Ok(());
        }
    };
    match action {
        "install" => cmd_install(rest),
        "list" => cmd_list(rest),
        "installed" => cmd_list_installed(),
        "update" => cmd_update(rest),
        "uninstall" => cmd_uninstall(rest),
        "enable" => cmd_set_enabled(rest, true),
        "disable" => cmd_set_enabled(rest, false),
        "help" | "-h" | "--help" => {
            print_help();
            Ok(())
        }
        other => Err(format!(
            "unknown subcommand: `{other}`. Try `tedi ext help`."
        )),
    }
}

// ---- plain-mode subcommands -------------------------------------------

fn cmd_install(args: &[String]) -> Result<(), String> {
    let reference = args.first().ok_or_else(|| {
        "missing argument: tedi ext install <path|owner/repo|registry-id>".to_string()
    })?;
    let runtime = build_runtime()?;
    let outcome = install_reference_with_progress(reference, &runtime, &NoopProgress)?;
    println!(
        "Installed {} v{}",
        outcome.manifest.id, outcome.manifest.version
    );
    Ok(())
}

fn cmd_list(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--installed") {
        return cmd_list_installed();
    }
    let runtime = build_runtime()?;
    let doc = fetch_registry(&runtime)?;
    if doc.official.is_empty() && doc.unofficial.is_empty() {
        println!("(registry empty)");
        return Ok(());
    }
    print_registry_groups(&doc);
    println!();
    println!("Install: tedi ext install <id>");
    Ok(())
}

fn cmd_list_installed() -> Result<(), String> {
    let rows = load_installed_rows()?;
    if rows.is_empty() {
        println!("No extensions installed.");
        return Ok(());
    }
    println!("INSTALLED EXTENSIONS ({})", rows.len());
    for r in &rows {
        let badge = if r.enabled { "[on] " } else { "[off]" };
        let update_hint = match &r.latest {
            Some(v) if v != &r.version => format!("  -> v{v} available"),
            _ => String::new(),
        };
        println!(
            "  {badge}  {} (id: {})  v{}{update_hint}",
            r.name, r.id, r.version
        );
        println!("         source: {}", r.source);
    }
    Ok(())
}

fn cmd_update(args: &[String]) -> Result<(), String> {
    let id_filter = args.iter().find(|a| !a.starts_with("--")).cloned();
    let runtime = build_runtime()?;
    let rows = check_updates_only(id_filter.as_deref(), &runtime)?;
    if rows.is_empty() {
        return match id_filter {
            Some(f) => Err(format!("extension not installed: {f}")),
            None => {
                println!("No extensions installed.");
                Ok(())
            }
        };
    }

    let mut to_apply: Vec<(String, String)> = Vec::new();
    for r in &rows {
        match (&r.message, r.has_update, &r.latest_version) {
            (Some(m), _, _) => println!("[{}] {m}", r.id),
            (None, true, Some(latest)) => {
                println!(
                    "[{}] v{} -> v{latest} (update available)",
                    r.id, r.current_version
                );
                to_apply.push((r.id.clone(), r.source.clone()));
            }
            _ => println!("[{}] v{} (up to date)", r.id, r.current_version),
        }
    }

    if to_apply.is_empty() {
        println!();
        println!("Nothing to update.");
        return Ok(());
    }

    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        println!();
        println!(
            "Non-interactive shell; {} update(s) available but not applied.",
            to_apply.len()
        );
        println!("Run on a TTY, or re-run with explicit ids:");
        for (id, _) in &to_apply {
            println!("    tedi ext install {id}");
        }
        return Ok(());
    }

    println!();
    print!("Apply {} update(s)? (y/N): ", to_apply.len());
    let _ = std::io::stdout().flush();
    let mut buf = String::new();
    let n = std::io::stdin()
        .read_line(&mut buf)
        .map_err(|e| format!("read stdin: {e}"))?;
    if n == 0 || !buf.trim().eq_ignore_ascii_case("y") {
        println!("Skipped.");
        return Ok(());
    }

    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let mut failed = 0usize;
    for (id, source) in to_apply {
        println!();
        println!("Updating {id} ({source})...");
        let Some(owner_repo) = source.strip_prefix("github:") else {
            println!("[{id}] skipped (non-github source)");
            continue;
        };
        if let Err(e) = install_github(&runtime, owner_repo, &root, &state_path, &NoopProgress) {
            failed += 1;
            eprintln!("[{id}] update failed: {e}");
        }
    }
    if failed > 0 {
        return Err(format!("{failed} update(s) failed (see above)"));
    }
    Ok(())
}

fn cmd_uninstall(args: &[String]) -> Result<(), String> {
    let id = args
        .first()
        .ok_or_else(|| "missing argument: tedi ext uninstall <id>".to_string())?;
    do_uninstall(id)?;
    println!("Uninstalled {id}.");
    Ok(())
}

fn cmd_set_enabled(args: &[String], enabled: bool) -> Result<(), String> {
    let action_name = if enabled { "enable" } else { "disable" };
    let id = args
        .first()
        .ok_or_else(|| format!("missing argument: tedi ext {action_name} <id>"))?;
    do_set_enabled(id, enabled)?;
    println!("{} {id}.", if enabled { "Enabled" } else { "Disabled" });
    Ok(())
}

// ---- pure data fns (shared by plain mode + TUI) -----------------------

/// Install an extension by reference (path / owner-repo / registry id),
/// streaming progress through `progress`. This is the single seam both
/// the plain CLI and the TUI go through.
pub(crate) fn install_reference_with_progress(
    reference: &str,
    runtime: &tokio::runtime::Runtime,
    progress: &dyn InstallProgress,
) -> Result<InstallOutcome, String> {
    let root = extensions_root()?;
    let state_path = root.join("state.json");

    // 1) Local file. No extension check; `install_from_bytes` validates
    //    the zip magic bytes, so `tedi ext install ./build/my-ext` works
    //    on any real zip.
    let p = std::path::Path::new(reference);
    if p.is_file() {
        let bytes = fs::read(p).map_err(|e| format!("read {}: {e}", p.display()))?;
        return install_from_bytes_with_progress(
            &root,
            &state_path,
            &bytes,
            &format!("local:{}", p.display()),
            progress,
        );
    }

    if looks_like_path(reference) {
        return Err(format!(
            "`{reference}` looks like a file path but no file was found at that location"
        ));
    }

    if looks_like_github_ref(reference) {
        let normalized = ext_cmd::normalize_owner_repo(reference)?;
        return install_github(runtime, &normalized, &root, &state_path, progress);
    }

    // Bare registry id: fetch index, find entry, install its repository.
    let doc = fetch_registry(runtime)?;
    let entry = doc
        .official
        .iter()
        .chain(doc.unofficial.iter())
        .find(|e| e.id == *reference)
        .ok_or_else(|| registry_not_found_msg(reference, &doc))?;
    let normalized = ext_cmd::normalize_owner_repo(&entry.repository)?;
    install_github(runtime, &normalized, &root, &state_path, progress)
}

/// Walk `<extensions_root>/` + `state.json` and build a sorted-by-name list
/// of installed extensions. Skips staging/trash directories and entries
/// whose manifest fails to parse.
pub(crate) fn load_installed_rows() -> Result<Vec<InstalledRow>, String> {
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
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with(".staging-") || name.starts_with(".trash-") {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let text = match fs::read_to_string(&manifest_path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let Ok(manifest) = Manifest::parse(&text) else {
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

/// Check upstream for newer releases. Persists `latest_version` +
/// `last_checked_at_ms` for every row inspected. Does NOT apply updates —
/// returns one [`UpdateRow`] per inspected extension so the caller can
/// render and prompt independently. Pure data: no print, no read_line.
pub(crate) fn check_updates_only(
    filter: Option<&str>,
    runtime: &tokio::runtime::Runtime,
) -> Result<Vec<UpdateRow>, String> {
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let initial = load_state(&state_path);

    let targets: Vec<(String, String, String)> = initial
        .entries
        .iter()
        .filter(|(id, _)| filter.map(|f| id.as_str() == f).unwrap_or(true))
        .map(|(id, e)| (id.clone(), e.version.clone(), e.source.clone()))
        .collect();

    let mut state_w = initial;
    let now = now_ms();
    let mut rows: Vec<UpdateRow> = Vec::new();
    for (id, current_version, source) in targets {
        let Some(owner_repo) = source.strip_prefix("github:").map(|s| s.to_string()) else {
            if let Some(e) = state_w.entries.get_mut(&id) {
                e.last_checked_at_ms = Some(now);
            }
            let msg = format!("non-github source ({source}); skip");
            rows.push(UpdateRow {
                id,
                current_version,
                latest_version: None,
                has_update: false,
                source,
                message: Some(msg),
            });
            continue;
        };
        let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
        let json = match runtime.block_on(ext_cmd::http_get_text(&api)) {
            Ok(j) => j,
            Err(e) => {
                let msg = format!("check failed: {e}");
                rows.push(UpdateRow {
                    id,
                    current_version,
                    latest_version: None,
                    has_update: false,
                    source,
                    message: Some(msg),
                });
                continue;
            }
        };
        let Some(tag) = ext_cmd::pick_release_tag(&json) else {
            rows.push(UpdateRow {
                id,
                current_version,
                latest_version: None,
                has_update: false,
                source,
                message: Some("no tag_name in release JSON".into()),
            });
            continue;
        };
        let latest = ext_cmd::strip_v_prefix(&tag);
        let has_update =
            ext_cmd::compare_versions(&current_version, &latest) == std::cmp::Ordering::Less;
        if let Some(e) = state_w.entries.get_mut(&id) {
            e.latest_version = Some(latest.clone());
            e.last_checked_at_ms = Some(now);
        }
        rows.push(UpdateRow {
            id,
            current_version,
            latest_version: Some(latest),
            has_update,
            source,
            message: None,
        });
    }
    save_state(&state_path, &state_w)?;
    Ok(rows)
}

pub(crate) fn do_uninstall(id: &str) -> Result<(), String> {
    validate_id(id)?;
    let root = extensions_root()?;
    let dir = root.join(id);
    let state_path = root.join("state.json");
    let mut st = load_state(&state_path);
    let had_dir = dir.exists();
    let had_state = st.entries.contains_key(id);
    if !had_dir && !had_state {
        return Err(format!("extension not installed: {id}"));
    }
    if had_dir {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {id}: {e}"))?;
    }
    st.entries.remove(id);
    save_state(&state_path, &st)?;
    Ok(())
}

pub(crate) fn do_set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    validate_id(id)?;
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let mut st = load_state(&state_path);
    let entry = st
        .entries
        .get_mut(id)
        .ok_or_else(|| format!("extension not installed: {id}"))?;
    entry.enabled = enabled;
    save_state(&state_path, &st)?;
    Ok(())
}

/// Build a "not in registry" error listing the ids the user could have meant.
/// Empty registry falls back to a plain "registry empty" hint.
fn registry_not_found_msg(reference: &str, doc: &RegistryDoc) -> String {
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

fn print_registry_groups(doc: &RegistryDoc) {
    if !doc.official.is_empty() {
        println!("OFFICIAL");
        for e in &doc.official {
            print_registry_row(e);
        }
    }
    if !doc.unofficial.is_empty() {
        if !doc.official.is_empty() {
            println!();
        }
        println!("UNOFFICIAL");
        for e in &doc.unofficial {
            print_registry_row(e);
        }
    }
}

fn print_registry_row(e: &RegistryEntry) {
    let license = if e.license.is_empty() {
        "-"
    } else {
        e.license.as_str()
    };
    println!("  {:<28}  by {:<18}  {}", e.id, e.publisher, license);
    if !e.description.is_empty() {
        println!("    {}", e.description);
    }
}

// ---- helpers ------------------------------------------------------------

/// Returns `<dirs::data_dir()>/<BUNDLE_ID>/extensions`, creating it if
/// missing. Matches `app.path().app_data_dir().push("extensions")`.
pub(crate) fn extensions_root() -> Result<PathBuf, String> {
    let mut p = dirs::data_dir().ok_or_else(|| "could not determine data_dir".to_string())?;
    p.push(BUNDLE_ID);
    p.push("extensions");
    fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))?;
    Ok(p)
}

pub(crate) fn build_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))
}

pub(crate) fn fetch_registry(runtime: &tokio::runtime::Runtime) -> Result<RegistryDoc, String> {
    let json = runtime.block_on(ext_cmd::http_get_text(REGISTRY_URL))?;
    serde_json::from_str(&json).map_err(|e| format!("parse registry JSON: {e}"))
}

/// Download `owner_repo`'s latest release zip and install it, reporting
/// progress through `progress`. Used by plain CLI (NoopProgress) and TUI.
pub(crate) fn install_github(
    runtime: &tokio::runtime::Runtime,
    owner_repo: &str,
    root: &std::path::Path,
    state_path: &std::path::Path,
    progress: &dyn InstallProgress,
) -> Result<InstallOutcome, String> {
    use crate::modules::extensions::install::InstallPhase;
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    progress.phase(InstallPhase::Downloading {
        bytes_done: 0,
        bytes_total: None,
    });
    let json = runtime.block_on(ext_cmd::http_get_text(&api))?;
    let zip_url = ext_cmd::pick_release_zip(&json)
        .ok_or_else(|| format!("no .zip asset in latest release of {owner_repo}"))?;
    let bytes = runtime.block_on(ext_cmd::http_get_bytes_with_progress(
        &zip_url,
        |done, total| {
            progress.phase(InstallPhase::Downloading {
                bytes_done: done,
                bytes_total: total,
            });
        },
    ))?;
    let outcome = install_from_bytes_with_progress(
        root,
        state_path,
        &bytes,
        &format!("github:{owner_repo}"),
        progress,
    )?;
    Ok(outcome)
}

/// True for inputs with an unambiguous filesystem-path shape: explicit
/// dot-prefix, leading `/`, leading `~/`, Windows drive letter, or any
/// backslash. The github-ref check already covers single-slash `owner/repo`,
/// so this only catches inputs the user clearly meant as paths. Bare
/// filenames without a separator are not matched because they collide with
/// registry ids.
pub(crate) fn looks_like_path(s: &str) -> bool {
    if s.contains('\\') {
        return true;
    }
    if s.starts_with("./") || s.starts_with("../") || s.starts_with("~/") || s.starts_with('/') {
        return true;
    }
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    false
}

pub(crate) fn looks_like_github_ref(s: &str) -> bool {
    if s.contains('\\') {
        return false;
    }
    if s.contains("://") || s.starts_with("github.com/") {
        return true;
    }
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    if parts[0].starts_with('.') || parts[1].starts_with('.') {
        return false;
    }
    let id_safe = |p: &str| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    id_safe(parts[0]) && id_safe(parts[1])
}

#[allow(dead_code)]
fn print_help() {
    print!("{}", HELP);
}

#[allow(dead_code)]
pub(crate) const HELP: &str = concat!(
    "tedi ext - manage TEDI extensions\n",
    "\n",
    "USAGE:\n",
    "    tedi ext [SUBCOMMAND] [ARGS] [--plain]\n",
    "    tedi --extension [SUBCOMMAND] [ARGS] [--plain]    (alias)\n",
    "\n",
    "On a TTY the dashboard TUI opens automatically. Pass `--plain` (or\n",
    "redirect stdout) to force the legacy text output for scripts and CI.\n",
    "\n",
    "SUBCOMMANDS:\n",
    "    install <REF>           Install an extension. <REF> can be:\n",
    "                              - path to a local .zip file\n",
    "                              - owner/repo (e.g. IlhamriSKY/TEDI.discord-rich-presence)\n",
    "                              - full GitHub URL\n",
    "                              - registry id (e.g. discord-rich-presence)\n",
    "    list                    Browse the public registry; pick one to install (TUI on TTY).\n",
    "    list --installed        Show extensions currently installed locally.\n",
    "    installed               Alias for `list --installed`.\n",
    "    update [<ID>]           Check upstream for newer releases. Without <ID>,\n",
    "                            checks every github-sourced extension. Prompts before applying.\n",
    "    uninstall <ID>          Remove an installed extension.\n",
    "    enable <ID>             Enable an installed extension.\n",
    "    disable <ID>            Disable an installed extension.\n",
    "    help                    Print this help.\n",
    "\n",
    "FLAGS:\n",
    "    --plain, -p             Force text output (no TUI), even on a TTY.\n",
    "\n",
    "Registry: https://tedi.ilhamriski.com/extensions/\n",
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_ext_subcommand_form() {
        let args = vec![
            "tedi.exe".into(),
            "ext".into(),
            "install".into(),
            "owner/repo".into(),
        ];
        assert_eq!(
            extract_subcommand(&args),
            Some(vec!["install".into(), "owner/repo".into()])
        );
    }

    #[test]
    fn extract_extension_flag_alias() {
        let args = vec!["tedi".into(), "--extension".into(), "list".into()];
        assert_eq!(extract_subcommand(&args), Some(vec!["list".into()]));
    }

    #[test]
    fn extract_ignores_unrelated_invocations() {
        let args = vec!["tedi".into(), ".".into()];
        assert!(extract_subcommand(&args).is_none());
        let args = vec!["tedi".into(), "--version".into()];
        assert!(extract_subcommand(&args).is_none());
    }

    #[test]
    fn plain_flag_strips_anywhere() {
        let mut args = vec!["install".into(), "--plain".into(), "owner/repo".into()];
        assert!(extract_plain_flag(&mut args));
        assert_eq!(args, vec!["install".to_string(), "owner/repo".to_string()]);

        let mut args = vec!["list".into(), "-p".into()];
        assert!(extract_plain_flag(&mut args));
        assert_eq!(args, vec!["list".to_string()]);

        let mut args = vec!["update".into()];
        assert!(!extract_plain_flag(&mut args));
        assert_eq!(args, vec!["update".to_string()]);
    }

    #[test]
    fn focus_dispatch_per_subcommand() {
        let s = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(matches!(
            focus_for_subcommand(&s(&[])),
            InitialFocus::Dashboard
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["installed"])),
            InitialFocus::Installed
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["list", "--installed"])),
            InitialFocus::Installed
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["list"])),
            InitialFocus::Registry
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["install", "owner/repo"])),
            InitialFocus::InstallPrompt { .. }
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["update"])),
            InitialFocus::Updates { .. }
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["uninstall", "foo"])),
            InitialFocus::UninstallConfirm { .. }
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["enable", "foo"])),
            InitialFocus::SetEnabled { on: true, .. }
        ));
        assert!(matches!(
            focus_for_subcommand(&s(&["disable", "foo"])),
            InitialFocus::SetEnabled { on: false, .. }
        ));
    }

    #[test]
    fn github_ref_detection() {
        assert!(looks_like_github_ref("IlhamriSKY/repo"));
        assert!(looks_like_github_ref("https://github.com/owner/repo"));
        assert!(looks_like_github_ref("github.com/owner/repo"));
        assert!(!looks_like_github_ref("discord-rich-presence"));
        assert!(!looks_like_github_ref("./my-ext.zip"));
        assert!(!looks_like_github_ref("/abs/path/file.zip"));
        assert!(!looks_like_github_ref("a/b/c"));
    }

    #[test]
    fn path_shape_detection() {
        assert!(looks_like_path("./my-ext.zip"));
        assert!(looks_like_path("../parent/ext.zip"));
        assert!(looks_like_path("/abs/path/file.zip"));
        assert!(looks_like_path("~/Downloads/my-ext.zip"));
        assert!(looks_like_path(r"C:\Users\me\ext.zip"));
        assert!(looks_like_path("C:/Users/me/ext.zip"));
        assert!(looks_like_path("D:"));
        assert!(!looks_like_path("owner/repo"));
        assert!(!looks_like_path("https://github.com/owner/repo"));
        assert!(!looks_like_path("github.com/owner/repo"));
        assert!(!looks_like_path("discord-rich-presence"));
    }

    #[test]
    fn registry_message_lists_ids() {
        let doc = RegistryDoc {
            official: vec![RegistryEntry {
                id: "discord-rich-presence".into(),
                name: "Discord RP".into(),
                publisher: "IlhamriSKY".into(),
                description: String::new(),
                repository: "https://github.com/IlhamriSKY/TEDI.discord-rich-presence".into(),
                license: "Apache-2.0".into(),
            }],
            unofficial: vec![],
        };
        let msg = registry_not_found_msg("foo", &doc);
        assert!(msg.contains("foo"));
        assert!(msg.contains("discord-rich-presence"));
    }

    #[test]
    fn registry_message_empty() {
        let doc = RegistryDoc {
            official: vec![],
            unofficial: vec![],
        };
        let msg = registry_not_found_msg("foo", &doc);
        assert!(msg.contains("registry"));
        assert!(msg.contains("empty"));
    }

    #[test]
    fn noop_progress_is_no_op() {
        // Compile-time check: NoopProgress must implement InstallProgress
        // and accept all phase variants without panicking.
        use crate::modules::extensions::install::{InstallPhase, NoopProgress};
        let n = NoopProgress;
        n.phase(InstallPhase::Downloading {
            bytes_done: 0,
            bytes_total: None,
        });
        n.phase(InstallPhase::Verifying);
        n.phase(InstallPhase::Extracting);
        n.phase(InstallPhase::Finalizing);
        n.phase(InstallPhase::Done);
        n.file(0, 1, "x");
    }

    #[test]
    #[ignore]
    fn live_registry_fetch_parses() {
        let runtime = build_runtime().expect("tokio runtime");
        let doc = fetch_registry(&runtime).expect("registry fetch failed");
        let entries: Vec<&RegistryEntry> =
            doc.official.iter().chain(doc.unofficial.iter()).collect();
        assert!(!entries.is_empty(), "registry returned no extensions");
        for e in &entries {
            assert!(!e.id.is_empty(), "entry has empty id");
            assert!(
                !e.repository.is_empty(),
                "entry {} has empty repository",
                e.id
            );
            ext_cmd::normalize_owner_repo(&e.repository).unwrap_or_else(|err| {
                panic!(
                    "registry entry {}: repository `{}` failed to normalize as owner/repo: {err}",
                    e.id, e.repository
                )
            });
            eprintln!("ok: {} ({})", e.id, e.repository);
        }
    }
}
