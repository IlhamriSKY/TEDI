//! Key dispatch for the `tedi ext` TUI. Pure-ish: every handler updates
//! [`App`] in place and may call into [`Bridge`] to spawn an async task.
//! Rendering reads the updated `App` on the next frame.
//!
//! Global keys (always active outside text input):
//!   q / Ctrl+C  quit
//!   ?           toggle help modal
//!   Tab / S-Tab cycle tabs
//!   h / l       prev / next tab (vim-style; only when no filter focus)
//!   r           refresh current tab
//!   /           focus filter
//!   Esc         close modal / unfocus filter
//!
//! Tab-specific:
//!   Installed:  Enter detail / e enable / d disable / x uninstall
//!   Registry:   Enter or i install
//!   Updates:    Enter or u update one / U update all

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::modules::cli_ext::InitialFocus;
use crate::modules::extensions::install::InstallPhase;

use super::actions::{AppMsg, Bridge};
use super::app::{App, InstalledSummary, Loadable, Modal, ProgressView, Tab};

/// Apply a message coming back from a background task.
pub fn apply_msg(app: &mut App, msg: AppMsg) {
    match msg {
        AppMsg::InstalledLoaded(r) => {
            app.installed = match r {
                Ok(v) => Loadable::Loaded(v),
                Err(e) => Loadable::Error(e),
            };
            clamp_cursor(app);
            // If we landed in the TUI from `tedi ext uninstall/enable/disable
            // <id>` and the install list is now ready, surface the modal.
            promote_initial_focus(app);
        }
        AppMsg::RegistryLoaded(r) => {
            app.registry = match r {
                Ok(v) => Loadable::Loaded(v),
                Err(e) => Loadable::Error(e),
            };
            clamp_cursor(app);
        }
        AppMsg::UpdatesChecked(r) => {
            app.updates = match r {
                Ok(v) => Loadable::Loaded(v),
                Err(e) => Loadable::Error(e),
            };
            clamp_cursor(app);
        }
        AppMsg::InstallPhaseUpdate(phase) => apply_install_phase(app, phase),
        AppMsg::InstallFileUpdate { index, total, path } => {
            apply_install_file(app, index, total, path)
        }
        AppMsg::InstallDone(result) => apply_install_done(app, *result),
        AppMsg::UpdateOneDone(result) => apply_update_one_done(app, result),
        AppMsg::UninstallDone(result) => apply_uninstall_done(app, result),
        AppMsg::SetEnabledDone(result) => apply_set_enabled_done(app, result),
    }
}

fn apply_install_phase(app: &mut App, phase: InstallPhase) {
    if let Some(m) = &mut app.modal {
        match m {
            Modal::InstallConfirm { progress, .. } | Modal::UpdateConfirm { progress, .. } => {
                let p = progress.get_or_insert_with(ProgressView::new);
                p.apply_phase(phase);
            }
            Modal::UpdateAll { progress, .. } => {
                let p = progress.get_or_insert_with(ProgressView::new);
                p.apply_phase(phase);
            }
            _ => {}
        }
    }
}

fn apply_install_file(app: &mut App, index: usize, total: usize, path: String) {
    if let Some(m) = &mut app.modal {
        match m {
            Modal::InstallConfirm { progress, .. } | Modal::UpdateConfirm { progress, .. } => {
                let p = progress.get_or_insert_with(ProgressView::new);
                p.apply_file(index, total, path);
            }
            Modal::UpdateAll { progress, .. } => {
                let p = progress.get_or_insert_with(ProgressView::new);
                p.apply_file(index, total, path);
            }
            _ => {}
        }
    }
}

fn apply_install_done(
    app: &mut App,
    result: Result<crate::modules::extensions::install::InstallOutcome, String>,
) {
    if let Some(Modal::InstallConfirm { finished, .. }) = &mut app.modal {
        *finished = Some(
            result
                .as_ref()
                .map(InstalledSummary::from)
                .map_err(|e| e.clone()),
        );
    }
    // The just-installed extension may already exist in `installed`; reload
    // unconditionally so the user sees the new version immediately.
    app.installed = Loadable::Loading;
    app.toast(match &result {
        Ok(o) => format!("Installed {} v{}", o.manifest.id, o.manifest.version),
        Err(e) => format!("Install failed: {e}"),
    });
}

