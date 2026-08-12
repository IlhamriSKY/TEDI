//! GitHub CLI driver for the Source Control panel's Pull Requests view.
//!
//! Everything pull-request- and stack-shaped is delegated to `gh` and to
//! GitHub's own `gh-stack` extension rather than rebuilt against the REST API.
//! `gh` already owns the credential (keyring, SSO, enterprise hosts), and
//! `gh stack` already owns stack tracking, the cascading rebase and the stack
//! object on GitHub. Owning any of that here would mean a second, drifting
//! implementation of a preview feature GitHub is still shipping. So this file
//! is the transport and the security boundary, and nothing else.
//!
//! Mirrors `commands::git_run`: one runner taking an argument vector, so the
//! whole feature is composed in TypeScript (`src/modules/scm/gh.ts`) and can be
//! driven by `scripts/gh-stack-verify.ts` over a recording runner.

use std::path::Path;
use std::process::{Command, Stdio};

use super::commands::require_root;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW. Same reason as the `git` side: no console flash on
/// Windows when shelling out.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Returned verbatim when the `gh` binary is not on PATH, so the panel can tell
/// "GitHub CLI is not installed" from a real gh failure without matching an
/// OS error string that differs per platform. Mirrored by `GH_NOT_FOUND` in
/// `src/modules/scm/gh.ts`.
const GH_NOT_FOUND: &str = "gh-not-found";

/// The only extension the panel may install. `gh extension install` compiles
/// and runs code from whatever repository it is handed, so this is a fixed
/// value rather than anything the caller supplies.
const STACK_EXTENSION: &str = "github/gh-stack";

/// `(subcommand, allowed verbs)`. Both levels are pinned because an argument
/// vector arrives over IPC and `gh` is an authenticated client for the user's
/// entire GitHub account, not just this repository. A first-word-only allowlist
/// would hand the webview `gh auth token` (prints the credential),
/// `gh api -X DELETE ...` (any authenticated request) and
/// `gh extension install <anything>` (arbitrary code execution). `api` is
/// absent for the same reason.
const ALLOWED: &[(&str, &[&str])] = &[
    ("auth", &["status"]),
    ("extension", &["install", "list"]),
    ("pr", &["checkout", "create", "list", "view"]),
    ("repo", &["create", "view"]),
    (
        "stack",
        &[
            "add", "checkout", "init", "merge", "rebase", "submit", "sync", "unstack", "view",
        ],
    ),
];

pub(crate) fn check_gh_args(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a.bytes().any(|b| b == 0)) {
        return Err("gh: argument contains a NUL byte".into());
    }
    let Some(sub) = args.first() else {
        return Err("gh: no subcommand".into());
    };
    // The verb is the first non-flag word after the subcommand. Finding it
    // rather than reading `args[1]` means a leading `--json` cannot push an
    // unlisted verb past the table.
    let verb = args[1..]
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(String::as_str);

    // Pin the whole vector for an install: everything after the verb names the
    // code that is about to run, so an allowlist on the first two words alone
    // would be no allowlist at all.
    if sub == "extension" && verb == Some("install") {
        let expected = ["extension", "install", STACK_EXTENSION];
        return if args.len() == expected.len() && args.iter().zip(expected).all(|(a, e)| a == e) {
            Ok(())
        } else {
            Err(format!(
                "gh: only `gh extension install {STACK_EXTENSION}` is allowed"
            ))
        };
    }

    let Some((_, verbs)) = ALLOWED.iter().find(|(s, _)| s == sub) else {
        return Err(format!("gh: subcommand '{sub}' is not allowed"));
    };
    match verb {
        Some(v) if verbs.contains(&v) => Ok(()),
        Some(v) => Err(format!("gh: '{sub} {v}' is not allowed")),
        None => Err(format!("gh: '{sub}' needs a subcommand of its own")),
    }
}

fn gh(repo: &Path) -> Command {
    let mut cmd = Command::new("gh");
    cmd.current_dir(repo);
    // The same no-hang contract `git()` holds itself to. Nothing here has a
    // terminal attached, so every route by which gh could stop and wait for one
    // is closed up front: a login prompt, a pager, or an editor opened for a PR
    // body would each block a worker thread forever rather than fail.
    cmd.stdin(Stdio::null());
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("GH_PAGER", "cat");
    cmd.env("GH_EDITOR", "true");
    // Output is parsed, not displayed. gh already drops colour when stdout is
    // not a tty; this also covers a user who has forced it on in gh config.
    cmd.env("NO_COLOR", "1");
    // Drop the AppImage's LD_LIBRARY_PATH before running the system gh, for the
    // same reason git does: gh links its own TLS stack for the API calls.
    crate::modules::appimage::sanitize_env(&mut cmd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Run one allowlisted `gh` invocation in `repo_path`'s repository and return
/// its stdout; a non-zero exit is an `Err` carrying whichever stream explained
/// the failure.
#[tauri::command]
pub async fn gh_run(repo_path: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gh_run_inner(repo_path, args))
        .await
        .map_err(|e| format!("gh_run join error: {e}"))?
}

fn gh_run_inner(repo_path: String, args: Vec<String>) -> Result<String, String> {
    check_gh_args(&args)?;
    let root = require_root(&repo_path)?;
    let out = gh(&root).args(&args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GH_NOT_FOUND.to_string()
        } else {
            e.to_string()
        }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    // gh reports some failures on stdout with an empty stderr (the `✗ ...`
    // lines the stack extension prints), so both streams are tried before
    // falling back to a bare exit code the user cannot act on.
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("gh exited with status {}", out.status)
    })
}

#[cfg(test)]
mod tests {
    use super::check_gh_args;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allows_what_the_panel_drives() {
        for args in [
            &["auth", "status"][..],
            &["pr", "list", "--json", "number"][..],
            &["pr", "create", "--base", "main", "--title", "t"][..],
            &["stack", "view", "--json"][..],
            &["stack", "submit", "--auto", "--open"][..],
            &["extension", "install", "github/gh-stack"][..],
        ] {
            assert!(check_gh_args(&v(args)).is_ok(), "{args:?} should be allowed");
        }
    }

    #[test]
    fn refuses_the_credential_and_arbitrary_request_paths() {
        for args in [
            &["auth", "token"][..],
            &["auth", "login"][..],
            &["api", "-X", "DELETE", "/repos/o/r"][..],
            &["pr", "merge", "1"][..],
            &["stack", "feedback"][..],
            &["secret", "list"][..],
        ] {
            assert!(check_gh_args(&v(args)).is_err(), "{args:?} should be refused");
        }
    }

    #[test]
    fn refuses_an_extension_install_that_is_not_the_stack_extension() {
        assert!(check_gh_args(&v(&["extension", "install", "evil/pwn"])).is_err());
        // Trailing arguments are still arguments to `install`, so the exact
        // vector is what is compared, not "contains the right name somewhere".
        assert!(check_gh_args(&v(&["extension", "install", "github/gh-stack", "evil/pwn"])).is_err());
        assert!(check_gh_args(&v(&["extension", "install", "evil/pwn", "github/gh-stack"])).is_err());
    }

    #[test]
    fn a_leading_flag_cannot_hide_the_verb() {
        assert!(check_gh_args(&v(&["auth", "--hostname", "x", "token"])).is_err());
        assert!(check_gh_args(&v(&["stack", "--json", "view"])).is_ok());
    }
}
