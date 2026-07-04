//! Crash-safe file writes: stage into a sibling temp file, fsync, then
//! rename over the target.
//!
//! A torn write (crash / power loss between `open` and the last byte) would
//! otherwise leave a half-written file. Several callers persist data whose
//! readers fall back to defaults on a parse error, so a torn write would
//! silently wipe user state - worth the extra fsync to avoid.
//!
//! The temp file is created in the SAME directory as the target so the final
//! `rename` is same-filesystem (atomic) and never a cross-device copy. On any
//! failure the temp is removed best-effort so a crash mid-write does not leave
//! a stray `.tmp` behind.
//!
//! Callers that need a specific final byte stream (DPAPI-encrypted, 0600
//! perms, pretty-printed JSON) compose AROUND this: produce the bytes, then
//! call [`atomic_write`]. This helper owns only the staging/rename mechanics,
//! never the encoding.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Atomically replace `path` with `bytes`.
///
/// Stages into `<dir>/.<filename>.tedi.tmp`, fsyncs it, then renames over
/// `path`. Removes the temp on any failure. Returns the underlying
/// [`io::Error`] so callers can map it to their own error type.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_staged(path, bytes, |tmp| fs::File::create(tmp))
}

/// Unix-only [`atomic_write`] variant that creates the staging temp with the
/// given permission `mode` BEFORE any bytes are written, so the contents are
/// never briefly world-readable. Used for the Linux secrets file (mode
/// `0o600`) where the plaintext must never touch disk with loose perms.
#[cfg(unix)]
pub fn atomic_write_mode(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    write_staged(path, bytes, move |tmp| {
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(tmp)
    })
}

/// Stage `bytes` into `<dir>/.<filename>.tedi.tmp` (opened via `open_tmp`),
/// fsync, then rename over `path`. Removes the temp on any failure.
fn write_staged<F>(path: &Path, bytes: &[u8], open_tmp: F) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<fs::File>,
{
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;

    // Temp lives beside the target so `rename` stays on one filesystem.
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(".tedi.tmp");
    let tmp = parent.join(tmp_name);

    // Wrap the body so a single `?` short-circuit funnels through the cleanup
    // below; we must not leave the staged temp behind on failure.
    let result = (|| -> io::Result<()> {
        let mut f = open_tmp(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        // Drop the handle before renaming: Windows refuses to rename a file
        // with an open handle in some configurations.
        drop(f);
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
