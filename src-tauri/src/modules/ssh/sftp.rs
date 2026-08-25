//! SFTP file operations over an existing SSH session.
//!
//! Reuses the russh `Handle` held by `SshSession` to open a fresh `sftp`
//! subsystem channel on demand and forwards browse/read/write/transfer
//! commands through it. The remote SSH user owns the channel, so every
//! operation is constrained by their unix permissions on the remote box. A
//! `permission denied` response bubbles up as a structured error the
//! frontend renders in-tree without crashing the panel.
//!
//! Anything that walks a tree (recursive delete, recursive chmod, folder
//! transfer) is bounded by `MAX_WALK_ENTRIES`: one SFTP round trip per entry
//! is fine for a project folder and a terrible idea for `/`, so an oversized
//! tree is refused with a message pointing at the terminal instead.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags, StatusCode};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::session::SshSession;
use super::{ssh_runtime, SshState};

/// Ceiling on any recursive walk. Past this the operation is refused rather
/// than left to grind through tens of thousands of round trips.
const MAX_WALK_ENTRIES: usize = 20_000;
/// Transfer chunk. russh-sftp pipelines writes, so a large buffer keeps the
/// wire busy; it still caps how much of any one file is resident at a time.
const CHUNK: usize = 256 * 1024;
/// Coalesce progress events to one per megabyte. A multi-GB file must not
/// push tens of thousands of IPC messages at the webview.
const PROGRESS_STEP: u64 = 1024 * 1024;

/// Directory entry pushed to the frontend. Shape matches the local
/// `fs::DirEntry` so the frontend tree can reuse its renderer without
/// branching on local vs remote.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    /// `"file"`, `"dir"`, or `"symlink"`. For a symlink this describes what
    /// the link RESOLVES to, so the tree can expand a linked directory;
    /// `symlink` below still marks it as a link. Everything else (block,
    /// char, fifo, socket) collapses to `"file"` so the tree still renders.
    pub kind: String,
    pub size: u64,
    /// Unix seconds; `0` when the server did not report mtime.
    pub mtime: u64,
    /// `"drwxr-xr-x"` style `ls -l` summary, or empty when the server did not
    /// report a mode. Shown in the row so users see why a directory is
    /// read-only before they try to write.
    pub permissions: String,
    /// True when the entry itself is a symlink, whatever `kind` resolved to.
    pub symlink: bool,
}

/// Full metadata for one path, behind the Properties dialog.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpStat {
    /// The entry itself (`lstat`): `"file"`, `"dir"` or `"symlink"`.
    pub kind: String,
    /// What a symlink resolves to; equal to `kind` for everything else, and
    /// `"broken"` when the link points at nothing.
    pub target_kind: String,
    pub size: u64,
    /// Unix seconds, `0` when unreported.
    pub mtime: u64,
    /// Permission plus setuid/setgid/sticky bits (`mode & 0o7777`). `None`
    /// when the server reported no mode, which is what greys out the editor.
    ///
    /// For a resolvable symlink this - and every other metadata field below -
    /// describes the TARGET, not the link. SSH_FXP_SETSTAT is `chmod()`, which
    /// follows links, so showing the link's own `0o777` would let the user
    /// "edit" a mode that is not the one their Apply actually changes.
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
    pub link_target: Option<String>,
}

/// Result of a chmod. `failed` counts entries a recursive pass could not
/// touch (a subtree owned by someone else), which is a warning, not an error:
/// `chmod -R` behaves the same way.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChmodSummary {
    pub changed: u32,
    pub failed: u32,
}

/// Byte-level transfer progress streamed to the frontend so the SSH explorer
/// can show a moving percentage for both the current file and the whole job.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    /// 1-based position of the file currently moving.
    pub index: u32,
    pub count: u32,
    /// Path relative to the transfer root, so a nested file stays identifiable.
    pub name: String,
    pub written: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

impl TransferProgress {
    /// Same file, `written` bytes in. `bytesDone` counts from where this file
    /// started, so the overall bar only ever moves forward.
    fn at(&self, written: u64) -> Self {
        Self {
            written,
            bytes_done: self.bytes_done + written,
            ..self.clone()
        }
    }
}

/// Outcome of a multi-file transfer. Individual failures do not abort the
/// rest: a folder where one file is unreadable still delivers the others.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub ok: u32,
    /// `"<name>: <reason>"` per failure, in transfer order.
    pub failed: Vec<String>,
}

