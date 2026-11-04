//! Language servers for the agent: go to definition, references, hover, symbols, diagnostics.
//!
//! A server is started on the first question about a file of its language and stopped after
//! [`IDLE`] without one, because rust-analyzer alone holds a gigabyte: nothing here costs anything
//! until it is used. Only a program on PATH is started. `node_modules/.bin` is what a repository
//! controls, so resolving there would run a stranger's binary on a code question.
//!
//! A server can still load project code once running (a build script, the workspace's own typescript),
//! the same as opening the folder in an editor. So the `lsp` verb asks every time and a card cannot
//! make it permanent: "always" given in one project would hold in the next one you clone.
//!
//! The whole protocol stays in this file. An answer leaves as `{path, line, col, text}` lines
//! numbered from 1, so no caller ever sees an LSP position.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Notify};

const IDLE: Duration = Duration::from_secs(300);
/// Rust-analyzer and tsserver are a gigabyte each on a big repo; the oldest makes way.
const MAX_SERVERS: usize = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// A server publishes diagnostics when it is ready, and a slow one is reported as pending.
const DIAGNOSTICS_WAIT: Duration = Duration::from_secs(8);
const MAX_RESULTS: usize = 100;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// A server that stops reading fills its pipe, and everything after that would wait on it.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Documents shown to one server. Each is re-read on every question, so this stays small.
const MAX_OPEN_DOCS: usize = 16;

struct ServerSpec {
    id: &'static str,
    extensions: &'static [&'static str],
    /// First one found on PATH wins.
    commands: &'static [(&'static str, &'static [&'static str])],
    roots: &'static [&'static str],
    install: &'static str,
}

const SERVERS: &[ServerSpec] = &[
    ServerSpec {
        id: "typescript",
        extensions: &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
        commands: &[("typescript-language-server", &["--stdio"])],
        roots: &["tsconfig.json", "jsconfig.json", "package.json"],
        install: "npm i -g typescript-language-server typescript",
    },
    ServerSpec {
        id: "rust",
        extensions: &["rs"],
        commands: &[("rust-analyzer", &[])],
        roots: &["Cargo.toml"],
        install: "rustup component add rust-analyzer",
    },
    ServerSpec {
        id: "python",
        extensions: &["py", "pyi"],
        commands: &[
            ("pyright-langserver", &["--stdio"]),
            ("basedpyright-langserver", &["--stdio"]),
            ("pylsp", &[]),
        ],
        roots: &["pyproject.toml", "setup.py", "requirements.txt"],
        install: "npm i -g pyright",
    },
    ServerSpec {
        id: "go",
        extensions: &["go"],
        commands: &[("gopls", &[])],
        roots: &["go.mod"],
        install: "go install golang.org/x/tools/gopls@latest",
    },
    ServerSpec {
        id: "cpp",
        extensions: &["c", "h", "cc", "cpp", "cxx", "hpp", "hh"],
        commands: &[("clangd", &[])],
        roots: &["compile_commands.json", "CMakeLists.txt"],
        install: "install clangd from your LLVM package",
    },
    ServerSpec {
        id: "php",
        extensions: &["php"],
        commands: &[("intelephense", &["--stdio"])],
        roots: &["composer.json"],
        install: "npm i -g intelephense",
    },
];

fn language_id(ext: &str) -> &'static str {
    match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "go" => "go",
        "c" | "h" => "c",
        "php" => "php",
        _ => "cpp",
    }
}

fn spec_for(ext: &str) -> Option<&'static ServerSpec> {
    SERVERS.iter().find(|s| s.extensions.contains(&ext))
}

/// The nearest folder holding one of `markers`, then the nearest `.git`, then the file's own.
fn find_root(file: &Path, markers: &[&str]) -> PathBuf {
    let holds = |dir: &Path, names: &[&str]| names.iter().any(|m| dir.join(m).exists());
    file.ancestors()
        .skip(1)
        .find(|d| holds(d, markers))
        .or_else(|| file.ancestors().skip(1).find(|d| holds(d, &[".git"])))
        .or_else(|| file.parent())
        .unwrap_or(file)
        .to_path_buf()
}

