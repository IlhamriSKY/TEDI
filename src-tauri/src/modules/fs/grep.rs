use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use super::to_canon;

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;

#[derive(Serialize)]
pub struct GrepHit {
    pub path: String,
    pub rel: String,
    pub line: u64,
    pub text: String,
}

#[derive(Serialize)]
pub struct GrepResponse {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub files_scanned: usize,
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| format!("bad glob {p:?}: {e}"))?;
        b.add(g);
    }
    let set = b.build().map_err(|e| format!("globset build: {e}"))?;
    Ok(Some(set))
}

// A sync `#[tauri::command]` runs on the WebView2 UI (main) thread on Windows,
// so this recursive walk would freeze the whole app for the duration of a
// project-wide search. Offload to the blocking pool (mirrors git_status).
#[tauri::command]
pub async fn fs_grep(
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<GrepResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_grep_inner(pattern, root, glob, case_insensitive, max_results)
    })
    .await
    .map_err(|e| format!("fs_grep join error: {e}"))?
}

fn fs_grep_inner(
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<GrepResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive.unwrap_or(false))
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|e| format!("bad regex: {e}"))?;

    let globs = build_globset(glob.as_deref().unwrap_or(&[]))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build_parallel();

    // Per-worker local buffer drained into `worker_bufs` on worker drop.
    // Replaces an older design that locked one shared `Mutex<Vec<GrepHit>>`
    // per match and serialized every walker thread on a hot lock.
    let worker_bufs: Arc<Mutex<Vec<Vec<GrepHit>>>> = Arc::new(Mutex::new(Vec::new()));
    let total_hits = Arc::new(AtomicUsize::new(0));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    struct WorkerBuf {
        local: Vec<GrepHit>,
        out: Arc<Mutex<Vec<Vec<GrepHit>>>>,
    }
    impl Drop for WorkerBuf {
        fn drop(&mut self) {
            if !self.local.is_empty() {
                if let Ok(mut guard) = self.out.lock() {
                    guard.push(std::mem::take(&mut self.local));
                }
            }
        }
    }

    walker.run(|| {
        let matcher = matcher.clone();
        let globs = globs.clone();
        let total_hits = total_hits.clone();
        let scanned = scanned.clone();
        let truncated = truncated.clone();
        let root_path = root_path.clone();
        let mut worker = WorkerBuf {
            local: Vec::new(),
            out: worker_bufs.clone(),
        };

        Box::new(move |dent_res| {
            if truncated.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let dent = match dent_res {
                Ok(d) => d,
                Err(_) => return WalkState::Continue,
            };
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = dent.path();
            let rel = match path.strip_prefix(&root_path) {
                Ok(r) => to_canon(r),
                Err(_) => return WalkState::Continue,
            };
            if let Some(set) = globs.as_ref() {
                if !set.is_match(&rel) {
                    return WalkState::Continue;
                }
            }
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() > FILE_SIZE_CAP {
                    return WalkState::Continue;
                }
            }

            scanned.fetch_add(1, Ordering::Relaxed);

            let abs = to_canon(path);
            let rel_clone = rel.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();

            let _ = searcher.search_path(
                &matcher,
                path,
                UTF8(|line_num, text| {
                    // Atomic claim of one slot in the global cap. Bump first;
                    // if the race is lost, set `truncated` so other workers
                    // exit fast.
                    let prev = total_hits.fetch_add(1, Ordering::Relaxed);
                    if prev >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    worker.local.push(GrepHit {
                        path: abs.clone(),
                        rel: rel_clone.clone(),
                        line: line_num,
                        text: text.trim_end_matches('\n').to_string(),
                    });
                    Ok(true)
                }),
            );

            WalkState::Continue
        })
    });

    // Worker closures have all been dropped; `worker_bufs` has a single owner.
    let mut final_hits: Vec<GrepHit> = Arc::into_inner(worker_bufs)
        .and_then(|m| m.into_inner().ok())
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect();
    // Per-worker buffers cluster hits by thread, not traversal order. Sort
    // by (rel, line) so the result is deterministic and grouped per file.
    final_hits.sort_by(|a, b| a.rel.cmp(&b.rel).then(a.line.cmp(&b.line)));
    // Atomic claim can overshoot when workers race past `cap`. Trim back.
    if final_hits.len() > cap {
        final_hits.truncate(cap);
    }

    Ok(GrepResponse {
        hits: final_hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::Relaxed),
    })
}

