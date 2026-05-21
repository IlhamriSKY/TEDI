use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
    },
    /// Decoded image - body is a `data:` URL ready for `<img src>`.
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
        mime: String,
        size: u64,
    },
    Binary {
        size: u64,
    },
    /// File exceeds MAX_READ_BYTES. UI decides whether to offer "open anyway".
    TooLarge {
        size: u64,
        limit: u64,
    },
}

/// Sniff an image mime from path extension + magic bytes. Returns `None` if
/// the file isn't a recognized image format.
fn sniff_image_mime(path: &Path, bytes: &[u8]) -> Option<&'static str> {
    // Magic-byte check first - authoritative when present.
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    // RIFF????WEBP
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // ICO: 00 00 01 00 ; CUR: 00 00 02 00
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    // SVG / other text-based formats - defer to extension.
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("svg") => Some("image/svg+xml"),
        Some("avif") => Some("image/avif"),
        _ => None,
    }
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<ReadResult, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let size = meta.len();
    if size > MAX_READ_BYTES {
        return Ok(ReadResult::TooLarge {
            size,
            limit: MAX_READ_BYTES,
        });
    }

    let bytes = std::fs::read(&p).map_err(|e| {
        log::debug!("fs_read_file read({}) failed: {e}", p.display());
        e.to_string()
    })?;

    Ok(classify_bytes(&p, bytes))
}

/// Shared bytes→`ReadResult` classifier. `path` only drives extension-based
/// MIME hints (SVG, AVIF) - callers reading a git blob can pass the repo-
/// relative path. Size is `bytes.len()` since the blob has no on-disk size.
pub(crate) fn classify_bytes(path: &Path, bytes: Vec<u8>) -> ReadResult {
    let size = bytes.len() as u64;

    // Image sniff before the null-byte check - PNG/JPEG/etc. contain nulls
    // and would otherwise be reported as plain binary.
    if let Some(mime) = sniff_image_mime(path, &bytes) {
        // SVG is text - encode as UTF-8 in the data URL so it renders even
        // if the file has odd whitespace.
        let data_url = if mime == "image/svg+xml" {
            match std::str::from_utf8(&bytes) {
                Ok(s) => format!("data:{mime};utf8,{}", urlencode_svg(s)),
                Err(_) => format!("data:{mime};base64,{}", B64.encode(&bytes)),
            }
        } else {
            format!("data:{mime};base64,{}", B64.encode(&bytes))
        };
        return ReadResult::Image {
            data_url,
            mime: mime.to_string(),
            size,
        };
    }

    // Null-byte sniff on the first chunk. Not perfect (misses UTF-16 BOM
    // cases) but catches the common "this is a PNG" mistake cheaply.
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return ReadResult::Binary { size };
    }

    match String::from_utf8(bytes) {
        Ok(content) => ReadResult::Text { content, size },
        Err(_) => ReadResult::Binary { size },
    }
}

/// Minimal percent-encoding for SVG embedded in a `data:` URL. We only escape
/// characters that break the URL grammar - leaving the SVG mostly readable.
fn urlencode_svg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            '"' => out.push_str("%22"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            _ => out.push(c),
        }
    }
    out
}

/// Result of a partial (offset/limit) file read. Only the requested line
/// range crosses the IPC boundary, avoiding multi-MB payloads for the AI tool.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadPortionResult {
    Text {
        content: String,
        size: u64,
        #[serde(rename = "totalLines")]
        total_lines: usize,
        #[serde(rename = "startLine")]
        start_line: usize,
        #[serde(rename = "endLine")]
        end_line: usize,
    },
    Binary {
        size: u64,
    },
    TooLarge {
        size: u64,
        limit: u64,
    },
}

/// Read only a slice of lines from a text file. The file is streamed through
/// a `BufReader` so only the requested `[offset, offset+limit)` range is
/// allocated as `String`s - the rest of the file is scanned byte-by-byte
/// just to count newlines.
#[tauri::command]
pub fn fs_read_file_portion(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ReadPortionResult, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| {
        log::debug!("fs_read_file_portion stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let size = meta.len();
    if size > MAX_READ_BYTES {
        return Ok(ReadPortionResult::TooLarge {
            size,
            limit: MAX_READ_BYTES,
        });
    }

    let file = std::fs::File::open(&p).map_err(|e| {
        log::debug!("fs_read_file_portion open({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let mut reader = BufReader::new(file);

    // Binary sniff: peek at the first chunk without consuming from the buffer.
    {
        let buf = reader.fill_buf().map_err(|e| {
            log::debug!("fs_read_file_portion fill_buf({}) failed: {e}", p.display());
            e.to_string()
        })?;
        let sniff_len = buf.len().min(BINARY_SNIFF_BYTES);
        if buf[..sniff_len].contains(&0) {
            return Ok(ReadPortionResult::Binary { size });
        }
    }

    let start = offset.unwrap_or(0);
    // Hard cap so a misbehaving caller can't ask for `usize::MAX` lines and
    // overflow `start + lim` below (panic in debug, wrap in release).
    const MAX_LINE_LIMIT: usize = 10_000;
    let lim = limit.unwrap_or(2000).min(MAX_LINE_LIMIT);
    let end = start.saturating_add(lim);

    // Stream lines: skip `start` lines, collect up to `lim`, then count the rest.
    let mut line_buf = String::new();
    let mut total_lines: usize = 0;
    let mut collected: Vec<String> = Vec::with_capacity(lim.min(2048));

    loop {
        line_buf.clear();
        let bytes_read = reader.read_line(&mut line_buf).map_err(|e| {
            log::debug!("fs_read_file_portion read_line({}) failed: {e}", p.display());
            e.to_string()
        })?;
        if bytes_read == 0 {
            break;
        }

        if total_lines >= start && total_lines < end {
            // Strip trailing \r\n so the output is equivalent to
            // `full_content.split("\n").slice(...)` on the frontend.
            let trimmed = line_buf.trim_end_matches(['\r', '\n']);
            collected.push(trimmed.to_string());
        }
        total_lines += 1;
    }

    let end_line = (start + collected.len()).min(total_lines);
    let content = collected.join("\n");

    Ok(ReadPortionResult::Text {
        content,
        size,
        total_lines,
        start_line: start,
        end_line,
    })
}

/// Atomic write: stage into a sibling temp file, then rename over the target.
/// Prevents partial writes from leaving a half-saved file on crash/power loss.
#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "path has no file name".to_string())?;

    let tmp = parent.join(format!(".{file_name}.tedi.tmp"));

    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| {
            log::debug!("fs_write_file create({}) failed: {e}", tmp.display());
            e.to_string()
        })?;
        f.write_all(content.as_bytes()).map_err(|e| {
            log::debug!("fs_write_file write({}) failed: {e}", tmp.display());
            e.to_string()
        })?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp, &target).map_err(|e| {
        log::warn!(
            "fs_write_file rename({} -> {}) failed: {e}",
            tmp.display(),
            target.display()
        );
        // Best-effort cleanup of the staged temp.
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;

    Ok(())
}
