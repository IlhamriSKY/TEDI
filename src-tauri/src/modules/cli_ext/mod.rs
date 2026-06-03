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

mod commands;
mod helpers;
mod install;
mod registry;
mod types;

use std::io::Write;

use crate::modules::cli;

use commands::{
    cmd_install, cmd_list, cmd_list_installed, cmd_menu, cmd_set_enabled, cmd_uninstall, cmd_update,
};
use helpers::print_help;

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

#[cfg(test)]
mod tests {
    use super::extract_subcommand;
    use crate::modules::cli_ext::helpers::{help_text, looks_like_github_ref, looks_like_path};
    use crate::modules::cli_ext::registry::registry_not_found_msg;
    use crate::modules::cli_ext::types::{RegistryDoc, RegistryEntry};

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
        use crate::modules::cli_ext::helpers::capitalize;
        assert_eq!(capitalize("enable"), "Enable");
        assert_eq!(capitalize("x"), "X");
        assert_eq!(capitalize(""), "");
    }

    #[test]
    fn noop_progress_is_no_op() {
        use crate::modules::extensions::install::{InstallPhase, InstallProgress, NoopProgress};
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
        use crate::modules::cli_ext::helpers::build_runtime;
        use crate::modules::cli_ext::registry::fetch_registry;
        use crate::modules::extensions::github;
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
