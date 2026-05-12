# Changelog

All notable changes to **CMDAN**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> CMDAN is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.0.2] — Initial CMDAN release

First release under the CMDAN name. Versioning restarts from `0.0.2` because CMDAN tracks its own roadmap independently of upstream Terax.

### Added
- Workspaces with persisted tab layouts and switcher in the sidebar
- Tab grouping and drag-to-reorder
- Terminal and editor split panes (mix and match per tab)
- Spawn a new terminal tab from inside an existing shell instead of an external window (OSC 8889, `cmdan_open`)
- Inline image preview
- Side-by-side Markdown preview
- "Open folder" workspace picker in the header
- Code-editor visual refresh

### Changed
- AI tool-routing, sub-agents, snippets, and plan-mode flow polished
- Project memory file renamed to `CMDAN.md`

### Removed
- Auto-updater. New releases must be downloaded manually from [GitHub Releases](https://github.com/IlhamriSKY/CMDAN/releases).
