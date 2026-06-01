//! Headless CLI for `tedi ext <subcmd>` and the `tedi --extension <subcmd>`
//! alias. Short-circuits out of `lib::run` before Tauri boots and runs
//! install/list/update/uninstall against the same `<app_data_dir>/extensions/`
//! directory and `state.json` the GUI uses.
//!
//! Interactive mode (on a TTY) uses `dialoguer::Select` for arrow-key
//! navigation. No alternate-screen TUI, no raw-mode contention with the
//! parent shell - output flows inline like a normal command.
//!
//! Subcommands:
//!   tedi ext                     # menu: pick an action
//!   tedi ext install <ref>       # ref = path | owner/repo | github URL | registry id
//!   tedi ext install             # arrow-pick from registry (TTY only)
//!   tedi ext list                # registry browser (interactive picker on a TTY)
//!   tedi ext list --installed    # locally installed (alias: `tedi ext installed`)
//!   tedi ext update [<id>]       # one id or every github-sourced install
//!   tedi ext uninstall [<id>]    # arrow-pick when id omitted
//!   tedi ext enable [<id>]
//!   tedi ext disable [<id>]
//!
//! Concurrency: `state.json` is also written by the running GUI. There is
//! no file lock; the later writer wins, matching the behaviour two GUI
//! windows already accept. The GUI shows the pre-CLI view until it reloads.

use std::fs;
use std::io::{IsTerminal, Write};
use std::path::PathBuf;

use dialoguer::theme::{ColorfulTheme, Theme};

use crate::modules::cli;
use crate::modules::cli_paint::{
    color_enabled, paint_bold, paint_brand, paint_dim, paint_err, paint_header, paint_id,
    paint_installed, paint_off, paint_official, paint_ok, paint_on, paint_unofficial,
    paint_update_hint,
};
use crate::modules::extensions::install::{
    install_from_bytes_with_progress, InstallOutcome, InstallPhase, InstallProgress, NoopProgress,
};
use crate::modules::extensions::manifest::{validate_id, Manifest};
use crate::modules::extensions::state::{load as load_state, now_ms, save as save_state};
use crate::modules::extensions::{github, version};

/// `ColorfulTheme` brings dialoguer's coloured prompt + active-item ">"
/// indicator. Wrapped in a small selector so non-TTY shells still get the
/// plain theme (no ANSI in pipes / CI).
fn picker_theme() -> Box<dyn Theme> {
    if color_enabled() {
        Box::new(ColorfulTheme::default())
    } else {
        Box::new(dialoguer::theme::SimpleTheme)
    }
}

/// Public extension registry. Shape:
/// `{ official: [{id,name,publisher,description,repository,icon,license}], unofficial: [...] }`.
const REGISTRY_URL: &str = "https://tedi.ilhamriski.com/extensions/";

#[derive(serde::Deserialize)]
struct RegistryDoc {
    #[serde(default)]
    official: Vec<RegistryEntry>,
    #[serde(default)]
    unofficial: Vec<RegistryEntry>,
}

#[derive(serde::Deserialize, Clone)]
struct RegistryEntry {
    id: String,
    #[allow(dead_code)]
    name: String,
    #[serde(default)]
    publisher: String,
    #[serde(default)]
    description: String,
    repository: String,
    #[serde(default)]
    license: String,
}

/// One row of the Installed list, joining manifest + state. Sorted by name
/// at construction time so picker / printer share order.
struct InstalledRow {
    id: String,
    name: String,
    version: String,
    enabled: bool,
    source: String,
    latest: Option<String>,
}

