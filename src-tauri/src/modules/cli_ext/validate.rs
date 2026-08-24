//! `tedi ext validate`: the pre-publish check.
//!
//! Every rule here exists because the failure it catches is INVISIBLE at
//! runtime. A keybinding pointing at a command id that does not exist does not
//! throw - the key simply does nothing. A misspelled permission does not throw
//! either; the gate denies a call the author believed was granted, inside an
//! async handler, where the rejection is unhandled and the button still looks
//! fine. A missing `main` file fails activation with a console error nobody has
//! DevTools open to see.
//!
//! Errors are things that are definitely broken (exit 1). Warnings are things
//! that are probably wrong but that the host tolerates on purpose (exit 0) -
//! notably an unknown permission, which must stay installable so an extension
//! written for a newer TEDI still loads on an older one.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::modules::cli_paint::{
    paint_dim, paint_err, paint_header, paint_id, paint_ok, paint_warn,
};
use crate::modules::extensions::manifest::Manifest;
use crate::modules::extensions::version::satisfies;

use super::scaffold::MANIFEST_SCHEMA;

/// Commands `ctx.invoke` refuses even under `invoke:*`, so asking for one is
/// always a dead grant.
///
/// Mirrors `HARD_DENY_INVOKE` in `src/modules/extensions/permissions.ts`, which
/// is the enforcing copy - this one only produces a warning.
/// `scripts/ext-permissions-verify.ts` reads this file and fails if the two
/// lists diverge, so the duplication cannot rot silently.
const HARD_DENIED: &[&str] = &[
    "secrets_get_all",
    "secrets_get",
    "secrets_set",
    "secrets_delete",
    "ext_install_from_zip",
    "ext_install_from_github",
    "ext_enable",
    "ext_disable",
    "ext_uninstall",
];

#[derive(Default)]
struct Report {
    errors: Vec<String>,
    warnings: Vec<String>,
}

impl Report {
    fn error(&mut self, msg: impl Into<String>) {
        self.errors.push(msg.into());
    }
    fn warn(&mut self, msg: impl Into<String>) {
        self.warnings.push(msg.into());
    }
}

/// The fixed permission list, read back out of the embedded JSON Schema rather
/// than duplicated here. The schema is generated from the same Zod schema the
/// host validates with, so this stays a single source of truth across three
/// languages instead of a fourth hand-kept copy.
fn known_permissions() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Ok(schema) = serde_json::from_str::<Value>(MANIFEST_SCHEMA) else {
        return out;
    };
    let branches = schema
        .pointer("/properties/permissions/items/anyOf")
        .and_then(Value::as_array);
    for branch in branches.into_iter().flatten() {
        if let Some(values) = branch.get("enum").and_then(Value::as_array) {
            for v in values {
                if let Some(s) = v.as_str() {
                    out.insert(s.to_string());
                }
            }
        }
    }
    out
}

/// `contributes.<key>` as an array, or empty when absent / the wrong shape.
/// Absent is legal for every category, and a wrong shape is already reported
/// by the frontend's Zod parse, so neither is this function's problem.
fn contrib<'a>(contributes: &'a Value, key: &str) -> &'a [Value] {
    contributes
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub(super) fn cmd_validate(args: &[String]) -> Result<(), String> {
    let dir = match args.first() {
        Some(d) => PathBuf::from(d),
        None => std::env::current_dir().map_err(|e| format!("cwd: {e}"))?,
    };
    let manifest_path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|e| {
        format!(
            "{}: {e} - run this from an extension folder, or pass its path",
            manifest_path.display()
        )
    })?;

    let manifest = Manifest::parse(&text)?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| format!("manifest parse: {e}"))?;

    let mut report = Report::default();
    check_files(&dir, &manifest, &mut report);
    check_permissions(&manifest, &mut report);
    check_contributions(&manifest, &mut report);
    check_metadata(&manifest, &raw, &mut report);

    print_report(&manifest, &report);
    if report.errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} error{}",
            report.errors.len(),
            if report.errors.len() == 1 { "" } else { "s" }
        ))
    }
}

