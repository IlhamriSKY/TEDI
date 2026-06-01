//! GitHub release discovery + the HTTP helpers it builds on.
//!
//! Neutral logic shared by the Tauri command surface (`commands.rs`) and the
//! headless CLI (`cli_ext.rs`, `cli_update.rs`). Lives here so neither the
//! command layer nor the CLI owns it. Resolves the latest release tag /
//! `.zip` asset for an `owner/repo`, with an unauthenticated fallback path
//! for when the GitHub REST API is rate limited.

/// 50 MiB cap on a single download. Matches the install-package cap in
/// `install.rs`; mirrored here because the byte fetch enforces it mid-stream.
pub(crate) const MAX_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024;

// ---------- HTTP helpers ----------

pub(crate) async fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    http_get_bytes_with_progress(url, |_done, _total| {}).await
}

/// Streaming variant of [`http_get_bytes`] that reports cumulative bytes
/// received via `on_progress`. The closure runs on the network thread on
/// every chunk read - keep it cheap (typical implementation: send through
/// an `mpsc` channel). `bytes_total` is `Some(content_length)` when the
/// server advertised one, `None` otherwise.
pub(crate) async fn http_get_bytes_with_progress<F: FnMut(u64, Option<u64>)>(
    url: &str,
    mut on_progress: F,
) -> Result<Vec<u8>, String> {
    // `connect_timeout` fails fast on unreachable hosts so an offline user
    // gets an error in 15s instead of reqwest's default tens-of-seconds
    // stall. `timeout` caps the whole request: long enough for a 50 MiB
    // asset on a slow link, short enough that a stalled stream gives up.
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut resp = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    // Trust an honest content-length first so we bail early when the server
    // advertises a multi-GB body. Servers that omit or lie still hit the
    // running-total check below.
    let total = resp.content_length();
    if let Some(len) = total {
        if len > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "download too large: {} bytes (cap {})",
                len, MAX_DOWNLOAD_BYTES
            ));
        }
    }
    // Initial tick lets the UI render "0 / N" before the first chunk lands.
    on_progress(0, total);
    // Stream chunks so a misreporting server cannot push past the cap.
    // Stop when the body ends or the running total tips over.
    let mut bytes = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "download exceeded cap mid-stream ({} bytes)",
                MAX_DOWNLOAD_BYTES
            ));
        }
        bytes.extend_from_slice(&chunk);
        on_progress(bytes.len() as u64, total);
    }
    Ok(bytes)
}

