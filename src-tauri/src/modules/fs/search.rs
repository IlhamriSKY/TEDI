use std::path::PathBuf;

use ignore::WalkBuilder;
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
    /// Ranking score (higher = better). Useful for client-side sorting.
    pub score: i32,
    /// Byte indices in `name` that matched the fuzzy query.
    /// Empty if matched only on the path (not the name).
    pub name_match: Vec<u32>,
}

/// Walks `root` honoring `.gitignore` / `.ignore` rules. With `include_hidden`
/// set, dot-prefixed names are still considered. Matches are ranked using a
/// fuzzy subsequence score (filename hits + contiguity + word-boundary bonus
/// + shorter path tiebreak). An empty query returns nothing - callers
/// short-circuit before invoking.
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

    let mut out: Vec<SearchHit> = Vec::with_capacity(cap.min(64));

    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    for dent in walker.flatten() {
        if out.len() >= cap.saturating_mul(4) {
            // Walk a few times the requested cap so ranking has options.
            break;
        }
        let path = dent.path();
        if path == root_path {
            continue;
        }
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);

        let (name_score, name_match) = score_fuzzy(&name, &q_chars);
        let (path_score, _) = score_fuzzy(&rel, &q_chars);
        if name_score == 0 && path_score == 0 {
            continue;
        }

        // Filename matches outweigh path matches by a constant boost so a
        // matched name always wins against a matched path component.
        let mut score = name_score.max(0) * 3 + path_score.max(0);
        if name_score > 0 {
            score += 1_000;
        }
        // Slight penalty for deeper paths so closer hits surface first.
        score -= rel.matches('/').count() as i32 * 2;

        out.push(SearchHit {
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
    }

    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.rel.len().cmp(&b.rel.len())));
    out.truncate(cap);
    Ok(out)
}

/// Returns `(score, matched_byte_indices)`. Score is 0 when no subsequence
/// match exists. Higher scores reward:
///  - Exact substring match
///  - Contiguous runs
///  - Matches at word boundaries (start, after `_`, `-`, `/`, `.`, `\`,
///    space, or before uppercase camel transitions)
///  - Matches near the start of the haystack
fn score_fuzzy(haystack: &str, needle: &[char]) -> (i32, Vec<usize>) {
    if needle.is_empty() {
        return (0, Vec::new());
    }
    let lower: Vec<char> = haystack.chars().flat_map(|c| c.to_lowercase()).collect();
    // Byte indices for each char so the returned positions are usable
    // against the original string.
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
                        || (p.is_lowercase() && original[i].is_uppercase())
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
