//! Headless `tedi --update` / `tedi -u`. Sibling of `cli_ext.rs`; same
//! short-circuit pattern for the updater. Runs on all three desktop OSes
//! without booting Tauri.
//!
//! Flow:
//! 1. Fetch `latest.json` from the configured endpoint.
//! 2. Compare versions via `compare_versions` from the extensions helper.
//! 3. Prompt on a TTY, auto-accept on non-interactive shells.
//! 4. Download the platform-matching bundle and verify its minisign
//!    signature against the pubkey baked into `tauri.conf.json`.
//! 5. Install in place per platform:
//!    - Windows: spawn the NSIS installer with `/PASSIVE /UPDATE` so it
//!      replaces `TEDI.exe`. Same flags as `tauri-plugin-updater` with
//!      `installMode: "passive"`.
//!    - Linux: AppImage in-place swap via `$APPIMAGE`. `.deb`/`.rpm`
//!      installs go through the system package manager; we print a hint
//!      pointing at `apt` / `dnf` instead of pretending to update.
//!    - macOS: extract `.app.tar.gz` via `tar -xzf`, rename the current
//!      `.app` aside, move the new one into place.
//!
//! `ENDPOINT` and `PUBKEY_B64` must match `plugins.updater.endpoints[0]`
//! and `plugins.updater.pubkey` in `tauri.conf.json`. Embedded by hand
//! because `generate_context!` only exposes them post-boot.

use std::io::{IsTerminal, Write};
use std::sync::OnceLock;

use crate::modules::cli;
use crate::modules::extensions::commands as ext_cmd;

// ----- ANSI helpers -----------------------------------------------------
// Mirrors the gating in `cli.rs` / `cli_ext.rs` / `cli_theme.rs` so all
// four `tedi` CLI surfaces speak the same palette and respect NO_COLOR.

fn color_enabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none())
}

fn ansi(code: &str, text: &str) -> String {
    if color_enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

fn paint_dim(s: &str) -> String {
    ansi("2", s)
}
fn paint_id(s: &str) -> String {
    ansi("33;1", s)
}
fn paint_ok(s: &str) -> String {
    ansi("32", s)
}
fn paint_warn(s: &str) -> String {
    ansi("33", s)
}
fn paint_header(s: &str) -> String {
    ansi("36;1", s)
}

/// Update manifest URL. Mirrors `plugins.updater.endpoints[0]` in
/// `tauri.conf.json`. Tauri normally fetches this from inside the app; we
/// hit it directly with our shared HTTP helper.
const ENDPOINT: &str = "https://github.com/IlhamriSKY/TEDI/releases/latest/download/latest.json";

/// Base64-encoded minisign public key. Mirrors `plugins.updater.pubkey`
/// in `tauri.conf.json`. Updating one without the other splits the trust
/// roots between GUI and CLI; keep them in lock-step.
const PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYwODYyOTk4OTJBQ0VBRTUKUldUbDZxeVNtQ21HWUM2c3dKb0N1b3Q3ZE9oTjJNOG0vSzgvVThuMXFleFdDVUlXdzhHYkpuenEK";

#[derive(serde::Deserialize, Debug)]
struct Manifest {
    /// Tag-name style, usually prefixed with `v`. Stripped via
    /// `strip_v_prefix` before semver-compare.
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[derive(serde::Deserialize, Debug, Clone)]
struct PlatformEntry {
    /// Multi-line minisign signature blob, base64 inside its own framing.
    /// `minisign-verify::Signature::decode` parses the file format directly.
    signature: String,
    /// Bundle download URL. Hosted on the GitHub release the manifest came
    /// from. `http_get_bytes` follows redirects to the S3 asset host.
    url: String,
}

/// Run the headless update flow and exit. Returns without acting when
/// `--update` / `-u` is not in argv.
///
/// One escape hatch from "exit": when a TEDI GUI is already running on this
/// machine, return without `process::exit` so the rest of `lib::run` can
/// boot Tauri. `tauri-plugin-single-instance` then detects the existing
/// window, forwards `--update` via `tedi:trigger-update`, and exits this
/// duplicate process. The in-app updater (`useUpdater`) handles the
/// download / close / install / relaunch dance through `tauri-plugin-updater`,
/// which is the only path that works on Windows when `TEDIApp.exe` is in
/// use (NSIS cannot replace a mapped binary, so the headless install would
/// silently no-op).
pub fn handle_update_command_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().skip(1).any(|a| cli::is_update_flag(a)) {
        return;
    }
    cli::attach_parent_console();

    if another_gui_instance_is_running() {
        println!(
            "{} {}",
            paint_ok("→"),
            paint_dim(
                "TEDI is already running. Forwarding update request to the in-app updater..."
            ),
        );
        let _ = std::io::stdout().flush();
        return;
    }

    let code = match run_update() {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "tedi --update: {e}");
            1
        }
    };
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(code);
}

