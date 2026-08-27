//! `tedi ext create` and `tedi ext types`: the zero-install path from nothing
//! to a working, type-checked extension.
//!
//! Everything written here is embedded in the binary with `include_str!`, so
//! the scaffold an author gets - including `tedi.d.ts` and
//! `manifest.schema.json` - always describes the TEDI they are actually
//! running. That is the point: a downloaded-from-the-web `.d.ts` goes stale
//! the moment the host ships new API, and a stale `.d.ts` is worse than none,
//! because it promises methods the host does not have. `tedi ext types`
//! refreshes both files in place after an app upgrade.
//!
//! The templates live as real files under `src-tauri/templates/ext/` rather
//! than as string literals, so they are lintable, formattable, and diffable
//! like any other source.

use std::fs;
use std::path::{Path, PathBuf};

use crate::modules::cli_paint::{paint_dim, paint_header, paint_id, paint_ok};
use crate::modules::extensions::manifest::validate_id;

use super::helpers::{interactive, picker_theme};

/// The typed API contract, verbatim from the repo. `scripts/extensions/ext-api-parity.ts`
/// keeps it identical to the host's real `ExtensionContext` at compile time,
/// so what an author codes against cannot drift from what they get.
pub(super) const TEDI_D_TS: &str = include_str!("../../../../extensions/tedi.d.ts");

/// JSON Schema for `manifest.json`, generated from the same Zod schema the
/// host parses with (see `scripts/ext-schema-verify.ts`).
pub(super) const MANIFEST_SCHEMA: &str =
    include_str!("../../../../extensions/manifest.schema.json");

const T_MANIFEST: &str = include_str!("../../../templates/ext/manifest.json");
const T_INDEX_JS: &str = include_str!("../../../templates/ext/src/index.js");
const T_BUILD_MJS: &str = include_str!("../../../templates/ext/build.mjs");
const T_PACKAGE_JSON: &str = include_str!("../../../templates/ext/package.json");
const T_JSCONFIG: &str = include_str!("../../../templates/ext/jsconfig.json");
const T_GITIGNORE: &str = include_str!("../../../templates/ext/.gitignore");
const T_README: &str = include_str!("../../../templates/ext/README.md");

/// Turn `acme.my-thing` into `My Thing` for the display name, and
/// `acme-my-thing` for the npm package name (npm forbids neither dots nor
/// uppercase, but a dotted name reads like a scope and confuses tooling).
fn derive_names(id: &str) -> (String, String) {
    let tail = id.rsplit('.').next().unwrap_or(id);
    let display = tail
        .split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(super::helpers::capitalize)
        .collect::<Vec<_>>()
        .join(" ");
    let pkg = id.replace('.', "-");
    (
        if display.is_empty() {
            id.to_string()
        } else {
            display
        },
        pkg,
    )
}

fn fill(template: &str, id: &str, name: &str, pkg: &str, host_version: &str) -> String {
    template
        .replace("__ID__", id)
        .replace("__NAME__", name)
        .replace("__PKG_NAME__", pkg)
        .replace("__HOST_VERSION__", host_version)
}

/// `tedi ext create [<id>] [--dir <path>]`
///
/// Writes into `<dir>/<id>/`, refusing a non-empty target rather than merging
/// into it: a half-overwritten extension folder is far harder to recover from
/// than re-running the command with a different id.
pub(super) fn cmd_create(args: &[String]) -> Result<(), String> {
    let mut id: Option<String> = None;
    let mut dir: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" | "-d" => {
                dir = Some(
                    it.next()
                        .ok_or_else(|| "--dir needs a path".to_string())?
                        .clone(),
                );
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown flag: {other}"));
            }
            other => {
                if id.is_none() {
                    id = Some(other.to_string());
                }
            }
        }
    }

    let id = match id {
        Some(i) => i,
        None => prompt_id()?,
    };
    validate_id(&id)?;

    let base = match dir {
        Some(d) => PathBuf::from(d),
        None => std::env::current_dir().map_err(|e| format!("cwd: {e}"))?,
    };
    let target = base.join(&id);
    if target.exists()
        && fs::read_dir(&target)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Err(format!(
            "{} already exists and is not empty",
            target.display()
        ));
    }

    let (name, pkg) = derive_names(&id);
    let host_version = env!("CARGO_PKG_VERSION");

    fs::create_dir_all(target.join("src")).map_err(|e| format!("mkdir: {e}"))?;
    let files: [(&str, String); 8] = [
        (
            "manifest.json",
            fill(T_MANIFEST, &id, &name, &pkg, host_version),
        ),
        (
            "src/index.js",
            fill(T_INDEX_JS, &id, &name, &pkg, host_version),
        ),
        ("build.mjs", T_BUILD_MJS.to_string()),
        (
            "package.json",
            fill(T_PACKAGE_JSON, &id, &name, &pkg, host_version),
        ),
        ("jsconfig.json", T_JSCONFIG.to_string()),
        (".gitignore", T_GITIGNORE.to_string()),
        ("README.md", fill(T_README, &id, &name, &pkg, host_version)),
        ("tedi.d.ts", TEDI_D_TS.to_string()),
    ];
    for (rel, body) in files {
        write_file(&target, rel, &body)?;
    }
    write_file(&target, "manifest.schema.json", MANIFEST_SCHEMA)?;

    println!(
        "\n{} {} {}",
        paint_ok("created"),
        paint_id(&id),
        paint_dim(&format!("in {}", target.display()))
    );
    println!("\n{}", paint_header("NEXT"));
    println!("  {}", paint_dim(&format!("cd {id}")));
    println!(
        "  {}   {}",
        paint_id("npm install"),
        paint_dim("esbuild + the type checker")
    );
    println!(
        "  {}   {}",
        paint_id("npm run watch"),
        paint_dim("src/ -> extension.js on every save")
    );
    println!(
        "  {}  {}",
        paint_id("tedi ext install ."),
        paint_dim("load it into the running app")
    );
    println!(
        "\n{}\n",
        paint_dim("Open src/index.js and type `ctx.` - the API completes from tedi.d.ts.")
    );
    Ok(())
}