fn check_files(dir: &Path, m: &Manifest, r: &mut Report) {
    match m.main.as_deref() {
        Some(main) => {
            let path = dir.join(main);
            if !path.is_file() {
                r.error(format!(
                    "manifest.main is \"{main}\" but that file does not exist - did you run `npm run build`?"
                ));
            } else if let Ok(body) = std::fs::read_to_string(&path) {
                // Not a parse: the point is to catch a bundle that was built
                // without the entry export, which loads fine and then silently
                // contributes nothing.
                if !body.contains("activate") {
                    r.warn(format!(
                        "{main} contains no `activate` - the host will load it and log a warning, and only your declarative contributions will apply"
                    ));
                }
            }
        }
        None => r.warn(
            "no manifest.main - this installs as a declarative-only pack (settings, no code)",
        ),
    }
    if let Some(icon) = m.icon.as_deref() {
        if !dir.join(icon).is_file() {
            r.error(format!(
                "manifest.icon is \"{icon}\" but that file does not exist"
            ));
        }
    }
}

fn check_permissions(m: &Manifest, r: &mut Report) {
    let known = known_permissions();
    let mut seen = BTreeSet::new();
    for p in &m.permissions {
        if !seen.insert(p.clone()) {
            r.warn(format!("duplicate permission \"{p}\""));
            continue;
        }
        if let Some(cmd) = p.strip_prefix("invoke:") {
            if HARD_DENIED.contains(&cmd) {
                r.warn(format!(
                    "\"{p}\" is hard-denied and will always be refused - use ctx.secrets.* for keychain access; installing extensions is a user action"
                ));
            } else if cmd.contains('*') {
                r.warn(format!(
                    "\"{p}\" is a glob, so the install dialog badges it high-risk - list the exact commands you call instead"
                ));
            }
            continue;
        }
        // `*` and other globs are legal and deliberately loud in the dialog.
        if p.contains('*') {
            r.warn(format!(
                "\"{p}\" grants far more than any extension needs and badges high-risk at install"
            ));
            continue;
        }
        if !known.is_empty() && !known.contains(p) {
            r.warn(format!(
                "\"{p}\" is not a permission this TEDI checks - it installs but grants nothing, so this is usually a typo"
            ));
        }
    }
}

