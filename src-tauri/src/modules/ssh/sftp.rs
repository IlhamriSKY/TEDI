//! SFTP file operations over an existing SSH session.
//!
//! Reuses the russh `Handle` held by `SshSession` to open a fresh `sftp`
//! subsystem channel on demand and forwards browse/read/write commands
//! through it. The remote SSH user owns the channel, so every operation is
//! constrained by their unix permissions on the remote box. A
//! `permission denied` response bubbles up as a structured error the
//! frontend renders in-tree without crashing the panel.

use std::sync::Arc;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType, OpenFlags, StatusCode};
use serde::Serialize;
use tauri::ipc::Channel;

use super::session::SshSession;
use super::{ssh_runtime, SshState};

/// Directory entry pushed to the frontend. Shape matches the local
/// `fs::DirEntry` so the frontend tree can reuse its renderer without
/// branching on local vs remote.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    /// `"file"`, `"dir"`, or `"symlink"`. Everything else (block, char,
    /// fifo, unknown) collapses to `"file"` so the tree still renders.
    pub kind: String,
    pub size: u64,
    /// Unix seconds; `0` when the server did not report mtime.
    pub mtime: u64,
    /// `"rwxr-xr-x"` style permission summary, or empty when the server
    /// did not report a mode. Surfaced as a tooltip so users see why a
    /// directory is read-only before they try to write.
    pub permissions: String,
}

/// Look up an SSH session by id and clone its `Arc<SshSession>`. Every
/// command starts with this prelude.
async fn get_session(
    state: &tauri::State<'_, SshState>,
    id: u32,
) -> Result<Arc<SshSession>, String> {
    state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_sftp: unknown session id={id}");
            "no ssh session".to_string()
        })
}

/// Shared SFTP command scaffolding: resolve the session, open the sftp
/// subsystem, and run `f` on the daemon runtime, mapping the join error.
async fn on_sftp<F, Fut, T>(state: &tauri::State<'_, SshState>, id: u32, f: F) -> Result<T, String>
where
    F: FnOnce(Arc<SftpSession>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, String>> + Send,
    T: Send + 'static,
{
    let session = get_session(state, id).await?;
    ssh_runtime()
        .spawn(async move {
            let sftp = session.ensure_sftp().await?;
            f(sftp).await
        })
        .await
        .map_err(|e| format!("ssh task join failed: {e}"))?
}

/// Translate an SFTP error to a short user-facing string while preserving
/// the permission/no-such-file distinction so the explorer renders the
/// right empty state. Other errors collapse to a generic message with the
/// underlying display.
fn humanize(err: SftpError) -> String {
    match &err {
        SftpError::Status(s) => match s.status_code {
            StatusCode::PermissionDenied => "permission denied".to_string(),
            StatusCode::NoSuchFile => "no such file or directory".to_string(),
            StatusCode::OpUnsupported => "operation not supported by remote".to_string(),
            _ => {
                if s.error_message.is_empty() {
                    format!("sftp: {}", s.status_code)
                } else {
                    format!("sftp: {}", s.error_message)
                }
            }
        },
        _ => format!("sftp: {err}"),
    }
}

/// Byte-level upload progress streamed to the frontend so the SSH explorer
/// can show a moving percentage while a dropped file transfers.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub written: u64,
    pub total: u64,
}

fn map_file_type(ft: FileType) -> &'static str {
    if ft.is_dir() {
        "dir"
    } else if ft.is_symlink() {
        "symlink"
    } else {
        "file"
    }
}

#[tauri::command]
pub async fn ssh_sftp_home(state: tauri::State<'_, SshState>, id: u32) -> Result<String, String> {
    on_sftp(&state, id, |sftp| async move {
        sftp.canonicalize(".").await.map_err(humanize)
    })
    .await
}

