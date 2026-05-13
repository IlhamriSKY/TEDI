# Changelog

All notable changes to **TEDI**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) (pre-`1.0`, minor bumps may include breaking changes).

> TEDI is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai), starting from upstream **Terax v0.5.9**. Earlier history belongs to the upstream project: see [Terax CHANGELOG](https://github.com/crynta/terax-ai/blob/main/CHANGELOG.md).

## [0.1.4] - 2026-05-13

### Fixed
- **Ask TEDI** popup now anchors to the actual selection rectangle (top-center) instead of where the mouseup landed, so it consistently appears just above the highlighted text. Falls back to the mouse coordinate when the DOM/xterm selection rect can't be measured.
- The popup only triggers when the mouseup lands inside a terminal/editor pane (`[data-pane-leaf]`), preventing it from popping in the status bar, tab strip, or sidebar after a stale xterm selection.

### Changed
- **Ask TEDI** button restyled: pill (`rounded-full`), AI-magic icon prefix, semibold label tracking, smaller shadow and faster transition. Width 156 to 168, height locked at 34, gap above selection 10px.
- Per-platform bundle scope: Windows now only emits NSIS (`.exe`) - MSI dropped - using LZMA compression to slim the installer. Linux builds remain `deb`/`rpm`/`appimage`. `bundle.targets` in the shared `tauri.conf.json` removed in favor of per-platform overrides in `tauri.linux.conf.json` / `tauri.windows.conf.json`.
- Release profile: `strip = "symbols"` (was `true`) - explicit about what's stripped.
- SSH event pump: pattern-match `ChannelMsg::ExtendedData { ext: 1, .. }` directly instead of an `if ext == 1` guard (clippy-clean).
- `public/icon.png`: re-exported smaller (852 KB to 22 KB) for faster initial paint of the About panel.

## [0.1.3] - 2026-05-13

### Fixed
- Workspaces: switching to another workspace no longer kills running PTYs. The previous workspace's terminal leaves are now cached in-memory; the dispose effect treats cached leaves as still-live, so the same xterm sessions are re-attached when you switch back. Closing a workspace still tears its sessions down.

### Changed
- Status-bar **Update** pill: solid primary fill (was outline) for higher contrast against the status bar.
- **Ask TEDI** floating button (text selection): solid primary fill, rounded corners, shadow + ring, dedicated `Kbd` chip for the shortcut. Width bumped 110→156px so the shortcut isn't truncated.

## [0.1.2] - 2026-05-13

### Changed
- Status-bar update pill: removed `max-w-32` clamp so the "Update available" label is not truncated on wide status bars.
- OSC 8889 (`tedi_open`) spawn-tab parser now accepts a `split=row|col` field so shells can request a split-pane spawn instead of a new tab.

## [0.1.1] - 2026-05-13

First update delivered over the signed auto-update channel - used to verify the end-to-end signed-update flow on real installs.

### Changed
- Polish across AI surfaces (chat, mini window, status-bar controls, agents, transport, todos), settings (general, models, store), explorer (file tree, search, constants), tabs, editor language resolver, status bar, App.tsx, contributing notes, `.gitignore`, and `globals.css`.

## [0.1.0] - 2026-05-13

Initial release under the **TEDI** (Terminal Environment & Development Infrastructure) name. Versioning restarts from `0.1.0` because TEDI tracks its own roadmap independently of upstream Terax.

### Added
- Workspaces with persisted tab layouts and switcher in the sidebar.
- Tab grouping and drag-to-reorder.
- Terminal and editor split panes (mix and match per tab).
- Spawn a new terminal tab from inside an existing shell instead of an external window (OSC 8889, `tedi_open`).
- Inline image preview.
- Side-by-side Markdown preview.
- "Open folder" workspace picker in the header.
- Code-editor visual refresh.
- Signed auto-updater (`tauri-plugin-updater`): checks GitHub Releases every 6 hours, offers in-app install + relaunch. First install is still manual.
- Settings → About: "Check for updates" button for manual polling.

### Changed
- AI tool-routing, sub-agents, snippets, and plan-mode flow polished.
- Project memory file renamed to `TEDI.md`.
- Identity rebranded from CMDAN to TEDI (bundle id `id.ilhamrisky.tedi`, crate `tedi`, keychain service `tedi`, store files `tedi-*.json`).