pub(crate) async fn http_get_text(url: &str) -> Result<String, String> {
    // Small JSON bodies, so a short total timeout is fine. Same connect cap
    // as `http_get_bytes` so a network outage surfaces consistently.
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut req = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    // Optional auth: a personal access token in TEDI_GITHUB_TOKEN lifts the
    // anonymous 60 req/h cap to 5000 req/h. Read on every call so a user
    // can drop a token in without restarting TEDI. Only the api.github.com
    // host gets the header; arbitrary URLs do not, in case a redirect ever
    // points elsewhere.
    if url.contains("api.github.com") {
        if let Ok(tok) = std::env::var("TEDI_GITHUB_TOKEN") {
            let tok = tok.trim();
            if !tok.is_empty() {
                req = req.header("Authorization", format!("Bearer {tok}"));
            }
        }
    }
    let resp = req.send().await.map_err(|e| format!("GET {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // Surface rate-limit hits with an actionable hint. The raw JSON
        // body's message would otherwise be hidden inside a generic HTTP
        // 403 toast and the user would have no idea what to do.
        let body = resp.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::FORBIDDEN
            && (body.contains("rate limit") || body.contains("API rate"))
        {
            return Err(
                "GitHub API rate limit reached (60 requests/hour for unauthenticated \
                 access). Set the TEDI_GITHUB_TOKEN environment variable to a personal \
                 access token to raise the cap to 5000 requests/hour, or wait until the \
                 limit window resets (typically within the hour)."
                    .to_string(),
            );
        }
        return Err(format!("GET {url}: HTTP {status}"));
    }
    // Cap the body so a compromised/MITM'd endpoint can't stream an unbounded
    // response into memory (the sibling byte path caps via MAX_DOWNLOAD_BYTES;
    // this text path previously buffered without limit). Manifests / release
    // JSON are tiny, so a few MiB is generous.
    const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_TEXT_BYTES {
            return Err(format!(
                "response body too large: {len} bytes (cap {MAX_TEXT_BYTES})"
            ));
        }
    }
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        if buf.len() + chunk.len() > MAX_TEXT_BYTES {
            return Err(format!(
                "response body exceeds cap ({MAX_TEXT_BYTES} bytes)"
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|e| format!("response body not valid UTF-8: {e}"))
}

// ---------- release discovery ----------

pub(crate) fn pick_release_tag(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("tag_name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// Pick the first `.zip` asset from a GitHub release JSON.
pub(crate) fn pick_release_zip(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let assets = v.get("assets")?.as_array()?;
    for a in assets {
        let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        if name.to_lowercase().ends_with(".zip") {
            if let Some(url) = a.get("browser_download_url").and_then(|x| x.as_str()) {
                return Some(url.to_string());
            }
        }
    }
    // Fall back to the source zipball (tagged commit) if no asset matches.
    v.get("zipball_url")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

pub(crate) fn normalize_owner_repo(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    let candidate = if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("github.com/") {
        rest
    } else {
        trimmed
    };
    // Drop a trailing `.git` if present.
    let candidate = candidate.trim_end_matches(".git");
    let parts: Vec<&str> = candidate.split('/').collect();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("expected owner/repo format".into());
    }
    let owner = parts[0];
    let repo = parts[1];
    let safe = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !safe(owner) || !safe(repo) {
        return Err("owner/repo contains unsupported characters".into());
    }
    Ok(format!("{owner}/{repo}"))
}

/// Resolve `(tag, zip_url)` for the latest release of `owner_repo`. Tries
/// the GitHub REST API first - richer metadata, but anonymous requests are
/// rate limited to 60/hour per IP - and falls back to two unauthenticated
/// public endpoints when the API returns 403 / rate-limited:
///
///   1. `GET https://github.com/<owner>/<repo>/releases/latest` (302 to
///      `.../releases/tag/<tag>`) gives the tag without needing the API.
///   2. `GET https://github.com/<owner>/<repo>/releases/expanded_assets/<tag>`
///      returns an HTML fragment (the same one the release page loads via
///      AJAX when "Assets" is expanded) listing every download link.
///
/// Both fallbacks are stable HTML/redirect surfaces - changes since 2020
/// have been backward compatible.
pub(crate) async fn resolve_latest_release(owner_repo: &str) -> Result<(String, String), String> {
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    match http_get_text(&api).await {
        Ok(json) => {
            let tag = pick_release_tag(&json)
                .ok_or_else(|| "could not read tag_name from GitHub response".to_string())?;
            let url = pick_release_zip(&json)
                .ok_or_else(|| "no .zip asset in latest release".to_string())?;
            return Ok((tag, url));
        }
        Err(e) if is_rate_limited_err(&e) => {
            // fall through to the unauthenticated path
        }
        Err(e) => return Err(e),
    }
    let tag = latest_tag_via_redirect(owner_repo).await?;
    let url = pick_zip_via_html(owner_repo, &tag).await?;
    Ok((tag, url))
}

/// Tag-only variant of [`resolve_latest_release`] for the update-check
/// path, which never downloads anything and so does not need the asset URL.
pub(crate) async fn resolve_latest_tag(owner_repo: &str) -> Result<String, String> {
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    match http_get_text(&api).await {
        Ok(json) => {
            return pick_release_tag(&json)
                .ok_or_else(|| "could not read tag_name from GitHub response".to_string());
        }
        Err(e) if is_rate_limited_err(&e) => {}
        Err(e) => return Err(e),
    }
    latest_tag_via_redirect(owner_repo).await
}

fn is_rate_limited_err(err: &str) -> bool {
    err.contains("rate limit") || err.contains("HTTP 403")
}

/// Discover the latest release tag by following GitHub's public 302 from
/// `/<owner>/<repo>/releases/latest` to `/<owner>/<repo>/releases/tag/<tag>`.
/// Redirects are disabled so we can read the `Location` header directly;
/// the path's final segment is the tag we want.
async fn latest_tag_via_redirect(owner_repo: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!("https://github.com/{owner_repo}/releases/latest");
    let resp = client
        .head(&url)
        .send()
        .await
        .map_err(|e| format!("HEAD {url}: {e}"))?;
    if !resp.status().is_redirection() {
        return Err(format!(
            "expected 302 from {url}, got HTTP {}",
            resp.status()
        ));
    }
    let loc = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing Location header on /releases/latest".to_string())?;
    let tag = loc
        .rsplit('/')
        .next()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| format!("malformed Location header: {loc}"))?;
    Ok(tag.to_string())
}

/// Pick the first `.zip` download link from the `expanded_assets` HTML
/// fragment GitHub serves for a release. The fragment is stable enough
/// to scan with naive string ops: every asset is rendered as
/// `<a href="/owner/repo/releases/download/<tag>/<name>.zip">`. We split
/// on `"`, accept the first token shaped like a download path that ends
/// in `.zip` (case-insensitive). Matching ignores owner/repo case because
/// GitHub canonicalises the case in HTML even when the user typed it
/// differently.
async fn pick_zip_via_html(owner_repo: &str, tag: &str) -> Result<String, String> {
    let url = format!("https://github.com/{owner_repo}/releases/expanded_assets/{tag}");
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    for tok in html.split('"') {
        if tok.starts_with('/')
            && tok.contains("/releases/download/")
            && tok.to_ascii_lowercase().ends_with(".zip")
        {
            return Ok(format!("https://github.com{tok}"));
        }
    }
    Err(format!("no .zip asset link in expanded_assets for {tag}"))
}