#[derive(Serialize)]
pub struct GlobHit {
    pub path: String,
    pub rel: String,
}

#[derive(Serialize)]
pub struct GlobResponse {
    pub hits: Vec<GlobHit>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn fs_glob(
    pattern: String,
    root: String,
    max_results: Option<usize>,
) -> Result<GlobResponse, String> {
    tauri::async_runtime::spawn_blocking(move || fs_glob_inner(pattern, root, max_results))
        .await
        .map_err(|e| format!("fs_glob join error: {e}"))?
}

fn fs_glob_inner(
    pattern: String,
    root: String,
    max_results: Option<usize>,
) -> Result<GlobResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results.unwrap_or(500).clamp(1, HARD_MAX_RESULTS);

    let glob = Glob::new(&pattern).map_err(|e| format!("bad glob: {e}"))?;
    let mut gb = GlobSetBuilder::new();
    gb.add(glob);
    let set = gb.build().map_err(|e| format!("globset build: {e}"))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    let mut hits: Vec<GlobHit> = Vec::new();
    let mut truncated = false;
    for dent in walker.flatten() {
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if !set.is_match(&rel) {
            continue;
        }
        hits.push(GlobHit {
            path: to_canon(path),
            rel,
        });
    }

    Ok(GlobResponse { hits, truncated })
}

#[derive(Serialize)]
pub struct GrepReplaceEdit {
    pub path: String,
    pub rel: String,
    pub replacements: usize,
}

#[derive(Serialize)]
pub struct GrepReplaceResponse {
    pub files_changed: usize,
    pub total_replacements: usize,
    pub edits: Vec<GrepReplaceEdit>,
    pub truncated: bool,
}

/// File-level regex find-and-replace driven by the explorer Search panel.
/// Walks the same `ignore` tree as `fs_grep` (respects `.gitignore`), reads
/// each candidate file as UTF-8, applies `regex::Regex::replace_all`, and
/// writes the result back when the content actually changed.
///
/// Binary files: skipped silently. The 5 MiB cap mirrors `fs_grep` so a
/// stray multi-GB asset never blocks the walk.
///
/// Returns a per-file edit log capped at `MAX_REPLACE_FILES` so the IPC
/// payload stays small even on a huge replace. `total_replacements` and
/// `files_changed` always reflect the full operation - only the edit list
/// is truncated.
#[tauri::command]
pub async fn fs_grep_replace(
    pattern: String,
    replacement: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
) -> Result<GrepReplaceResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_grep_replace_inner(pattern, replacement, root, glob, case_insensitive)
    })
    .await
    .map_err(|e| format!("fs_grep_replace join error: {e}"))?
}

fn fs_grep_replace_inner(
    pattern: String,
    replacement: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
) -> Result<GrepReplaceResponse, String> {
    use std::fs;

    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(case_insensitive.unwrap_or(false))
        .multi_line(true)
        .build()
        .map_err(|e| format!("bad regex: {e}"))?;

    let globs = build_globset(glob.as_deref().unwrap_or(&[]))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    const MAX_REPLACE_FILES: usize = 1_000;
    let mut files_changed = 0usize;
    let mut total_replacements = 0usize;
    let mut edits: Vec<GrepReplaceEdit> = Vec::new();
    let mut truncated = false;

    for dent in walker.flatten() {
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if let Some(set) = globs.as_ref() {
            if !set.is_match(&rel) {
                continue;
            }
        }
        if let Ok(meta) = fs::metadata(path) {
            if meta.len() > FILE_SIZE_CAP {
                continue;
            }
        }

        let original = match fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue, // binary / non-UTF-8 / unreadable -> skip
        };

        let mut count = 0usize;
        let replaced = re
            .replace_all(&original, |caps: &regex::Captures| {
                count += 1;
                let mut buf = String::new();
                caps.expand(&replacement, &mut buf);
                buf
            })
            .into_owned();

        if count == 0 || replaced == original {
            continue;
        }

        if let Err(e) = crate::modules::fs::atomic::atomic_write(path, replaced.as_bytes()) {
            return Err(format!("write {}: {e}", path.display()));
        }

        files_changed += 1;
        total_replacements += count;
        if edits.len() < MAX_REPLACE_FILES {
            edits.push(GrepReplaceEdit {
                path: to_canon(path),
                rel,
                replacements: count,
            });
        } else {
            truncated = true;
        }
    }

    Ok(GrepReplaceResponse {
        files_changed,
        total_replacements,
        edits,
        truncated,
    })
}