/// `name` on PATH, with the extensions Windows runs. PATH only: see the module doc.
fn on_path(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(str::to_owned)
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{name}{ext}")))
            .find(|p| p.is_file())
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// One framed message, or `None` when the stream has ended or lied about its length.
async fn read_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> Option<Value> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let length = length.filter(|n| *n <= MAX_MESSAGE_BYTES)?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await.ok()?;
    serde_json::from_slice(&body).ok()
}

fn frame(message: &Value) -> Vec<u8> {
    let body = message.to_string();
    format!("Content-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
}

type Pending = Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>;

struct Server {
    key: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    /// The whole tree: on Windows a server is often a `.cmd` shim over node over tsserver, and
    /// killing the shim alone left a gigabyte of orphans behind, across restarts.
    #[cfg(windows)]
    job: Option<crate::modules::pty::job::PtyJob>,
    pending: Pending,
    next_id: AtomicI64,
    last_used: AtomicU64,
    /// Open documents: uri -> (version, text).
    docs: Mutex<HashMap<String, (i64, String)>>,
    /// By path, not uri: a server answers `file:///c%3A/x` for a file opened as `file:///C:/x`.
    diagnostics: Mutex<HashMap<String, Value>>,
    diagnostics_arrived: Notify,
    /// Work the server has announced and not finished: an empty answer during it means little.
    working: Mutex<std::collections::HashSet<String>>,
}

impl Server {
    async fn send(&self, message: &Value) -> Result<(), String> {
        let bytes = frame(message);
        let write = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(&bytes).await?;
            stdin.flush().await
        };
        match tokio::time::timeout(WRITE_TIMEOUT, write).await {
            Ok(done) => done.map_err(|e| format!("the language server is gone: {e}")),
            Err(_) => {
                self.kill().await;
                Err("the language server stopped reading, so it was stopped; ask again".into())
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await
    }

    async fn request(&self, method: &str, params: Value, wait: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("the language server exited".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!(
                    "{method} timed out after {}s; the server may still be indexing",
                    wait.as_secs()
                ))
            }
        }
    }

    /// What the server asked or told us.
    async fn on_message(&self, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        match (method, message.get("id")) {
            // Answers to a request of ours.
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { return };
                if let Some(tx) = self.pending.lock().await.remove(&id) {
                    let answer = match message.get("error") {
                        Some(e) => Err(e
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("language server error")
                            .to_owned()),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(answer);
                }
            }
            // A request from the server: it must be answered, or some servers wait forever.
            (Some(method), Some(id)) => {
                let result = match method {
                    "workspace/configuration" => {
                        let n = message["params"]["items"].as_array().map_or(0, Vec::len);
                        Value::Array(vec![Value::Null; n])
                    }
                    "workspace/workspaceFolders" => Value::Null,
                    _ => Value::Null,
                };
                let _ = self
                    .send(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
                    .await;
            }
            (Some("textDocument/publishDiagnostics"), None) => {
                let params = &message["params"];
                if let Some(uri) = params["uri"].as_str() {
                    self.diagnostics
                        .lock()
                        .await
                        .insert(uri_to_path(uri), params["diagnostics"].clone());
                    self.diagnostics_arrived.notify_waiters();
                }
            }
            (Some("$/progress"), None) => {
                let token = message["params"]["token"].to_string();
                match message["params"]["value"]["kind"].as_str() {
                    Some("begin") => {
                        self.working.lock().await.insert(token);
                    }
                    Some("end") => {
                        self.working.lock().await.remove(&token);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    async fn close_doc(&self, uri: &str) -> Result<(), String> {
        self.diagnostics.lock().await.remove(&uri_to_path(uri));
        self.notify(
            "textDocument/didClose",
            json!({"textDocument": {"uri": uri}}),
        )
        .await
    }

    /// Tell the server a document's text changed, when it has.
    async fn change_doc(
        &self,
        uri: &str,
        doc: &mut (i64, String),
        text: &str,
    ) -> Result<(), String> {
        if doc.1 == text {
            return Ok(());
        }
        doc.0 += 1;
        text.clone_into(&mut doc.1);
        self.diagnostics.lock().await.remove(&uri_to_path(uri));
        self.notify(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": uri, "version": doc.0},
                "contentChanges": [{"text": text}],
            }),
        )
        .await
    }

    /// Show the server the file as it is on disk, and every other file it has open too: an open
    /// document outranks the disk, so one edited since would answer from its old text. Returns the text.
    async fn sync(&self, uri: &str, file: &Path, language: &str) -> Result<String, String> {
        let text = read_source(file).await?;
        let mut docs = self.docs.lock().await;
        for other in docs
            .keys()
            .filter(|k| *k != uri)
            .cloned()
            .collect::<Vec<_>>()
        {
            let path = url::Url::parse(&other)
                .ok()
                .and_then(|u| u.to_file_path().ok());
            let now = match path {
                Some(path) => read_source(&path).await.ok(),
                None => None,
            };
            match (now, docs.len() >= MAX_OPEN_DOCS) {
                (Some(now), false) => {
                    if let Some(doc) = docs.get_mut(&other) {
                        self.change_doc(&other, doc, &now).await?;
                    }
                }
                _ => {
                    docs.remove(&other);
                    self.close_doc(&other).await?;
                }
            }
        }
        match docs.get_mut(uri) {
            Some(doc) => self.change_doc(uri, doc, &text).await?,
            None => {
                docs.insert(uri.to_owned(), (1, text.clone()));
                self.notify(
                    "textDocument/didOpen",
                    json!({"textDocument": {
                        "uri": uri, "languageId": language, "version": 1, "text": text,
                    }}),
                )
                .await?;
            }
        }
        Ok(text)
    }

    async fn stop(&self) {
        // Polite first: a `.cmd` shim's child is the real server, and killing the shim leaves it.
        let polite = self.request("shutdown", Value::Null, Duration::from_secs(2));
        if polite.await.is_ok() {
            let _ = self.notify("exit", Value::Null).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        self.kill().await;
    }

    async fn kill(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        let _ = self.child.lock().await.start_kill();
    }
}

/// A server's place, taken before it has started: a start can take a minute, and it must not hold
/// up questions about any other language, the reaper, or quitting.
type Slot = Arc<tokio::sync::OnceCell<Arc<Server>>>;

fn servers() -> &'static Mutex<HashMap<String, Slot>> {
    static MAP: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

async fn read_source(file: &Path) -> Result<String, String> {
    let size = tokio::fs::metadata(file)
        .await
        .map_err(|e| format!("{}: {e}", file.display()))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(format!("{} is larger than 4 MB", file.display()));
    }
    tokio::fs::read_to_string(file)
        .await
        .map_err(|e| format!("{}: {e}", file.display()))
}

/// Stops whatever has been idle too long. Started once, with the first server.
fn start_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let idle: Vec<Arc<Server>> = {
                let mut map = servers().lock().await;
                let keys: Vec<String> = map
                    .iter()
                    .filter(|(_, slot)| {
                        slot.get().is_some_and(|s| {
                            now_secs().saturating_sub(s.last_used.load(Ordering::Relaxed))
                                > IDLE.as_secs()
                        })
                    })
                    .map(|(k, _)| k.clone())
                    .collect();
                keys.iter()
                    .filter_map(|k| map.remove(k).and_then(|slot| slot.get().cloned()))
                    .collect()
            };
            for server in idle {
                tauri::async_runtime::spawn(async move { server.stop().await });
            }
        }
    });
}