fn apply_update_one_done(app: &mut App, result: Result<InstalledSummary, String>) {
    // Standalone update modal: stash the result, leave the modal open
    // so the user reads the outcome before pressing Esc.
    if let Some(Modal::UpdateConfirm { finished, .. }) = &mut app.modal {
        *finished = Some(result.clone());
        app.installed = Loadable::Loading;
        return;
    }
    // Batch update modal: record + advance.
    if let Some(Modal::UpdateAll {
        finished,
        queue,
        progress,
        running,
        ..
    }) = &mut app.modal
    {
        match result.clone() {
            Ok(s) => finished.push((s.id.clone(), Ok(()))),
            Err(e) => finished.push(("(unknown)".to_string(), Err(e))),
        };
        // Move on to the next queued row. The actual spawn happens in
        // `apply_update_all_step`, called by the main loop after this msg
        // settles — we just unblock it here.
        *running = false;
        *progress = None;
        if queue.is_empty() {
            app.installed = Loadable::Loading;
        }
    }
}

fn apply_uninstall_done(app: &mut App, result: Result<super::actions::UninstallOk, String>) {
    if let Some(Modal::UninstallConfirm {
        in_flight,
        finished,
        ..
    }) = &mut app.modal
    {
        *in_flight = false;
        *finished = Some(result.as_ref().map(|_| ()).map_err(|e| e.clone()));
    }
    app.toast(match &result {
        Ok(ok) => format!("Uninstalled {}", ok.id),
        Err(e) => format!("Uninstall failed: {e}"),
    });
    app.installed = Loadable::Loading;
}

fn apply_set_enabled_done(app: &mut App, result: Result<super::actions::SetEnabledOk, String>) {
    if let Some(Modal::SetEnabledConfirm {
        in_flight,
        finished,
        ..
    }) = &mut app.modal
    {
        *in_flight = false;
        *finished = Some(result.as_ref().map(|_| ()).map_err(|e| e.clone()));
    }
    app.toast(match &result {
        Ok(ok) => format!("{} {}", if ok.on { "Enabled" } else { "Disabled" }, ok.id),
        Err(e) => format!("Toggle failed: {e}"),
    });
    app.installed = Loadable::Loading;
}

/// Promote the deferred subcommand modal once the installed list lands.
/// Called whenever installed reload finishes — first time it sees a
/// matching pending focus, it surfaces the modal.
fn promote_initial_focus(app: &mut App) {
    if app.modal.is_some() {
        return;
    }
    match app.initial.clone() {
        InitialFocus::UninstallConfirm { id } => {
            let name = lookup_installed_name(app, &id).unwrap_or_else(|| id.clone());
            app.modal = Some(Modal::UninstallConfirm {
                id,
                name,
                in_flight: false,
                finished: None,
            });
            app.initial = InitialFocus::Installed;
        }
        InitialFocus::SetEnabled { id, on } => {
            app.modal = Some(Modal::SetEnabledConfirm {
                id,
                on,
                in_flight: false,
                finished: None,
            });
            app.initial = InitialFocus::Installed;
        }
        _ => {}
    }
}

fn lookup_installed_name(app: &App, id: &str) -> Option<String> {
    let Loadable::Loaded(rows) = &app.installed else {
        return None;
    };
    rows.iter().find(|r| r.id == id).map(|r| r.name.clone())
}

fn clamp_cursor(app: &mut App) {
    let len = app.current_len();
    if len == 0 {
        app.set_cursor(0);
        return;
    }
    let cur = app.cursor();
    if cur >= len {
        app.set_cursor(len - 1);
    }
}

/// Main key handler. Modals capture input first.
pub fn handle_key(app: &mut App, bridge: &Bridge, ev: KeyEvent) {
    if ev.kind == KeyEventKind::Release {
        return;
    }
    // Ctrl+C always quits, even inside a modal — except when an install
    // is mid-flight (let the user choose to wait or hard-kill).
    if ev.modifiers.contains(KeyModifiers::CONTROL) && matches!(ev.code, KeyCode::Char('c')) {
        if !is_critical_in_flight(app) {
            app.should_quit = true;
        }
        return;
    }

    if app.modal.is_some() {
        handle_modal_key(app, bridge, ev);
        return;
    }

    if app.filtering {
        handle_filter_key(app, ev);
        return;
    }

    handle_root_key(app, bridge, ev);
}

