use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use super::to_canon;

#[derive(Serialize)]
pub struct SearchHit {
    /// Absolute path of the matched file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
    /// File name only.
    pub name: String,
    pub is_dir: bool,
    /// Ranking score (higher is better). Drives client-side sorting.
    pub score: i32,
    /// Byte indices in `name` that matched the fuzzy query. Empty when the
    /// match was only on the path, not the name.
    pub name_match: Vec<u32>,
}

/// Walk `root` honoring `.gitignore` / `.ignore` rules. With `include_hidden`,
/// dot-prefixed names are also considered. Matches ranked by a fuzzy
/// subsequence score (filename hits, contiguity, word-boundary bonus, shorter
/// path tiebreak). Empty query returns nothing.
#[tauri::command]
pub fn fs_search(
    root: String,
    query: String,
    limit: Option<usize>,
    include_hidden: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let q_chars: Vec<char> = q.chars().collect();
    let cap = limit.unwrap_or(200).min(1000);
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let show_hidden = include_hidden.unwrap_or(false);

    // Walk in parallel. `ignore::WalkBuilder` is already pulled in for grep,
    // and on a large monorepo the single-threaded walk + scoring pass was
    // the bottleneck for the fuzzy file picker.
    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build_parallel();

    let worker_bufs: Arc<Mutex<Vec<Vec<SearchHit>>>> = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    // Walk past the requested cap so ranking has options to pick from.
    let walk_cap = cap.saturating_mul(4);

    struct WorkerBuf {
        local: Vec<SearchHit>,
        out: Arc<Mutex<Vec<Vec<SearchHit>>>>,
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
        let q_chars = q_chars.clone();
        let root_path = root_path.clone();
        let collected = collected.clone();
        let stop = stop.clone();
        let mut worker = WorkerBuf {
            local: Vec::new(),
            out: worker_bufs.clone(),
        };

        Box::new(move |dent_res| {
            if stop.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let dent = match dent_res {
                Ok(d) => d,
                Err(_) => return WalkState::Continue,
            };
            let path = dent.path();
            if path == root_path {
                return WalkState::Continue;
            }
            let rel = match path.strip_prefix(&root_path) {
                Ok(r) => to_canon(r),
                Err(_) => return WalkState::Continue,
            };
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);

            let (name_score, name_match) = score_fuzzy(&name, &q_chars);
            let (path_score, _) = score_fuzzy(&rel, &q_chars);
            if name_score == 0 && path_score == 0 {
                return WalkState::Continue;
            }

            let mut score = name_score.max(0) * 3 + path_score.max(0);
            if name_score > 0 {
                score += 1_000;
            }
            score -= rel.matches('/').count() as i32 * 2;

            // Atomic claim against the over-walk cap.
            let prev = collected.fetch_add(1, Ordering::Relaxed);
            if prev >= walk_cap {
                stop.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            worker.local.push(SearchHit {
                path: to_canon(path),
                rel,
                name,
                is_dir,
                score,
                name_match: if name_score > 0 {
                    name_match.iter().map(|&i| i as u32).collect()
                } else {
                    Vec::new()
                },
            });

            WalkState::Continue
        })
    });

    let mut out: Vec<SearchHit> = Arc::into_inner(worker_bufs)
        .and_then(|m| m.into_inner().ok())
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.rel.len().cmp(&b.rel.len())));
    out.truncate(cap);
    Ok(out)
}

/// Returns `(score, matched_byte_indices)`. Score is 0 when no subsequence
/// match exists. Higher scores reward exact substring matches, contiguous
/// runs, matches at word boundaries (start, after `_`, `-`, `/`, `.`, `\`,
/// space, or before camel-case uppercase), and matches near the start.
fn score_fuzzy(haystack: &str, needle: &[char]) -> (i32, Vec<usize>) {
    if needle.is_empty() {
        return (0, Vec::new());
    }
    let lower: Vec<char> = haystack.chars().flat_map(|c| c.to_lowercase()).collect();
    // Byte indices per char so the returned positions are usable against
    // the original string.
    let mut char_byte_idx: Vec<usize> = Vec::with_capacity(haystack.len());
    for (i, _) in haystack.char_indices() {
        char_byte_idx.push(i);
    }

    let mut idx = 0usize; // needle cursor
    let mut matches: Vec<usize> = Vec::with_capacity(needle.len());
    let mut score: i32 = 0;
    let mut prev_match: Option<usize> = None;
    let original: Vec<char> = haystack.chars().collect();

    for (i, &c) in lower.iter().enumerate() {
        if idx >= needle.len() {
            break;
        }
        if c == needle[idx] {
            matches.push(char_byte_idx.get(i).copied().unwrap_or(0));
            let mut bonus = 1;
            // Word-boundary bonus.
            let prev_ch = if i == 0 {
                None
            } else {
                original.get(i - 1).copied()
            };
            let is_boundary = match prev_ch {
                None => true,
                Some(p) => {
                    matches!(p, '_' | '-' | '/' | '\\' | '.' | ' ')
                        || (p.is_lowercase() && original.get(i).is_some_and(|o| o.is_uppercase()))
                }
            };
            if is_boundary {
                bonus += 4;
            }
            // Contiguity bonus.
            if let Some(prev) = prev_match {
                if i == prev + 1 {
                    bonus += 3;
                }
            }
            score += bonus;
            prev_match = Some(i);
            idx += 1;
        }
    }

    if idx < needle.len() {
        return (0, Vec::new());
    }
    // Exact-substring boost (case-insensitive).
    let needle_str: String = needle.iter().collect();
    let lower_str: String = lower.iter().collect();
    if lower_str.contains(&needle_str) {
        score += 20;
    }
    // Earlier-match bonus.
    if let Some(&first) = matches.first() {
        score += (32i32 - first.min(32) as i32).max(0);
    }
    (score, matches)
}
