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

#[tauri::command]
pub fn fs_grep(
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
pub fn fs_glob(
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