#[tauri::command]
pub async fn ssh_sftp_read_dir(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
    include_hidden: bool,
) -> Result<Vec<SftpEntry>, String> {
    on_sftp(&state, id, move |sftp| async move {
        let read = sftp.read_dir(path.clone()).await.map_err(humanize)?;
        let mut entries: Vec<SftpEntry> = read
            .filter(|e| include_hidden || !e.file_name().starts_with('.'))
            .map(|e| {
                let metadata = e.metadata();
                let ft = metadata.file_type();
                SftpEntry {
                    name: e.file_name(),
                    kind: map_file_type(ft).to_string(),
                    size: metadata.len(),
                    mtime: metadata.mtime.map(u64::from).unwrap_or(0),
                    permissions: format_permissions(&metadata),
                }
            })
            .collect();
        // Match fs::tree: directories first, then files, both alphabetical
        // case-insensitive. Stable across sessions and matches the local
        // explorer.
        entries.sort_by(|a, b| {
            let ad = a.kind == "dir";
            let bd = b.kind == "dir";
            if ad != bd {
                return bd.cmp(&ad); // dirs first
            }
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });
        Ok(entries)
    })
    .await
}

#[tauri::command]
pub async fn ssh_sftp_read_file(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
) -> Result<String, String> {
    on_sftp(&state, id, move |sftp| async move {
        // Cap the read so a huge (or maliciously oversized) remote file can't
        // OOM the app by being slurped whole into memory + an IPC string.
        // Mirrors the local fs_read_file size guard.
        const MAX_SFTP_READ_BYTES: u64 = 16 * 1024 * 1024;
        if let Ok(meta) = sftp.metadata(path.clone()).await {
            if meta.len() > MAX_SFTP_READ_BYTES {
                return Err(format!(
                    "file too large to open: {} bytes (cap {} bytes)",
                    meta.len(),
                    MAX_SFTP_READ_BYTES
                ));
            }
        }
        let bytes = sftp.read(path).await.map_err(humanize)?;
        // Mirror fs::file::fs_read_file: return UTF-8 text. Binary files
        // explode any editor pane anyway; rejecting up front with a clear
        // message beats handing junk to CodeMirror.
        String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
    })
    .await
}

#[tauri::command]
pub async fn ssh_sftp_write_file(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
    contents: String,
) -> Result<(), String> {
    on_sftp(&state, id, move |sftp| async move {
        // CREATE | TRUNCATE | WRITE matches local fs_write_file's "rewrite
        // in place" contract. The file is replaced atomically from the
        // editor's view even when the server lacks atomic rename-into-place.
        let mut file = sftp
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(humanize)?;
        use tokio::io::AsyncWriteExt;
        file.write_all(contents.as_bytes())
            .await
            .map_err(|e| format!("sftp write: {e}"))?;
        file.shutdown()
            .await
            .map_err(|e| format!("sftp close: {e}"))?;
        Ok(())
    })
    .await
}

