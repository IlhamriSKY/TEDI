//! The `tedi ext` subcommand handlers: the action menu, install, list,
//! installed, update, uninstall, and enable/disable, plus their interactive
//! prompts.

use std::fs;
use std::io::Write;

use crate::modules::cli_paint::{
    paint_bold, paint_dim, paint_err, paint_header, paint_id, paint_off, paint_ok, paint_on,
    paint_update_hint,
};
use crate::modules::extensions::manifest::validate_id;
use crate::modules::extensions::state::{load as load_state, now_ms, save as save_state};
use crate::modules::extensions::{github, version};

use super::helpers::{
    build_runtime, capitalize, extensions_root, interactive, looks_like_github_ref,
    looks_like_path, picker_theme, print_help,
};
use super::install::{install_github, install_with_progress};
use super::registry::{
    build_installed_lookups, fetch_registry, find_installed_for, load_installed_rows,
    print_registry_groups, registry_label, registry_not_found_msg,
};
use super::types::RegistryEntry;

// ---- subcommands --------------------------------------------------------

/// `tedi ext` with no subcommand: arrow-pick an action on a TTY, print help
/// on non-TTY (CI / pipes shouldn't get stuck on a picker with no input).
pub(super) fn cmd_menu() -> Result<(), String> {
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
        ("Create a new extension", "create"),
        ("Validate an extension folder", "validate"),
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
        // Authoring actions take their target interactively (create prompts
        // for an id, validate defaults to the cwd), so an empty arg list is
        // the right call here.
        "create" => super::scaffold::cmd_create(&[]),
        "validate" => super::validate::cmd_validate(&[]),
        _ => Ok(()),
    }
}

pub(super) fn cmd_install(args: &[String]) -> Result<(), String> {
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

pub(super) fn cmd_list(args: &[String]) -> Result<(), String> {
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
        println!("{}", paint_dim("(registry empty)"));
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
        println!("{}", paint_dim("Install: tedi ext install <id>"));
        return Ok(());
    }

    let labels: Vec<&str> = entries.iter().map(|(l, _)| l.as_str()).collect();
    let theme = picker_theme();
    let chosen = dialoguer::Select::with_theme(theme.as_ref())
        .with_prompt(
            "Select an extension (installed items are reinstalled/updated) · Esc to cancel",
        )
        .items(&labels)
        .default(0)
        .interact_opt()
        .map_err(|e| format!("picker: {e}"))?;
    let Some(idx) = chosen else {
        println!("{}", paint_dim("Cancelled."));
        return Ok(());
    };
    let pick = entries[idx].1.clone();
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let normalized = github::normalize_owner_repo(&pick.repository)?;
    install_github(&runtime, &normalized, &root, &state_path)
}

pub(super) fn cmd_list_installed() -> Result<(), String> {
    let rows = load_installed_rows()?;
    if rows.is_empty() {
        println!("{}", paint_dim("No extensions installed."));
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

pub(super) fn cmd_update(args: &[String]) -> Result<(), String> {
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
                println!("{}", paint_dim("No extensions installed."));
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
        let tag = match runtime.block_on(github::resolve_latest_tag(owner_repo)) {
            Ok(t) => t,
            Err(e) => {
                println!(
                    "{} {} {e}",
                    paint_dim(&format!("[{id}]")),
                    paint_err("check failed:"),
                );
                continue;
            }
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
            "{}",
            paint_dim(&format!(
                "Non-interactive shell; {} update(s) available but not applied.",
                to_apply.len()
            )),
        );
        println!(
            "{}",
            paint_dim("Run on a TTY, or re-run with explicit ids:")
        );
        for (id, _, _, _) in &to_apply {
            println!("    {}", paint_id(&format!("tedi ext install {id}")));
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
        println!("{}", paint_dim("Skipped."));
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

pub(super) fn cmd_uninstall(args: &[String]) -> Result<(), String> {
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

pub(super) fn cmd_set_enabled(args: &[String], enabled: bool) -> Result<(), String> {
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
