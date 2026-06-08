<div align="center">
  <img src="public/icon.png" width="120" height="120" alt="TEDI" />
  <h1>TEDI</h1>
  <p><strong>One lightweight app. Eight features. Your whole dev workflow in a single window.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" />
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
    <img src="https://img.shields.io/badge/footprint-~7--10%20MB-brightgreen" alt="footprint" />
    <img src="https://img.shields.io/badge/telemetry-none-blue" alt="no telemetry" />
  </p>
</div>

---

## What is TEDI?

**TEDI** (**T**erminal **E**nvironment & **D**evelopment **I**nfrastructure) is a lightweight, low-footprint desktop app that folds eight tools devs reach for every day into one window - so you stop alt-tabbing between a terminal, an SSH client, a DB browser, an editor, an AI chat, a browser, and a Git tool.

Built on Tauri 2 (Rust + a single webview), the whole app ships in roughly **7-10 MB** with **no telemetry** and API keys kept in the OS keychain.

## The eight features

| # | Feature | What it does |
|---|---------|--------------|
| 1 | **Terminal multiplexer** | Native PTY terminals (zsh / bash / fish / pwsh) on xterm.js + WebGL, split horizontally/vertically, grouped into tabs, with shell integration (cwd + prompt markers via OSC 7 / 133), inline search, and link detection. Inactive tabs keep streaming in the background. |
| 2 | **SSH connection** | Connect to remote hosts (`russh`), open remote terminals, and browse/transfer files over an integrated **SFTP** explorer - all from a saved connection manager. |
| 3 | **SQL explorer** *(extension)* | Browse and query databases from a dedicated panel - delivered through TEDI's extension system (see feature 8), so it installs at runtime and updates independently. |
| 4 | **Code editor** | CodeMirror 6 with TS/JS, Rust, Python, PHP, HTML/CSS, JSON, Markdown, C/C++, Java, C#, SQL and more - plus inline AI autocomplete, diff view, Vim mode, image preview, and side-by-side Markdown preview. |
| 5 | **AI-native agent** | Bring-your-own-key agent (OpenAI, Anthropic, Google, Groq, xAI, Cerebras, DeepSeek, any OpenAI-compatible endpoint, and **local** LM Studio). Multi-agent / sub-agents, voice input, project memory via `TEDI.md`, and tools (read / write / grep / glob / shell) gated behind explicit approval. |
| 6 | **AI browser control** | A real in-app browser (native webview, not an iframe) that the agent can drive end-to-end: navigate, read the page, type like a human, click, scroll, and - as a last resort - screenshot the tab to *see* it. Group and rotate browser panes alongside your terminals. |
| 7 | **Workspaces** | Each workspace keeps a distinct project session (tab layout + working dirs) and switches instantly without re-opening folders. The header's open-folder picker spawns a terminal rooted at the chosen directory. |
| 8 | **Source control + extensions** | Inline Git diff / SCM pane for staging and reviewing changes, and a first-class **extension/plugin** system: install from a local `.zip` or a GitHub release and pull in settings, themes, slash commands, AI tools, commands, keybindings, and panels (this is how the SQL explorer above plugs in). |

…and it's all **fully themeable** - presets, custom colors, transparency, and extension-supplied themes - while staying lightweight.

## Install