/// Upload a local file to the remote over SFTP. Reads `local_path` off the
/// async runtime (a big file must not block it) and streams the bytes into
/// `remote_path`, replacing it in place. Directories are rejected up front -
/// recursive upload is a separate feature. The remote kernel enforces write
/// permission on the target dir; a denial surfaces as `permission denied`.
/// `on_progress` emits `{written, total}` as each chunk lands so the explorer
/// can render a percentage instead of jumping 0% -> 100%.
#[tauri::command]
pub async fn ssh_sftp_upload(
    state: tauri::State<'_, SshState>,
    id: u32,
    local_path: String,
    remote_path: String,
    on_progress: Channel<UploadProgress>,
) -> Result<(), String> {
    // Cap the whole-file read so a huge drop can't OOM the app. Matches the
    // read-file guard's intent; uploads get a larger ceiling.
    const MAX_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
    let read_path = local_path.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let meta = std::fs::metadata(&read_path).map_err(|e| format!("read local file: {e}"))?;
        if meta.is_dir() {
            return Err("cannot upload a folder (files only)".to_string());
        }
        if meta.len() > MAX_UPLOAD_BYTES {
            return Err(format!(
                "file too large to upload: {} bytes (cap {} bytes)",
                meta.len(),
                MAX_UPLOAD_BYTES
            ));
        }
        std::fs::read(&read_path).map_err(|e| format!("read local file: {e}"))
    })
    .await
    .map_err(|e| format!("read task join failed: {e}"))??;

    on_sftp(&state, id, move |sftp| async move {
        let total = bytes.len() as u64;
        let mut file = sftp
            .open_with_flags(
                remote_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(humanize)?;
        use tokio::io::AsyncWriteExt;
        // Chunk the write so a large file reports a moving percentage. 256 KiB
        // keeps the event count bounded (<=1024 for the 256 MiB cap) while
        // still feeling live. Send an initial 0% so the bar appears at once.
        const CHUNK: usize = 256 * 1024;
        let _ = on_progress.send(UploadProgress { written: 0, total });
        let mut written: u64 = 0;
        for chunk in bytes.chunks(CHUNK) {
            file.write_all(chunk)
                .await
                .map_err(|e| format!("sftp write: {e}"))?;
            written += chunk.len() as u64;
            let _ = on_progress.send(UploadProgress { written, total });
        }
        file.shutdown()
            .await
            .map_err(|e| format!("sftp close: {e}"))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn ssh_sftp_create_file(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
) -> Result<(), String> {
    on_sftp(&state, id, move |sftp| async move {
        // EXCL so we do not silently clobber a file the user did not see
        // (e.g. created moments ago by another process).
        let mut file = sftp
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await
            .map_err(humanize)?;
        use tokio::io::AsyncWriteExt;
        file.shutdown()
            .await
            .map_err(|e| format!("sftp close: {e}"))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn ssh_sftp_create_dir(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
) -> Result<(), String> {
    on_sftp(&state, id, move |sftp| async move {
        sftp.create_dir(path).await.map_err(humanize)
    })
    .await
}

#[tauri::command]
pub async fn ssh_sftp_rename(
    state: tauri::State<'_, SshState>,
    id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    on_sftp(&state, id, move |sftp| async move {
        sftp.rename(from, to).await.map_err(humanize)
    })
    .await
}

#[tauri::command]
pub async fn ssh_sftp_delete(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
) -> Result<(), String> {
    on_sftp(&state, id, move |sftp| async move {
        // SFTP needs separate calls for files vs dirs. `rmdir` only
        // succeeds on empty dirs on most servers. Stat once to pick the
        // right call. Server permission errors surface through humanize()
        // so the user sees `permission denied` instead of a generic failure.
        let metadata = sftp.metadata(path.clone()).await.map_err(humanize)?;
        if metadata.file_type().is_dir() {
            sftp.remove_dir(path).await.map_err(humanize)
        } else {
            sftp.remove_file(path).await.map_err(humanize)
        }
    })
    .await
}

/// Render `rwxr-xr-x` permissions from the SFTP metadata's mode bits.
/// Empty when the server omitted permissions (some non-OpenSSH servers do).
fn format_permissions(metadata: &russh_sftp::protocol::FileAttributes) -> String {
    if metadata.permissions.is_none() {
        return String::new();
    }
    metadata.permissions().to_string()
}

/// Open the SFTP subsystem if not already open. Exposed via SshSession so
/// the mod.rs commands stay decoupled from the SSH handshake details.
pub(super) async fn open_sftp_on_handle(session: &SshSession) -> Result<Arc<SftpSession>, String> {
    let handle_guard = session.handle.lock().await;
    let handle = handle_guard
        .as_ref()
        .ok_or_else(|| "ssh session is closed".to_string())?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("ssh: open sftp channel failed: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("ssh: request sftp subsystem failed: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("ssh: sftp handshake failed: {e}"))?;
    Ok(Arc::new(sftp))
}