/// Detect whether another `TEDIApp` GUI process is alive on this machine.
///
/// Windows is the case that motivated this: NSIS cannot overwrite a
/// `TEDIApp.exe` that is currently mapped by the running GUI, so the headless
/// install silently no-ops. On macOS / Linux a POSIX rename succeeds even
/// while the binary is mapped (the running process keeps the old inode), so
/// the headless flow there does not need the same hand-off and we return
/// `false` to preserve the existing path.
#[cfg(target_os = "windows")]
fn another_gui_instance_is_running() -> bool {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // The current process is `TEDIApp.exe --update` itself (spawned by the
    // `tedi.exe` launcher), so we must exclude our own PID from the scan.
    let current_pid = std::process::id();
    // SAFETY: CreateToolhelp32Snapshot returns INVALID_HANDLE_VALUE on
    // failure (checked below). Process32FirstW / Process32NextW iterate the
    // snapshot until they return 0. `entry.szExeFile` is a fixed-size wide
    // buffer the OS fills with a null-terminated process image name.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID != current_pid {
                    let name_len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = OsString::from_wide(&entry.szExeFile[..name_len]);
                    if name
                        .to_string_lossy()
                        .eq_ignore_ascii_case("TEDIApp.exe")
                    {
                        found = true;
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(not(target_os = "windows"))]
fn another_gui_instance_is_running() -> bool {
    // POSIX rename swaps the bundle file even while the running GUI has it
    // mapped, so headless install is non-destructive on macOS / Linux. Add
    // platform-specific enumeration here if the in-app updater ever needs
    // to own this flow too.
    false
}

fn run_update() -> Result<(), String> {
    let current = env!("CARGO_PKG_VERSION");
    println!(
        "{} {} {}",
        paint_header("TEDI"),
        paint_id(&format!("v{current}")),
        paint_dim("checking for updates..."),
    );

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;

    let json = runtime.block_on(ext_cmd::http_get_text(ENDPOINT))?;
    let manifest: Manifest =
        serde_json::from_str(&json).map_err(|e| format!("parse latest.json: {e}"))?;

    let latest = ext_cmd::strip_v_prefix(&manifest.version);
    let cmp = ext_cmd::compare_versions(current, &latest);
    if cmp != std::cmp::Ordering::Less {
        println!(
            "{} Already on the latest version {}.",
            paint_ok("✓"),
            paint_id(&format!("(v{current})")),
        );
        return Ok(());
    }
    println!(
        "{} {} -> {}",
        paint_warn("Update available:"),
        paint_dim(&format!("v{current}")),
        paint_id(&format!("v{latest}")),
    );

    let key = current_platform_key()?;
    let platform = manifest
        .platforms
        .get(&key)
        .ok_or_else(|| {
            let mut available: Vec<&str> = manifest.platforms.keys().map(|s| s.as_str()).collect();
            available.sort();
            format!(
                "no `{key}` entry in latest.json (available: {})",
                available.join(", ")
            )
        })?
        .clone();

    if !manifest.notes.is_empty() {
        println!();
        println!("{}", paint_header("Release notes:"));
        // 30-line cap keeps the prompt visible on long changelogs.
        for line in manifest.notes.lines().take(30) {
            // Strip control / escape bytes: `notes` comes from the
            // network-fetched (unsigned) latest.json, so an embedded ESC/OSC
            // sequence could spoof the terminal (title, OSC 8 links, OSC 52
            // clipboard). Keep tab; drop every other control char.
            let safe: String = line.chars().filter(|c| !c.is_control() || *c == '\t').collect();
            println!("  {safe}");
        }
        let extra = manifest.notes.lines().count().saturating_sub(30);
        if extra > 0 {
            println!("  {}", paint_dim(&format!("({extra} more line(s) omitted)")));
        }
        println!();
    }

    // Confirm on a TTY; in a non-interactive shell, assume the caller
    // meant it. Mirrors `apt -y` under automation.
    if std::io::stdin().is_terminal() {
        print!(
            "Download and install {}? (y/N): ",
            paint_id(&format!("v{latest}"))
        );
        let _ = std::io::stdout().flush();
        let mut buf = String::new();
        let n = std::io::stdin()
            .read_line(&mut buf)
            .map_err(|e| format!("read stdin: {e}"))?;
        if n == 0 || !buf.trim().eq_ignore_ascii_case("y") {
            println!("{}", paint_dim("Skipped."));
            return Ok(());
        }
    } else {
        println!("{}", paint_dim("Non-interactive shell; proceeding with download."));
    }

    println!("{} {}", paint_dim("Downloading"), platform.url);
    let bytes = runtime.block_on(ext_cmd::http_get_bytes(&platform.url))?;
    println!(
        "{} {}",
        paint_dim("Downloaded"),
        paint_dim(&format!("{} bytes.", bytes.len())),
    );

    println!("{}", paint_dim("Verifying signature..."));
    verify_signature(&bytes, &platform.signature)?;
    println!("{} {}", paint_ok("✓"), paint_ok("Signature OK."));

    println!("{}", paint_dim("Installing..."));
    let outcome = install_bundle(&bytes, &platform.url)?;
    println!("{} {outcome}", paint_ok("✓"));
    Ok(())
}

/// Tauri updater manifest key for this build: `<os>-<arch>` where `os` is
/// `windows` / `darwin` / `linux` and `arch` is `x86_64` / `aarch64` / `i686`.
fn current_platform_key() -> Result<String, String> {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("unsupported os for updater".into());
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "i686"
    } else {
        return Err("unsupported arch for updater".into());
    };
    Ok(format!("{os}-{arch}"))
}