fn check_contributions(m: &Manifest, r: &mut Report) {
    let c = &m.contributes;
    if c.is_null() {
        return;
    }

    let commands = contrib(c, "commands");
    let command_ids: BTreeSet<&str> = commands.iter().filter_map(|v| str_field(v, "id")).collect();

    for (category, key) in [
        ("command", "commands"),
        ("panel", "panels"),
        ("setting", "settings"),
    ] {
        let mut seen = BTreeSet::new();
        for item in contrib(c, key) {
            if let Some(id) = str_field(item, "id") {
                if !seen.insert(id) {
                    r.error(format!("duplicate {category} id \"{id}\""));
                }
                // ONLY commands. Every contribution registry is keyed by
                // (extensionId, id), so a panel or setting id shares no
                // namespace with another extension's - warning about those
                // would be noise on correct manifests, which is how a linter
                // teaches people to stop reading it.
                //
                // Commands are the exception, and not because of the registry:
                // the user's keybinding OVERRIDES map in Settings -> Shortcuts
                // is keyed by command id ALONE. Two extensions both declaring
                // `format` would silently share one rebind.
                if category == "command" && !id.starts_with(&m.id) {
                    r.warn(format!(
                        "command id \"{id}\" is not namespaced under \"{}\" - a user's keybinding override is stored by command id alone, so two extensions using this id would share one rebind",
                        m.id
                    ));
                }
            }
        }
    }

    for kb in contrib(c, "keybindings") {
        match str_field(kb, "command") {
            Some(cmd) if !command_ids.contains(cmd) => r.error(format!(
                "keybinding targets \"{cmd}\", which is not in contributes.commands - the key would do nothing"
            )),
            None => r.error("keybinding has no `command`".to_string()),
            _ => {}
        }
    }

    for panel in contrib(c, "panels") {
        if let Some(cmd) = str_field(panel, "toggleCommand") {
            if !command_ids.contains(cmd) {
                r.error(format!(
                    "panel toggleCommand \"{cmd}\" is not in contributes.commands"
                ));
            }
        }
        if str_field(panel, "kind") == Some("action") && str_field(panel, "toggleCommand").is_none()
        {
            r.error(
                "a panel with kind \"action\" needs a toggleCommand - there is nothing else for its button to run"
                    .to_string(),
            );
        }
    }
    if !contrib(c, "panels").is_empty() && !m.permissions.iter().any(|p| p == "panels:register") {
        r.error(
            "contributes.panels needs the \"panels:register\" permission, or registerPanelRenderer throws".to_string(),
        );
    }

    for s in contrib(c, "settings") {
        if str_field(s, "type") == Some("select")
            && s.get("options")
                .and_then(Value::as_array)
                .is_none_or(|o| o.is_empty())
        {
            r.error(format!(
                "setting \"{}\" is a select with no options",
                str_field(s, "id").unwrap_or("?")
            ));
        }
    }

    for tool in contrib(c, "aiTools") {
        if str_field(tool, "description").is_none_or(str::is_empty) {
            r.error(format!(
                "aiTool \"{}\" has no description - the model has nothing to decide on",
                str_field(tool, "name").unwrap_or("?")
            ));
        }
    }
}

fn check_metadata(m: &Manifest, raw: &Value, r: &mut Report) {
    if m.description.as_deref().is_none_or(str::is_empty) {
        r.warn("no description - the Settings card and the install dialog show it");
    }
    if m.icon.is_none() {
        r.warn("no icon - the extension list falls back to a generic mark");
    }
    if m.author.as_deref().is_none_or(str::is_empty) {
        r.warn("no author");
    }
    if raw.get("$schema").is_none() {
        r.warn(
            "no \"$schema\" - adding \"./manifest.schema.json\" gives you completion and inline validation while editing this file (`tedi ext types` writes the schema)",
        );
    }
    match m.engines.as_ref().and_then(|e| e.tedi.as_deref()) {
        None => r.warn(
            "no engines.tedi - name the TEDI version that added the newest API you call, so an older host refuses instead of half-working",
        ),
        Some(req) => {
            let host = env!("CARGO_PKG_VERSION");
            if !satisfies(req, host) {
                r.warn(format!(
                    "engines.tedi \"{req}\" is not satisfied by this TEDI ({host}) - it will install but refuse to activate here"
                ));
            }
        }
    }
    // Left-behind scaffold text. Cheap to check, and it is the single most
    // common thing to forget between `tedi ext create` and the first publish.
    if m.description.as_deref() == Some(&format!("{} for TEDI.", m.name)) {
        r.warn("description is still the scaffold placeholder");
    }
}