async fn start_server(spec: &ServerSpec, root: &Path, key: String) -> Result<Arc<Server>, String> {
    let (program, args) = spec
        .commands
        .iter()
        .find_map(|(name, args)| on_path(name).map(|p| (p, *args)))
        .ok_or_else(|| {
            format!(
                "no {} language server on PATH. Install one: {}",
                spec.id, spec.install
            )
        })?;
    let mut command = Command::new(&program);
    command
        .args(args)
        // Not the project's folder, and no looking there: an npm `.cmd` shim runs a bare `node`,
        // which cmd.exe would otherwise take from the current directory first.
        .env("NoDefaultCurrentDirectoryInExePath", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", program.display()))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    #[cfg(windows)]
    let job = child
        .id()
        .and_then(|pid| crate::modules::pty::job::PtyJob::create_for(pid).ok());

    // Drained for as long as it runs, or a chatty server blocks on a full pipe. Only the last line
    // is kept: when a server will not start, that is the reason, in its own words.
    let last_said = Arc::new(std::sync::Mutex::new(String::new()));
    let said = last_said.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                if let Ok(mut last) = said.lock() {
                    *last = line.chars().take(300).collect();
                }
            }
        }
    });

    let server = Arc::new(Server {
        key: key.clone(),
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        #[cfg(windows)]
        job,
        pending: Mutex::default(),
        next_id: AtomicI64::new(1),
        last_used: AtomicU64::new(now_secs()),
        docs: Mutex::default(),
        diagnostics: Mutex::default(),
        diagnostics_arrived: Notify::new(),
        working: Mutex::default(),
    });

    let reading = server.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        while let Some(message) = read_message(&mut reader).await {
            reading.on_message(message).await;
        }
        // Dropping the senders tells every waiter the server is gone.
        reading.pending.lock().await.clear();
        let mut map = servers().lock().await;
        if map
            .get(&reading.key)
            .and_then(|slot| slot.get())
            .is_some_and(|s| Arc::ptr_eq(s, &reading))
        {
            map.remove(&reading.key);
        }
    });

    let root_uri = url::Url::from_directory_path(root)
        .map_err(|()| format!("{} is not an absolute path", root.display()))?;
    let name = root
        .file_name()
        .map_or_else(|| "root".into(), |n| n.to_string_lossy().into_owned());
    let started = server
        .request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri.as_str(),
                "workspaceFolders": [{"uri": root_uri.as_str(), "name": name}],
                "capabilities": {
                    "general": {"positionEncodings": ["utf-16"]},
                    "window": {"workDoneProgress": true},
                    "workspace": {"symbol": {}, "configuration": true, "workspaceFolders": true},
                    "textDocument": {
                        "synchronization": {},
                        "definition": {},
                        "references": {},
                        "implementation": {},
                        "hover": {"contentFormat": ["plaintext", "markdown"]},
                        "documentSymbol": {"hierarchicalDocumentSymbolSupport": true},
                        "publishDiagnostics": {},
                    },
                },
            }),
            START_TIMEOUT,
        )
        .await;
    if let Err(e) = started {
        // It is in no map yet, so nothing else would ever stop it, and each retry would add another.
        server.kill().await;
        let said = last_said.lock().map(|s| s.clone()).unwrap_or_default();
        let why = if said.is_empty() { e } else { said };
        return Err(format!(
            "{} would not start: {why} ({})",
            program.display(),
            spec.install
        ));
    }
    server.notify("initialized", json!({})).await?;
    start_reaper();
    Ok(server)
}