/// Verify a Tauri-style minisign signature over `data`.
///
/// Both inputs carry an extra base64 layer in Tauri's manifest + config
/// format. `PUBKEY_B64` is base64 of the standard minisign public-key
/// file text; `signature_b64` is base64 of the standard minisign
/// signature file text. We strip the outer base64 on each side and hand
/// the plain-text minisign file contents to `minisign_verify`.
fn verify_signature(data: &[u8], signature_b64: &str) -> Result<(), String> {
    use base64::Engine as _;
    use minisign_verify::{PublicKey, Signature};

    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(PUBKEY_B64.as_bytes())
        .map_err(|e| format!("decode pubkey base64: {e}"))?;
    let pk_text = std::str::from_utf8(&pk_bytes).map_err(|e| format!("decode pubkey utf8: {e}"))?;
    let pk = PublicKey::decode(pk_text.trim()).map_err(|e| format!("decode pubkey: {e}"))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim().as_bytes())
        .map_err(|e| format!("decode signature base64: {e}"))?;
    let sig_text =
        std::str::from_utf8(&sig_bytes).map_err(|e| format!("decode signature utf8: {e}"))?;
    let sig = Signature::decode(sig_text.trim()).map_err(|e| format!("decode signature: {e}"))?;

    // `allow_legacy = false` rejects pre-hashed signatures (we never produce them).
    pk.verify(data, &sig, false)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// Windows: write the bundle to `%TEMP%` and spawn the NSIS installer with
/// `/PASSIVE /UPDATE`. Matches `tauri-plugin-updater` with
/// `installMode: "passive"`. The current process exits right after; NSIS
/// holds no handles on the running EXE, so it can replace `TEDI.exe`.
#[cfg(target_os = "windows")]
fn install_bundle(bytes: &[u8], url: &str) -> Result<String, String> {
    // Derive the installer filename from the (network-controlled) URL, but
    // sanitize it: strip any query/fragment and reject path separators or a
    // non-.exe name so a crafted URL can't steer the write outside %TEMP% or
    // produce an invalid path. The bytes are already minisign-verified, so
    // this is hardening, not the RCE gate.
    let raw = url
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("tedi-update.exe");
    let cleaned = raw.split(['?', '#']).next().unwrap_or("");
    let safe_name = if cleaned.is_empty()
        || cleaned.chars().any(|c| matches!(c, '/' | '\\' | ':'))
        || !cleaned.to_ascii_lowercase().ends_with(".exe")
    {
        "tedi-update.exe"
    } else {
        cleaned
    };
    let path = std::env::temp_dir().join(safe_name);
    std::fs::write(&path, bytes).map_err(|e| format!("write installer: {e}"))?;
    // `/PASSIVE` shows a non-interactive progress dialog; `/UPDATE` tells
    // the NSIS hook to skip the "already installed" check and overwrite.
    // Both flags come from the Tauri NSIS template.
    std::process::Command::new(&path)
        .args(["/PASSIVE", "/UPDATE"])
        .spawn()
        .map_err(|e| format!("spawn installer: {e}"))?;
    Ok("Installer launched in passive mode. \
        Re-open with `tedi` once the progress window closes."
        .into())
}

