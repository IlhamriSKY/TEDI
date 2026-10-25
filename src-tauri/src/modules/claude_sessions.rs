//! Claude Code's saved sessions, for the sidebar's "Claude Sessions" section.
//!
//! Layout (verified against Claude Code 2.1.310 on disk, not documented):
//!   ~/.claude/projects/<slug>/<sessionId>.jsonl   the transcript, append-only
//!   ~/.claude/projects/<slug>/<sessionId>/        its tool-results / subagents
//!   ~/.claude/sessions/<pid>.json                 { pid, sessionId } per RUNNING cli
//!
//! Titles are metadata lines Claude Code itself appends and re-appends near the
//! end of the file (`custom-title` from `/rename`, `agent-name`, `ai-title`,
//! `last-prompt`), so a TAIL read finds them: across 468 local sessions the
//! furthest one sat 34 KB from the end, while the files reach 150 MB. Reading
//! whole transcripts would be gigabytes per refresh.
//!
//! Rename appends a `custom-title` line, exactly what `/rename` writes, so
//! `claude --resume` shows the same name. Nothing here rewrites a transcript.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const TAIL_BYTES: u64 = 64 * 1024;
const HEAD_BYTES: u64 = 64 * 1024;

/// One saved agent session, Claude's or Codex's (`codex_sessions.rs` fills the
/// same shape so the sidebar renders both with one component).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub(crate) id: String,
    /// Claude: the `projects/<slug>` directory name. Lossy, so `cwd` is the real
    /// path. Codex: empty, its own index finds a thread by id.
    pub(crate) project: String,
    pub(crate) cwd: Option<String>,
    pub(crate) title: String,
    /// True when the title came from a rename, not an auto title.
    pub(crate) custom: bool,
    pub(crate) modified_ms: u64,
    /// Transcript bytes, when known (Codex does not report it).
    pub(crate) size: Option<u64>,
    /// A running process owns this session right now (Claude only).
    pub(crate) live: bool,
    /// `cwd` no longer exists (project moved or deleted). Both CLIs only find a
    /// session from its own folder, so resuming elsewhere cannot work.
    pub(crate) cwd_missing: bool,
}

/// Fill `cwd_missing`, statting each distinct folder once (sessions cluster in a
/// handful of projects).
pub(crate) fn mark_missing_cwds(list: &mut [AgentSession]) {
    let mut seen: HashMap<String, bool> = HashMap::new();
    for s in list {
        if let Some(cwd) = &s.cwd {
            s.cwd_missing = *seen
                .entry(cwd.clone())
                .or_insert_with(|| !Path::new(cwd).is_dir());
        }
    }
}

/// Parsed metadata keyed by path, reused while (mtime, size) are unchanged, so
/// a refresh only re-reads the sessions that actually moved.
type Cache = HashMap<PathBuf, ((u64, u64), Meta)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

#[derive(Clone, Default)]
struct Meta {
    cwd: Option<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    prompt: Option<String>,
    /// First real user message: the title of last resort, for sessions (often
    /// headless or `/goal` ones) whose `last-prompt` records carry no text.
    first_user: Option<String>,
    /// `cwd` maps to this session's project folder name. A later `cd` logs a
    /// different cwd, and `claude --resume` only finds the session from the
    /// folder it was started in.
    cwd_exact: bool,
}

/// `CLAUDE_CONFIG_DIR` is Claude Code's own override of `~/.claude`, so a user
/// who set it keeps their sessions there.
fn claude_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    dirs::home_dir()
        .map(|h| h.join(".claude"))
        .ok_or_else(|| "no home directory".to_string())
}