async fn server_for(spec: &ServerSpec, root: &Path) -> Result<Arc<Server>, String> {
    let key = format!("{}\u{0}{}", spec.id, root.display());
    let slot = {
        let mut map = servers().lock().await;
        if !map.contains_key(&key) && map.len() >= MAX_SERVERS {
            let oldest = map
                .iter()
                .filter_map(|(k, slot)| slot.get().map(|s| (k, s)))
                .min_by_key(|(_, s)| s.last_used.load(Ordering::Relaxed))
                .map(|(k, _)| k.clone());
            if let Some(gone) = oldest
                .and_then(|k| map.remove(&k))
                .and_then(|slot| slot.get().cloned())
            {
                tauri::async_runtime::spawn(async move { gone.stop().await });
            }
        }
        map.entry(key.clone()).or_default().clone()
    };
    let started = slot
        .get_or_try_init(|| start_server(spec, root, key.clone()))
        .await
        .cloned();
    if started.is_err() {
        servers().lock().await.remove(&key);
    }
    started
}

/// LSP columns count UTF-16 units.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The LSP position of a 1-based line and either a symbol on it or a 1-based column.
fn position(
    text: &str,
    line: u64,
    column: Option<u64>,
    symbol: Option<&str>,
) -> Result<Value, String> {
    if line == 0 {
        return Err("line counts from 1".into());
    }
    let zero = line - 1;
    let content = text
        .lines()
        .nth(zero as usize)
        .ok_or_else(|| format!("the file has no line {line}"))?;
    let character = match (symbol, column) {
        (Some(symbol), _) => {
            let at = content
                .find(symbol)
                .ok_or_else(|| format!("\"{symbol}\" is not on line {line}: {}", content.trim()))?;
            utf16_len(&content[..at])
        }
        (None, Some(col)) => col.saturating_sub(1) as usize,
        (None, None) => return Err("name the `symbol` on that line, or a `column`".into()),
    };
    Ok(json!({"line": zero, "character": character}))
}