/// Scan argv for the `ext` subcommand or `--extension` flag, run it, then
/// `process::exit`. Returns without acting when neither form is present.
pub fn handle_extension_command_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    let Some(sub_args) = extract_subcommand(&args) else {
        return;
    };
    cli::attach_parent_console();
    let code = match run_subcommand(&sub_args) {
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

fn run_subcommand(args: &[String]) -> Result<(), String> {
    let (action, rest) = match args.split_first() {
        Some((a, r)) => (a.as_str(), r),
        None => return cmd_menu(),
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

// ---- subcommands --------------------------------------------------------

/// `tedi ext` with no subcommand: arrow-pick an action on a TTY, print help
/// on non-TTY (CI / pipes shouldn't get stuck on a picker with no input).
fn cmd_menu() -> Result<(), String> {
    if !interactive() {
        print_help();
        return Ok(());
    }
    let actions = [
        ("List installed extensions", "installed"),
        ("Browse registry & install", "list"),
        ("Install by reference", "install"),
        ("Check for updates", "update"),
        ("Enable an extension", "enable"),
        ("Disable an extension", "disable"),
        ("Uninstall an extension", "uninstall"),
        ("Quit", "quit"),
    ];
    let labels: Vec<&str> = actions.iter().map(|(l, _)| *l).collect();
    let theme = picker_theme();
    let chosen = dialoguer::Select::with_theme(theme.as_ref())
        .with_prompt("tedi ext")
        .items(&labels)
        .default(0)
        .interact_opt()
        .map_err(|e| format!("picker: {e}"))?;
    let Some(idx) = chosen else {
        return Ok(());
    };
    match actions[idx].1 {
        "installed" => cmd_list_installed(),
        "list" => cmd_list(&[]),
        "install" => cmd_install(&[]),
        "update" => cmd_update(&[]),
        "enable" => cmd_set_enabled(&[], true),
        "disable" => cmd_set_enabled(&[], false),
        "uninstall" => cmd_uninstall(&[]),
        _ => Ok(()),
    }
}

fn cmd_install(args: &[String]) -> Result<(), String> {
    let runtime = build_runtime()?;
    let root = extensions_root()?;
    let state_path = root.join("state.json");

    let reference = match args.first() {
        Some(r) => r.clone(),
        None => prompt_install_reference(&runtime)?,
    };

    let p = std::path::Path::new(&reference);
    if p.is_file() {
        let bytes = fs::read(p).map_err(|e| format!("read {}: {e}", p.display()))?;
        let outcome = install_with_progress(
            &root,
            &state_path,
            &bytes,
            &format!("local:{}", p.display()),
        )?;
        println!(
            "{} Installed {} {} {}",
            paint_ok("✓"),
            paint_id(&outcome.manifest.id),
            paint_dim(&format!("v{}", outcome.manifest.version)),
            paint_dim(&format!("(from local:{})", p.display())),
        );
        return Ok(());
    }

    if looks_like_path(&reference) {
        return Err(format!(
            "`{reference}` looks like a file path but no file was found at that location"
        ));
    }

    if looks_like_github_ref(&reference) {
        let normalized = github::normalize_owner_repo(&reference)?;
        return install_github(&runtime, &normalized, &root, &state_path);
    }

    let doc = fetch_registry(&runtime)?;
    let entry = doc
        .official
        .iter()
        .chain(doc.unofficial.iter())
        .find(|e| e.id == reference)
        .ok_or_else(|| registry_not_found_msg(&reference, &doc))?;
    let normalized = github::normalize_owner_repo(&entry.repository)?;
    install_github(&runtime, &normalized, &root, &state_path)
}

/// Interactive variant: present a registry picker when the user invoked
/// `tedi ext install` without a target ref. Falls back to a typed-input
/// prompt if registry fetch fails so the flow still completes.
fn prompt_install_reference(runtime: &tokio::runtime::Runtime) -> Result<String, String> {
    if !interactive() {
        return Err("missing argument: tedi ext install <path|owner/repo|registry-id>".into());
    }
    let doc = fetch_registry(runtime).ok();
    let entries: Vec<RegistryEntry> = doc
        .into_iter()
        .flat_map(|d| d.official.into_iter().chain(d.unofficial))
        .collect();
    if entries.is_empty() {
        return prompt_typed_reference();
    }
    let mut labels: Vec<String> = entries
        .iter()
        .map(|e| {
            if e.description.is_empty() {
                e.id.clone()
            } else {
                format!("{} - {}", e.id, e.description)
            }
        })
        .collect();
    labels.push(paint_dim("(type a custom ref)"));
    let theme = picker_theme();
    let chosen = dialoguer::Select::with_theme(theme.as_ref())
        .with_prompt("Install from registry")
        .items(&labels)
        .default(0)
        .interact_opt()
        .map_err(|e| format!("picker: {e}"))?;
    let Some(idx) = chosen else {
        return Err("cancelled".into());
    };
    if idx == labels.len() - 1 {
        return prompt_typed_reference();
    }
    Ok(entries[idx].repository.clone())
}

fn prompt_typed_reference() -> Result<String, String> {
    use std::io::BufRead;
    print!("Enter path / owner-repo / registry-id: ");
    let _ = std::io::stdout().flush();
    let mut buf = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut buf)
        .map_err(|e| format!("read stdin: {e}"))?;
    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return Err("no reference given".into());
    }
    Ok(trimmed.to_string())
}

fn cmd_list(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--installed") {
        return cmd_list_installed();
    }
    let runtime = build_runtime()?;
    let doc = fetch_registry(&runtime)?;

    // Cross-reference each registry entry against the local install state so
    // the user can see at a glance which extensions are already installed and
    // which have a newer version cached from a previous `ext update` check.
    let (rows, by_id, by_repo) = build_installed_lookups();

    let mut entries: Vec<(String, RegistryEntry)> = Vec::new();
    let mut installed_count = 0usize;
    let mut update_count = 0usize;
    for e in &doc.official {
        let inst = find_installed_for(e, &rows, &by_id, &by_repo);
        if let Some(r) = inst {
            installed_count += 1;
            if matches!(&r.latest, Some(latest) if latest != &r.version) {
                update_count += 1;
            }
        }
        entries.push((registry_label(e, "official", inst), e.clone()));
    }
    for e in &doc.unofficial {
        let inst = find_installed_for(e, &rows, &by_id, &by_repo);
        if let Some(r) = inst {
            installed_count += 1;
            if matches!(&r.latest, Some(latest) if latest != &r.version) {
                update_count += 1;
            }
        }
        entries.push((registry_label(e, "unofficial", inst), e.clone()));
    }
    if entries.is_empty() {
        println!("(registry empty)");
        return Ok(());
    }

    let summary = format!(
        "{} extension(s) - {} installed, {} update(s) available",
        entries.len(),
        installed_count,
        update_count,
    );
    println!("{}", paint_dim(&summary));
    if update_count > 0 {
        println!(
            "{}",
            paint_dim("Tip: `tedi ext update` to refresh upstream versions / apply updates."),
        );
    }
    println!();

    if !interactive() {
        print_registry_groups(&doc, &rows, &by_id, &by_repo);
        println!();
        println!("Install: tedi ext install <id>");
        return Ok(());
    }

    let labels: Vec<&str> = entries.iter().map(|(l, _)| l.as_str()).collect();
    let theme = picker_theme();
    let chosen = dialoguer::Select::with_theme(theme.as_ref())
        .with_prompt("Pilih extension (item terinstall akan di-reinstall/update). Esc untuk batal")
        .items(&labels)
        .default(0)
        .interact_opt()
        .map_err(|e| format!("picker: {e}"))?;
    let Some(idx) = chosen else {
        println!("Dibatalkan.");
        return Ok(());
    };
    let pick = entries[idx].1.clone();
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let normalized = github::normalize_owner_repo(&pick.repository)?;
    install_github(&runtime, &normalized, &root, &state_path)
}

