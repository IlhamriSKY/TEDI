//! Stdio transport host for MCP (Model Context Protocol) servers.
//!
//! The webview cannot spawn child processes, so the MCP SDK's Node-only
//! `StdioClientTransport` (it pulls in `cross-spawn`/`which`, which reference
//! the `process` global) blows up at load with `ReferenceError: process is not
//! defined`. This module is the backend half of a Tauri-native stdio transport:
//! it spawns the server with piped stdin/stdout, frames the server's stdout as
//! newline-delimited JSON-RPC messages streamed back over an IPC `Channel`, and
//! exposes write/kill. The frontend half lives in `src/modules/ai/lib/mcpTransport.ts`.
//!
//! Modeled on `net::http_stream` (Channel streaming + a static id-keyed
//! registry) and reuses `shared_child` + the Windows kill-on-close Job Object
//! the same way `shell::background` does.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use shared_child::SharedChild;
use tauri::ipc::Channel;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Suppress the console window Windows hands a console-subsystem child of a GUI
/// parent — without it every `npx`/`node` MCP server flashes a black cmd window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Events pushed to the webview for one MCP server process.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpEvent {
    /// One complete newline-delimited JSON-RPC message line from stdout.
    Message { line: String },
    /// The server process exited (`code` is None when killed by signal).
    Exit { code: Option<i32> },
    /// Terminal spawn/IO error.
    Error { message: String },
}

struct McpProc {
    child: Arc<SharedChild>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
    // Bounds the reader threads: on Unix there is no Job Object, so a grandchild
    // that inherited the pipe (the `npx` shim -> `node` case) would otherwise
    // park the readers on read() forever after the direct child is killed.
    stop_readers: AtomicBool,
    // Windows: kill-on-close Job Object force-kills the server's descendants
    // (e.g. the `node` grandchild behind an `npx` shim) when this drops.
    #[cfg(windows)]
    _job: Option<crate::modules::pty::job::PtyJob>,
}

impl Drop for McpProc {
    fn drop(&mut self) {
        self.stop_readers.store(true, Ordering::Release);
        let _ = self.child.kill();
    }
}

/// Live MCP server processes keyed by the frontend-supplied connection id.
static PROCS: OnceLock<Mutex<HashMap<String, Arc<McpProc>>>> = OnceLock::new();

fn procs() -> &'static Mutex<HashMap<String, Arc<McpProc>>> {
    PROCS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Windows: `Command::new("npx")` searches only for `npx.exe` and misses the
/// `npx.cmd` shim every Node tool ships, so stdio MCP servers (overwhelmingly
/// `npx`/`uvx`-launched) fail to spawn. Resolve a bare program name through
/// PATH + PATHEXT to a concrete path; Rust std then routes the resulting
/// `.cmd`/`.bat` through cmd.exe with the CVE-2024-24576 escaping. A name that
/// already carries a path separator or extension is used verbatim.
#[cfg(windows)]
fn resolve_program(program: &str) -> String {
    use std::path::Path;
    let p = Path::new(program);
    if p.components().count() > 1 || p.extension().is_some() {
        return program.to_string();
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                let cand = dir.join(format!("{program}{ext}"));
                if cand.is_file() {
                    return cand.to_string_lossy().into_owned();
                }
            }
        }
    }
    program.to_string()
}

#[cfg(not(windows))]
fn resolve_program(program: &str) -> String {
    program.to_string()
}