fn print_report(m: &Manifest, r: &Report) {
    println!(
        "\n{} {} {}",
        paint_header("validate"),
        paint_id(&m.id),
        paint_dim(&m.version)
    );
    for e in &r.errors {
        println!("  {} {e}", paint_err("error"));
    }
    for w in &r.warnings {
        println!("  {}  {w}", paint_warn("warn"));
    }
    if r.errors.is_empty() && r.warnings.is_empty() {
        println!("  {} nothing to report", paint_ok("ok"));
    }
    println!(
        "\n{}\n",
        paint_dim(&format!(
            "{} error(s), {} warning(s)",
            r.errors.len(),
            r.warnings.len()
        ))
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Manifest {
        Manifest::parse(json).expect("fixture should parse")
    }

    /// The permission list must survive the trip through the generated schema,
    /// or every unknown-permission warning silently turns off.
    #[test]
    fn known_permissions_come_from_the_embedded_schema() {
        let known = known_permissions();
        assert!(known.contains("ui:toast"), "got {known:?}");
        assert!(known.contains("ai:prompt"));
        assert!(!known.contains("invoke:fs_read_file"));
    }

    #[test]
    fn flags_a_keybinding_with_no_command() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","contributes":{
                "commands":[{"id":"a.b.one","title":"One"}],
                "keybindings":[{"command":"a.b.typo","key":"Mod+K"}]}}"#,
        );
        let mut r = Report::default();
        check_contributions(&m, &mut r);
        assert!(
            r.errors.iter().any(|e| e.contains("a.b.typo")),
            "{:?}",
            r.errors
        );
    }

    #[test]
    fn accepts_a_matching_keybinding() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","contributes":{
                "commands":[{"id":"a.b.one","title":"One"}],
                "keybindings":[{"command":"a.b.one","key":"Mod+K"}]}}"#,
        );
        let mut r = Report::default();
        check_contributions(&m, &mut r);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
    }

    #[test]
    fn panels_require_their_permission() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","contributes":{
                "panels":[{"id":"a.b.p","title":"P","surface":"right"}]}}"#,
        );
        let mut r = Report::default();
        check_contributions(&m, &mut r);
        assert!(
            r.errors.iter().any(|e| e.contains("panels:register")),
            "{:?}",
            r.errors
        );
    }

    /// An unknown permission must never be an error: it is how an extension
    /// built for a newer TEDI stays installable on an older one.
    #[test]
    fn unknown_permission_warns_but_does_not_error() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","permissions":["ui:tost","invoke:fs_read_file"]}"#,
        );
        let mut r = Report::default();
        check_permissions(&m, &mut r);
        assert!(r.errors.is_empty());
        assert!(
            r.warnings.iter().any(|w| w.contains("ui:tost")),
            "{:?}",
            r.warnings
        );
        // A legitimate exact invoke grant is silent.
        assert!(!r.warnings.iter().any(|w| w.contains("fs_read_file")));
    }

    #[test]
    fn hard_denied_and_glob_invokes_warn() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","permissions":["invoke:secrets_get","invoke:git_*"]}"#,
        );
        let mut r = Report::default();
        check_permissions(&m, &mut r);
        assert_eq!(r.warnings.len(), 2, "{:?}", r.warnings);
        assert!(r.warnings[0].contains("hard-denied"));
        assert!(r.warnings[1].contains("glob"));
    }

    #[test]
    fn select_setting_needs_options() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","contributes":{
                "settings":[{"id":"a.b.mode","type":"select","label":"Mode"}]}}"#,
        );
        let mut r = Report::default();
        check_contributions(&m, &mut r);
        assert!(
            r.errors.iter().any(|e| e.contains("select")),
            "{:?}",
            r.errors
        );
    }

    #[test]
    fn unprefixed_command_id_warns() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","contributes":{
                "commands":[{"id":"format","title":"Format"}]}}"#,
        );
        let mut r = Report::default();
        check_contributions(&m, &mut r);
        assert!(
            r.warnings.iter().any(|w| w.contains("namespaced")),
            "{:?}",
            r.warnings
        );
    }

    /// Panels and settings are keyed per extension, so an unprefixed id there
    /// collides with nothing. Warning about those was a false positive on two
    /// shipped extensions - and a linter that cries wolf on correct manifests
    /// is one people stop reading.
    #[test]
    fn unprefixed_panel_and_setting_ids_are_silent() {
        let m = parse(
            r#"{"id":"a.b","name":"B","version":"1.0.0","permissions":["panels:register"],"contributes":{
                "panels":[{"id":"main","title":"Main","surface":"right"}],
                "settings":[{"id":"relayUrl","type":"string","label":"Relay"}]}}"#,
        );
        let mut r = Report::default();
        check_contributions(&m, &mut r);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    }
}
