<div align="center">
  <img src="public/icon.png" width="120" height="120" alt="TEDI" />
  <p><strong>TEDI - Terminal Environment & Development Infrastructure. Fork of <a href="https://github.com/crynta/terax-ai">Terax</a>.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" />
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
    <img src="https://img.shields.io/badge/fork-crynta%2Fterax--ai-blue" alt="fork" />
  </p>
</div>

---

> [!IMPORTANT]
> **Built on top of [Terax v0.5.9](https://github.com/crynta/terax-ai/releases/tag/v0.5.9) by [Crynta](https://github.com/crynta).**
> Full credit to the upstream authors for the Rust PTY backend, the React + xterm.js client, and the AI agent core. TEDI keeps the same Apache-2.0 license and tracks its own roadmap onward. Please star the upstream repo if you find TEDI useful.

## What is TEDI?

**TEDI** (**T**erminal **E**nvironment & **D**evelopment **I**nfrastructure) is a lightweight, low-footprint terminal that boosts developer productivity. Split-screen terminals, tab grouping, and workspaces - designed for developer workflows.

## Install

Pre-built binaries: **[Releases](https://github.com/IlhamriSKY/TEDI/releases/latest)**.

Windows, macOS, and Linux (`.deb`, `.rpm`, `.AppImage`). Download the artifact for your OS and install. Re-download from Releases when a new version drops or check at settings.

## Screenshots

<p align="center">
  <img src="docs/tedi1.png" width="49%" alt="TEDI screenshot 1" />
  <img src="docs/tedi2.png" width="49%" alt="TEDI screenshot 2" />
</p>
<p align="center">
  <img src="docs/tedi3.png" width="49%" alt="TEDI screenshot 3" />
  <img src="docs/tedi4.png" width="49%" alt="TEDI screenshot 4" />
</p>

## Features

**Terminal**

- xterm.js + WebGL, multi-tab, background-streaming inactive tabs
- Native PTY via `portable-pty` (zsh, bash, fish, pwsh)
- Shell integration: cwd + prompt markers via OSC 7 / 133
- Split panes: horizontal and vertical, mix terminals and editors freely
- Inline search, link detection

**Editor**

- CodeMirror 6 with TS/JS, Rust, Python, PHP, HTML/CSS, JSON, Markdown, C/C++, Java, C# and More
- Inline AI autocomplete and diff-based
- Vim mode and themes (Tokyo Night, Nord, GitHub, Atom One, Aura, Copilot, Xcode)
- Inline image preview tab
- Side-by-side Markdown preview

**Workspaces & Tabs**

- Workspaces keep distinct project sessions (tab layout + cwd) and switch without re-opening folders
- Open-folder picker in the header auto-spawns a terminal at the picked root
- Sortable, drag-to-reorder, pinnable tabs across terminal / editor / preview / AI-diff kinds

**AI (BYOK)**

- OpenAI, Anthropic, Google, Groq, xAI, Cerebras, DeepSeek, SumoPod, plus any OpenAI-compatible endpoint and LM Studio (local/offline). Full list: `PROVIDERS` in [src/modules/ai/config.ts](src/modules/ai/config.ts)
- Voice input, multi-agent / sub-agents, snippets, custom system prompt
- Tools: read / write / grep / glob / shell with explicit approval
- Project memory via `TEDI.md` at workspace root
- Tool-routing and approval-flow polish

**File Explorer**

- Catppuccin / Material icon theme, fuzzy search, inline rename
- "Reveal in terminal" opens a new tab rooted at the picked folder

**Extensions**

- Install third-party extensions from a local `.zip` or directly from a GitHub release (`owner/repo`)
- Manifest-declared **settings**, **themes**, **slash commands**, **AI tools**, **commands**, **keybindings**, **panels** auto-render under each card in Settings → Extensions
- Per-extension icon, namespaced settings/secrets/storage, permission-gated host API (`invoke`, `secrets`, `events`, `app context`, `ui.toast`)
- One-click **Check updates** + **Update** powered by the GitHub `releases/latest` endpoint
- Two-window sync, idempotent disable/uninstall, atomic state writes, path-traversal + size guards on every install path
- Authoring guide: [extensions/README.md](extensions/README.md) · Reference extension: [Discord Rich Presence](https://github.com/IlhamriSKY/TEDI.discord-rich-presence)

**Quality**

- Apache-2.0, no telemetry, API keys in OS keychain (`keyring`)
- Small bundle (~7-10 MB depending on platform)

## Configure AI

Settings > AI > pick a provider, paste your API key. For local inference, point TEDI at your LM Studio endpoint. Keys are written to the OS keychain via `keyring`. They never touch disk or `localStorage`.

## Extensions

TEDI ships **no extensions** in the binary - every extension is installed at runtime from either a local `.zip` or a GitHub release. Re-installing the same `manifest.id` replaces the previous copy, so the same install paths handle updates too.

```
Settings → Extensions → From file       (pick a local .zip)
Settings → Extensions → From GitHub     (paste owner/repo)
Settings → Extensions → Check updates   (re-hit releases/latest on every github-sourced extension)
```

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

**Installing the `tedi` command (macOS / Linux AppImage):**

On macOS and Linux AppImage, the `tedi` command is not on `PATH` by default. Go to **Settings → General → "Install `tedi` command in PATH"** to create a shim at `~/.local/bin/tedi`. On Windows, the NSIS installer handles this automatically.

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
- **macOS**: minimum macOS 10.15. Builds are ad-hoc signed but **not notarized** with Apple, so Gatekeeper may say _"TEDI is damaged and can't be opened"_ on first launch. Drag the app to `/Applications`, then in Terminal run once:
  ```
  xattr -cr /Applications/TEDI.app
  ```
  Then open from Launchpad/Finder (right-click → _Open_ the first time if still prompted).

## Credits

TEDI is derived from [crynta/terax-ai@v0.5.9](https://github.com/crynta/terax-ai/releases/tag/v0.5.9). The original Tauri + Rust backend, the xterm.js terminal stack, the CodeMirror editor stack, and the AI agent pipeline are the work of [Crynta](https://github.com/crynta) and the Terax contributors. Please go give the upstream project a star if you use TEDI.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for required attribution.