fn cmd_list_installed() -> Result<(), String> {
    let rows = load_installed_rows()?;
    if rows.is_empty() {
        println!("No extensions installed.");
        return Ok(());
    }
    println!(
        "{} {}",
        paint_header("INSTALLED EXTENSIONS"),
        paint_dim(&format!("({})", rows.len())),
    );
    for r in &rows {
        let badge = if r.enabled { paint_on() } else { paint_off() };
        let update_hint = match &r.latest {
            Some(v) if v != &r.version => paint_update_hint(&format!("  -> v{v} available")),
            _ => String::new(),
        };
        println!(
            "  {badge}  {} {}  {}{update_hint}",
            paint_bold(&r.name),
            paint_dim(&format!("(id: {})", r.id)),
            paint_dim(&format!("v{}", r.version)),
        );
        println!("         {}", paint_dim(&format!("source: {}", r.source)));
    }
    Ok(())
}

fn cmd_update(args: &[String]) -> Result<(), String> {
    let id_filter = args.iter().find(|a| !a.starts_with("--")).cloned();
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let runtime = build_runtime()?;
    let initial = load_state(&state_path);

    let mut targets: Vec<(String, String, String)> = Vec::new();
    for (id, entry) in initial.entries.iter() {
        if let Some(ref f) = id_filter {
            if id != f {
                continue;
            }
        }
        targets.push((id.clone(), entry.version.clone(), entry.source.clone()));
    }
    if targets.is_empty() {
        return match id_filter {
            Some(f) => Err(format!("extension not installed: {f}")),
            None => {
                println!("No extensions installed.");
                Ok(())
            }
        };
    }

    let mut to_apply: Vec<(String, String, String, String)> = Vec::new();
    let mut state_w = initial;
    let now = now_ms();
    for (id, current_version, source) in targets {
        let Some(owner_repo) = source.strip_prefix("github:") else {
            println!(
                "{} {} {}",
                paint_dim(&format!("[{id}]")),
                paint_dim(&format!("non-github source ({source});")),
                paint_dim("skip"),
            );
            if let Some(e) = state_w.entries.get_mut(&id) {
                e.last_checked_at_ms = Some(now);
            }
            continue;
        };
        let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
        let json = match runtime.block_on(github::http_get_text(&api)) {
            Ok(j) => j,
            Err(e) => {
                println!(
                    "{} {} {e}",
                    paint_dim(&format!("[{id}]")),
                    paint_err("check failed:"),
                );
                continue;
            }
        };
        let Some(tag) = github::pick_release_tag(&json) else {
            println!(
                "{} {}",
                paint_dim(&format!("[{id}]")),
                paint_err("no tag_name in release JSON"),
            );
            continue;
        };
        let latest = version::strip_v_prefix(&tag);
        let has_update =
            version::compare_versions(&current_version, &latest) == std::cmp::Ordering::Less;
        if let Some(e) = state_w.entries.get_mut(&id) {
            e.latest_version = Some(latest.clone());
            e.last_checked_at_ms = Some(now);
        }
        if has_update {
            println!(
                "{} {} -> {} {}",
                paint_dim(&format!("[{id}]")),
                paint_dim(&format!("v{current_version}")),
                paint_id(&format!("v{latest}")),
                paint_update_hint("(update available)"),
            );
            to_apply.push((id, current_version, latest, owner_repo.to_string()));
        } else {
            println!(
                "{} {} {}",
                paint_dim(&format!("[{id}]")),
                paint_dim(&format!("v{current_version}")),
                paint_ok("(up to date)"),
            );
        }
    }
    save_state(&state_path, &state_w)?;

    if to_apply.is_empty() {
        println!();
        println!("{}", paint_ok("Nothing to update."));
        return Ok(());
    }

    if !interactive() {
        println!();
        println!(
            "Non-interactive shell; {} update(s) available but not applied.",
            to_apply.len()
        );
        println!("Run on a TTY, or re-run with explicit ids:");
        for (id, _, _, _) in &to_apply {
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

    let mut failed = 0usize;
    for (id, _from, _to, owner_repo) in to_apply {
        println!();
        println!(
            "{} {} {}",
            paint_header("Updating"),
            paint_id(&id),
            paint_dim(&format!("(github:{owner_repo})...")),
        );
        if let Err(e) = install_github(&runtime, &owner_repo, &root, &state_path) {
            failed += 1;
            eprintln!(
                "{} {} {e}",
                paint_dim(&format!("[{id}]")),
                paint_err("update failed:"),
            );
        }
    }
    if failed > 0 {
        return Err(format!("{failed} update(s) failed (see above)"));
    }
    Ok(())
}

fn cmd_uninstall(args: &[String]) -> Result<(), String> {
    let id = match args.first() {
        Some(id) => id.clone(),
        None => prompt_installed_id("Uninstall which extension?")?,
    };
    validate_id(&id)?;
    let root = extensions_root()?;
    let dir = root.join(&id);
    let state_path = root.join("state.json");
    let mut st = load_state(&state_path);
    let had_dir = dir.exists();
    let had_state = st.entries.contains_key(&id);
    if !had_dir && !had_state {
        return Err(format!("extension not installed: {id}"));
    }
    if had_dir {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {id}: {e}"))?;
    }
    st.entries.remove(&id);
    save_state(&state_path, &st)?;
    println!("{} Uninstalled {}.", paint_ok("✓"), paint_id(&id));
    Ok(())
}

fn cmd_set_enabled(args: &[String], enabled: bool) -> Result<(), String> {
    let action_name = if enabled { "enable" } else { "disable" };
    let id = match args.first() {
        Some(id) => id.clone(),
        None => prompt_installed_id(&format!("{} which extension?", capitalize(action_name)))?,
    };
    validate_id(&id)?;
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let mut st = load_state(&state_path);
    let entry = st
        .entries
        .get_mut(&id)
        .ok_or_else(|| format!("extension not installed: {id}"))?;
    entry.enabled = enabled;
    save_state(&state_path, &st)?;
    let verb = if enabled {
        paint_ok("Enabled")
    } else {
        paint_dim("Disabled")
    };
    println!("{} {verb} {}.", paint_ok("✓"), paint_id(&id));
    Ok(())
}

/// Arrow-pick from the installed list. Errors when nothing is installed
/// or the user cancels - the caller bubbles those up.
fn prompt_installed_id(prompt: &str) -> Result<String, String> {
    if !interactive() {
        return Err("missing argument: id required on a non-interactive shell".into());
    }
    let rows = load_installed_rows()?;
    if rows.is_empty() {
        return Err("No extensions installed.".into());
    }
    let labels: Vec<String> = rows
        .iter()
        .map(|r| {
            let badge = if r.enabled { paint_on() } else { paint_off() };
            format!(
                "{badge} {} {}  {}",
                r.name,
                paint_dim(&format!("(id: {})", r.id)),
                paint_dim(&format!("v{}", r.version)),
            )
        })
        .collect();
    let theme = picker_theme();
    let chosen = dialoguer::Select::with_theme(theme.as_ref())
        .with_prompt(prompt)
        .items(&labels)
        .default(0)
        .interact_opt()
        .map_err(|e| format!("picker: {e}"))?;
    let Some(idx) = chosen else {
        return Err("cancelled".into());
    };
    Ok(rows[idx].id.clone())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + c.as_str(),
        None => String::new(),
    }
}

// ---- helpers ------------------------------------------------------------

fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Walk `<extensions_root>/` + `state.json` and build a sorted-by-name list
/// of installed extensions. Skips staging/trash directories and entries
/// whose manifest fails to parse.
fn load_installed_rows() -> Result<Vec<InstalledRow>, String> {
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

/// Build a "not in registry" error listing the ids the user could have meant.
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

fn print_registry_groups(
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

fn print_registry_row(e: &RegistryEntry, installed: Option<&InstalledRow>) {
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

fn registry_label(e: &RegistryEntry, group: &str, installed: Option<&InstalledRow>) -> String {
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
fn installed_status(row: Option<&InstalledRow>) -> String {
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
fn build_installed_lookups() -> (
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

fn find_installed_for<'a>(
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

fn extensions_root() -> Result<PathBuf, String> {
    let p = crate::modules::ids::extensions_root()
        .ok_or_else(|| "could not determine data_dir".to_string())?;
    fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))?;
    Ok(p)
}

fn build_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))
}

fn fetch_registry(runtime: &tokio::runtime::Runtime) -> Result<RegistryDoc, String> {
    let json = runtime.block_on(github::http_get_text(REGISTRY_URL))?;
    serde_json::from_str(&json).map_err(|e| format!("parse registry JSON: {e}"))
}

/// Plain-mode progress reporter: prints one human-readable line per phase
/// and overwrites the extract progress on a single line so the terminal
/// doesn't get spammed. Falls back to plain println on Windows console
/// hosts that don't honour `\r`.
struct CliProgress {
    last_was_progress: std::sync::Mutex<bool>,
}

impl CliProgress {
    fn new() -> Self {
        Self {
            last_was_progress: std::sync::Mutex::new(false),
        }
    }
}

impl InstallProgress for CliProgress {
    fn phase(&self, phase: InstallPhase) {
        let (line, sticky) = match phase {
            InstallPhase::Downloading {
                bytes_done,
                bytes_total,
            } => (
                match bytes_total {
                    Some(t) if t > 0 => {
                        format!("Downloading: {} / {}", fmt_bytes(bytes_done), fmt_bytes(t))
                    }
                    _ => format!("Downloading: {}", fmt_bytes(bytes_done)),
                },
                true,
            ),
            InstallPhase::Verifying => ("Verifying...".into(), false),
            InstallPhase::Extracting => ("Extracting...".into(), false),
            InstallPhase::Finalizing => ("Finalizing...".into(), false),
            InstallPhase::Done => ("Done.".into(), false),
        };
        let mut stdout = std::io::stdout();
        let mut last = self
            .last_was_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *last && !sticky {
            let _ = writeln!(stdout);
        }
        if sticky {
            let _ = write!(stdout, "\r\x1b[2K{line}");
        } else {
            let _ = writeln!(stdout, "{line}");
        }
        let _ = stdout.flush();
        *last = sticky;
    }

    fn file(&self, index: usize, total: usize, _path: &str) {
        if total == 0 {
            return;
        }
        let step = (total / 10).max(1);
        if !index.is_multiple_of(step) && index + 1 != total {
            return;
        }
        let pct = ((index as f64 + 1.0) / total as f64 * 100.0).round() as u32;
        let mut stdout = std::io::stdout();
        let _ = write!(
            stdout,
            "\r\x1b[2KExtracting: {}/{} files ({pct}%)",
            index + 1,
            total
        );
        let _ = stdout.flush();
        let mut last = self
            .last_was_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if index + 1 == total {
            let _ = writeln!(stdout);
            *last = false;
        } else {
            *last = true;
        }
    }
}

fn fmt_bytes(b: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    if b >= MB {
        format!("{:.1} MiB", b as f64 / MB as f64)
    } else if b >= KB {
        format!("{:.1} KiB", b as f64 / KB as f64)
    } else {
        format!("{b} B")
    }
}

fn install_with_progress(
    root: &std::path::Path,
    state_path: &std::path::Path,
    bytes: &[u8],
    source: &str,
) -> Result<InstallOutcome, String> {
    let progress: Box<dyn InstallProgress> = if interactive() {
        Box::new(CliProgress::new())
    } else {
        Box::new(NoopProgress)
    };
    install_from_bytes_with_progress(root, state_path, bytes, source, progress.as_ref())
}

fn install_github(
    runtime: &tokio::runtime::Runtime,
    owner_repo: &str,
    root: &std::path::Path,
    state_path: &std::path::Path,
) -> Result<(), String> {
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    let json = runtime.block_on(github::http_get_text(&api))?;
    let zip_url = github::pick_release_zip(&json)
        .ok_or_else(|| format!("no .zip asset in latest release of {owner_repo}"))?;
    println!("{} {zip_url}", paint_dim("Downloading"));
    let progress: Box<dyn InstallProgress> = if interactive() {
        Box::new(CliProgress::new())
    } else {
        Box::new(NoopProgress)
    };
    let bytes = runtime.block_on(github::http_get_bytes_with_progress(
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
        progress.as_ref(),
    )?;
    println!(
        "{} Installed {} {} {}",
        paint_ok("✓"),
        paint_id(&outcome.manifest.id),
        paint_dim(&format!("v{}", outcome.manifest.version)),
        paint_dim(&format!("(from github:{owner_repo})")),
    );
    Ok(())
}

fn looks_like_path(s: &str) -> bool {
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

fn looks_like_github_ref(s: &str) -> bool {
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

fn print_help() {
    print!("{}", help_text());
}

/// Colorised help text. Matches the palette used by `cli.rs::help_text()`
/// and `cli_theme.rs::help_text()` so the three `--help` outputs look
/// uniform. ANSI codes are gated through `ansi()` (TTY + `NO_COLOR`).
fn help_text() -> String {
    let r = paint_dim("[<REF>]");
    let i = paint_dim("[<ID>]");
    format!(
        "{title}  {tag}\n\
         \n\
         {usage}\n  \
         {tedi} ext {sub}        Pick an action (arrow keys)\n  \
         {tedi} ext install {r}    path | owner/repo | GitHub URL | registry id\n  \
         {tedi} --extension {sub}  Alias for `tedi ext {sub}`\n\
         \n\
         {hint}\n  \
         {dim_hint1}\n  \
         {dim_hint2}\n\
         \n\
         {subs}\n  \
         {c_install} {r}         Install. Omit {r} for an interactive registry picker\n  \
         {c_list}                  Browse the public registry (TTY picker)\n  \
         {c_list_inst}      Show locally installed extensions\n  \
         {c_installed}             Alias for `list --installed`\n  \
         {c_update} {i}          Check upstream / apply updates\n  \
         {c_uninst} {i}       Remove an installed extension\n  \
         {c_enable} {i}          Enable an installed extension\n  \
         {c_disable} {i}         Disable an installed extension\n  \
         {c_help}                  Print this help\n\
         \n\
         {dim_registry}\n",
        title = paint_brand(&format!("tedi ext  {}", env!("CARGO_PKG_VERSION"))),
        tag = paint_dim("· manage TEDI extensions"),
        usage = paint_header("USAGE"),
        tedi = paint_id("tedi"),
        sub = paint_dim("[<subcommand>]"),
        r = r,
        hint = paint_header("INTERACTIVE"),
        dim_hint1 = paint_dim(
            "Subcommands prompt with an arrow-key picker when the target arg is omitted."
        ),
        dim_hint2 =
            paint_dim("Non-TTY shells (CI, pipes) print a hint instead of stalling on the picker."),
        subs = paint_header("SUBCOMMANDS"),
        c_install = paint_id("install   "),
        c_list = paint_id("list             "),
        c_list_inst = paint_id("list --installed"),
        c_installed = paint_id("installed        "),
        c_update = paint_id("update   "),
        c_uninst = paint_id("uninstall"),
        c_enable = paint_id("enable   "),
        c_disable = paint_id("disable  "),
        c_help = paint_id("help             "),
        dim_registry = paint_dim("Registry: https://tedi.ilhamriski.com/extensions/"),
        i = i,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `help_text()` keeps the canonical section names and every subcommand
    /// id. Tests run with stdout piped so `ansi()` returns plain text - the
    /// assertions match plain substrings only.
    #[test]
    fn help_text_keeps_sections_and_subcommands() {
        let h = help_text();
        for section in ["USAGE", "INTERACTIVE", "SUBCOMMANDS"] {
            assert!(
                h.contains(section),
                "expected `{section}` in `tedi ext help`"
            );
        }
        for sub in [
            "install",
            "list",
            "list --installed",
            "installed",
            "update",
            "uninstall",
            "enable",
            "disable",
            "help",
        ] {
            assert!(h.contains(sub), "expected subcommand `{sub}` in help");
        }
        assert!(h.contains("--extension"), "alias `--extension` missing");
        assert!(
            h.contains("tedi.ilhamriski.com/extensions"),
            "registry URL missing",
        );
    }

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
    fn capitalize_first_letter() {
        assert_eq!(capitalize("enable"), "Enable");
        assert_eq!(capitalize("x"), "X");
        assert_eq!(capitalize(""), "");
    }

    #[test]
    fn noop_progress_is_no_op() {
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
            github::normalize_owner_repo(&e.repository).unwrap_or_else(|err| {
                panic!(
                    "registry entry {}: repository `{}` failed to normalize as owner/repo: {err}",
                    e.id, e.repository
                )
            });
            eprintln!("ok: {} ({})", e.id, e.repository);
        }
    }
}