/// A `file:` uri as this app writes paths, with forward slashes.
fn uri_to_path(uri: &str) -> String {
    url::Url::parse(uri)
        .ok()
        .and_then(|u| u.to_file_path().ok())
        .map_or_else(|| uri.to_owned(), |p| normal_path(&p))
}

/// Forward slashes and an upper-case drive: tsserver answers `c:/` for a file opened as `C:/`, and
/// the same file must not read as somewhere else.
fn normal_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(drive), Some(':')) => format!("{}{}", drive.to_ascii_uppercase(), &text[1..]),
        _ => text,
    }
}

/// Reads the source line for each location, inside the project only: a location in a dependency or
/// the standard library is named, and a question about code does not read the rest of the disk.
struct Lines {
    root: String,
    files: HashMap<String, Vec<String>>,
}

impl Lines {
    fn new(root: &Path) -> Self {
        Self {
            root: normal_path(root),
            files: HashMap::new(),
        }
    }

    async fn get(&mut self, path: &str, line: usize) -> Option<String> {
        if !path.starts_with(&format!("{}/", self.root)) {
            return None;
        }
        if !self.files.contains_key(path) {
            let text = tokio::fs::read_to_string(path).await.unwrap_or_default();
            self.files
                .insert(path.to_owned(), text.lines().map(str::to_owned).collect());
        }
        let text = self.files.get(path)?.get(line)?.trim();
        Some(text.chars().take(200).collect())
    }
}

/// `Location | Location[] | LocationLink[]` -> lines numbered from 1.
async fn locations(answer: &Value, lines: &mut Lines) -> Value {
    let list: Vec<&Value> = match answer {
        Value::Array(items) => items.iter().collect(),
        Value::Null => vec![],
        one => vec![one],
    };
    let total = list.len();
    let mut out = Vec::new();
    for item in list.into_iter().take(MAX_RESULTS) {
        let uri = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let range = item
            .get("range")
            .or_else(|| item.get("targetSelectionRange"))
            .unwrap_or(&Value::Null);
        let line = range["start"]["line"].as_u64().unwrap_or(0);
        let path = uri_to_path(uri);
        let text = lines.get(&path, line as usize).await;
        let mut row = json!({
            "path": path,
            "line": line + 1,
            "col": range["start"]["character"].as_u64().unwrap_or(0) + 1,
        });
        if let Some(text) = text {
            row["text"] = json!(text);
        }
        out.push(row);
    }
    if total > MAX_RESULTS {
        json!({"total": total, "shown": out})
    } else {
        Value::Array(out)
    }
}

fn hover_text(answer: &Value) -> String {
    fn piece(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Array(items) => items.iter().map(piece).collect::<Vec<_>>().join("\n\n"),
            other => other
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        }
    }
    piece(&answer["contents"]).chars().take(4000).collect()
}