fn is_critical_in_flight(app: &App) -> bool {
    matches!(
        &app.modal,
        Some(Modal::InstallConfirm {
            progress: Some(_),
            finished: None,
            ..
        }) | Some(Modal::UpdateConfirm {
            progress: Some(_),
            finished: None,
            ..
        }) | Some(Modal::UpdateAll { running: true, .. })
    )
}

fn handle_root_key(app: &mut App, bridge: &Bridge, ev: KeyEvent) {
    match ev.code {
        KeyCode::Char('q') => app.should_quit = true,
        KeyCode::Char('?') => app.open_help(),
        KeyCode::Tab => switch_tab(app, bridge, app.focus.next()),
        KeyCode::BackTab => switch_tab(app, bridge, app.focus.prev()),
        KeyCode::Char('h') | KeyCode::Left => switch_tab(app, bridge, app.focus.prev()),
        KeyCode::Char('l') | KeyCode::Right => switch_tab(app, bridge, app.focus.next()),
        KeyCode::Char('1') => switch_tab(app, bridge, Tab::Installed),
        KeyCode::Char('2') => switch_tab(app, bridge, Tab::Registry),
        KeyCode::Char('3') => switch_tab(app, bridge, Tab::Updates),
        KeyCode::Char('r') => refresh(app, bridge),
        KeyCode::Char('/') => {
            app.filtering = true;
        }
        KeyCode::Esc => {
            app.filter.clear();
        }
        KeyCode::Up | KeyCode::Char('k') => app.move_cursor(-1),
        KeyCode::Down | KeyCode::Char('j') => app.move_cursor(1),
        KeyCode::Char('g') => app.jump_top(),
        KeyCode::Char('G') => app.jump_bottom(),
        KeyCode::PageUp => app.move_cursor(-10),
        KeyCode::PageDown => app.move_cursor(10),
        KeyCode::Enter => dispatch_default_action(app, bridge),
        // Tab-specific keys after navigation, so 'i' / 'u' / 'e' / 'd' / 'x'
        // don't collide with vim motions.
        KeyCode::Char(c) => match (app.focus, c) {
            (Tab::Installed, 'e') => trigger_set_enabled(app, true),
            (Tab::Installed, 'd') => trigger_set_enabled(app, false),
            (Tab::Installed, 'x') => trigger_uninstall(app),
            (Tab::Registry, 'i') => trigger_install_from_registry(app),
            (Tab::Updates, 'u') => trigger_update_one(app),
            (Tab::Updates, 'U') => trigger_update_all(app, bridge),
            _ => {}
        },
        _ => {}
    }
}

fn handle_filter_key(app: &mut App, ev: KeyEvent) {
    match ev.code {
        KeyCode::Enter | KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab => {
            app.filtering = false;
            // Reset cursor to top so the user sees the first match.
            app.set_cursor(0);
        }
        _ => {
            if app.filter.handle_key(ev) {
                // Cursor may now point past the filtered list — clamp.
                clamp_cursor(app);
            }
        }
    }
}

