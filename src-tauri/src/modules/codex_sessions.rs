//! Codex CLI's saved sessions ("threads"), for the sidebar's AI Sessions section.
//!
//! Unlike Claude Code, Codex keeps TWO indexes beside its rollout files
//! (`~/.codex/session_index.jsonl` and the `threads` table in `state_5.sqlite`),
//! and they already disagree on this machine (36 names vs 1). Deleting a rollout
//! behind their back leaves a row that breaks `codex resume`. So nothing here
//! touches Codex's files: every action goes through Codex's own app-server
//! (`thread/list`, `thread/name/set`, `thread/delete`; verified on codex-cli
//! 0.163), the same API its desktop app and VS Code extension use.
//!
//! One short-lived `codex app-server` per action, JSON-RPC over stdio. It is
//! spawned only when the user opens the section or acts on a row, never polled.

use super::claude_sessions::{clean_prompt, first_line, mark_missing_cwds, valid_id, AgentSession};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Cold start measured at ~1.1 s; this only trips on a wedged server.
const TIMEOUT: Duration = Duration::from_secs(20);
/// Upper bound on listed threads, so a pathological history cannot hang the panel.
const MAX_THREADS: usize = 2000;
/// The server exits on stdin EOF in ~30 ms; this is the grace before the kill.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// JSON-RPC "method not found": a Codex older than this API.
const METHOD_NOT_FOUND: i64 = -32601;

struct AppServer {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
    // Kills the `codex.cmd` -> node -> codex.exe chain on drop, not just the shim.
    #[cfg(windows)]
    _job: Option<crate::modules::pty::job::PtyJob>,
}

impl AppServer {
    fn start() -> Result<Self, String> {
        let mut cmd = Command::new(crate::modules::mcp::resolve_program("codex"));
        cmd.arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        crate::modules::appimage::sanitize_env(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Codex CLI not found on PATH".to_string()
            } else {
                format!("could not start codex: {e}")
            }
        })?;
        #[cfg(windows)]
        let job = crate::modules::pty::job::PtyJob::create_for(child.id()).ok();
        let stdout = child.stdout.take().ok_or("no stdout pipe")?;
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut s = AppServer {
            stdin: child.stdin.take(),
            child,
            lines,
            next_id: 0,
            #[cfg(windows)]
            _job: job,
        };
        s.call(
            "initialize",
            json!({ "clientInfo": { "name": "tedi", "version": env!("CARGO_PKG_VERSION") } }),
        )?;
        s.send(&json!({ "method": "initialized" }))?;
        Ok(s)
    }

    fn send(&mut self, msg: &Value) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("codex stdin closed")?;
        writeln!(stdin, "{msg}")
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("codex app-server write: {e}"))
    }

    /// One request; skips notifications and anything else until its response.
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .map_err(|_| format!("codex app-server did not answer {method}"))?;
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if msg["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                if err["code"].as_i64() == Some(METHOD_NOT_FOUND) {
                    return Err(format!(
                        "This Codex CLI has no {method}; update it with `codex update`"
                    ));
                }
                let text = err["message"].as_str().unwrap_or("unknown error");
                return Err(format!("codex {method}: {text}"));
            }
            return Ok(msg["result"].clone());
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        // EOF on stdin is the real stop: the server exits on it, and on Unix that
        // is what also ends the native `codex` behind the npm shim, which a kill
        // of the shim alone would orphan. The kill (and on Windows the job) is the
        // fallback for a server that hangs.
        self.stdin.take();
        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `thread/list` sends `updatedAt` in seconds.