fn symbol_kind(kind: u64) -> &'static str {
    const KINDS: [&str; 26] = [
        "",
        "file",
        "module",
        "namespace",
        "package",
        "class",
        "method",
        "property",
        "field",
        "constructor",
        "enum",
        "interface",
        "function",
        "variable",
        "constant",
        "string",
        "number",
        "boolean",
        "array",
        "object",
        "key",
        "null",
        "enum member",
        "struct",
        "event",
        "operator",
    ];
    KINDS.get(kind as usize).copied().unwrap_or("symbol")
}

/// A document's symbols as a flat list. Hierarchical answers keep a `parent`.
fn flatten_symbols(items: &[Value], parent: Option<&str>, out: &mut Vec<Value>) {
    for item in items {
        if out.len() >= MAX_RESULTS * 3 {
            return;
        }
        let name = item["name"].as_str().unwrap_or_default();
        let range = item
            .get("selectionRange")
            .or_else(|| item.get("range"))
            .or_else(|| item.get("location").and_then(|l| l.get("range")))
            .unwrap_or(&Value::Null);
        let mut row = json!({
            "name": name,
            "kind": symbol_kind(item["kind"].as_u64().unwrap_or(0)),
            "line": range["start"]["line"].as_u64().unwrap_or(0) + 1,
        });
        if let Some(parent) = parent {
            row["parent"] = json!(parent);
        }
        // A project-wide search: the line means nothing without its file.
        if let Some(uri) = item["location"]["uri"].as_str() {
            row["path"] = json!(uri_to_path(uri));
        }
        out.push(row);
        if let Some(children) = item["children"].as_array() {
            flatten_symbols(children, Some(name), out);
        }
    }
}

fn describe_diagnostics(list: &Value) -> Value {
    let rows: Vec<Value> = list
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .take(MAX_RESULTS * 2)
        .map(|d| {
            let severity = match d["severity"].as_u64() {
                Some(1) => "error",
                Some(2) => "warning",
                Some(3) => "info",
                _ => "hint",
            };
            json!({
                "line": d["range"]["start"]["line"].as_u64().unwrap_or(0) + 1,
                "col": d["range"]["start"]["character"].as_u64().unwrap_or(0) + 1,
                "severity": severity,
                "message": d["message"],
                "source": d["source"],
            })
        })
        .collect();
    Value::Array(rows)
}

/// Answer one question. `args`: `{op, path, line?, symbol?, column?, query?}`.
pub async fn query(args: &Value) -> Result<Value, String> {
    let op = args["op"].as_str().ok_or("op is required")?;
    let raw = args["path"].as_str().ok_or("path is required")?;
    let file = PathBuf::from(raw);
    if !file.is_absolute() {
        return Err(format!("{raw} is not an absolute path"));
    }
    let ext = file
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let spec = spec_for(&ext).ok_or_else(|| {
        let known: Vec<&str> = SERVERS.iter().map(|s| s.id).collect();
        format!(
            "no language server for .{ext}. Known: {}.",
            known.join(", ")
        )
    })?;
    // The real path, so a link inside the project cannot name what the source lines read.
    let file = tokio::fs::canonicalize(&file)
        .await
        .map_err(|e| format!("{raw}: {e}"))?;
    let file = dunce_like(file);
    let root = find_root(&file, spec.roots);
    let server = server_for(spec, &root).await?;
    server.last_used.store(now_secs(), Ordering::Relaxed);

    let uri = url::Url::from_file_path(&file)
        .map_err(|()| format!("{raw} is not an absolute path"))?
        .to_string();
    let text = server.sync(&uri, &file, language_id(&ext)).await?;
    let at = || {
        position(
            &text,
            args["line"].as_u64().unwrap_or(0),
            args["column"].as_u64(),
            args["symbol"].as_str(),
        )
    };
    let doc = json!({"uri": uri});
    let mut lines = Lines::new(&root);
    let answer = match op {
        "definition" | "implementation" | "references" => {
            let method = format!("textDocument/{op}");
            let mut params = json!({"textDocument": doc, "position": at()?});
            if op == "references" {
                params["context"] = json!({"includeDeclaration": true});
            }
            let found = server.request(&method, params, REQUEST_TIMEOUT).await?;
            locations(&found, &mut lines).await
        }
        "hover" => {
            let params = json!({"textDocument": doc, "position": at()?});
            let found = server
                .request("textDocument/hover", params, REQUEST_TIMEOUT)
                .await?;
            json!(hover_text(&found))
        }
        "symbols" => {
            let found = match args["query"].as_str() {
                Some(query) => {
                    server
                        .request("workspace/symbol", json!({"query": query}), REQUEST_TIMEOUT)
                        .await?
                }
                None => {
                    server
                        .request(
                            "textDocument/documentSymbol",
                            json!({"textDocument": doc}),
                            REQUEST_TIMEOUT,
                        )
                        .await?
                }
            };
            let mut out = Vec::new();
            flatten_symbols(found.as_array().map_or(&[], Vec::as_slice), None, &mut out);
            Value::Array(out)
        }
        "diagnostics" => {
            let deadline = tokio::time::Instant::now() + DIAGNOSTICS_WAIT;
            loop {
                let arrived = server.diagnostics_arrived.notified();
                if let Some(list) = server.diagnostics.lock().await.get(&uri_to_path(&uri)) {
                    break describe_diagnostics(list);
                }
                if tokio::time::timeout_at(deadline, arrived).await.is_err() {
                    return Ok(json!({
                        "pending": true,
                        "note": "the server has not checked this file yet; ask again shortly",
                    }));
                }
            }
        }
        other => {
            return Err(format!(
                "unknown op \"{other}\". Have: definition, implementation, references, hover, symbols, diagnostics."
            ))
        }
    };
    let indexing = !server.working.lock().await.is_empty();
    server.last_used.store(now_secs(), Ordering::Relaxed);
    Ok(if indexing {
        json!({"result": answer, "note": "the server is still indexing, so this may be incomplete"})
    } else {
        answer
    })
}