fn handle_modal_key(app: &mut App, bridge: &Bridge, ev: KeyEvent) {
    let Some(modal) = &mut app.modal else {
        return;
    };
    match modal {
        Modal::Help | Modal::Detail(_) | Modal::Toast(_) | Modal::Error(_) => match ev.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') | KeyCode::Char('?') => {
                app.close_modal();
            }
            _ => {}
        },
        Modal::InstallConfirm {
            input,
            progress,
            finished,
        } => {
            if finished.is_some() {
                if matches!(ev.code, KeyCode::Esc | KeyCode::Enter) {
                    app.close_modal();
                }
                return;
            }
            if progress.is_some() {
                // Install in flight — only allow Esc to back out (best-effort;
                // the install thread keeps running until it finishes/aborts).
                if matches!(ev.code, KeyCode::Esc) {
                    app.close_modal();
                    app.toast("Install canceled (background task may still finish)");
                }
                return;
            }
            match ev.code {
                KeyCode::Esc => app.close_modal(),
                KeyCode::Enter => {
                    let reference = input.value().trim().to_string();
                    if reference.is_empty() {
                        app.toast("enter a path / owner-repo / registry id first");
                        return;
                    }
                    *progress = Some(ProgressView::new());
                    bridge.install(reference);
                }
                _ => {
                    let _ = input.handle_key(ev);
                }
            }
        }
        Modal::UninstallConfirm {
            id,
            in_flight,
            finished,
            ..
        } => {
            if finished.is_some() {
                if matches!(ev.code, KeyCode::Esc | KeyCode::Enter) {
                    app.close_modal();
                }
                return;
            }
            if *in_flight {
                return;
            }
            match ev.code {
                KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                    *in_flight = true;
                    bridge.uninstall(id.clone());
                }
                KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => app.close_modal(),
                _ => {}
            }
        }
        Modal::SetEnabledConfirm {
            id,
            on,
            in_flight,
            finished,
        } => {
            if finished.is_some() {
                if matches!(ev.code, KeyCode::Esc | KeyCode::Enter) {
                    app.close_modal();
                }
                return;
            }
            if *in_flight {
                return;
            }
            match ev.code {
                KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                    *in_flight = true;
                    bridge.set_enabled(id.clone(), *on);
                }
                KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => app.close_modal(),
                _ => {}
            }
        }
        Modal::UpdateConfirm {
            id,
            progress,
            finished,
            ..
        } => {
            if finished.is_some() {
                if matches!(ev.code, KeyCode::Esc | KeyCode::Enter) {
                    app.close_modal();
                }
                return;
            }
            if progress.is_some() {
                if matches!(ev.code, KeyCode::Esc) {
                    app.close_modal();
                    app.toast("Update canceled (background task may still finish)");
                }
                return;
            }
            match ev.code {
                KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                    *progress = Some(ProgressView::new());
                    bridge.update_one(id.clone());
                }
                KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => app.close_modal(),
                _ => {}
            }
        }
        Modal::UpdateAll {
            queue,
            running,
            progress,
            ..
        } => {
            if matches!(ev.code, KeyCode::Esc) && !*running {
                app.close_modal();
                return;
            }
            if !*running && queue.is_empty() {
                if matches!(ev.code, KeyCode::Enter) {
                    app.close_modal();
                }
                return;
            }
            // While running, ignore keys other than Ctrl+C (handled above).
            // Once between items, Enter triggers the next.
            if !*running && matches!(ev.code, KeyCode::Enter) {
                if let Some(row) = queue.first().cloned() {
                    *progress = Some(ProgressView::new());
                    *running = true;
                    let owner_repo = row.source.strip_prefix("github:").unwrap_or("").to_string();
                    // Drop the head from the queue *after* we've copied
                    // the source string, so subsequent ticks can keep
                    // counting down correctly.
                    queue.remove(0);
                    bridge.update_one(owner_repo);
                }
            }
        }
    }
}

fn dispatch_default_action(app: &mut App, bridge: &Bridge) {
    match app.focus {
        Tab::Installed => show_detail_modal(app),
        Tab::Registry => trigger_install_from_registry(app),
        Tab::Updates => trigger_update_one(app),
    }
    // Silence unused-bridge in match arms that don't spawn yet.
    let _ = bridge;
}

fn show_detail_modal(app: &mut App) {
    let Loadable::Loaded(rows) = &app.installed else {
        return;
    };
    let view = app.filtered_installed_indices(rows);
    let Some(&row_idx) = view.get(app.cursor()) else {
        return;
    };
    let row = rows[row_idx].clone();
    app.modal = Some(Modal::Detail(row));
}

fn trigger_set_enabled(app: &mut App, on: bool) {
    let Loadable::Loaded(rows) = &app.installed else {
        return;
    };
    let view = app.filtered_installed_indices(rows);
    let Some(&row_idx) = view.get(app.cursor()) else {
        return;
    };
    let id = rows[row_idx].id.clone();
    if rows[row_idx].enabled == on {
        app.toast(format!(
            "{} already {}",
            id,
            if on { "enabled" } else { "disabled" }
        ));
        return;
    }
    app.modal = Some(Modal::SetEnabledConfirm {
        id,
        on,
        in_flight: false,
        finished: None,
    });
}

