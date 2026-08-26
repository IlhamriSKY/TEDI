# Security

TEDI runs shells, reads and writes files, and talks to AI providers, so security bugs matter. If you find one, please tell us before posting it publicly.

## Reporting

Use **[GitHub Security Advisories](https://github.com/IlhamriSKY/TEDI/security/advisories/new)** to file a private report. Include:

- What the issue is and what it lets an attacker do
- Steps to reproduce (a small PoC is great)
- Version, OS, arch

You'll usually hear back within a few days. Once it's fixed, we'll credit you in the release notes, unless you'd rather stay anonymous.

Please **don't** open a public GitHub issue for security reports.

## Supported versions

Until `1.0.0`, only the latest minor gets security fixes.

## What's in scope

- The Rust backend in `src-tauri/` (PTY, FS, IPC, plugins)
- The frontend in `src/`, anywhere untrusted input lands (terminal output, file content, AI tool results, credentials)
- Release artifacts on GitHub

## What's not

- Bugs in upstream deps (Tauri, xterm.js, CodeMirror, AI SDKs). Report those upstream; we'll ship the fix once it's released.
- Anything that needs an already-compromised machine or a local attacker with shell access
- An extension doing what extensions can do. They aren't sandboxed (see below), so a malicious one you chose to install isn't a TEDI vulnerability, same as a VS Code or Neovim plugin. What _is_ in scope: an extension gaining something this file doesn't disclose, or the install dialog claiming a boundary it doesn't hold.

## What we do to keep things safe

- **Secrets** (API keys, SSH keys and passphrases) are stored per platform, and never in `localStorage` or logs:
  - **macOS**: the login Keychain, via `keyring`.
  - **Windows**: a DPAPI-encrypted file in the app's local data dir, bound to your Windows logon. Not the Credential Manager, whose 2560-byte blob cap is too small for an RSA private key.
  - **Linux**: a `0600` JSON file in the app's local data dir, **not encrypted**. An AppImage/deb/rpm install can't assume a Secret Service daemon is running, so this is the same file fallback Chromium uses. Note the consequence: anything that can read your home directory reads your secrets, so a backup, a filesystem snapshot, or an unencrypted disk carries them in the clear. Use full-disk encryption if that matters to you.
- **No telemetry.** No analytics, no crash reporting, no phone-home. TEDI does reach the network for: AI requests, the web preview, the update check below, and commit-author avatars in the git graph. Avatars are derived from the GitHub `users.noreply.github.com` address alone, so a real email address is never sent anywhere.
- **Signed updates, applied only when you click.** The app checks GitHub Releases every 6 hours and tells you when there's a new version. Downloading and installing is your click; nothing is fetched or applied in the background. Update artifacts are minisign-signed and the updater verifies that signature before it installs anything. Be clear on what that does _not_ cover: the installers are **not** code-signed (no Authenticode on Windows, ad-hoc signed and un-notarized on macOS), so a manual download from Releases raises an OS warning and carries no signature you can check yourself. Verification here is the updater's job, not the operating system's.
- **AI tool approval.** File writes and shell commands from the agent need your OK before they run.
- **No Node in the renderer.** The frontend reaches the host only over Tauri IPC.
- **The MCP automation channel is off until you turn it on, and it says when it's on.** The Install MCP button (the plug in the header) lets any AI CLI on your machine drive TEDI: read every pane, terminal and editor, run shell commands in your shell, change settings, enable or disable extensions. Turning it on opens a **WebView2 DevTools port on loopback, and DevTools has no authentication of any kind** — so while it's on, anything already running as your user can drive the window and read what's in it, not only the CLI you meant to connect. That's the same boundary as your own shell, which is why it's opt-in, why it needs a restart to take effect (WebView2 fixes its browser arguments before the first webview exists), and why the header shows a dot for as long as the channel is live. Three lines are drawn inside it: panes you marked **private** are absent from the surface entirely, not merely unreadable; **API keys never pass through it** (they're in the keyring above, never in the settings store); and **installing an extension is refused** — the driver can enable, disable, reload, update or uninstall what you already approved, but new third-party code still goes through the permission review you see. Turn the channel back off in the same dialog. Note that `eval_js` reaches everything the page reaches, so this is a boundary about _whether_ the channel is open, not a permission model inside it.
- **Extensions are not sandboxed.** Read this one twice. Extension JavaScript runs in the main webview with the app's full privileges. The permissions shown at install are what the extension _declares_ and what you approve; they gate the `ctx.*` host API, and they do not stop extension code that calls Tauri IPC directly. Making them a real boundary needs the extension code isolated into a worker or a cross-origin frame, which is a rewrite of the extension API rather than a patch, so until then install extensions only from sources you trust. The install dialog says the same thing before you click, and `TEDI.md` documents it under Extensions.

## What we can't promise

- TEDI runs whatever you (or the agent) tell it to run, with your permissions. That's kind of the point of a terminal.
- AI providers see whatever you send them. Read their retention policies.
- Local LLM endpoints (LM Studio, OpenAI-compatible) are trusted at the network level. Only point TEDI at servers you control.
