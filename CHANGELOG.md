# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.1.1]

First update over the auto-update channel — used to verify signed-update flow works end to end on real installs.

### Changed
- Polish across AI surfaces, settings, explorer, and status bar based on follow-up edits after the 0.1.0 cut.

## [0.1.0] — Initial TEDI release

First release under the **TEDI** (Terminal Environment & Development Infrastructure) name. Versioning restarts from `0.1.0` because TEDI tracks its own roadmap independently of upstream Terax.

### Added
- Workspaces with persisted tab layouts and switcher in the sidebar
- Tab grouping and drag-to-reorder
- Terminal and editor split panes (mix and match per tab)
- Spawn a new terminal tab from inside an existing shell instead of an external window (OSC 8889, `tedi_open`)
- Inline image preview
- Side-by-side Markdown preview
- "Open folder" workspace picker in the header
- Code-editor visual refresh

### Changed
- AI tool-routing, sub-agents, snippets, and plan-mode flow polished
- Project memory file renamed to `TEDI.md`

### Auto-update
- Signed auto-updater re-enabled via `tauri-plugin-updater`. App checks GitHub Releases every 6 hours and offers in-app install + relaunch. First install is still manual.