/// Linux: AppImage in-place swap. Requires `$APPIMAGE` (set by the AppImage
/// runtime to the .AppImage file the user keeps around). `.deb`/`.rpm`
/// installs go through the system package manager; we print a hint instead
/// of pretending to update.
#[cfg(target_os = "linux")]
fn install_bundle(bytes: &[u8], _url: &str) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let appimage = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| {
            "`tedi --update` on Linux supports AppImage installs only.\n\
             Run from an .AppImage file (so $APPIMAGE is set), or use your \
             package manager for .deb/.rpm installs \
             (e.g. `sudo apt update && sudo apt install --only-upgrade tedi`)."
                .to_string()
        })?;
    let appimage_str = appimage.to_string_lossy().into_owned();
    let new_path = std::path::PathBuf::from(format!("{appimage_str}.new"));
    let old_path = std::path::PathBuf::from(format!("{appimage_str}.old"));
    let _ = std::fs::remove_file(&new_path);
    std::fs::write(&new_path, bytes).map_err(|e| format!("write {}: {e}", new_path.display()))?;
    let mut perms = std::fs::metadata(&new_path)
        .map_err(|e| format!("stat new appimage: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&new_path, perms).map_err(|e| format!("chmod new appimage: {e}"))?;
    // Atomic-ish swap: rename current aside, rename new into place, remove
    // the backup on success.
    let _ = std::fs::remove_file(&old_path);
    std::fs::rename(&appimage, &old_path).map_err(|e| format!("backup current appimage: {e}"))?;
    if let Err(e) = std::fs::rename(&new_path, &appimage) {
        // Best-effort rollback so the user is not left without TEDI.
        let _ = std::fs::rename(&old_path, &appimage);
        return Err(format!("swap in new appimage: {e}"));
    }
    let _ = std::fs::remove_file(&old_path);
    Ok(format!(
        "AppImage updated in place at {appimage_str}. Re-run `tedi` to launch the new version."
    ))
}

/// macOS: bundle is a `.app.tar.gz`. Unpack with the system `tar` (always
/// present), find the extracted `.app`, rename the running `.app` to
/// `<name>.app.old`, move the new one into place, and clean up. The
/// process exits right after; exec'd dylibs are already in memory, so
/// swapping the on-disk bundle is safe.
#[cfg(target_os = "macos")]
fn install_bundle(bytes: &[u8], _url: &str) -> Result<String, String> {
    use std::process::Command;
    let pid = std::process::id();
    let staging = std::env::temp_dir().join(format!("tedi-update-{pid}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir staging: {e}"))?;
    let tarball = staging.join("update.tar.gz");
    std::fs::write(&tarball, bytes).map_err(|e| format!("write tarball: {e}"))?;

    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&tarball)
        .arg("-C")
        .arg(&staging)
        .status()
        .map_err(|e| format!("spawn tar: {e}"))?;
    if !status.success() {
        return Err(format!("tar -xzf failed (exit {status:?})"));
    }

    let extracted_app = std::fs::read_dir(&staging)
        .map_err(|e| format!("read staging: {e}"))?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_dir() && p.extension().and_then(|s| s.to_str()) == Some("app"))
        .ok_or_else(|| "no .app/ inside extracted tarball".to_string())?;

    let current_exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let current_app = find_app_root(&current_exe).ok_or_else(|| {
        format!(
            "could not locate the running .app bundle from {} \
             (run from an installed TEDI.app; `tedi --update` cannot \
             update a `cargo run` binary)",
            current_exe.display()
        )
    })?;

    let backup = std::path::PathBuf::from(format!("{}.old", current_app.display()));
    let _ = std::fs::remove_dir_all(&backup);
    // `mv` handles cross-filesystem moves between /var/folders (staging) and
    // /Applications (typical install) where std::fs::rename would EXDEV.
    let st = Command::new("mv")
        .arg(&current_app)
        .arg(&backup)
        .status()
        .map_err(|e| format!("spawn mv backup: {e}"))?;
    if !st.success() {
        return Err("mv current.app -> backup failed".into());
    }
    let st = Command::new("mv")
        .arg(&extracted_app)
        .arg(&current_app)
        .status()
        .map_err(|e| format!("spawn mv install: {e}"))?;
    if !st.success() {
        // Rollback so the user is not left without TEDI.
        let _ = Command::new("mv").arg(&backup).arg(&current_app).status();
        return Err("mv new.app -> install failed".into());
    }
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&backup);
    Ok(format!(
        "Replaced {} in place. Re-run `tedi` to launch the new version.",
        current_app.display()
    ))
}

