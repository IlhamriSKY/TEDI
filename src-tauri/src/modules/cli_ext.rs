//! Headless CLI for `tedi ext <subcmd>` and the `tedi --extension <subcmd>`
//! alias. Short-circuits out of `lib::run` before Tauri boots and runs
//! install/list/update/uninstall against the same `<app_data_dir>/extensions/`
//! directory and `state.json` the GUI uses.
//!
//! Subcommands:
//!   tedi ext install <ref>       # path | owner/repo | github URL | registry id
//!   tedi ext list                # registry picker (interactive on a TTY)
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
use crate::modules::extensions::commands as ext_cmd;
use crate::modules::extensions::install::install_from_bytes;
use crate::modules::extensions::manifest::{validate_id, Manifest};
use crate::modules::extensions::state::{
    load as load_state, now_ms, save as save_state,
};

/// Bundle id from `tauri.conf.json`. Tauri 2's `app_data_dir` returns
/// `<dirs::data_dir()>/<bundle_id>` on every desktop platform, so we can
/// reproduce the path without an `AppHandle`. Keep in sync with the
/// `identifier` field in `tauri.conf.json`.
const BUNDLE_ID: &str = "id.ilhamrisky.tedi";

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

// ---- subcommands --------------------------------------------------------

fn cmd_install(args: &[String]) -> Result<(), String> {
    let reference = args.first().ok_or_else(|| {
        "missing argument: tedi ext install <path|owner/repo|registry-id>".to_string()
    })?;
    let root = extensions_root()?;
    let state_path = root.join("state.json");

    // 1) Local file. No extension check; `install_from_bytes` validates the
    //    zip magic bytes, so `tedi ext install ./build/my-ext` works on any
    //    real zip.
    let p = std::path::Path::new(reference);
    if p.is_file() {
        let bytes = fs::read(p).map_err(|e| format!("read {}: {e}", p.display()))?;
        let outcome = install_from_bytes(
            &root,
            &state_path,
            &bytes,
            &format!("local:{}", p.display()),
        )?;
        println!(
            "Installed {} v{} (from local:{})",
            outcome.manifest.id,
            outcome.manifest.version,
            p.display()
        );
        return Ok(());
    }

    // 2) Path-shaped input that did not resolve. Fail fast rather than
    //    burning a registry round-trip on a typo. Covers `./foo`, `../foo`,
    //    `/abs/foo`, `~/foo`, `C:\foo`, and anything containing `\`.
    if looks_like_path(reference) {
        return Err(format!(
            "`{reference}` looks like a file path but no file was found at that location"
        ));
    }

    // Network from here on. Build the tokio runtime once and reuse it: the
    // github branch fetches the release JSON + asset, the registry branch
    // also fetches the index.
    let runtime = build_runtime()?;

    // 3) owner/repo or full GitHub URL.
    if looks_like_github_ref(reference) {
        let normalized = ext_cmd::normalize_owner_repo(reference)?;
        return install_github(&runtime, &normalized, &root, &state_path);
    }

    // 4) Bare registry id.
    let doc = fetch_registry(&runtime)?;
    let entry = doc
        .official
        .iter()
        .chain(doc.unofficial.iter())
        .find(|e| e.id == *reference)
        .ok_or_else(|| registry_not_found_msg(reference, &doc))?;
    let normalized = ext_cmd::normalize_owner_repo(&entry.repository)?;
    install_github(&runtime, &normalized, &root, &state_path)
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

fn cmd_list(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--installed") {
        return cmd_list_installed();
    }

    let runtime = build_runtime()?;
    let doc = fetch_registry(&runtime)?;

    // Flatten official + unofficial into one ordered list so the picker
    // and the non-TTY printer share iteration order.
    let mut items: Vec<(String, RegistryEntry)> = Vec::new();
    for e in &doc.official {
        items.push((registry_label(e, "official"), e.clone()));
    }
    for e in &doc.unofficial {
        items.push((registry_label(e, "unofficial"), e.clone()));
    }
    if items.is_empty() {
        println!("(registry empty)");
        return Ok(());
    }

    // Non-TTY: dump the full tabular view + install hint so pipes/CI can
    // grep for ids.
    use std::io::IsTerminal;
    let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    if !interactive {
        print_registry_groups(&doc);
        println!();
        println!("Install: tedi ext install <id>");
        return Ok(());
    }

    // TTY: skip the static table. The picker already shows every entry
    // with its description; printing twice adds visual noise.
    let labels: Vec<&str> = items.iter().map(|(l, _)| l.as_str()).collect();
    let chosen = dialoguer::Select::new()
        .with_prompt("Pilih extension untuk diinstall (Esc untuk batal)")
        .items(&labels)
        .default(0)
        .interact_opt()
        .map_err(|e| format!("picker: {e}"))?;
    let Some(idx) = chosen else {
        println!("Dibatalkan.");
        return Ok(());
    };
    let pick = items[idx].1.clone();
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let normalized = ext_cmd::normalize_owner_repo(&pick.repository)?;
    install_github(&runtime, &normalized, &root, &state_path)
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

fn cmd_list_installed() -> Result<(), String> {
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let state = load_state(&state_path);

    struct Row {
        id: String,
        name: String,
        version: String,
        enabled: bool,
        source: String,
        latest: Option<String>,
    }
    let mut rows: Vec<Row> = Vec::new();

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
        rows.push(Row {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            enabled: st.map(|s| s.enabled).unwrap_or(true),
            source: st.map(|s| s.source.clone()).unwrap_or_else(|| "local".into()),
            latest: st.and_then(|s| s.latest_version.clone()),
        });
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));

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
    let root = extensions_root()?;
    let state_path = root.join("state.json");
    let runtime = build_runtime()?;
    let initial = load_state(&state_path);

    // Filter up front so we do not hit GitHub for every installed extension
    // when the user asked about just one.
    let mut targets: Vec<(String, String, String)> = Vec::new(); // (id, current_version, source)
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

    let mut to_apply: Vec<(String, String, String, String)> = Vec::new(); // (id, from, to, owner_repo)
    let mut state_w = initial;
    let now = now_ms();
    for (id, current_version, source) in targets {
        let Some(owner_repo) = source.strip_prefix("github:") else {
            println!("[{id}] non-github source ({source}); skip");
            if let Some(e) = state_w.entries.get_mut(&id) {
                e.last_checked_at_ms = Some(now);
            }
            continue;
        };
        let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
        let json = match runtime.block_on(ext_cmd::http_get_text(&api)) {
            Ok(j) => j,
            Err(e) => {
                println!("[{id}] check failed: {e}");
                continue;
            }
        };
        let Some(tag) = ext_cmd::pick_release_tag(&json) else {
            println!("[{id}] no tag_name in release JSON");
            continue;
        };
        let latest = ext_cmd::strip_v_prefix(&tag);
        let has_update = ext_cmd::compare_versions(&current_version, &latest)
            == std::cmp::Ordering::Less;
        if let Some(e) = state_w.entries.get_mut(&id) {
            e.latest_version = Some(latest.clone());
            e.last_checked_at_ms = Some(now);
        }
        if has_update {
            println!("[{id}] v{current_version} -> v{latest} (update available)");
            to_apply.push((id, current_version, latest, owner_repo.to_string()));
        } else {
            println!("[{id}] v{current_version} (up to date)");
        }
    }
    save_state(&state_path, &state_w)?;

    if to_apply.is_empty() {
        println!();
        println!("Nothing to update.");
        return Ok(());
    }

    // Non-TTY (CI, piped, redirected stdin) can't answer y/N, and defaulting
    // to "yes" on a long-running pipeline is risky. Print the action and stop.
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
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
    // EOF (n == 0) or anything other than y/Y means skip.
    if n == 0 || !buf.trim().eq_ignore_ascii_case("y") {
        println!("Skipped.");
        return Ok(());
    }

    // Best-effort apply: per-id failures print but do not abort the rest,
    // so one flaky GitHub release does not strand the other updates.
    let mut failed = 0usize;
    for (id, _from, _to, owner_repo) in to_apply {
        println!();
        println!("Updating {id} (github:{owner_repo})...");
        if let Err(e) = install_github(&runtime, &owner_repo, &root, &state_path) {
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
    validate_id(id)?;
    let root = extensions_root()?;
    let dir = root.join(id);
    let state_path = root.join("state.json");
    let mut st = load_state(&state_path);
    let had_dir = dir.exists();
    let had_state = st.entries.contains_key(id);
    // Refuse on typo. The GUI silently succeeds, but a CLI no-op looks like
    // success when the id is wrong, so surface the error.
    if !had_dir && !had_state {
        return Err(format!("extension not installed: {id}"));
    }
    if had_dir {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {id}: {e}"))?;
    }
    st.entries.remove(id);
    save_state(&state_path, &st)?;
    println!("Uninstalled {id}.");
    Ok(())
}

fn cmd_set_enabled(args: &[String], enabled: bool) -> Result<(), String> {
    let action_name = if enabled { "enable" } else { "disable" };
    let id = args
        .first()
        .ok_or_else(|| format!("missing argument: tedi ext {action_name} <id>"))?;
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
    println!(
        "{} {id}.",
        if enabled { "Enabled" } else { "Disabled" }
    );
    Ok(())
}

// ---- helpers ------------------------------------------------------------

/// Returns `<dirs::data_dir()>/<BUNDLE_ID>/extensions`, creating it if
/// missing. Matches `app.path().app_data_dir().push("extensions")`.
fn extensions_root() -> Result<PathBuf, String> {
    let mut p = dirs::data_dir().ok_or_else(|| "could not determine data_dir".to_string())?;
    p.push(BUNDLE_ID);
    p.push("extensions");
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
    let json = runtime.block_on(ext_cmd::http_get_text(REGISTRY_URL))?;
    serde_json::from_str(&json).map_err(|e| format!("parse registry JSON: {e}"))
}

fn install_github(
    runtime: &tokio::runtime::Runtime,
    owner_repo: &str,
    root: &std::path::Path,
    state_path: &std::path::Path,
) -> Result<(), String> {
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    let json = runtime.block_on(ext_cmd::http_get_text(&api))?;
    let zip_url = ext_cmd::pick_release_zip(&json)
        .ok_or_else(|| format!("no .zip asset in latest release of {owner_repo}"))?;
    println!("Downloading {zip_url}");
    let bytes = runtime.block_on(ext_cmd::http_get_bytes(&zip_url))?;
    let outcome = install_from_bytes(
        root,
        state_path,
        &bytes,
        &format!("github:{owner_repo}"),
    )?;
    println!(
        "Installed {} v{} (from github:{owner_repo})",
        outcome.manifest.id, outcome.manifest.version
    );
    Ok(())
}

/// True for inputs with an unambiguous filesystem-path shape: explicit
/// dot-prefix, leading `/`, leading `~/`, Windows drive letter, or any
/// backslash. The github-ref check already covers single-slash `owner/repo`,
/// so this only catches inputs the user clearly meant as paths. Bare
/// filenames without a separator are not matched because they collide with
/// registry ids.
fn looks_like_path(s: &str) -> bool {
    if s.contains('\\') {
        return true;
    }
    if s.starts_with("./") || s.starts_with("../") || s.starts_with("~/") || s.starts_with('/') {
        return true;
    }
    // `C:\...` already caught by the backslash check. This catches the
    // forward-slash variant (`C:/foo`) and the bare `C:` form.
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    false
}

fn looks_like_github_ref(s: &str) -> bool {
    if s.contains('\\') {
        return false; // Windows path separator means real fs path
    }
    if s.contains("://") || s.starts_with("github.com/") {
        return true;
    }
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    // GitHub usernames start with an alphanumeric, so a leading `.` on
    // either segment is a path component, not a github ref.
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

fn print_registry_row(e: &RegistryEntry) {
    let license = if e.license.is_empty() {
        "-"
    } else {
        e.license.as_str()
    };
    println!(
        "  {:<28}  by {:<18}  {}",
        e.id, e.publisher, license
    );
    if !e.description.is_empty() {
        println!("    {}", e.description);
    }
}

fn registry_label(e: &RegistryEntry, group: &str) -> String {
    if e.description.is_empty() {
        format!("[{group}] {}", e.id)
    } else {
        format!("[{group}] {} - {}", e.id, e.description)
    }
}

fn print_help() {
    print!("{}", HELP);
}

const HELP: &str = concat!(
    "tedi ext - manage TEDI extensions\n",
    "\n",
    "USAGE:\n",
    "    tedi ext <SUBCOMMAND> [ARGS]\n",
    "    tedi --extension <SUBCOMMAND> [ARGS]    (alias)\n",
    "\n",
    "SUBCOMMANDS:\n",
    "    install <REF>           Install an extension. <REF> can be:\n",
    "                              - path to a local .zip file\n",
    "                              - owner/repo (e.g. IlhamriSKY/TEDI.discord-rich-presence)\n",
    "                              - full GitHub URL\n",
    "                              - registry id (e.g. discord-rich-presence)\n",
    "    list                    Browse the public registry; pick one to install (interactive on a TTY).\n",
    "    list --installed        Show extensions currently installed locally.\n",
    "    installed               Alias for `list --installed`.\n",
    "    update [<ID>]           Check upstream for newer releases. Without <ID>,\n",
    "                            checks every github-sourced extension. Prompts before applying.\n",
    "    uninstall <ID>          Remove an installed extension.\n",
    "    enable <ID>             Enable an installed extension.\n",
    "    disable <ID>            Disable an installed extension.\n",
    "    help                    Print this help.\n",
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
        let args = vec![
            "tedi".into(),
            "--extension".into(),
            "list".into(),
        ];
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
        // GitHub refs and registry ids must not be classified as paths,
        // otherwise the install pipeline reports "looks like a file but
        // does not exist" on legal inputs.
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

    /// Live smoke test against the public registry. `#[ignore]` so `cargo
    /// test` stays offline-clean; run with
    /// `cargo test live_registry -- --ignored --nocapture`.
    ///
    /// Exercises the full user path: build runtime, reqwest GET with our
    /// timeouts, JSON parse into `RegistryDoc`, then check each entry's
    /// repository normalizes to an `owner/repo` pair.
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
            assert!(!e.repository.is_empty(), "entry {} has empty repository", e.id);
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