/// `canonicalize` on Windows answers with a `\\?\` prefix, which no language server understands.
fn dunce_like(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

#[tauri::command]
pub async fn lsp_query(args: Value) -> Result<Value, String> {
    query(&args).await
}

/// Called on exit, so a server does not outlive the app.
pub fn cleanup() {
    let Ok(mut map) = servers().try_lock() else {
        return;
    };
    for server in map.drain().filter_map(|(_, slot)| slot.get().cloned()) {
        #[cfg(windows)]
        if let Some(job) = &server.job {
            job.terminate();
        }
        if let Ok(mut child) = server.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_framed_message_round_trips_and_a_bad_one_ends_the_stream() {
        let message = json!({"id": 1, "result": "é"});
        let mut good = BufReader::new(std::io::Cursor::new(frame(&message)));
        assert_eq!(read_message(&mut good).await, Some(message));
        assert_eq!(read_message(&mut good).await, None);

        let huge = format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1);
        let mut lying = BufReader::new(std::io::Cursor::new(huge.into_bytes()));
        assert_eq!(read_message(&mut lying).await, None);
    }

    #[test]
    fn a_position_comes_from_the_symbol_in_utf16() {
        let text = "first\nconst é = foo();\n";
        let found = position(text, 2, None, Some("foo")).unwrap();
        assert_eq!(found, json!({"line": 1, "character": 10}));
        assert_eq!(
            position(text, 1, Some(3), None).unwrap(),
            json!({"line": 0, "character": 2})
        );
        assert!(position(text, 9, Some(1), None).is_err());
        assert!(position(text, 0, Some(1), None).is_err());
        assert!(position(text, 2, None, Some("missing")).is_err());
        assert!(position(text, 2, None, None).is_err());
    }

    #[test]
    fn a_root_is_the_nearest_marker_and_never_above_the_file_without_one() {
        let dir = std::env::temp_dir().join(format!("tedi-lsp-root-{}", std::process::id()));
        let deep = dir.join("pkg/src");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(dir.join("pkg/package.json"), "{}").unwrap();
        assert_eq!(
            find_root(&deep.join("a.ts"), &["package.json"]),
            dir.join("pkg")
        );
        assert_eq!(
            find_root(&deep.join("a.ts"), &["no-such-marker"]),
            find_git_or_parent(&deep)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn find_git_or_parent(dir: &Path) -> PathBuf {
        dir.ancestors()
            .find(|d| d.join(".git").exists())
            .unwrap_or(dir)
            .to_path_buf()
    }

    #[test]
    fn answers_keep_only_what_a_caller_can_use() {
        assert_eq!(
            hover_text(&json!({"contents": {"value": "fn a()"}})),
            "fn a()"
        );
        assert_eq!(
            hover_text(&json!({"contents": ["a", {"value": "b"}]})),
            "a\n\nb"
        );
        let mut out = Vec::new();
        flatten_symbols(
            &[
                json!({"name": "A", "kind": 5, "selectionRange": {"start": {"line": 2}},
                     "children": [{"name": "b", "kind": 6, "range": {"start": {"line": 3}}}]}),
            ],
            None,
            &mut out,
        );
        assert_eq!(out[0], json!({"name": "A", "kind": "class", "line": 3}));
        assert_eq!(
            out[1],
            json!({"name": "b", "kind": "method", "line": 4, "parent": "A"})
        );
        let rows = describe_diagnostics(&json!([{"severity": 1, "message": "bad",
            "range": {"start": {"line": 0, "character": 4}}}]));
        assert_eq!(rows[0]["severity"], "error");
        assert_eq!(rows[0]["col"], 5);
    }

    #[test]
    fn a_path_outside_the_root_is_named_but_not_read() {
        let lines = Lines::new(Path::new("D:/project"));
        assert_eq!(lines.root, "D:/project");
        assert!(!"D:/projectile/x.ts".starts_with(&format!("{}/", lines.root)));
    }

    #[test]
    fn one_file_reads_as_one_path_whatever_case_the_server_gave_its_drive() {
        assert_eq!(normal_path(Path::new("c:/a/b.ts")), "C:/a/b.ts");
        assert_eq!(normal_path(Path::new("/home/a.ts")), "/home/a.ts");
    }

    #[test]
    fn a_verbatim_windows_path_loses_its_prefix() {
        assert_eq!(
            dunce_like(PathBuf::from(r"\\?\D:\a\b.ts")),
            PathBuf::from(r"D:\a\b.ts")
        );
    }

    /// Against the real servers, when installed: `cargo test --lib lsp::tests::live -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_typescript() {
        if on_path("typescript-language-server").is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("tedi-lsp-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("tsconfig.json"),
            "{\"compilerOptions\":{\"strict\":true}}",
        )
        .unwrap();
        let a = dir.join("a.ts");
        std::fs::write(
            &a,
            "export function add(x: number) { return x + 1; }\nadd(1);\nconst s: string = 1;\n",
        )
        .unwrap();
        let path = a.to_string_lossy().to_string();

        // An answer during indexing comes wrapped in a note. Asking again is what a caller does.
        async fn ask(args: Value) -> Value {
            for _ in 0..40 {
                let answer = query(&args).await.unwrap();
                if answer.get("note").is_none() {
                    return answer;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            panic!("still indexing");
        }
        let def = ask(json!({"op": "definition", "path": path, "line": 2, "symbol": "add"})).await;
        assert_eq!(def[0]["line"], 1, "{def}");
        assert!(
            def[0]["text"]
                .as_str()
                .unwrap_or_default()
                .contains("function add"),
            "{def}"
        );
        let refs = ask(json!({"op": "references", "path": path, "line": 1, "symbol": "add"})).await;
        assert_eq!(refs.as_array().map(Vec::len), Some(2), "{refs}");
        let hover = ask(json!({"op": "hover", "path": path, "line": 1, "symbol": "add"})).await;
        assert!(
            hover.as_str().unwrap_or_default().contains("add"),
            "{hover}"
        );
        let symbols = ask(json!({"op": "symbols", "path": path})).await;
        assert!(symbols.to_string().contains("add"), "{symbols}");
        let diagnostics = ask(json!({"op": "diagnostics", "path": path})).await;
        assert!(
            diagnostics.to_string().contains("not assignable"),
            "{diagnostics}"
        );

        cleanup();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
