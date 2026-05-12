# Security

CMDAN runs shells, reads/writes files, and talks to AI providers — so security bugs matter. If you find one, please tell us before posting it publicly.

## Reporting

Use **[GitHub Security Advisories](https://github.com/IlhamriSKY/CMDAN/security/advisories/new)** to file a private report. Include:

- What the issue is and what it lets an attacker do
- Steps to reproduce (a small PoC is great)
- Version, OS, arch

You'll usually hear back within a few days. Once it's fixed, we'll credit you in the release notes — unless you'd rather stay anonymous.

Please **don't** open a public GitHub issue for security reports.

## Supported versions

Until `1.0.0`, only the latest minor gets security fixes.

## What's in scope

- The Rust backend in `src-tauri/` (PTY, FS, IPC, plugins)
- The frontend in `src/` — anywhere untrusted input lands (terminal output, file content, AI tool results, credentials)
- Release artifacts on GitHub

## What's not

- Bugs in upstream deps (Tauri, xterm.js, CodeMirror, AI SDKs…) — report those upstream. We'll ship the fix once it's released.
- Bugs that originate in the upstream [crynta/terax-ai](https://github.com/crynta/terax-ai) without CMDAN-specific code paths — please also surface them upstream.
- Anything that needs an already-compromised machine or a local attacker with shell access

## What we do to keep things safe

- **API keys** live in the OS keychain via `keyring` — not on disk, not in `localStorage`, not in logs.
- **No telemetry.** CMDAN only talks to the network when you ask it to (AI requests, web preview).
- **No auto-update.** Updates are downloaded manually from GitHub Releases — no silent network calls and no auto-applied binaries.
- **AI tool approval.** File writes and shell commands from the agent need your OK before they run.
- **No Node in the renderer.** The frontend only reaches the host through the allow-listed Tauri commands.

## What we can't promise

- CMDAN runs whatever you (or the agent) tell it to run, with your permissions. That's kind of the point of a terminal.
- AI providers see whatever you send them. Read their retention policies.
- Local LLM endpoints (LM Studio, OpenAI-compatible) are trusted at the network level — only point CMDAN at servers you control.
