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

**TEDI** (**T**erminal **E**nvironment & **D**evelopment **I**nfrastructure) folds eight tools you reach for every day (a terminal, SSH client, DB browser, editor, AI agent, browser, and Git) into one window, so you stop alt-tabbing. Built on Tauri 2 (Rust + a single webview), it ships in roughly **7-10 MB** with **no telemetry**; API keys stay in the OS keychain.

## The eight features

| #   | Feature                         | What it does                                                                                                                                                                                                                     |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Terminal multiplexer**        | Native PTY terminals (zsh / bash / fish / pwsh) on xterm.js + WebGL: split panes, tab groups, shell integration (OSC 7 / 133), inline search, and link detection. Inactive tabs keep streaming.                                  |
| 2   | **SSH connection**              | Connect to remote hosts (`russh`), open remote shells, and browse/transfer files over an integrated **SFTP** explorer, all from a saved connection manager.                                                                      |
| 3   | **SQL explorer** _(extension)_  | Browse and query databases from a dedicated panel. Ships as an extension (feature 8), so it installs and updates at runtime.                                                                                                     |
| 4   | **Code editor**                 | CodeMirror 6 for TS/JS, Rust, Python, PHP, HTML/CSS, JSON, Markdown, C/C++, Java, C#, SQL, and more, with inline AI autocomplete, diff view, Vim mode, and Markdown/image preview.                                               |
| 5   | **AI-native agent**             | Bring-your-own-key agent (OpenAI, Anthropic, Google, Groq, xAI, Cerebras, DeepSeek, any OpenAI-compatible endpoint, or **local** LM Studio). Sub-agents, voice input, project memory via `TEDI.md`, and tools gated by approval. |
| 6   | **AI browser control**          | A real in-app browser (native webview) the agent drives end to end: navigate, read, type, click, scroll, and screenshot the tab to _see_ it.                                                                                     |
| 7   | **Workspaces**                  | Each workspace keeps its own project session (tab layout + working dirs) and switches instantly. The header folder picker spawns a terminal rooted there.                                                                        |
| 8   | **Source control + extensions** | Inline Git diff / SCM pane, and a first-class **extension** system: install from a `.zip` or GitHub release to add settings, themes, slash commands, AI tools, commands, keybindings, and panels.                                |

Everything is **fully themeable** (presets, custom colors, transparency, extension themes) while staying lightweight.

## Install

Pre-built binaries: **[Releases](https://github.com/IlhamriSKY/TEDI/releases/latest)** (Windows, macOS, Linux `.deb` / `.rpm` / `.AppImage`). Download for your OS and install; TEDI auto-checks for updates.

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

**Settings → AI**, pick a provider, paste your API key (or point TEDI at a local LM Studio endpoint). Keys go to the OS keychain via `keyring`, never to disk or `localStorage`. Full list: `PROVIDERS` in [src/modules/ai/config.ts](src/modules/ai/config.ts).

## Extensions

TEDI ships **no extensions** in the binary; every one (including the SQL explorer) installs at runtime. Re-installing the same `manifest.id` replaces the old copy, so the same path handles updates.

```
Settings → Extensions → From file       (pick a local .zip)
Settings → Extensions → From GitHub     (paste owner/repo)
Settings → Extensions → Check updates   (re-check releases/latest)
```

Per-extension icon, namespaced settings/secrets/storage, and a permission-gated host API. Authoring guide: [extensions/README.md](extensions/README.md). Reference extension: [Discord Rich Presence](https://github.com/IlhamriSKY/TEDI.discord-rich-presence).

## CLI

```bash
tedi [PATH]          # open a folder or file in TEDI
tedi .               # open the current directory
tedi ext <subcmd>    # manage extensions headlessly (install / list / update / ...)
tedi theme <subcmd>  # manage themes from the terminal
tedi --help | --version | --update
```

If TEDI is already running, the request forwards to the existing window (no second instance). On macOS / Linux AppImage the `tedi` command is not on `PATH` by default: **Settings → General → "Install `tedi` command in PATH"** creates a shim at `~/.local/bin/tedi`. Windows' installer handles this.

## Architecture

A Tauri 2 app: a React 19 webview (`src/`) talks to a Rust backend (`src-tauri/`) via `invoke()` and streaming `Channel`s. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for a one-page map, then [TEDI.md](TEDI.md) for the per-module reference.

## Build from source

Prereqs: Rust stable ([rustup](https://rustup.rs)), Node 20.19+ / 22.12+ with [pnpm](https://pnpm.io), and [Tauri's platform prereqs](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri:dev     # dev (isolated data dir)
pnpm tauri build   # production bundle
```

Pre-PR checks (full list in [CONTRIBUTING.md](CONTRIBUTING.md)):

```bash
pnpm exec tsc --noEmit && pnpm lint:imports && pnpm format:check
cd src-tauri && cargo clippy && cargo fmt
```

## Notes per platform

- **Windows**: SmartScreen warns on first launch (unsigned); click _More info > Run anyway_. Shell priority: `pwsh.exe`, `powershell.exe`, `cmd.exe`.
- **Linux**: on `EGL_BAD_PARAMETER` or a blank window, set `WEBKIT_DISABLE_DMABUF_RENDERER=1`. AppImage needs FUSE (else `--appimage-extract-and-run`, or use the `.deb` / `.rpm`).
- **macOS**: minimum 10.15. Unsigned builds may trip Gatekeeper; drag to `/Applications`, run `xattr -cr /Applications/TEDI.app` once, then open from Finder.

## Credits

TEDI is a fork of **[crynta/terax-ai@v0.5.9](https://github.com/crynta/terax-ai/releases/tag/v0.5.9)** by [Crynta](https://github.com/crynta). The Tauri/Rust backend, the xterm.js terminal, the CodeMirror editor, and the AI agent pipeline are the work of Crynta and the Terax contributors. Same Apache-2.0 license; if TEDI is useful, please star upstream [Terax](https://github.com/crynta/terax-ai).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for required attribution.