/// Shared SFTP command scaffolding: resolve the session, open the sftp
/// subsystem, and run `f` on the daemon runtime, mapping the join error.
async fn on_sftp<F, Fut, T>(state: &tauri::State<'_, SshState>, id: u32, f: F) -> Result<T, String>
where
    F: FnOnce(Arc<SftpSession>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, String>> + Send,
    T: Send + 'static,
{
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_sftp: unknown session id={id}");
            "no ssh session".to_string()
        })?;
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

/// Exotic types (fifo, socket, block, char) collapse to `"file"`: the tree
/// only ever branches on dir-vs-not, and they render identically. The exact
/// type is still visible in the row's `ls -l` mode string.
fn map_file_type(ft: FileType) -> &'static str {
    if ft.is_dir() {
        "dir"
    } else if ft.is_symlink() {
        "symlink"
    } else {
        "file"
    }
}

/// Join a POSIX remote directory and a name. Remote paths are always `/`
/// separated regardless of the local OS.
fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Last segment of a remote path, tolerating a trailing slash. Falls back to
/// `"root"` for `/` so a transfer of the filesystem root still has a name.
fn remote_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) if !name.is_empty() => name.to_string(),
        _ if trimmed.is_empty() => "root".to_string(),
        _ => trimmed.to_string(),
    }
}

/// One entry from a recursive remote walk.
struct WalkEntry {
    path: String,
    is_dir: bool,
    /// The entry itself is a link. Callers that would otherwise reach through
    /// it (chmod) skip it; callers that operate on the link (delete) do not.
    is_symlink: bool,
    size: u64,
}

/// Breadth-first listing of everything under `root`, which must be a
/// directory. Parents always precede their children, so callers create
/// directories in order and reverse the vector to delete children first.
///
/// Symlinks are yielded as non-directories and never descended: following a
/// link that points at `/` would take the whole server with it.
async fn walk_remote(sftp: &SftpSession, root: &str) -> Result<Vec<WalkEntry>, String> {
    let mut out: Vec<WalkEntry> = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(root.to_string());
    while let Some(dir) = queue.pop_front() {
        let read = sftp.read_dir(dir.clone()).await.map_err(humanize)?;
        for e in read {
            if out.len() >= MAX_WALK_ENTRIES {
                return Err(format!(
                    "folder holds more than {MAX_WALK_ENTRIES} entries - do this from the terminal"
                ));
            }
            let metadata = e.metadata();
            let file_type = metadata.file_type();
            let is_dir = file_type.is_dir();
            let path = join_remote(&dir, &e.file_name());
            if is_dir {
                queue.push_back(path.clone());
            }
            out.push(WalkEntry {
                path,
                is_dir,
                is_symlink: file_type.is_symlink(),
                size: metadata.len(),
            });
        }
    }
    Ok(out)
}

/// `ls -l` type character from the raw mode bits. Exact, unlike the crate's
/// four-way `FileType`, which folds fifo/socket/block/char into one variant.
fn type_char(mode: u32) -> char {
    match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        0o100000 => '-',
        0o060000 => 'b',
        0o020000 => 'c',
        0o010000 => 'p',
        0o140000 => 's',
        _ => '?',
    }
}

/// Render `drwxr-xr-x` from the SFTP metadata's mode bits. Empty when the
/// server omitted permissions (some non-OpenSSH servers do).
fn format_permissions(metadata: &FileAttributes) -> String {
    match metadata.permissions {
        None => String::new(),
        Some(mode) => format!("{}{}", type_char(mode), metadata.permissions()),
    }
}