/// A session id is a UUID; anything else could walk out of `projects/`.
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A project slug is one directory name: Claude Code maps every
/// non-alphanumeric character to `-`, so no separator or dot ever survives.
fn valid_project(p: &str) -> bool {
    !p.is_empty() && p.len() <= 255 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn session_path(project: &str, id: &str) -> Result<PathBuf, String> {
    if !valid_project(project) || !valid_id(id) {
        return Err("invalid session reference".into());
    }
    Ok(claude_dir()?
        .join("projects")
        .join(project)
        .join(format!("{id}.jsonl")))
}

fn read_range(f: &mut fs::File, start: u64, len: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_ok() {
        let _ = f.take(len).read_to_end(&mut buf);
    }
    buf
}

/// The JSON string value right after `"key":` in a line, unescaped. Used on
/// lines that can be megabytes long, so it never parses the whole line.
fn string_after(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let at = line.find(&pat)? + pat.len() - 1;
    serde_json::Deserializer::from_str(&line[at..])
        .into_iter::<String>()
        .next()?
        .ok()
}

/// Fold one chunk of lines into `m`. Later lines win, matching how Claude Code
/// reads its own append-only metadata.
fn scan(chunk: &[u8], m: &mut Meta, project: &str) {
    for line in String::from_utf8_lossy(chunk).lines() {
        if line.starts_with("{\"type\":\"custom-title\"") {
            m.custom_title = string_after(line, "customTitle").or(m.custom_title.take());
        } else if line.starts_with("{\"type\":\"ai-title\"") {
            m.ai_title = string_after(line, "aiTitle").or(m.ai_title.take());
        } else if line.starts_with("{\"type\":\"last-prompt\"") {
            m.prompt = string_after(line, "lastPrompt").or(m.prompt.take());
        } else {
            if !m.cwd_exact {
                if let Some(c) = string_after(line, "cwd").map(native_cwd) {
                    m.cwd_exact = slug(&c) == project;
                    if m.cwd_exact || m.cwd.is_none() {
                        m.cwd = Some(c);
                    }
                }
            }
            // A tool result is also a `user` line; its `content` is not a prompt.
            if m.first_user.is_none()
                && line.contains("\"type\":\"user\"")
                && !line.contains("\"tool_result\"")
                && !line.contains("\"isMeta\":true")
            {
                m.first_user = string_after(line, "content")
                    .map(|c| clean_prompt(&c))
                    .filter(|c| !c.is_empty());
            }
        }
    }
}

/// A slash command logs as `<command-name>/goal</command-name>...<command-args>
/// the text</command-args>`; the args are what the user actually asked.
pub(crate) fn clean_prompt(c: &str) -> String {
    if let Some(a) = c.split("<command-args>").nth(1) {
        let args = a.split("</command-args>").next().unwrap_or("").trim();
        if !args.is_empty() {
            return args.to_string();
        }
    }
    let mut out = String::new();
    let mut in_tag = false;
    for ch in c.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Claude run from Git Bash logs its cwd as `/d/path`, which ConPTY cannot start
/// in and which would file the same project under two folders.
fn native_cwd(p: String) -> String {
    let b = p.as_bytes();
    if cfg!(windows) && b.len() >= 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() {
        if b.len() == 2 {
            return format!("{}:\\", (b[1] as char).to_ascii_uppercase());
        }
        if b[2] == b'/' {
            return format!(
                "{}:{}",
                (b[1] as char).to_ascii_uppercase(),
                p[2..].replace('/', "\\")
            );
        }
    }
    p
}

/// Claude Code's folder name for a cwd: every non-alphanumeric char becomes `-`.
fn slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn read_meta(path: &Path, size: u64, project: &str) -> Meta {
    let mut m = Meta::default();
    let Ok(mut f) = fs::File::open(path) else {
        return m;
    };
    let tail_start = size.saturating_sub(TAIL_BYTES);
    let mut tail = read_range(&mut f, tail_start, TAIL_BYTES);
    if tail_start > 0 {
        // The chunk starts mid-line; drop the fragment.
        let cut = tail
            .iter()
            .position(|&b| b == b'\n')
            .map_or(tail.len(), |i| i + 1);
        tail.drain(..cut);
    }
    scan(&tail, &mut m, project);
    // Only a file larger than the tail has a head we have not seen yet.
    let untitled = m.custom_title.is_none() && m.ai_title.is_none() && m.prompt.is_none();
    if tail_start > 0 && (!m.cwd_exact || untitled) {
        let mut head = Meta::default();
        scan(&read_range(&mut f, 0, HEAD_BYTES), &mut head, project);
        // With no folder-name match (Claude shortens very long slugs), the
        // session's FIRST cwd is its start folder; the tail only has the latest.
        if head.cwd_exact || (!m.cwd_exact && head.cwd.is_some()) {
            m.cwd_exact = head.cwd_exact;
            m.cwd = head.cwd;
        }
        // The head's first prompt beats a mid-session one the tail happened on.
        m.first_user = head.first_user.or(m.first_user);
    }
    m
}

/// Session ids held by a running `claude`. Its registry file can outlive a
/// crash, so the pid is checked against the process table too.
fn live_ids(root: &Path) -> std::collections::HashSet<String> {
    let mut by_pid: Vec<(u32, String)> = Vec::new();
    if let Ok(rd) = fs::read_dir(root.join("sessions")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&p) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            if let (Some(pid), Some(id)) = (v["pid"].as_u64(), v["sessionId"].as_str()) {
                by_pid.push((pid as u32, id.to_string()));
            }
        }
    }
    if by_pid.is_empty() {
        return Default::default();
    }
    let pids: Vec<sysinfo::Pid> = by_pid
        .iter()
        .map(|(p, _)| sysinfo::Pid::from_u32(*p))
        .collect();
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&pids),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    by_pid
        .into_iter()
        .filter(|(p, _)| sys.process(sysinfo::Pid::from_u32(*p)).is_some())
        .map(|(_, id)| id)
        .collect()
}

