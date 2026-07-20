# Contributing

Thanks for wanting to help. Issues, PRs, and ideas are all welcome.

New here? Skim [ARCHITECTURE.md](ARCHITECTURE.md) for the lay of the land, then browse the [good first issues](https://github.com/IlhamriSKY/TEDI/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) for a curated on-ramp.

## Quick start

```bash
pnpm install
pnpm tauri:dev
```

`pnpm tauri:dev` uses an isolated dev data dir (its own bundle id), so you never touch your production TEDI's settings, workspaces, or extensions. Use plain `pnpm tauri dev` only when you intentionally want to share prod data.

Prereqs: Rust (stable), Node 20.19+ or 22.12+ (CI builds on Node 24; a `.nvmrc` pins it - run `nvm use`), pnpm, plus your platform's [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Before opening a PR

Run these and make sure they pass:

```bash
pnpm exec tsc --noEmit          # frontend types
pnpm lint:imports               # module import discipline (no cross-module relative imports)
pnpm format:check               # frontend format (Prettier)
cd src-tauri && cargo clippy    # Rust lint
cd src-tauri && cargo fmt       # Rust format
cd src-tauri && cargo test      # Rust unit tests (CI runs these too)
```

To auto-fix formatting:

```bash
pnpm format                     # Prettier write
pnpm fmt:rust                   # cargo fmt --all
```

Build a release bundle at least once if you touched anything in `src-tauri/`:

```bash
pnpm tauri build
```

## Branches

Branch off `main`. Use these prefixes (kebab-case):

| Prefix   | Use for                                 |
| -------- | --------------------------------------- |
| `feat/`  | New feature                             |
| `fix/`   | Bug fix                                 |
| `chore/` | Refactor, tooling, config, dependencies |
| `docs/`  | Docs-only changes                       |
| `perf/`  | Performance work                        |

Examples: `feat/split-panes`, `fix/explorer-focus`, `chore/windows-bundle-config`.

Don't open PRs from your fork's `main` branch - it makes future syncs painful for you. Always work on a feature branch.

## Issues first for non-trivial work

For anything beyond a typo, a small bug fix, or a clear `good-first-issue` - **open an issue first** and wait for a maintainer to ack the approach. A 10-minute conversation saves a 500-line PR that doesn't fit the roadmap.

If an issue already exists for what you want to do, comment "I'll take this" before starting so we don't duplicate work.

## What we want

- **Bug fixes** - always.
- **Features** - open an issue first if it's non-trivial. We'd rather discuss the approach than reject a finished PR.
- **Docs / typos / small UX fixes** - just send the PR.
- **New AI providers** - add an entry to the `PROVIDERS` and `MODELS` arrays in `src/modules/ai/config.ts` (and the `ProviderId` union). Keep BYOK; no hardcoded keys.
- **Themes / icon packs** - yes, but keep the bundle size in check.

## What we don't want

- Telemetry, analytics, or anything that phones home.
- Hardcoded API keys or accounts. TEDI stays BYOK.
- Large dependencies for small wins. Binary size is not a hard limit, but resident memory is: prefer what does not add a background thread, a poll loop, or an unbounded buffer.
- Sweeping refactors with no functional change.

## Code style

- Follow the existing patterns. Read adjacent files before adding new ones.
- TypeScript: no `any` unless you really mean it.
- Rust: `cargo fmt` + `clippy` clean.
- Few comments. Code should explain itself; comments are for the _why_, not the _what_.
- No emoji in code or commit messages.

### Formatting standard

Formatting is enforced by tooling - don't hand-format. The repo ships with:

| File                     | Scope                              |
| ------------------------ | ---------------------------------- |
| `.editorconfig`          | Indent, EOL, charset (all editors) |
| `.prettierrc.json`       | TS/TSX/JS/CSS/JSON/MD via Prettier |
| `.prettierignore`        | Files Prettier should skip         |
| `src-tauri/rustfmt.toml` | Rust formatting via `cargo fmt`    |

**TypeScript / React / CSS / JSON / Markdown (Prettier)**

- 2-space indent, LF line endings, UTF-8
- Semicolons: **yes**
- Quotes: **double** (`"foo"`) - JSX attributes too
- Trailing comma: `all`
- Print width: 100 (Markdown: 80, preserve prose)
- Arrow parens: `always` (`(x) => x`)
- Tailwind class ordering: handled by `prettier-plugin-tailwindcss`

**Rust (rustfmt)**

- 4-space indent, max width 100, LF line endings
- `edition = "2021"`, imports + modules reordered
- Field/try shorthand enabled

**General rules**

- Don't disable Prettier or rustfmt on chunks of code without a written justification in the PR description.
- Don't mix unrelated reformatting into a feature PR - see "What gets bounced back" below.
- File names: `camelCase.ts` for TS utilities/hooks (the dominant convention; a few older `kebab-case.ts` utils remain), `PascalCase.tsx` for React components, `snake_case.rs` for Rust modules - match the convention already used in the surrounding folder.
- One blank line between top-level declarations; no consecutive blank lines.
- Group imports: stdlib / external / `@/*` aliases / relative - separated by a blank line (Prettier preserves this; you place the breaks).

## Commits & PRs

We squash-merge every PR - the **PR title becomes the squash commit**, so it should follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(terminal): add split panes
fix(explorer): prevent input from disappearing on create
chore(deps): bump tauri to 2.x
docs(readme): clarify Linux install on Arch
```

Types: `feat`, `fix`, `chore`, `docs`, `perf`, `refactor`, `test`, `build`, `ci`.
Common scopes: `terminal`, `editor`, `explorer`, `pty`, `ai`, `settings`, `tabs`, `shortcuts`, `agents`, `ui`.

Within a PR, individual commit messages can be whatever - they get squashed.

**One logical change per PR.** A PR that adds a feature, fixes an unrelated bug, and reformats `.gitignore` is three PRs. Split them.

**Open a draft PR early** if you want feedback mid-flight; mark "Ready for review" when done. Fill out the PR template - what changed, why, how you tested. Include screenshots / GIFs for any UI change.

### What gets merged faster

- Clear problem statement
- Small, focused diff
- Follows existing patterns (read 2-3 nearby files before writing yours)
- `pnpm exec tsc --noEmit` clean
- Manual testing notes ("I tested by doing X, Y, Z")

### What gets bounced back

- Mixed-concern PRs ("split this please")
- Large architectural PRs without prior discussion
- New dependencies without justification
- Breaking changes without migration notes
- Incidental reformatting unrelated to the change (adds noise to review)
- AI-generated code that obviously wasn't read by the author

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture (the two-process model, a diagram, and end-to-end data-flow walkthroughs). The short version:

```
src-tauri/        Rust backend (every #[tauri::command] is registered in src/lib.rs)
  src/modules/    pty, pty_daemon, fs, shell, git, ssh, extensions (+ cli*.rs,
                  format.rs, preview.rs, secrets.rs, net.rs)
  tedi-cli/       Windows console-subsystem `tedi` launcher
src/
  app/App.tsx     Top-level coordinator (cross-module wiring, not feature logic)
  settings/       Settings UI (a SEPARATE Tauri webview; distinct from src/modules/settings/)
  components/      shadcn/ui + Vercel AI Elements (generated; don't hand-edit)
  lib/            Shared helpers
  modules/        19 self-contained features:
                  terminal, editor, explorer, panes, tabs, workspaces, header,
                  statusbar, shortcuts, commandPalette, settings, theme, ai, scm,
                  ssh, browser, scheduler, updater, extensions
```

For the exhaustive per-file reference (every command, every gotcha) see [TEDI.md](TEDI.md).

## Security issues

Don't file them as issues - see [SECURITY.md](SECURITY.md).

## License

By contributing you agree your work is licensed under [Apache-2.0](LICENSE).