/// Spawn an MCP server with piped stdio. Stdout is framed into JSON-RPC lines
/// and streamed via `on_event`; the process is tracked under `id` for
/// `mcp_write`/`mcp_kill`. Returns once the process is spawned (not when it
/// exits) — failures after spawn surface as `McpEvent::Exit`/`Error`.
#[tauri::command]
pub fn mcp_spawn(
    id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    on_event: Channel<McpEvent>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    // Replace any existing process under this id (reconnect) so we never leak.
    if let Some(old) = procs().lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }

    let mut cmd = std::process::Command::new(resolve_program(&command));
    cmd.args(&args);
    if let Some(env) = env {
        cmd.envs(env); // additive: inherit parent env (PATH, etc.), then overlay
    }
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let shared = SharedChild::spawn(&mut cmd).map_err(|e| format!("spawn failed: {e}"))?;
    let stdin = shared.take_stdin();
    let stdout = shared.take_stdout().ok_or("no stdout pipe")?;
    let stderr = shared.take_stderr().ok_or("no stderr pipe")?;

    #[cfg(windows)]
    let job = match crate::modules::pty::job::PtyJob::create_for(shared.id()) {
        Ok(j) => Some(j),
        Err(e) => {
            log::warn!("mcp job-object setup failed for pid={}: {e}", shared.id());
            None
        }
    };

    let child = Arc::new(shared);
    let proc = Arc::new(McpProc {
        child: child.clone(),
        stdin: Mutex::new(stdin),
        stop_readers: AtomicBool::new(false),
        #[cfg(windows)]
        _job: job,
    });
    procs().lock().unwrap().insert(id.clone(), proc.clone());

    // stdout reader: frame newline-delimited JSON-RPC and push each line.
    {
        let on_event = on_event.clone();
        let proc_ref = proc.clone();
        let mut pipe = stdout;
        thread::spawn(move || {
            let mut acc: Vec<u8> = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                if proc_ref.stop_readers.load(Ordering::Acquire) {
                    break;
                }
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        acc.extend_from_slice(&buf[..n]);
                        while let Some(nl) = acc.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = acc.drain(..=nl).collect();
                            // Trim the '\n' and an optional preceding '\r'.
                            let mut end = line.len() - 1;
                            if end > 0 && line[end - 1] == b'\r' {
                                end -= 1;
                            }
                            if end == 0 {
                                continue;
                            }
                            let text = String::from_utf8_lossy(&line[..end]).into_owned();
                            if on_event.send(McpEvent::Message { line: text }).is_err() {
                                return; // frontend tore the channel down
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // stderr drain: MCP servers log diagnostics here. Read and discard so a
    // full pipe never blocks the child (matches the old JS host's behavior).
    {
        let proc_ref = proc.clone();
        let mut pipe = stderr;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                if proc_ref.stop_readers.load(Ordering::Acquire) {
                    break;
                }
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
    }

    // wait thread: report exit and drop the registry entry (which drops the
    // Windows Job Object and reaps any descendants).
    {
        let on_event = on_event.clone();
        let child_wait = child;
        let id = id.clone();
        let proc_ref = proc;
        thread::spawn(move || {
            let code = child_wait.wait().ok().and_then(|s| s.code());
            let _ = on_event.send(McpEvent::Exit { code });
            procs().lock().unwrap().remove(&id);
            // The direct child is reaped; on Unix a grandchild may still hold the
            // pipe, parking the readers on read(). After a grace window, signal
            // them to stop so the threads + FDs are released.
            thread::sleep(Duration::from_secs(2));
            proc_ref.stop_readers.store(true, Ordering::Release);
        });
    }

    Ok(())
}

/// Write a raw frame (caller appends the trailing newline) to the server's stdin.
#[tauri::command]
pub fn mcp_write(id: String, data: String) -> Result<(), String> {
    let proc = procs()
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("mcp server '{id}' is not running"))?;
    let mut guard = proc.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("stdin closed")?;
    stdin
        .write_all(data.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

/// Kill the server process and forget it. Idempotent.
#[tauri::command]
pub fn mcp_kill(id: String) -> Result<(), String> {
    if let Some(proc) = procs().lock().unwrap().remove(&id) {
        proc.stop_readers.store(true, Ordering::Release);
        let _ = proc.child.kill();
        *proc.stdin.lock().unwrap() = None; // drop stdin → EOF to the child
    }
    Ok(())
}