pub(crate) fn first_line(s: &str, max: usize) -> String {
    let line = s
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    out
}

fn list_inner() -> Result<Vec<AgentSession>, String> {
    let root = claude_dir()?;
    let projects = root.join("projects");
    let Ok(dirs) = fs::read_dir(&projects) else {
        return Ok(Vec::new());
    };
    let live = live_ids(&root);
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let old = guard.take().unwrap_or_default();
    let mut fresh: Cache = HashMap::new();
    let mut out = Vec::new();

    for d in dirs.flatten() {
        let project = d.file_name().to_string_lossy().into_owned();
        if !d.file_type().is_ok_and(|t| t.is_dir()) || !valid_project(&project) {
            continue;
        }
        let Ok(files) = fs::read_dir(d.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            let Some(id) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".jsonl"))
                .filter(|id| valid_id(id))
                .map(str::to_string)
            else {
                continue;
            };
            let Ok(md) = f.metadata() else { continue };
            let size = md.len();
            let modified_ms = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            let key = (modified_ms, size);
            let meta = match old.get(&path) {
                Some((k, m)) if *k == key => m.clone(),
                _ => read_meta(&path, size, &project),
            };
            // Claude Code's own order: `/rename` beats the auto title. `agent-name`
            // is not consulted, since Claude also writes it unasked.
            let custom = meta.custom_title.is_some();
            let title = meta
                .custom_title
                .clone()
                .or_else(|| meta.ai_title.clone())
                .map(|t| first_line(&t, 120))
                .or_else(|| meta.prompt.as_deref().map(|p| first_line(p, 80)))
                .or_else(|| meta.first_user.as_deref().map(|p| first_line(p, 80)))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| id.chars().take(8).collect());
            out.push(AgentSession {
                live: live.contains(&id),
                id,
                project: project.clone(),
                cwd: meta.cwd.clone(),
                title,
                custom,
                modified_ms,
                size: Some(size),
                cwd_missing: false,
            });
            fresh.insert(path, (key, meta));
        }
    }
    *guard = Some(fresh);
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    mark_missing_cwds(&mut out);
    Ok(out)
}

fn rename_inner(project: String, id: String, title: String) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("title must be 1-200 characters".into());
    }
    let path = session_path(&project, &id)?;
    let mut f = fs::OpenOptions::new()
        .read(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open session: {e}"))?;
    // Never glue our line onto a half-written one.
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let needs_nl = len > 0 && read_range(&mut f, len - 1, 1).first() != Some(&b'\n');
    let mut line = String::new();
    if needs_nl {
        line.push('\n');
    }
    // The same two records `/rename` appends: the list title, and the name the
    // prompt bar shows when the session is resumed.
    for (kind, field) in [("custom-title", "customTitle"), ("agent-name", "agentName")] {
        // Built by hand: `json!` sorts keys, and Claude Code (and `scan`) find
        // these records by their leading `{"type":"..."` prefix.
        let title = serde_json::to_string(title).map_err(|e| e.to_string())?;
        line.push_str(&format!(
            "{{\"type\":\"{kind}\",\"{field}\":{title},\"sessionId\":\"{id}\"}}\n"
        ));
    }
    // One write, so a concurrently appending `claude` cannot interleave mid-line.
    f.write_all(line.as_bytes())
        .map_err(|e| format!("write session: {e}"))
}

