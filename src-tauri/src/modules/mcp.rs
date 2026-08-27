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

/// Hard cap on an un-newline-terminated stdout run. A conforming MCP server frames
/// JSON-RPC as newline-delimited lines; a malicious/buggy one writing a huge blob
/// with no newline would otherwise grow the accumulator until the host OOMs. Set
/// well above any realistic single message (large base64 image results included)
/// so it only trips on genuine abuse.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Best-effort kill of the child's whole process group on Unix. The child is a
/// group leader (`process_group(0)` below ⇒ pgid == pid), so `kill -KILL -pid`
/// reaps an `npx`/`uvx` shim's `node`/`python` grandchild that would otherwise
/// orphan to init. Dep-free (shells out to `kill`). No-op on Windows, where the
/// kill-on-close Job Object already reaps descendants.
#[cfg(unix)]
fn kill_process_group(child: &SharedChild) {
    let pid = child.id();
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(format!("-{pid}"))
        .status();
}
#[cfg(not(unix))]
fn kill_process_group(_child: &SharedChild) {}

/// Events pushed to the webview for one MCP server process.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpEvent {
    /// One complete newline-delimited JSON-RPC message line from stdout.
    Message { line: String },
    /// One line the server wrote to stderr (kept for failure diagnostics; the
    /// frontend buffers a tail and surfaces it when a connect/handshake fails).
    Stderr { line: String },
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
        kill_process_group(&self.child); // Unix: reap the grandchild before the direct child
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
///
/// Offloaded: a sync `#[tauri::command]` runs on the WebView2 UI thread on
/// Windows, and this one stats the cwd then does a full `CreateProcess`.
#[tauri::command]
pub async fn mcp_spawn(
    id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    on_event: Channel<McpEvent>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mcp_spawn_inner(id, command, args, env, cwd, on_event)
    })
    .await
    .map_err(|e| format!("mcp_spawn join error: {e}"))?
}

fn mcp_spawn_inner(
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
    //
    // The `remove` is deliberately its own statement. Edition 2021 keeps an
    // `if let` scrutinee's temporaries alive for the whole body, so
    // `if let Some(old) = procs().lock().unwrap().remove(&id) { ... }` held the
    // GLOBAL registry lock across `kill_process_group`, which on Unix is a full
    // fork/exec/wait of `kill`. Every other MCP command blocked behind it.
    let old = procs().lock().unwrap().remove(&id);
    if let Some(old) = old {
        kill_process_group(&old.child); // Unix: reap the grandchild too, not just the shim
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

    crate::modules::appimage::sanitize_env(&mut cmd);

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
                        // A run this large with no newline can only be a broken or
                        // hostile server — terminate before it exhausts host memory.
                        if acc.len() > MAX_LINE_BYTES {
                            let _ = on_event.send(McpEvent::Error {
                                message: format!(
                                    "MCP server sent {MAX_LINE_BYTES}+ bytes with no newline; terminating."
                                ),
                            });
                            proc_ref.stop_readers.store(true, Ordering::Release);
                            let _ = proc_ref.child.kill();
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // stderr reader: frame into lines and forward as Stderr events so a failed
    // handshake can surface the server's own diagnostic (missing key, bad arg).
    // Still fully drained so a full pipe never blocks the child.
    {
        let on_event = on_event.clone();
        let proc_ref = proc.clone();
        let mut pipe = stderr;
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
                            let mut end = line.len() - 1;
                            if end > 0 && line[end - 1] == b'\r' {
                                end -= 1;
                            }
                            if end == 0 {
                                continue;
                            }
                            let text = String::from_utf8_lossy(&line[..end]).into_owned();
                            let _ = on_event.send(McpEvent::Stderr { line: text });
                        }
                        if acc.len() > MAX_LINE_BYTES {
                            acc.clear(); // don't let a no-newline blob grow unbounded
                        }
                    }
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
            // Remove only if the registry still holds THIS process. The old code
            // removed by id unconditionally, so on the documented reconnect path
            // (kill the old, register the new under the same id) the dying
            // process's wait thread deleted the BRAND-NEW entry moments after it
            // was inserted. The server kept running while every later
            // `mcp_write` answered "mcp server '<id>' is not running".
            {
                let mut map = procs().lock().unwrap();
                if map.get(&id).is_some_and(|cur| Arc::ptr_eq(cur, &proc_ref)) {
                    map.remove(&id);
                }
            }
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
///
/// Offloaded: this is a BLOCKING pipe write into another process. A server that
/// stops draining its stdin (busy, wedged, or just slow) fills the pipe buffer
/// and parks the caller indefinitely — on the WebView2 UI thread on Windows,
/// that parks the whole app with it.
///
/// `spawn_blocking` is safe HERE even though it is explicitly forbidden for
/// `pty_write` (see `PtyClient::send_oneway`, where it would transpose
/// keystrokes). Two reasons: the `stdin` mutex is held across `write_all` +
/// `flush`, so a frame can never interleave with another frame; and JSON-RPC
/// pairs requests to responses by `id`, so the relative order of two concurrent
/// `send`s carries no meaning. The one ordering that does matter — `initialize`
/// before everything else — is enforced by the SDK awaiting its response.
#[tauri::command]
pub async fn mcp_write(id: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mcp_write_inner(id, data))
        .await
        .map_err(|e| format!("mcp_write join error: {e}"))?
}

fn mcp_write_inner(id: String, data: String) -> Result<(), String> {
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
pub async fn mcp_kill(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mcp_kill_inner(id))
        .await
        .map_err(|e| format!("mcp_kill join error: {e}"))?
}

fn mcp_kill_inner(id: String) -> Result<(), String> {
    // Take it out and RELEASE the registry lock before touching the process.
    // Holding it across the body (which edition 2021 does for an `if let`
    // scrutinee) meant this function could wedge the entire MCP backend: the
    // `stdin.lock()` below blocks whenever a concurrent `mcp_write` is parked in
    // `write_all` on a full pipe - the `npx` -> `node` grandchild case this file
    // already worries about - and every `mcp_spawn`/`mcp_write`/`mcp_kill` for
    // every server then queued behind the global mutex, on the shared blocking
    // pool.
    let proc = procs().lock().unwrap().remove(&id);
    if let Some(proc) = proc {
        proc.stop_readers.store(true, Ordering::Release);
        kill_process_group(&proc.child); // Unix: reap the grandchild too
        let _ = proc.child.kill();
        // Dropping stdin sends EOF, which is how a well-behaved MCP server
        // exits. `try_lock`, not `lock`: the child is already killed, so this is
        // a courtesy - and waiting on a wedged writer to hand it over is exactly
        // the stall described above. The handle drops with the Arc regardless.
        if let Ok(mut guard) = proc.stdin.try_lock() {
            *guard = None;
        }
    }
    Ok(())
}
