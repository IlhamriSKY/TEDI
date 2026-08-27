pub mod atomic;
pub mod file;
pub mod grep;
pub mod mutate;
pub mod search;
pub mod tree;

use std::path::Path;

/// Frontend-facing path: forward-slash on every platform.
///
/// On Windows this also strips the extended-length prefix that
/// `std::fs::canonicalize` always returns. That is not cosmetic. The frontend's
/// resolved-path guards are prefix tests on a lowercased string - e.g.
/// `checkWritable` does `startsWith("c:/windows/")` and `checkDeletable` matches
/// `/^[a-zA-Z]:$/` for a drive root (`src/modules/ai/lib/security.ts`). Left
/// alone, `\\?\C:\Windows\...` became `//?/c:/windows/...`, which matches
/// NEITHER, so every one of those checks silently passed. Measured:
///
///   canonicalize("C:\\Windows\\System32\\drivers\\etc\\hosts")
///     -> \\?\C:\Windows\System32\drivers\etc\hosts
///     old: //?/c:/windows/system32/...  startsWith("c:/windows/") == false
///     new: c:/windows/system32/...      startsWith("c:/windows/") == true
///
/// The literal-path checks caught a direct `C:/Windows/...` write, so the only
/// paths that reached the resolved check were the ones that arrived via a
/// symlink - i.e. the guard failed in exactly the case it exists for.
///
/// `\\?\UNC\server\share` is the other prefix form and denotes `\\server\share`,
/// so it collapses to a plain UNC path rather than losing its leading slashes.
pub fn to_canon(p: impl AsRef<Path>) -> String {
    let s = p.as_ref().to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        let s = match s.strip_prefix(r"\\?\UNC\") {
            Some(rest) => format!(r"\\{rest}"),
            None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
        };
        s.replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        s
    }
}
