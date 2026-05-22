//! Full TUI for `tedi ext` subcommands. Built on [`ratatui`] + [`crossterm`].
//! Replaces the line-by-line `println!` / `dialoguer::Select` UX of the
//! legacy CLI with a single dashboard (Installed / Registry / Updates tabs)
//! and a modal slot for confirmations.
//!
//! Entry point: [`run`]. Called from [`cli_ext::handle_extension_command_and_exit`]
//! whenever stdin + stdout are both terminals and `--plain` was not passed.
//! Non-TTY shells, `--plain`, and the `help` subcommand keep using the
//! plain-mode printers in `cli_ext.rs`.
//!
//! Terminal hygiene: [`TerminalGuard`] disables raw mode and leaves the
//! alternate screen on drop, even if the main loop panics, so a crash
//! never strands the user's shell in a broken state.

mod actions;
mod app;
mod events;
mod input;
mod theme;
mod ui;

use std::io::{self, Stdout};
use std::time::Duration;

use crossterm::event::{Event, EventStream, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::modules::cli_ext::InitialFocus;

use actions::{AppMsg, Bridge};
use app::{App, Loadable, Modal, ProgressView, Tab};
use events::{apply_msg, handle_key};

type TuiTerminal = Terminal<CrosstermBackend<Stdout>>;

/// Entry point called from `cli_ext::handle_extension_command_and_exit`.
/// Owns stdin/stdout for the duration of the TUI session.
pub(crate) fn run(initial: InitialFocus) -> Result<(), String> {
    let runtime = crate::modules::cli_ext::build_runtime()?;
    runtime.block_on(async move {
        let mut terminal = setup_terminal()?;
        let _guard = TerminalGuard;

        // Channel: every background task pushes here, the main loop drains.
        let (tx, mut rx) = mpsc::unbounded_channel::<AppMsg>();
        let bridge = Bridge::new(tx);

        let mut app = App::new(initial.clone());
        bootstrap(&mut app, &bridge);

        let mut event_stream = EventStream::new();
        let mut tick = tokio::time::interval(Duration::from_millis(80));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let result: Result<(), String> = loop {
            if let Err(e) = terminal.draw(|f| ui::render(f, &app)) {
                break Err(format!("draw: {e}"));
            }

            tokio::select! {
                evt = event_stream.next() => {
                    match evt {
                        Some(Ok(Event::Key(key))) if key.kind != KeyEventKind::Release => {
                            handle_key(&mut app, &bridge, key);
                        }
                        Some(Ok(Event::Resize(_, _))) => {
                            // Ratatui handles resize automatically on next draw.
                        }
                        Some(Err(e)) => break Err(format!("event stream: {e}")),
                        None => break Err("event stream closed".into()),
                        _ => {}
                    }
                }
                msg = rx.recv() => {
                    if let Some(msg) = msg {
                        apply_msg(&mut app, msg);
                        // UpdateAll modal needs to spawn the next item once
                        // the previous one settles (running=false, queue not empty).
                        advance_update_all(&mut app, &bridge);
                    }
                }
                _ = tick.tick() => {
                    app.tick = app.tick.wrapping_add(1);
                }
            }

            if app.should_quit {
                break Ok(());
            }
        };

        // Terminal restore happens in `_guard` drop. Surface any draw or
        // event error after restoring the terminal so the message lands
        // on the user's shell, not the alternate screen.
        drop(_guard);
        // Manual restore in case Drop ordering bites us (event stream
        // tasks may still be flushing).
        let _ = restore_terminal(&mut terminal);
        result
    })
}

fn setup_terminal() -> Result<TuiTerminal, String> {
    enable_raw_mode().map_err(|e| format!("enable_raw_mode: {e}"))?;
    let mut stdout = io::stdout();
    // Deliberately NO `EnableMouseCapture`. Mouse-tracking escape sequences
    // confuse some Windows console hosts (legacy conhost, older Windows
    // Terminal builds) and have been observed to swallow arrow keys.
    // Navigation is keyboard-only anyway.
    execute!(stdout, EnterAlternateScreen).map_err(|e| format!("enter alt screen: {e}"))?;
    let backend = CrosstermBackend::new(stdout);
    Terminal::new(backend).map_err(|e| format!("ratatui terminal: {e}"))
}

fn restore_terminal(terminal: &mut TuiTerminal) -> Result<(), String> {
    let _ = disable_raw_mode();
    let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen);
    let _ = terminal.show_cursor();
    Ok(())
}

/// Panic-safe restore. Runs on stack unwind from any panic in the TUI
/// loop. Errors are deliberately swallowed: the process is already going
/// down, and we'd rather leave a slightly noisy shell than abort during
/// cleanup.
struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        // Re-show the cursor — `Terminal::show_cursor` writes a CSI
        // sequence, which we can replicate directly.
        let _ = execute!(io::stdout(), crossterm::cursor::Show);
    }
}

/// Dispatch the initial async fetch + modal based on the subcommand that
/// opened the TUI. Always loads the focused tab's data on launch so the
/// user sees something other than a blank list.
fn bootstrap(app: &mut App, bridge: &Bridge) {
    // Always kick off the initial tab's data load.
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
            let filter = match &app.initial {
                InitialFocus::Updates { filter } => filter.clone(),
                _ => None,
            };
            bridge.check_updates(filter);
        }
    }

    // Subcommand-driven modals that don't depend on a list (install with a
    // ref) can open immediately. Modals that need a name lookup
    // (uninstall, enable, disable) wait for `installed` to land — see
    // `events::promote_initial_focus`.
    if let InitialFocus::InstallPrompt { reference } = &app.initial {
        app.modal = Some(Modal::InstallConfirm {
            input: input::Input::with_text(reference.clone()),
            progress: None,
            finished: None,
        });
        // Also load installed so the "→ already installed" hint lands.
        if app.installed.is_idle() {
            app.installed = Loadable::Loading;
            bridge.load_installed();
        }
    } else if matches!(
        &app.initial,
        InitialFocus::UninstallConfirm { .. } | InitialFocus::SetEnabled { .. }
    ) {
        // Force-load installed so the deferred modal can promote.
        if !matches!(app.installed, Loadable::Loaded(_)) {
            app.installed = Loadable::Loading;
            bridge.load_installed();
        }
    }
}

/// After every settled `UpdateOneDone` in the UpdateAll flow, if the queue
/// still has items and nothing is running, kick the next one. Bundled here
/// (not in `events.rs`) because it needs both the `Bridge` and the right
/// to mutate `app.modal` after the previous result was applied.
fn advance_update_all(app: &mut App, bridge: &Bridge) {
    let Some(Modal::UpdateAll {
        queue,
        running,
        progress,
        current,
        ..
    }) = &mut app.modal
    else {
        return;
    };
    if *running || queue.is_empty() {
        return;
    }
    // Pull the next github-sourced row; non-github ones were filtered out
    // when the queue was built in `events.rs`, but defensive double-check.
    let Some(row) = queue.first().cloned() else {
        return;
    };
    let owner_repo = row.source.strip_prefix("github:").unwrap_or("").to_string();
    if owner_repo.is_empty() {
        // Skip silently — push a synthetic "skipped" result so the count
        // still moves forward.
        queue.remove(0);
        return;
    }
    queue.remove(0);
    *progress = Some(ProgressView::new());
    *running = true;
    *current += 1;
    bridge.update_one(owner_repo);
}