#[cfg(target_os = "macos")]
fn find_app_root(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut cur = exe.parent()?;
    loop {
        if cur.extension().and_then(|s| s.to_str()) == Some("app") {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
}

// Catch-all so the file compiles on targets the rest of the crate gates out
// (android / ios). Reached only when argv had `--update` on such a target.
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn install_bundle(_bytes: &[u8], _url: &str) -> Result<String, String> {
    Err("headless updater not implemented for this target".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_key_for_current_target() {
        // Whatever this test runs on must round-trip cleanly: no panic,
        // result follows the `<os>-<arch>` shape.
        let key = current_platform_key().expect("platform key");
        let parts: Vec<&str> = key.split('-').collect();
        assert_eq!(parts.len(), 2, "expected `<os>-<arch>`, got `{key}`");
        assert!(
            matches!(parts[0], "windows" | "darwin" | "linux"),
            "unexpected os segment: {}",
            parts[0]
        );
        assert!(
            matches!(parts[1], "x86_64" | "aarch64" | "i686"),
            "unexpected arch segment: {}",
            parts[1]
        );
    }

    #[test]
    fn manifest_parses_tauri_shape() {
        let sample = r#"{
            "version": "v0.2.13",
            "notes": "Bug fixes\nAnd improvements",
            "pub_date": "2026-05-21T00:00:00Z",
            "platforms": {
                "windows-x86_64": {
                    "signature": "untrusted comment: signature\nABCDEF==\ntrusted comment: ts\nQRST==",
                    "url": "https://example/setup.exe"
                }
            }
        }"#;
        let m: Manifest = serde_json::from_str(sample).expect("parse");
        assert_eq!(m.version, "v0.2.13");
        assert_eq!(m.notes.lines().count(), 2);
        let p = m.platforms.get("windows-x86_64").expect("entry");
        assert!(p.signature.contains("ABCDEF=="));
        assert_eq!(p.url, "https://example/setup.exe");
    }

    #[test]
    fn pubkey_constant_decodes() {
        // Catch any edit to the constant that forgot to re-encode, before
        // signature verification would silently break on every release.
        use base64::Engine as _;
        let pk_bytes = base64::engine::general_purpose::STANDARD
            .decode(PUBKEY_B64.as_bytes())
            .expect("base64 decode");
        let pk_text = std::str::from_utf8(&pk_bytes).expect("utf8");
        assert!(
            pk_text.contains("minisign public key"),
            "decoded pubkey is missing the minisign header line"
        );
        minisign_verify::PublicKey::decode(pk_text.trim()).expect("minisign decode");
    }

    /// Diagnostic: print the raw signature blob for the current platform
    /// from `latest.json`. Useful when the live verify test fails because
    /// the manifest's signature framing differs from what
    /// `minisign-verify::Signature::decode` expects.
    #[test]
    #[ignore]
    fn live_updater_dump_signature() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let json = runtime
            .block_on(ext_cmd::http_get_text(ENDPOINT))
            .expect("fetch latest.json");
        let m: Manifest = serde_json::from_str(&json).expect("parse manifest");
        let key = current_platform_key().expect("platform key");
        let entry = m.platforms.get(&key).expect("platform entry");
        eprintln!("--- signature for {key} ---");
        eprintln!("{}", entry.signature);
        eprintln!("--- end signature ---");
        eprintln!("byte len: {}", entry.signature.len());
        eprintln!("line count: {}", entry.signature.lines().count());
        for (i, line) in entry.signature.lines().enumerate() {
            eprintln!("  line {i}: ({} chars) {}", line.len(), line);
        }
    }

    /// Live smoke test: hit the configured endpoint, parse, and verify the
    /// signature for whichever platform `latest.json` lists for the current
    /// OS/arch. `#[ignore]` because it hits the network and downloads
    /// several MB. Run with
    /// `cargo test live_updater -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_updater_manifest_and_signature_verify() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let json = runtime
            .block_on(ext_cmd::http_get_text(ENDPOINT))
            .expect("fetch latest.json");
        eprintln!("manifest first 200 chars: {}", &json[..json.len().min(200)]);
        let m: Manifest = serde_json::from_str(&json).expect("parse manifest");
        eprintln!("upstream version: {}", m.version);
        let key = current_platform_key().expect("platform key");
        let Some(platform) = m.platforms.get(&key) else {
            eprintln!(
                "skip: no `{key}` in manifest (have: {:?})",
                m.platforms.keys().collect::<Vec<_>>()
            );
            return;
        };
        let bytes = runtime
            .block_on(ext_cmd::http_get_bytes(&platform.url))
            .expect("download bundle");
        eprintln!("downloaded {} bytes from {}", bytes.len(), platform.url);
        verify_signature(&bytes, &platform.signature).expect("signature verify");
        eprintln!("ok: signature verified for {key}");
    }
}