/// `tedi ext types [<dir>]`
///
/// Refreshes `tedi.d.ts` + `manifest.schema.json` in an existing extension
/// folder from this binary. Run it after upgrading TEDI to code against the
/// API the new host actually has.
pub(super) fn cmd_types(args: &[String]) -> Result<(), String> {
    let dir = match args.first() {
        Some(d) => PathBuf::from(d),
        None => std::env::current_dir().map_err(|e| format!("cwd: {e}"))?,
    };
    if !dir.join("manifest.json").is_file() {
        return Err(format!(
            "no manifest.json in {} - run this from an extension folder, or pass its path",
            dir.display()
        ));
    }
    write_file(&dir, "tedi.d.ts", TEDI_D_TS)?;
    write_file(&dir, "manifest.schema.json", MANIFEST_SCHEMA)?;
    println!(
        "\n{} {}\n",
        paint_ok("types updated to TEDI"),
        paint_id(env!("CARGO_PKG_VERSION"))
    );
    Ok(())
}

fn write_file(root: &Path, rel: &str, body: &str) -> Result<(), String> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    println!("  {} {}", paint_ok("+"), paint_dim(rel));
    Ok(())
}

fn prompt_id() -> Result<String, String> {
    if !interactive() {
        return Err("usage: tedi ext create <id>   (e.g. acme.my-thing)".into());
    }
    let theme = picker_theme();
    let raw: String = dialoguer::Input::with_theme(theme.as_ref())
        .with_prompt("Extension id (publisher.name)")
        .interact_text()
        .map_err(|e| format!("prompt: {e}"))?;
    Ok(raw.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_display_and_package_names() {
        assert_eq!(
            derive_names("acme.my-thing"),
            ("My Thing".into(), "acme-my-thing".into())
        );
        assert_eq!(derive_names("hello"), ("Hello".into(), "hello".into()));
        assert_eq!(derive_names("a.b_c"), ("B C".into(), "a-b_c".into()));
    }

    /// The scaffold has to be internally consistent or the very first
    /// `npm run build` fails: `build.mjs` reads `manifest.main`, and
    /// `src/index.js` reaches one directory up for `tedi.d.ts`.
    #[test]
    fn templates_agree_with_each_other() {
        assert!(T_MANIFEST.contains("\"main\": \"extension.js\""));
        assert!(T_BUILD_MJS.contains("manifest.main"));
        assert!(T_INDEX_JS.contains("import(\"../tedi\")"));
        assert!(T_JSCONFIG.contains("\"checkJs\": true"));
        assert!(T_GITIGNORE.contains("/extension.js"));
    }

    /// A placeholder that no template substitutes would ship literally into
    /// the author's files.
    #[test]
    fn every_placeholder_is_substituted() {
        let filled = [
            fill(T_MANIFEST, "acme.x", "X", "acme-x", "0.0.0"),
            fill(T_INDEX_JS, "acme.x", "X", "acme-x", "0.0.0"),
            fill(T_PACKAGE_JSON, "acme.x", "X", "acme-x", "0.0.0"),
            fill(T_README, "acme.x", "X", "acme-x", "0.0.0"),
        ];
        for f in filled {
            assert!(!f.contains("__"), "unsubstituted placeholder in:\n{f}");
        }
    }

    /// The embedded copies are the whole reason `tedi ext types` can promise
    /// "matches the host you are running".
    #[test]
    fn embedded_api_artifacts_are_present() {
        assert!(TEDI_D_TS.contains("export type ExtensionContext"));
        assert!(MANIFEST_SCHEMA.contains("\"$id\""));
    }
}
