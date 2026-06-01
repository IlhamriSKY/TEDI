//! Lenient version comparison and `engines.tedi` constraint matching.
//!
//! Neutral logic shared by the Tauri command surface (`commands.rs`) and the
//! headless CLI (`cli_ext.rs`, `cli_update.rs`). Lives here so neither the
//! command layer nor the CLI owns it.

pub(crate) fn strip_v_prefix(tag: &str) -> String {
    tag.trim_start_matches(['v', 'V']).to_string()
}

/// Lenient version compare. Splits both sides on any non-digit, parses each
/// segment as u32 (`0` on parse failure), and compares lexicographically.
/// Missing trailing segments count as `0`. Pre-release suffixes are ignored
/// beyond their digits: `1.0.0` and `1.0.0-beta` compare equal, which
/// avoids a false "update available" on the same major-minor-patch.
pub(crate) fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(s: &str) -> Vec<u32> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    }
    let pa = parts(a);
    let pb = parts(b);
    let len = pa.len().max(pb.len()).max(1);
    for i in 0..len {
        let av = pa.get(i).copied().unwrap_or(0);
        let bv = pb.get(i).copied().unwrap_or(0);
        match av.cmp(&bv) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// True iff `host` satisfies the `engines.tedi` constraint. Supports the
/// shapes extensions in this project actually use: empty / `*` (any),
/// `">=X.Y.Z"`, `">X.Y.Z"`, `"<=X.Y.Z"`, `"<X.Y.Z"`, `"=X.Y.Z"`, and plain
/// `"X.Y.Z"` (exact). Comparison uses [`compare_versions`] so `v` prefixes
/// and trailing pre-release tags behave the same way the rest of the host
/// already expects.
pub(crate) fn satisfies(constraint: &str, host: &str) -> bool {
    let c = constraint.trim();
    if c.is_empty() || c == "*" {
        return true;
    }
    let host = strip_v_prefix(host);
    let (op, rest) = if let Some(r) = c.strip_prefix(">=") {
        (">=", r)
    } else if let Some(r) = c.strip_prefix("<=") {
        ("<=", r)
    } else if let Some(r) = c.strip_prefix('>') {
        (">", r)
    } else if let Some(r) = c.strip_prefix('<') {
        ("<", r)
    } else if let Some(r) = c.strip_prefix('=') {
        ("=", r)
    } else {
        ("=", c)
    };
    let target = strip_v_prefix(rest.trim());
    let ord = compare_versions(&host, &target);
    match op {
        ">=" => ord != std::cmp::Ordering::Less,
        ">" => ord == std::cmp::Ordering::Greater,
        "<=" => ord != std::cmp::Ordering::Greater,
        "<" => ord == std::cmp::Ordering::Less,
        _ => ord == std::cmp::Ordering::Equal,
    }
}