fn to_session(t: &Value) -> Option<AgentSession> {
    let id = t["id"].as_str().filter(|id| valid_id(id))?.to_string();
    let name = t["name"].as_str().map(str::trim).filter(|n| !n.is_empty());
    let title = name
        .map(|n| first_line(n, 120))
        .or_else(|| {
            t["preview"]
                .as_str()
                .map(|p| first_line(&clean_prompt(p), 80))
                .filter(|p| !p.is_empty())
        })
        .unwrap_or_else(|| id.chars().take(8).collect());
    Some(AgentSession {
        // The state DB stores Windows verbatim paths (`\\?\C:\...`); one folder
        // must not show up as two groups depending on which store answered.
        cwd: t["cwd"]
            .as_str()
            .map(|c| c.strip_prefix(r"\\?\").unwrap_or(c))
            .filter(|c| !c.is_empty())
            .map(str::to_string),
        custom: name.is_some(),
        modified_ms: t["updatedAt"].as_u64().unwrap_or(0) * 1000,
        project: String::new(),
        size: None,
        live: false,
        cwd_missing: false,
        title,
        id,
    })
}

fn list_inner() -> Result<Vec<AgentSession>, String> {
    let mut srv = AppServer::start()?;
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = srv.call(
            "thread/list",
            json!({ "limit": 200, "cursor": cursor, "sortKey": "updated_at" }),
        )?;
        if let Some(data) = page["data"].as_array() {
            out.extend(data.iter().filter_map(to_session));
        }
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() || out.len() >= MAX_THREADS {
            break;
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
    mark_missing_cwds(&mut out);
    Ok(out)
}

fn checked(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err("invalid session id".into())
    }
}

#[tauri::command]
pub async fn codex_sessions_list() -> Result<Vec<AgentSession>, String> {
    tauri::async_runtime::spawn_blocking(list_inner)
        .await
        .map_err(|e| format!("codex_sessions_list join error: {e}"))?
}

fn rename_inner(id: String, title: String) -> Result<(), String> {
    checked(&id)?;
    let name = title.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err("title must be 1-200 characters".into());
    }
    AppServer::start()?
        .call("thread/name/set", json!({ "threadId": id, "name": name }))
        .map(|_| ())
}

fn delete_inner(id: String) -> Result<(), String> {
    checked(&id)?;
    AppServer::start()?
        .call("thread/delete", json!({ "threadId": id }))
        .map(|_| ())
}

#[tauri::command]
pub async fn codex_session_rename(id: String, title: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_inner(id, title))
        .await
        .map_err(|e| format!("codex_session_rename join error: {e}"))?
}

#[tauri::command]
pub async fn codex_session_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_inner(id))
        .await
        .map_err(|e| format!("codex_session_delete join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_a_thread() {
        let t = json!({
            "id": "01a0de25-536c-7813-9581-a13f0381a4c9",
            "name": null,
            "preview": "update my opencode\nmore",
            "cwd": "D:\\x",
            "updatedAt": 1790433391u64
        });
        let s = to_session(&t).unwrap();
        assert_eq!((s.title.as_str(), s.custom), ("update my opencode", false));
        assert_eq!(s.modified_ms, 1790433391000);
        let named =
            to_session(&json!({ "id": "abc-1", "name": " Mine ", "preview": "x" })).unwrap();
        assert_eq!((named.title.as_str(), named.custom), ("Mine", true));
        let verbatim = to_session(&json!({ "id": "abc-2", "cwd": r"\\?\D:\x" })).unwrap();
        assert_eq!(verbatim.cwd.as_deref(), Some(r"D:\x"));
        // An id that could not be typed safely into a shell is dropped, not listed.
        assert!(to_session(&json!({ "id": "x; rm -rf /" })).is_none());
    }

    /// Rename + delete a THROWAWAY thread made with `thread/start`, never a real
    /// one: `CODEX_TEST_THREAD=<id> cargo test --lib codex_sessions -- --ignored`.
    #[test]
    #[ignore]
    fn rename_and_delete_round_trip() {
        let Ok(id) = std::env::var("CODEX_TEST_THREAD") else {
            return;
        };
        let find = || list_inner().unwrap().into_iter().find(|s| s.id == id);
        println!("listed before rename: {}", find().is_some());
        rename_inner(id.clone(), "  TEDI \"probe\"  ".into()).unwrap();
        let s = find().expect("a named thread is listed");
        assert_eq!((s.title.as_str(), s.custom), ("TEDI \"probe\"", true));
        assert!(rename_inner(id.clone(), "  ".into()).is_err());
        assert!(delete_inner("x; rm".into()).is_err());
        delete_inner(id.clone()).unwrap();
        assert!(find().is_none(), "deleted thread still listed");
    }

    /// Real Codex, read-only: `cargo test --lib codex_sessions -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn lists_this_machines_threads() {
        let t = Instant::now();
        let list = list_inner().unwrap();
        println!("{} threads in {} ms", list.len(), t.elapsed().as_millis());
        for s in list.iter().take(4) {
            println!("  {} | {} | {:?}", s.title, s.id, s.cwd);
        }
    }
}