Pre-built binaries: **[Releases](https://github.com/IlhamriSKY/TEDI/releases/latest)**.

Windows, macOS, and Linux (`.deb`, `.rpm`, `.AppImage`). Download the artifact for your OS and install. TEDI checks for updates automatically; re-download from Releases or check in Settings when a new version drops.

## Screenshots

<p align="center">
  <img src="docs/tedi1.png" width="49%" alt="TEDI screenshot 1" />
  <img src="docs/tedi2.png" width="49%" alt="TEDI screenshot 2" />
</p>
<p align="center">
  <img src="docs/tedi3.png" width="49%" alt="TEDI screenshot 3" />
  <img src="docs/tedi4.png" width="49%" alt="TEDI screenshot 4" />
</p>

## Configure AI

Settings > AI > pick a provider, paste your API key. For local/offline inference, point TEDI at your LM Studio endpoint. Keys are written to the OS keychain via `keyring` - they never touch disk or `localStorage`. Full provider list: `PROVIDERS` in [src/modules/ai/config.ts](src/modules/ai/config.ts).

## Extensions

TEDI ships **no extensions** in the binary - every extension (the SQL explorer included) is installed at runtime from either a local `.zip` or a GitHub release. Re-installing the same `manifest.id` replaces the previous copy, so the same install paths handle updates too.

```
Settings → Extensions → From file       (pick a local .zip)
Settings → Extensions → From GitHub     (paste owner/repo)
Settings → Extensions → Check updates   (re-hit releases/latest on every github-sourced extension)
```

Per-extension icon, namespaced settings/secrets/storage, and a permission-gated host API (`invoke`, `secrets`, `events`, `app context`, `ui.toast`). Authoring guide: [extensions/README.md](extensions/README.md) · Reference extension: [Discord Rich Presence](https://github.com/IlhamriSKY/TEDI.discord-rich-presence).

## CLI Usage

TEDI ships with a CLI that lets you open folders and files directly from the terminal.

```bash
tedi [PATH]          # Open a folder or file in TEDI
tedi .               # Open the current directory
tedi <file>          # Open a file in the editor (parent folder loads in explorer)
tedi ext <subcmd>    # Manage extensions headlessly (install / list / update / enable / ...)
tedi theme <subcmd>  # Manage themes from the terminal
tedi --help          # Print help message and exit
tedi --version       # Print version and exit
tedi --update        # Check for updates and open the update dialog
```

If TEDI is already running, the request is forwarded to the existing window - a second instance is not opened.

**Installing the `tedi` command (macOS / Linux AppImage):** the `tedi` command is not on `PATH` by default. Go to **Settings → General → "Install `tedi` command in PATH"** to create a shim at `~/.local/bin/tedi`. On Windows, the NSIS installer handles this automatically.

## Architecture

TEDI is a Tauri 2 app: a React 19 webview (`src/`) talks to a Rust backend (`src-tauri/`) through `invoke()` commands and streaming `Channel`s. Start with **[ARCHITECTURE.md](ARCHITECTURE.md)** for a one-page map with a diagram and end-to-end data-flow walkthroughs, then see [TEDI.md](TEDI.md) for the exhaustive per-module reference.

## Build from source

Prereqs:

- Rust stable: https://rustup.rs
- Node 20.19+ or 22.12+ and [pnpm](https://pnpm.io) (CI builds on Node 24; a `.nvmrc` pins it)
- Tauri platform prereqs: https://tauri.app/start/prerequisites/

```bash
pnpm install
pnpm tauri:dev     # dev (isolated data dir, won't touch your installed TEDI's data)
pnpm tauri build   # production bundle
```

Checks (see [CONTRIBUTING.md](CONTRIBUTING.md) for the full pre-PR list):

```bash
pnpm exec tsc --noEmit          # frontend type-check
pnpm lint:imports               # module import discipline
pnpm format:check               # Prettier
cd src-tauri && cargo clippy    # Rust lint
cd src-tauri && cargo fmt       # Rust format
```

## Notes per platform

- **Windows**: SmartScreen will warn on first launch (unsigned). Click _More info > Run anyway_. Shell priority: `pwsh.exe`, `powershell.exe`, `cmd.exe`.
- **Linux**: if you hit `EGL_BAD_PARAMETER` or a blank window, set `WEBKIT_DISABLE_DMABUF_RENDERER=1`. AppImage needs FUSE; otherwise run `--appimage-extract-and-run` or install the `.deb`/`.rpm`.
- **macOS**: minimum macOS 10.15. If the release workflow is running without Apple Developer signing/notarization secrets, builds fall back to ad-hoc signing and Gatekeeper may say _"TEDI can't be opened because Apple cannot check it for malicious software"_ or _"TEDI is damaged and can't be opened"_ on first launch. Drag the app to `/Applications`, then in Terminal run once:
  ```
  xattr -cr /Applications/TEDI.app
  ```
  Then open from Launchpad/Finder (right-click → _Open_ the first time if still prompted).

## Quality

- Apache-2.0, **no telemetry**, API keys in the OS keychain (`keyring`)
- Small bundle (~7-10 MB depending on platform), single webview, native PTY

## Credits

TEDI is a fork of and is derived from **[crynta/terax-ai@v0.5.9](https://github.com/crynta/terax-ai/releases/tag/v0.5.9)** by [Crynta](https://github.com/crynta). The original Tauri + Rust backend, the xterm.js terminal stack, the CodeMirror editor stack, and the AI agent pipeline are the work of Crynta and the Terax contributors. TEDI keeps the same Apache-2.0 license and tracks its own roadmap onward. If you find TEDI useful, please go give the upstream [Terax](https://github.com/crynta/terax-ai) project a star.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for required attribution.