/// Set the permission bits on one path. Uses `FileAttributes::empty()`, NOT
/// `default()`: the derived default carries size 0, uid/gid 0 and zeroed
/// timestamps, so a setstat built from it would truncate the file and reset
/// its owner along with the mode.
async fn set_mode(sftp: &SftpSession, path: &str, mode: u32) -> Result<(), String> {
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(mode & 0o7777);
    sftp.set_metadata(path, attrs).await.map_err(humanize)
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
                    symlink: ft.is_symlink(),
                }
            })
            .collect();

        // READDIR reports each symlink's own lstat, so a link to a directory
        // arrives as `symlink` and the tree refuses to expand it. Servers are
        // full of them (`current`, `/var/www/html`, `/lib`), so follow each
        // one with a stat and let `kind` describe the target. `symlink` and
        // the leading `l` in the mode string keep the row reading as a link;
        // a broken link just stays `symlink`, because the stat fails.
        //
        // Issued together rather than in a loop: SFTP tags every request with
        // an id and answers out of order, so a link-heavy directory like
        // /usr/bin costs one round trip instead of one per link. Bounded so
        // the burst can never be unreasonable, and so a pathological
        // directory does not stall the listing behind hundreds of stats.
        const MAX_SYMLINK_RESOLVE: usize = 128;
        let mut stats = tokio::task::JoinSet::new();
        for (i, entry) in entries.iter().enumerate() {
            if !entry.symlink || stats.len() >= MAX_SYMLINK_RESOLVE {
                continue;
            }
            let sftp = sftp.clone();
            let target = join_remote(&path, &entry.name);
            stats.spawn(async move { (i, sftp.metadata(target).await.ok()) });
        }
        while let Some(joined) = stats.join_next().await {
            let Ok((i, Some(meta))) = joined else {
                continue;
            };
            entries[i].kind = map_file_type(meta.file_type()).to_string();
            entries[i].size = meta.len();
        }

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
pub async fn ssh_sftp_stat(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
) -> Result<SftpStat, String> {
    on_sftp(&state, id, move |sftp| async move {
        // lstat, so the dialog edits the LINK's own mode rather than silently
        // retargeting its destination.
        let link = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(humanize)?;
        let kind = map_file_type(link.file_type()).to_string();
        // A link's own metadata is never what the dialog wants: its mode is a
        // fixed 0o777 and its size is the length of the target's path. Follow
        // it, and fall back to the link itself only when it is broken.
        let (meta, target_kind, link_target) = if link.file_type().is_symlink() {
            let target = sftp.read_link(path.clone()).await.ok();
            match sftp.metadata(path.clone()).await {
                Ok(m) => {
                    let resolved = map_file_type(m.file_type()).to_string();
                    (m, resolved, target)
                }
                // A broken link: say so instead of guessing at a kind.
                Err(_) => (link, "broken".to_string(), target),
            }
        } else {
            (link, kind.clone(), None)
        };
        Ok(SftpStat {
            kind,
            target_kind,
            size: meta.len(),
            mtime: meta.mtime.map(u64::from).unwrap_or(0),
            mode: meta.permissions.map(|m| m & 0o7777),
            uid: meta.uid,
            gid: meta.gid,
            user: meta.user.clone(),
            group: meta.group.clone(),
            link_target,
        })
    })
    .await
}

/// Change permissions on `path`. `recurse` is `"none"` (this entry only),
/// `"all"`, `"files"` or `"dirs"` - the files/dirs split is what keeps a
/// recursive `644` from stripping `x` off every directory and locking the
/// user out of their own tree.
#[tauri::command]
pub async fn ssh_sftp_chmod(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
    mode: u32,
    recurse: String,
) -> Result<ChmodSummary, String> {
    on_sftp(&state, id, move |sftp| async move {
        // The target itself is the user's explicit instruction: a failure
        // there is the whole operation failing.
        set_mode(&sftp, &path, mode).await?;
        let mut summary = ChmodSummary {
            changed: 1,
            failed: 0,
        };
        if recurse == "none" {
            return Ok(summary);
        }
        let meta = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(humanize)?;
        if !meta.file_type().is_dir() {
            return Ok(summary);
        }
        for e in walk_remote(&sftp, &path).await? {
            // SSH_FXP_SETSTAT is `chmod()`, which follows links. Touching a
            // link found during the walk would silently re-mode a file
            // somewhere else entirely, so skip them - `chmod -R` does too.
            if e.is_symlink {
                continue;
            }
            let wanted = match recurse.as_str() {
                "files" => !e.is_dir,
                "dirs" => e.is_dir,
                _ => true,
            };
            if !wanted {
                continue;
            }
            // A subtree owned by someone else is expected on a shared box.
            // Count it and carry on, exactly like `chmod -R`.
            match set_mode(&sftp, &e.path, mode).await {
                Ok(()) => summary.changed += 1,
                Err(_) => summary.failed += 1,
            }
        }
        Ok(summary)
    })
    .await
}