/// Surgical find-and-replace inside a single file, backing the explorer Search
/// panel's per-hit ("replace this one match") and per-file ("replace all in
/// file") actions (VS Code parity). `line` scopes the replace to that single
/// 1-indexed line; `None` rewrites every match in the file. Returns the number
/// of replacements written. A no-op (0 matches, or replacement identical to the
/// original) never touches disk.
#[tauri::command]
pub async fn fs_replace_in_file(
    path: String,
    pattern: String,
    replacement: String,
    line: Option<u64>,
    case_insensitive: Option<bool>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_replace_in_file_inner(path, pattern, replacement, line, case_insensitive)
    })
    .await
    .map_err(|e| format!("fs_replace_in_file join error: {e}"))?
}

fn fs_replace_in_file_inner(
    path: String,
    pattern: String,
    replacement: String,
    line: Option<u64>,
    case_insensitive: Option<bool>,
) -> Result<usize, String> {
    use std::fs;

    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if let Ok(meta) = fs::metadata(&file_path) {
        if meta.len() > FILE_SIZE_CAP {
            return Err("file too large".into());
        }
    }

    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(case_insensitive.unwrap_or(false))
        .multi_line(true)
        .build()
        .map_err(|e| format!("bad regex: {e}"))?;

    let original = fs::read_to_string(&file_path).map_err(|e| format!("read {path}: {e}"))?;

    let mut count = 0usize;
    let apply = |content: &str, count: &mut usize| -> String {
        re.replace_all(content, |caps: &regex::Captures| {
            *count += 1;
            let mut buf = String::new();
            caps.expand(&replacement, &mut buf);
            buf
        })
        .into_owned()
    };

    let replaced = match line {
        None => apply(&original, &mut count),
        Some(0) => return Err("line must be >= 1".into()),
        Some(ln) => {
            let mut out = String::with_capacity(original.len());
            for (i, seg) in original.split_inclusive('\n').enumerate() {
                if (i as u64) + 1 == ln {
                    // Feed the regex only the line's own text so a match can
                    // never swallow the line terminator (\n or \r\n).
                    let (content, term) = match seg.strip_suffix('\n') {
                        Some(rest) => match rest.strip_suffix('\r') {
                            Some(r2) => (r2, "\r\n"),
                            None => (rest, "\n"),
                        },
                        None => (seg, ""),
                    };
                    out.push_str(&apply(content, &mut count));
                    out.push_str(term);
                } else {
                    out.push_str(seg);
                }
            }
            out
        }
    };

    if count == 0 || replaced == original {
        return Ok(0);
    }
    crate::modules::fs::atomic::atomic_write(&file_path, replaced.as_bytes())
        .map_err(|e| format!("write {path}: {e}"))?;
    Ok(count)
}

#[cfg(test)]
mod replace_in_file_tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn tmp(content: &str) -> std::path::PathBuf {
        // Unique-per-call name without pulling in a tempfile dep: mix the
        // content length and address of a stack local into the file name.
        let marker = &content as *const _ as usize;
        let p = std::env::temp_dir().join(format!("tedi_rif_{}_{}.txt", content.len(), marker));
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn line_scoped_replace_only_touches_that_line() {
        let p = tmp("foo\nfoo bar foo\nfoo\n");
        let n = fs_replace_in_file_inner(
            p.to_string_lossy().into_owned(),
            "foo".into(),
            "X".into(),
            Some(2),
            Some(false),
        )
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "foo\nX bar X\nfoo\n");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn whole_file_replace_and_crlf_preserved() {
        let p = tmp("a\r\nb a\r\n");
        let n = fs_replace_in_file_inner(
            p.to_string_lossy().into_owned(),
            "a".into(),
            "Z".into(),
            None,
            Some(false),
        )
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "Z\r\nb Z\r\n");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn no_match_is_noop() {
        let p = tmp("hello\n");
        let n = fs_replace_in_file_inner(
            p.to_string_lossy().into_owned(),
            "zzz".into(),
            "Q".into(),
            None,
            Some(false),
        )
        .unwrap();
        assert_eq!(n, 0);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello\n");
        let _ = std::fs::remove_file(&p);
    }
}