fn trigger_uninstall(app: &mut App) {
    let Loadable::Loaded(rows) = &app.installed else {
        return;
    };
    let view = app.filtered_installed_indices(rows);
    let Some(&row_idx) = view.get(app.cursor()) else {
        return;
    };
    let row = &rows[row_idx];
    app.modal = Some(Modal::UninstallConfirm {
        id: row.id.clone(),
        name: row.name.clone(),
        in_flight: false,
        finished: None,
    });
}

fn trigger_install_from_registry(app: &mut App) {
    let Loadable::Loaded(rows) = &app.registry else {
        // Registry not loaded yet — open the install dialog blank so the
        // user can still type a ref.
        app.modal = Some(Modal::InstallConfirm {
            input: super::input::Input::new(),
            progress: None,
            finished: None,
        });
        return;
    };
    let view = app.filtered_registry_indices(rows);
    let reference = view
        .get(app.cursor())
        .and_then(|&i| rows.get(i))
        .map(|r| r.entry.repository.clone())
        .unwrap_or_default();
    app.modal = Some(Modal::InstallConfirm {
        input: super::input::Input::with_text(reference),
        progress: None,
        finished: None,
    });
}

fn trigger_update_one(app: &mut App) {
    let Loadable::Loaded(rows) = &app.updates else {
        return;
    };
    let view = app.filtered_updates_indices(rows);
    let Some(&row_idx) = view.get(app.cursor()) else {
        return;
    };
    let row = rows[row_idx].clone();
    if !row.has_update {
        app.toast(format!("{} is up to date", row.id));
        return;
    }
    let Some(owner_repo) = row.source.strip_prefix("github:") else {
        app.toast(format!("{}: non-github source, cannot auto-update", row.id));
        return;
    };
    app.modal = Some(Modal::UpdateConfirm {
        id: owner_repo.to_string(),
        from: row.current_version.clone(),
        to: row.latest_version.clone().unwrap_or_default(),
        source: row.source.clone(),
        progress: None,
        finished: None,
    });
}

fn trigger_update_all(app: &mut App, bridge: &Bridge) {
    let Loadable::Loaded(rows) = &app.updates else {
        return;
    };
    let queue: Vec<_> = rows
        .iter()
        .filter(|r| r.has_update && r.source.starts_with("github:"))
        .cloned()
        .collect();
    if queue.is_empty() {
        app.toast("Nothing to update");
        return;
    }
    let total = queue.len();
    let mut q = queue;
    let first = q.remove(0);
    let owner_repo = first
        .source
        .strip_prefix("github:")
        .unwrap_or("")
        .to_string();
    app.modal = Some(Modal::UpdateAll {
        queue: q,
        current: 1,
        total,
        progress: Some(ProgressView::new()),
        finished: Vec::new(),
        running: true,
    });
    bridge.update_one(owner_repo);
}

fn switch_tab(app: &mut App, bridge: &Bridge, tab: Tab) {
    app.set_focus(tab);
    // Lazy-load the tab's data the first time it's visited.
    match tab {
        Tab::Installed => {
            if app.installed.is_idle() {
                app.installed = Loadable::Loading;
                bridge.load_installed();
            }
        }
        Tab::Registry => {
            if app.registry.is_idle() {
                app.registry = Loadable::Loading;
                bridge.load_registry();
            }
        }
        Tab::Updates => {
            if app.updates.is_idle() {
                app.updates = Loadable::Loading;
                let filter = match &app.initial {
                    InitialFocus::Updates { filter } => filter.clone(),
                    _ => None,
                };
                bridge.check_updates(filter);
            }
        }
    }
}

fn refresh(app: &mut App, bridge: &Bridge) {
    match app.focus {
        Tab::Installed => {
            app.installed = Loadable::Loading;
            bridge.load_installed();
        }
        Tab::Registry => {
            app.registry = Loadable::Loading;
            bridge.load_registry();
        }
        Tab::Updates => {
            app.updates = Loadable::Loading;
            bridge.check_updates(None);
        }
    }
}