/// Whether a remote path exists, without following symlinks. Used to catch
/// name collisions before an upload or a move overwrites something.
#[tauri::command]
pub async fn ssh_sftp_exists(
    state: tauri::State<'_, SshState>,
    id: u32,
    path: String,
) -> Result<bool, String> {
    on_sftp(&state, id, move |sftp| async move {
        match sftp.symlink_metadata(path).await {
            Ok(_) => Ok(true),
            Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(false),
            Err(e) => Err(humanize(e)),
        }
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

/// One local file queued for upload, with the path it takes under the remote
/// target directory.
struct UploadItem {
    local: PathBuf,
    rel: String,
    size: u64,
}

/// Directories to create (parent-first) plus the files to send.
struct UploadPlan {
    dirs: Vec<String>,
    files: Vec<UploadItem>,
}

/// Expand the dropped/selected local paths into a flat transfer plan. Runs on
/// a blocking thread: `read_dir` over a deep tree must not sit on the async
/// runtime. A directory keeps its own name as the first path segment, so
/// dropping `~/site` onto `/var/www` produces `/var/www/site/...`.
fn plan_upload(paths: Vec<String>) -> Result<UploadPlan, String> {
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<UploadItem> = Vec::new();
    let mut pending: Vec<(PathBuf, String)> = Vec::new();

    for p in paths {
        let path = PathBuf::from(&p);
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .ok_or_else(|| format!("cannot upload {p}"))?;
        let meta = std::fs::metadata(&path).map_err(|e| format!("{name}: {e}"))?;
        if meta.is_dir() {
            dirs.push(name.clone());
            pending.push((path, name));
        } else {
            files.push(UploadItem {
                local: path,
                rel: name,
                size: meta.len(),
            });
        }
    }

    while let Some((dir, rel)) = pending.pop() {
        let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in read {
            let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
            if dirs.len() + files.len() >= MAX_WALK_ENTRIES {
                return Err(format!(
                    "folder holds more than {MAX_WALK_ENTRIES} entries - upload it in parts"
                ));
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let child_rel = format!("{rel}/{name}");
            let meta = entry.metadata().map_err(|e| format!("{child_rel}: {e}"))?;
            if meta.is_dir() {
                // Pushed before its children are read, so `dirs` stays
                // parent-first and the remote mkdir order is safe.
                dirs.push(child_rel.clone());
                pending.push((entry.path(), child_rel));
            } else {
                files.push(UploadItem {
                    local: entry.path(),
                    rel: child_rel,
                    size: meta.len(),
                });
            }
        }
    }

    Ok(UploadPlan { dirs, files })
}

/// Stream one local file into `remote`, reporting progress against `base`.
async fn upload_one(
    sftp: &SftpSession,
    local: &Path,
    remote: String,
    base: &TransferProgress,
    on_progress: &Channel<TransferProgress>,
) -> Result<(), String> {
    let mut src = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("read local file: {e}"))?;
    let mut dst = sftp
        .open_with_flags(
            remote,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(humanize)?;
    let mut buf = vec![0u8; CHUNK];
    let mut written = 0u64;
    let mut marked = 0u64;
    loop {
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| format!("read local file: {e}"))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| format!("sftp write: {e}"))?;
        written += n as u64;
        if written - marked >= PROGRESS_STEP {
            marked = written;
            let _ = on_progress.send(base.at(written));
        }
    }
    // shutdown() drains the pipelined write acks, so a server-side failure
    // (quota, permissions) surfaces here instead of being lost.
    dst.shutdown()
        .await
        .map_err(|e| format!("sftp close: {e}"))?;
    Ok(())
}

/// Upload local files and/or folders into a remote directory over SFTP.
/// Bytes stream through a fixed buffer, so a multi-GB file costs one chunk of
/// memory rather than its whole size. Every file is attempted: one failure is
/// recorded and the rest still transfer. The remote kernel enforces write
/// permission, so a denial surfaces as `permission denied`.
#[tauri::command]
pub async fn ssh_sftp_upload(
    state: tauri::State<'_, SshState>,
    id: u32,
    local_paths: Vec<String>,
    remote_dir: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferSummary, String> {
    let plan = tokio::task::spawn_blocking(move || plan_upload(local_paths))
        .await
        .map_err(|e| format!("upload scan join failed: {e}"))??;

    on_sftp(&state, id, move |sftp| async move {
        for rel in &plan.dirs {
            // Already-there is the normal case when merging into a live tree.
            // A real permission failure resurfaces on the first file inside,
            // with a message that names the file.
            let _ = sftp.create_dir(join_remote(&remote_dir, rel)).await;
        }
        let count = plan.files.len() as u32;
        let bytes_total: u64 = plan.files.iter().map(|f| f.size).sum();
        let mut summary = TransferSummary {
            ok: 0,
            failed: Vec::new(),
        };
        let mut bytes_done = 0u64;
        for (i, item) in plan.files.iter().enumerate() {
            let base = TransferProgress {
                index: i as u32 + 1,
                count,
                name: item.rel.clone(),
                written: 0,
                total: item.size,
                bytes_done,
                bytes_total,
            };
            let _ = on_progress.send(base.clone());
            let remote = join_remote(&remote_dir, &item.rel);
            match upload_one(&sftp, &item.local, remote, &base, &on_progress).await {
                Ok(()) => summary.ok += 1,
                Err(e) => summary.failed.push(format!("{}: {e}", item.rel)),
            }
            // Charge the full size either way, so the overall bar still
            // reaches 100% when one file of many fails.
            bytes_done += item.size;
            let _ = on_progress.send(base.at(item.size));
        }
        Ok(summary)
    })
    .await
}

/// Stream one remote file into `local`, reporting progress against `base`.
async fn download_one(
    sftp: &SftpSession,
    remote: String,
    local: &Path,
    base: &TransferProgress,
    on_progress: &Channel<TransferProgress>,
) -> Result<(), String> {
    let mut src = sftp
        .open_with_flags(remote, OpenFlags::READ)
        .await
        .map_err(humanize)?;
    let mut dst = tokio::fs::File::create(local)
        .await
        .map_err(|e| format!("write local file: {e}"))?;
    let mut buf = vec![0u8; CHUNK];
    let mut written = 0u64;
    let mut marked = 0u64;
    loop {
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| format!("sftp read: {e}"))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| format!("write local file: {e}"))?;
        written += n as u64;
        if written - marked >= PROGRESS_STEP {
            marked = written;
            let _ = on_progress.send(base.at(written));
        }
    }
    dst.flush()
        .await
        .map_err(|e| format!("write local file: {e}"))?;
    Ok(())
}

/// Download remote files and/or folders into a local directory over SFTP.
/// The mirror image of `ssh_sftp_upload`, down to the per-file failure list.
#[tauri::command]
pub async fn ssh_sftp_download(
    state: tauri::State<'_, SshState>,
    id: u32,
    remote_paths: Vec<String>,
    local_dir: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferSummary, String> {
    on_sftp(&state, id, move |sftp| async move {
        // Plan first, so the overall byte total is known before the first
        // chunk moves and the progress bar is honest from the start.
        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<(String, String, u64)> = Vec::new();
        for p in &remote_paths {
            let path = p.trim_end_matches('/').to_string();
            let name = remote_basename(&path);
            let meta = sftp
                .symlink_metadata(path.clone())
                .await
                .map_err(humanize)?;
            if !meta.file_type().is_dir() {
                files.push((path, name, meta.len()));
                continue;
            }
            dirs.push(name.clone());
            let prefix = format!("{path}/");
            for e in walk_remote(&sftp, &path).await? {
                let rel = format!(
                    "{name}/{}",
                    e.path.strip_prefix(&prefix).unwrap_or(e.path.as_str())
                );
                if e.is_dir {
                    dirs.push(rel);
                } else {
                    files.push((e.path, rel, e.size));
                }
            }
        }

        let root = PathBuf::from(&local_dir);
        for rel in &dirs {
            tokio::fs::create_dir_all(root.join(rel))
                .await
                .map_err(|e| format!("{rel}: {e}"))?;
        }

        let count = files.len() as u32;
        let bytes_total: u64 = files.iter().map(|f| f.2).sum();
        let mut summary = TransferSummary {
            ok: 0,
            failed: Vec::new(),
        };
        let mut bytes_done = 0u64;
        for (i, (remote, rel, size)) in files.into_iter().enumerate() {
            let base = TransferProgress {
                index: i as u32 + 1,
                count,
                name: rel.clone(),
                written: 0,
                total: size,
                bytes_done,
                bytes_total,
            };
            let _ = on_progress.send(base.clone());
            match download_one(&sftp, remote, &root.join(&rel), &base, &on_progress).await {
                Ok(()) => summary.ok += 1,
                Err(e) => summary.failed.push(format!("{rel}: {e}")),
            }
            bytes_done += size;
            let _ = on_progress.send(base.at(size));
        }
        Ok(summary)
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
        // lstat, not stat: a symlink to a directory must be unlinked, never
        // walked into and emptied.
        let metadata = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(humanize)?;
        if !metadata.file_type().is_dir() {
            return sftp.remove_file(path).await.map_err(humanize);
        }
        // SFTP has no recursive remove and `rmdir` only clears an EMPTY
        // directory, so walk the tree and delete children before parents.
        // Without this, deleting any non-empty folder failed outright.
        for e in walk_remote(&sftp, &path).await?.iter().rev() {
            let res = if e.is_dir {
                sftp.remove_dir(e.path.as_str()).await
            } else {
                sftp.remove_file(e.path.as_str()).await
            };
            res.map_err(|err| format!("{}: {}", e.path, humanize(err)))?;
        }
        sftp.remove_dir(path).await.map_err(humanize)
    })
    .await
}

/// Open the SFTP subsystem on `session`'s handle. Lives here, not as a
/// method on `SshSession`, so `session.rs` stays decoupled from the SFTP
/// wire-protocol details; `SshSession::ensure_sftp` calls this and caches
/// the result.
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
