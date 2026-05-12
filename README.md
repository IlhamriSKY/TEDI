<div align="center">
  <img src="public/icon.png" width="120" height="120" alt="CMDAN" />
  <h1>CMDAN</h1>

  <p><strong>AI-native terminal emulator — fork of <a href="https://github.com/crynta/terax-ai">crynta/terax-ai</a></strong></p>

  <p>
    <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" />
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
    <img src="https://img.shields.io/badge/fork%20of-crynta%2Fterax--ai-blue" alt="fork" />
  </p>
</div>

---

CMDAN is an opinionated fork of [Terax](https://github.com/crynta/terax-ai). Same Tauri 2 + Rust core, same xterm.js + CodeMirror frontend, same BYOK AI — with a heavier focus on multi-project workflows, in-terminal navigation, and visual previews. See [Differences vs. Terax](#differences-vs-terax) below for what changed.

> **Heads-up**: auto-update is disabled in this fork. Grab new builds manually from the [Releases](https://github.com/IlhamriSKY/CMDAN/releases) page.

## Install

Pre-built binaries: **[Releases → latest](https://github.com/IlhamriSKY/CMDAN/releases/latest)**

Windows · macOS · Linux (`.deb`, `.rpm`, `.AppImage`). Pick the artifact for your OS, download, install. No auto-updater — re-download from Releases when a new version drops.

## Features

**Terminal**
- xterm.js + WebGL, multi-tab, background-streaming inactive tabs
- Native PTY via `portable-pty` (zsh, bash, fish, pwsh, …)
- Shell integration: cwd + prompt markers via OSC 7 / 133
- **Spawn new tabs *from inside* a shell** — no more `start cmd` or `gnome-terminal` popping outside the app (OSC 8889 + `cmdan_open`)
- **Split panes**: horizontal and vertical, mix terminals and editors freely
- Inline search, link detection, true-color

**Editor**
- CodeMirror 6 with TS/JS, Rust, Python, PHP, HTML/CSS, JSON, Markdown, C/C++, Java, C#
- Inline AI autocomplete + diff-based edit approvals
- Vim mode + themes (Tokyo Night, Nord, GitHub, Atom One, Aura, Copilot, Xcode)
- Images render inline; Markdown has a side-by-side preview

**Workspaces & Tabs**
- **Workspaces**: keep distinct project sessions (tab layout + cwd) and switch between them without re-opening folders
- **Open new folder**: pick a workspace root from the header; auto-spawns a terminal there
- **Tab grouping & reordering**: drag tabs to reorder them
- Sortable, pinnable tabs across terminal / editor / preview / AI-diff kinds

**AI (BYOK)**
- OpenAI · Anthropic · Google · Groq · xAI · Cerebras · OpenAI-compatible (LM Studio for offline)
- Voice input, multi-agent / sub-agents, snippets, custom system prompt
- Tools: read / write / grep / glob / shell with explicit approval
- Project memory via `CMDAN.md` at workspace root
- Improved tool-call flow and fewer dead-end failures vs upstream

**File Explorer**
- Catppuccin / Material icon theme, fuzzy search, inline rename
- "Reveal in terminal" opens a new tab rooted at the picked folder

**Quality**
- Apache-2.0, no telemetry, API keys in OS keychain (`keyring`)
- Small bundle (~7–10 MB depending on platform)

## Differences vs. Terax

| Area | Upstream Terax | CMDAN |
|---|---|---|
| Workspaces | Single session | Named workspaces with persisted tab layouts |
| Tabs | Standard | Sortable, draggable, group-able across kinds |
| Splits | Single pane | Terminal + editor split panes per tab |
| Spawn new terminal | External `cmd.exe` / shell window | Spawn inside CMDAN via OSC 8889 / `cmdan_open` |
| Images | — | Inline preview tab |
| Markdown | Edit only | Edit + side-by-side rendered preview |
| AI | Stock pipeline | Improved tool routing, sub-agents, snippets, plan mode |
| Code editor | Vanilla CM6 | Tweaked theming, gutter, vim integration polish |
| Updater | Auto via GitHub releases | **Disabled** — download manually |
| Bundle ID | `app.crynta.terax` | `id.ilhamrisky.cmdan` |
| Keychain service | `terax-ai` | `cmdan` |

The Terax upstream remains the source of truth for the core PTY/Rust backend; CMDAN periodically rebases UX changes on top of it.

## Configure AI

Settings → AI → pick a provider, paste your API key. For local inference, point CMDAN at your LM Studio endpoint. Keys are written to the OS keychain via `keyring` — never to disk or `localStorage`.

## Build from source

**Prereqs**
- Rust stable — https://rustup.rs
- Node 20+ and [pnpm](https://pnpm.io)
- Tauri platform prereqs — https://tauri.app/start/prerequisites/

```bash
pnpm install
pnpm tauri dev     # dev
pnpm tauri build   # production bundle
```

**Checks**
```bash
pnpm exec tsc --noEmit          # frontend type-check
cd src-tauri && cargo clippy    # Rust lint
```

## Notes per platform

- **Windows**: SmartScreen will warn on first launch (unsigned). Click *More info → Run anyway*. Shell priority: `pwsh.exe` → `powershell.exe` → `cmd.exe`.
- **Linux**: if you hit `EGL_BAD_PARAMETER` / blank window, set `WEBKIT_DISABLE_DMABUF_RENDERER=1`. AppImage needs FUSE — otherwise run `--appimage-extract-and-run` or install the `.deb`/`.rpm`.
- **macOS**: minimum macOS 10.15.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). CMDAN is a derivative work of [crynta/terax-ai](https://github.com/crynta/terax-ai); upstream copyright notices are preserved.