fn delete_inner(project: String, id: String) -> Result<(), String> {
    let path = session_path(&project, &id)?;
    let root = claude_dir()?;
    if live_ids(&root).contains(&id) {
        return Err("this session is running in a Claude Code process; exit it first".into());
    }
    fs::remove_file(&path).map_err(|e| format!("delete session: {e}"))?;
    // Its tool-results / subagent transcripts. Absent for short sessions.
    let side = path.with_extension("");
    if side.is_dir() {
        fs::remove_dir_all(&side).map_err(|e| format!("delete session folder: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn claude_sessions_list() -> Result<Vec<AgentSession>, String> {
    tauri::async_runtime::spawn_blocking(list_inner)
        .await
        .map_err(|e| format!("claude_sessions_list join error: {e}"))?
}

#[tauri::command]
pub async fn claude_session_rename(
    project: String,
    id: String,
    title: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_inner(project, id, title))
        .await
        .map_err(|e| format!("claude_session_rename join error: {e}"))?
}

#[tauri::command]
pub async fn claude_session_delete(project: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_inner(project, id))
        .await
        .map_err(|e| format!("claude_session_delete join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_escapes() {
        assert!(!valid_project(".."));
        assert!(!valid_project("a/b"));
        assert!(!valid_project("a\\b"));
        assert!(valid_project("D--Ilham-Project-laragon-www"));
        assert!(!valid_id("../x"));
        assert!(valid_id("75af19d9-b25c-486e-82c6-0f14688d1ede"));
    }

    #[test]
    fn later_metadata_wins_and_custom_beats_ai() {
        let log = concat!(
            "{\"type\":\"ai-title\",\"aiTitle\":\"Old\",\"sessionId\":\"x\"}\n",
            // A `cd` into a subfolder must not move the session's folder.
            "{\"type\":\"user\",\"cwd\":\"D:\\\\a b\\\\c\\\\sub\",\"message\":{}}\n",
            "{\"type\":\"user\",\"cwd\":\"D:\\\\a b\\\\c\",\"message\":{}}\n",
            "{\"type\":\"user\",\"cwd\":\"D:\\\\a b\\\\c\\\\sub\",\"message\":{}}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"First\",\"sessionId\":\"x\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"Mine \\\"q\\\"\",\"sessionId\":\"x\"}\n",
        );
        let mut m = Meta::default();
        scan(log.as_bytes(), &mut m, "D--a-b-c");
        assert_eq!(m.custom_title.as_deref(), Some("Mine \"q\""));
        assert_eq!(m.ai_title.as_deref(), Some("Old"));
        assert_eq!(m.cwd.as_deref(), Some("D:\\a b\\c"));
    }

    /// A transcript larger than the tail window, written to a temp file.
    fn big_log(head: &str, tail: &str) -> (PathBuf, u64) {
        let pad = "{\"type\":\"assistant\",\"message\":{}}\n".repeat(4000);
        let body = format!("{head}{pad}{tail}");
        assert!(body.len() as u64 > TAIL_BYTES);
        let p = std::env::temp_dir().join(format!("tedi-cs-{}.jsonl", std::process::id()));
        fs::write(&p, &body).unwrap();
        (p, body.len() as u64)
    }

    #[test]
    fn start_cwd_wins_without_a_slug_match() {
        let (p, size) = big_log(
            "{\"type\":\"user\",\"cwd\":\"/start\",\"message\":{}}\n",
            "{\"type\":\"user\",\"cwd\":\"/start/sub\",\"message\":{}}\n\
             {\"type\":\"ai-title\",\"aiTitle\":\"T\",\"sessionId\":\"x\"}\n",
        );
        // Long paths get a shortened slug that matches neither cwd.
        let m = read_meta(&p, size, "-start-x1y2z3");
        assert_eq!(m.cwd.as_deref(), Some("/start"));
        // A tail cwd that DOES match is kept, even when the head is read for a title.
        let (p, size) = big_log(
            "{\"type\":\"user\",\"cwd\":\"/elsewhere\",\"message\":{}}\n",
            "{\"type\":\"user\",\"cwd\":\"/start\",\"message\":{}}\n",
        );
        let m = read_meta(&p, size, "-start");
        assert_eq!(m.cwd.as_deref(), Some("/start"));
        let _ = fs::remove_file(p);
    }

    #[test]
    fn marks_vanished_project_folders() {
        let here = std::env::temp_dir().to_string_lossy().into_owned();
        let mk = |cwd: Option<&str>| AgentSession {
            id: "a".into(),
            project: String::new(),
            cwd: cwd.map(str::to_string),
            title: String::new(),
            custom: false,
            modified_ms: 0,
            size: None,
            live: false,
            cwd_missing: false,
        };
        let mut list = vec![
            mk(Some(&here)),
            mk(Some("Z:/tedi/does/not/exist")),
            mk(None),
        ];
        mark_missing_cwds(&mut list);
        let got: Vec<bool> = list.iter().map(|s| s.cwd_missing).collect();
        assert_eq!(got, [false, true, false]);
    }

    #[test]
    fn prompt_fallback_and_bash_cwd() {
        assert_eq!(
            clean_prompt("<command-name>/goal</command-name><command-args>fix it</command-args>"),
            "fix it"
        );
        assert_eq!(
            clean_prompt("<ide_opened_file>x</ide_opened_file>hello"),
            "xhello"
        );
        if cfg!(windows) {
            assert_eq!(native_cwd("/d/Ilham/www".into()), r"D:\Ilham\www");
            assert_eq!(native_cwd("/d".into()), r"D:\");
            assert_eq!(native_cwd("/dev/x".into()), "/dev/x");
        }
    }

    /// List -> rename -> delete on a throwaway session in the REAL
    /// `~/.claude/projects` (a `Z--tedi-selftest` folder it removes again):
    /// `cargo test --lib claude_sessions -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn rename_and_delete_round_trip() {
        let project = "Z--tedi-selftest";
        let id = "00000000-0000-4000-8000-00000000beef";
        let dir = claude_dir().unwrap().join("projects").join(project);
        fs::create_dir_all(dir.join(id).join("tool-results")).unwrap();
        // No trailing newline: rename must not glue its record onto this line.
        fs::write(
            dir.join(format!("{id}.jsonl")),
            "{\"type\":\"user\",\"cwd\":\"Z:\\\\tedi\\\\selftest\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"Auto\",\"sessionId\":\"x\"}",
        )
        .unwrap();
        let find = || list_inner().unwrap().into_iter().find(|s| s.id == id);

        let s = find().expect("listed");
        assert_eq!((s.title.as_str(), s.custom), ("Auto", false));
        assert_eq!(s.cwd.as_deref(), Some(r"Z:\tedi\selftest"));

        rename_inner(project.into(), id.into(), "  My \"name\"  ".into()).unwrap();
        let s = find().expect("still listed");
        assert_eq!((s.title.as_str(), s.custom), ("My \"name\"", true));
        // Every line is still valid JSON after the append.
        let raw = fs::read_to_string(dir.join(format!("{id}.jsonl"))).unwrap();
        for l in raw.lines() {
            serde_json::from_str::<serde_json::Value>(l).expect(l);
        }
        assert!(rename_inner(project.into(), id.into(), "   ".into()).is_err());
        assert!(rename_inner("..".into(), id.into(), "x".into()).is_err());
        assert!(delete_inner(project.into(), "../../x".into()).is_err());

        delete_inner(project.into(), id.into()).unwrap();
        assert!(find().is_none());
        assert!(!dir.join(id).exists(), "sidecar folder removed");
        fs::remove_dir(&dir).unwrap();
    }

    /// Real-data smoke run: `cargo test --lib claude_sessions -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn lists_this_machines_sessions() {
        let t = std::time::Instant::now();
        let cold = list_inner().unwrap();
        let cold_ms = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let warm = list_inner().unwrap();
        let untitled = cold.iter().filter(|s| s.title.len() == 8).count();
        let no_cwd = cold.iter().filter(|s| s.cwd.is_none()).count();
        println!(
            "{} sessions, cold {cold_ms} ms, warm {} ms, untitled {untitled}, no cwd {no_cwd}, live {}",
            cold.len(),
            t.elapsed().as_millis(),
            cold.iter().filter(|s| s.live).count()
        );
        for s in cold.iter().take(5) {
            println!("  {} | {} | {:?}", s.title, s.id, s.cwd);
        }
        assert_eq!(cold.len(), warm.len());
    }
}
