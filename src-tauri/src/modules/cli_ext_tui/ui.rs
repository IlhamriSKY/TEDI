//! Render functions for the `tedi ext` TUI. Layout is fixed: title bar
//! + tab strip, body (one of three list views), footer with keymap. A
//!   single modal slot overlays everything when `app.modal` is set.
//!
//! Rendering is read-only — every function takes `&App` and writes
//! widgets through the supplied [`Frame`].

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Margin, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Borders, Clear, Gauge, List, ListItem, ListState, Padding, Paragraph, Tabs, Wrap,
};
use ratatui::Frame;

use crate::modules::cli_ext::UpdateRow;

use super::app::{App, Loadable, Modal, ProgressView, RegistryFlat, Tab};
use super::theme;

pub fn render(f: &mut Frame, app: &App) {
    let area = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // title + tabs
            Constraint::Min(3),    // body
            Constraint::Length(filter_bar_height(app)),
            Constraint::Length(1), // toast / status
            Constraint::Length(1), // keymap hint
        ])
        .split(area);

    render_header(f, app, chunks[0]);
    render_body(f, app, chunks[1]);
    if chunks[2].height > 0 {
        render_filter_bar(f, app, chunks[2]);
    }
    render_status(f, app, chunks[3]);
    render_keymap(f, app, chunks[4]);

    if app.modal.is_some() {
        render_modal(f, app);
    }
}

fn filter_bar_height(app: &App) -> u16 {
    if app.filtering || !app.filter.is_empty() {
        1
    } else {
        0
    }
}

fn render_header(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::border_idle())
        .title(Span::styled(
            format!(" TEDI Extensions  v{} ", env!("CARGO_PKG_VERSION")),
            theme::accent(),
        ))
        .title_alignment(Alignment::Left);
    let inner = block.inner(area);
    f.render_widget(block, area);

    let titles: Vec<Line> = [Tab::Installed, Tab::Registry, Tab::Updates]
        .iter()
        .enumerate()
        .map(|(i, t)| {
            Line::from(vec![
                Span::styled(format!(" {} ", i + 1), theme::dim()),
                Span::raw(t.label()),
            ])
        })
        .collect();
    let idx = match app.focus {
        Tab::Installed => 0,
        Tab::Registry => 1,
        Tab::Updates => 2,
    };
    let tabs = Tabs::new(titles)
        .select(idx)
        .style(Style::default())
        .highlight_style(theme::accent().add_modifier(Modifier::REVERSED))
        .divider(Span::styled("│", theme::dim()))
        .padding("", "");
    f.render_widget(tabs, inner);
}

fn render_body(f: &mut Frame, app: &App, area: Rect) {
    match app.focus {
        Tab::Installed => render_installed(f, app, area),
        Tab::Registry => render_registry(f, app, area),
        Tab::Updates => render_updates(f, app, area),
    }
}

fn render_installed(f: &mut Frame, app: &App, area: Rect) {
    let block = list_block(app, "Installed");
    let inner = block.inner(area);
    f.render_widget(block, area);

    match &app.installed {
        Loadable::Idle => placeholder(f, inner, "Press 'r' to load installed extensions."),
        Loadable::Loading => spinner(f, app, inner, "Loading installed extensions"),
        Loadable::Error(e) => placeholder_styled(f, inner, e, theme::err()),
        Loadable::Loaded(rows) if rows.is_empty() => placeholder(
            f,
            inner,
            "No extensions installed. Switch to Registry (Tab) to browse.",
        ),
        Loadable::Loaded(rows) => {
            let view = app.filtered_installed_indices(rows);
            if view.is_empty() {
                placeholder(f, inner, "No matches for current filter.");
                return;
            }
            let items: Vec<ListItem> = view
                .iter()
                .map(|&i| {
                    let r = &rows[i];
                    let badge = if r.enabled {
                        Span::styled("● ", theme::ok())
                    } else {
                        Span::styled("○ ", theme::dim())
                    };
                    let mut spans = vec![
                        badge,
                        Span::styled(
                            r.name.clone(),
                            Style::default().add_modifier(Modifier::BOLD),
                        ),
                        Span::raw("  "),
                        Span::styled(format!("v{}", r.version), theme::dim()),
                    ];
                    if r.has_update() {
                        if let Some(latest) = &r.latest {
                            spans.push(Span::raw("  "));
                            spans.push(Span::styled(format!("→ v{latest}"), theme::warn()));
                        }
                    }
                    let line1 = Line::from(spans);
                    let line2 = Line::from(vec![
                        Span::styled("  id: ", theme::dim()),
                        Span::raw(r.id.clone()),
                        Span::styled("   ", theme::dim()),
                        Span::styled(format!("[{}]", r.source), theme::dim()),
                    ]);
                    ListItem::new(vec![line1, line2])
                })
                .collect();
            let list = List::new(items)
                .highlight_style(theme::highlight())
                .highlight_symbol("▌ ");
            let mut state = ListState::default();
            state.select(Some(app.cursor().min(view.len().saturating_sub(1))));
            f.render_stateful_widget(list, inner, &mut state);
        }
    }
}

fn render_registry(f: &mut Frame, app: &App, area: Rect) {
    let block = list_block(app, "Registry");
    let inner = block.inner(area);
    f.render_widget(block, area);

    match &app.registry {
        Loadable::Idle => placeholder(f, inner, "Press 'r' to fetch the registry."),
        Loadable::Loading => spinner(f, app, inner, "Fetching registry"),
        Loadable::Error(e) => placeholder_styled(f, inner, e, theme::err()),
        Loadable::Loaded(rows) if rows.is_empty() => placeholder(f, inner, "Registry is empty."),
        Loadable::Loaded(rows) => {
            let view = app.filtered_registry_indices(rows);
            if view.is_empty() {
                placeholder(f, inner, "No matches for current filter.");
                return;
            }
            let items: Vec<ListItem> = view.iter().map(|&i| registry_item(&rows[i])).collect();
            let list = List::new(items)
                .highlight_style(theme::highlight())
                .highlight_symbol("▌ ");
            let mut state = ListState::default();
            state.select(Some(app.cursor().min(view.len().saturating_sub(1))));
            f.render_stateful_widget(list, inner, &mut state);
        }
    }
}

fn registry_item(row: &RegistryFlat) -> ListItem<'static> {
    let group_style = if row.group == "official" {
        theme::ok()
    } else {
        theme::warn()
    };
    let line1 = Line::from(vec![
        Span::styled(format!("[{}] ", row.group), group_style),
        Span::styled(
            row.entry.id.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            if row.entry.publisher.is_empty() {
                String::new()
            } else {
                format!("  by {}", row.entry.publisher)
            },
            theme::dim(),
        ),
    ]);
    let desc = if row.entry.description.is_empty() {
        Line::from(Span::styled("  (no description)", theme::dim()))
    } else {
        Line::from(Span::styled(
            format!("  {}", row.entry.description),
            theme::dim(),
        ))
    };
    ListItem::new(vec![line1, desc])
}

fn render_updates(f: &mut Frame, app: &App, area: Rect) {
    let block = list_block(app, "Updates");
    let inner = block.inner(area);
    f.render_widget(block, area);

    match &app.updates {
        Loadable::Idle => placeholder(f, inner, "Press 'r' to check for updates."),
        Loadable::Loading => spinner(f, app, inner, "Checking upstream releases"),
        Loadable::Error(e) => placeholder_styled(f, inner, e, theme::err()),
        Loadable::Loaded(rows) if rows.is_empty() => {
            placeholder(f, inner, "No extensions installed.")
        }
        Loadable::Loaded(rows) => {
            let view = app.filtered_updates_indices(rows);
            if view.is_empty() {
                placeholder(f, inner, "No matches for current filter.");
                return;
            }
            let items: Vec<ListItem> = view.iter().map(|&i| update_item(&rows[i])).collect();
            let list = List::new(items)
                .highlight_style(theme::highlight())
                .highlight_symbol("▌ ");
            let mut state = ListState::default();
            state.select(Some(app.cursor().min(view.len().saturating_sub(1))));
            f.render_stateful_widget(list, inner, &mut state);
        }
    }
}

fn update_item(row: &UpdateRow) -> ListItem<'static> {
    let (badge, badge_style) = if row.has_update {
        ("↑ ", theme::warn())
    } else if row.message.is_some() {
        ("· ", theme::dim())
    } else {
        ("✓ ", theme::ok())
    };
    let mut spans = vec![
        Span::styled(badge, badge_style),
        Span::styled(
            row.id.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(format!("v{}", row.current_version), theme::dim()),
    ];
    if let Some(latest) = &row.latest_version {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(format!("→ v{latest}"), theme::warn()));
    }
    let line1 = Line::from(spans);
    let line2 = match &row.message {
        Some(msg) => Line::from(Span::styled(format!("  {msg}"), theme::dim())),
        None => Line::from(Span::styled(format!("  [{}]", row.source), theme::dim())),
    };
    ListItem::new(vec![line1, line2])
}

fn list_block(app: &App, title: &str) -> Block<'static> {
    let style = if app.modal.is_none() {
        theme::border_focus()
    } else {
        theme::border_idle()
    };
    Block::default()
        .borders(Borders::ALL)
        .border_style(style)
        .padding(Padding::horizontal(1))
        .title(Span::styled(format!(" {title} "), theme::accent()))
}

fn render_filter_bar(f: &mut Frame, app: &App, area: Rect) {
    let prefix = if app.filtering { "/ " } else { "/ (paused) " };
    let line = Line::from(vec![
        Span::styled(prefix, theme::accent()),
        Span::raw(app.filter.value().to_string()),
    ]);
    let p = Paragraph::new(line);
    f.render_widget(p, area);
    if app.filtering {
        let x = area.x + prefix.chars().count() as u16 + app.filter.cursor_display();
        f.set_cursor_position((x.min(area.x + area.width.saturating_sub(1)), area.y));
    }
}

fn render_status(f: &mut Frame, app: &App, area: Rect) {
    if let Some(msg) = &app.status {
        let p = Paragraph::new(Line::from(Span::styled(msg.clone(), theme::dim())));
        f.render_widget(p, area);
    }
}

fn render_keymap(f: &mut Frame, app: &App, area: Rect) {
    let mut spans: Vec<Span> = Vec::new();
    let add = |spans: &mut Vec<Span>, key: &'static str, hint: &'static str| {
        spans.push(Span::styled(format!(" {key} "), theme::accent()));
        spans.push(Span::styled(hint, theme::dim()));
        spans.push(Span::raw("  "));
    };
    add(&mut spans, "Tab", "switch");
    add(&mut spans, "↑↓/jk", "nav");
    add(&mut spans, "/", "filter");
    add(&mut spans, "r", "refresh");
    match app.focus {
        Tab::Installed => {
            add(&mut spans, "Enter", "detail");
            add(&mut spans, "e/d", "enable/disable");
            add(&mut spans, "x", "uninstall");
        }
        Tab::Registry => {
            add(&mut spans, "Enter/i", "install");
        }
        Tab::Updates => {
            add(&mut spans, "Enter/u", "update");
            add(&mut spans, "U", "update all");
        }
    }
    add(&mut spans, "?", "help");
    add(&mut spans, "q", "quit");
    let p = Paragraph::new(Line::from(spans));
    f.render_widget(p, area);
}

fn placeholder(f: &mut Frame, area: Rect, text: &str) {
    placeholder_styled(f, area, text, theme::dim());
}

fn placeholder_styled(f: &mut Frame, area: Rect, text: &str, style: Style) {
    let p = Paragraph::new(Span::styled(text.to_string(), style))
        .alignment(Alignment::Center)
        .wrap(Wrap { trim: true });
    let centered = area.inner(Margin {
        horizontal: 2,
        vertical: 1,
    });
    f.render_widget(p, centered);
}

fn spinner(f: &mut Frame, app: &App, area: Rect, label: &str) {
    let line = Line::from(vec![
        Span::styled(theme::spinner_frame(app.tick).to_string(), theme::accent()),
        Span::raw("  "),
        Span::styled(label.to_string(), theme::dim()),
    ]);
    let p = Paragraph::new(line).alignment(Alignment::Center);
    let centered = area.inner(Margin {
        horizontal: 2,
        vertical: 1,
    });
    f.render_widget(p, centered);
}

// ---- modal --------------------------------------------------------------

fn render_modal(f: &mut Frame, app: &App) {
    let area = f.area();
    let (w_pct, h_pct) = match app.modal.as_ref().unwrap() {
        Modal::Help => (60, 70),
        Modal::Detail(_) => (60, 60),
        Modal::InstallConfirm { .. } => (70, 60),
        Modal::UpdateConfirm { .. } => (70, 60),
        Modal::UpdateAll { .. } => (70, 65),
        Modal::UninstallConfirm { .. } | Modal::SetEnabledConfirm { .. } => (50, 35),
        Modal::Toast(_) | Modal::Error(_) => (50, 25),
    };
    let centered = centered_rect(w_pct, h_pct, area);
    f.render_widget(Clear, centered);

    match app.modal.as_ref().unwrap() {
        Modal::Help => render_help_modal(f, centered),
        Modal::Detail(row) => render_detail_modal(f, centered, row),
        Modal::InstallConfirm {
            input,
            progress,
            finished,
        } => render_install_modal(
            f,
            app,
            centered,
            input,
            progress.as_ref(),
            finished.as_ref(),
        ),
        Modal::UninstallConfirm {
            id,
            name,
            in_flight,
            finished,
        } => render_uninstall_modal(f, app, centered, id, name, *in_flight, finished.as_ref()),
        Modal::SetEnabledConfirm {
            id,
            on,
            in_flight,
            finished,
        } => render_set_enabled_modal(f, app, centered, id, *on, *in_flight, finished.as_ref()),
        Modal::UpdateConfirm {
            id,
            from,
            to,
            source,
            progress,
            finished,
        } => render_update_one_modal(
            f,
            app,
            centered,
            id,
            from,
            to,
            source,
            progress.as_ref(),
            finished.as_ref(),
        ),
        Modal::UpdateAll {
            queue,
            current,
            total,
            progress,
            finished,
            running,
        } => render_update_all_modal(
            f,
            app,
            centered,
            queue.len(),
            *current,
            *total,
            progress.as_ref(),
            finished,
            *running,
        ),
        Modal::Toast(msg) => render_simple_modal(f, centered, " Notice ", msg, theme::dim()),
        Modal::Error(msg) => render_simple_modal(f, centered, " Error ", msg, theme::err()),
    }
}

fn render_help_modal(f: &mut Frame, area: Rect) {
    let lines = vec![
        Line::from(vec![Span::styled("Keymap", theme::accent())]),
        Line::from(""),
        Line::from("Tab / Shift-Tab    cycle Installed / Registry / Updates"),
        Line::from("1 / 2 / 3          jump to tab"),
        Line::from("↑ ↓ j k            navigate list"),
        Line::from("g / G              top / bottom"),
        Line::from("PgUp / PgDn        scroll page"),
        Line::from("/                  focus filter input"),
        Line::from("Esc                close modal / clear filter"),
        Line::from("Enter              default action (detail / install / update)"),
        Line::from(""),
        Line::from(vec![Span::styled("Installed tab", theme::accent())]),
        Line::from("e                  enable selected"),
        Line::from("d                  disable selected"),
        Line::from("x                  uninstall (confirms)"),
        Line::from(""),
        Line::from(vec![Span::styled("Registry tab", theme::accent())]),
        Line::from("Enter / i          install selected"),
        Line::from(""),
        Line::from(vec![Span::styled("Updates tab", theme::accent())]),
        Line::from("Enter / u          update selected"),
        Line::from("U                  update all (sequential)"),
        Line::from(""),
        Line::from("r                  refresh current tab"),
        Line::from("q / Ctrl+C         quit"),
    ];
    let p = Paragraph::new(Text::from(lines))
        .block(modal_block(" Help — press Esc to close "))
        .wrap(Wrap { trim: false });
    f.render_widget(p, area);
}

fn render_detail_modal(f: &mut Frame, area: Rect, row: &crate::modules::cli_ext::InstalledRow) {
    let lines = vec![
        Line::from(vec![
            Span::styled("Name:    ", theme::dim()),
            Span::styled(
                row.name.clone(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            Span::styled("Id:      ", theme::dim()),
            Span::raw(row.id.clone()),
        ]),
        Line::from(vec![
            Span::styled("Version: ", theme::dim()),
            Span::raw(format!("v{}", row.version)),
        ]),
        Line::from(vec![
            Span::styled("Source:  ", theme::dim()),
            Span::raw(row.source.clone()),
        ]),
        Line::from(vec![
            Span::styled("State:   ", theme::dim()),
            if row.enabled {
                Span::styled("enabled", theme::ok())
            } else {
                Span::styled("disabled", theme::warn())
            },
        ]),
        Line::from(""),
        Line::from(match &row.latest {
            Some(v) if v != &row.version => Span::styled(
                format!("Update available: v{v}"),
                theme::warn().add_modifier(Modifier::BOLD),
            ),
            _ => Span::styled("Up to date.", theme::ok()),
        }),
        Line::from(""),
        Line::from(Span::styled("Esc / Enter to close", theme::dim())),
    ];
    let p = Paragraph::new(Text::from(lines))
        .block(modal_block(" Details "))
        .wrap(Wrap { trim: false });
    f.render_widget(p, area);
}

fn render_install_modal(
    f: &mut Frame,
    app: &App,
    area: Rect,
    input: &super::input::Input,
    progress: Option<&ProgressView>,
    finished: Option<&Result<super::app::InstalledSummary, String>>,
) {
    let block = modal_block(" Install extension ");
    let inner = block.inner(area);
    f.render_widget(block, area);

    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(3),
            Constraint::Min(3),
            Constraint::Length(1),
        ])
        .split(inner.inner(Margin {
            horizontal: 1,
            vertical: 0,
        }));

    let header = Paragraph::new(Span::styled(
        "Enter a path, owner/repo, GitHub URL, or registry id:",
        theme::dim(),
    ));
    f.render_widget(header, layout[0]);

    let input_box = Block::default().borders(Borders::ALL).border_style(
        if progress.is_none() && finished.is_none() {
            theme::border_focus()
        } else {
            theme::border_idle()
        },
    );
    let input_inner = input_box.inner(layout[1]);
    f.render_widget(input_box, layout[1]);
    let para = Paragraph::new(Line::from(vec![Span::raw(input.value().to_string())]));
    f.render_widget(para, input_inner);
    if progress.is_none() && finished.is_none() {
        let cx = input_inner.x + input.cursor_display();
        f.set_cursor_position((
            cx.min(input_inner.x + input_inner.width.saturating_sub(1)),
            input_inner.y,
        ));
    }

    if let Some(p) = progress {
        render_progress_block(f, app, layout[2], p, finished);
    } else if let Some(fin) = finished {
        render_finished_message(f, layout[2], fin);
    } else {
        let hint = Paragraph::new(Line::from(vec![Span::styled(
            "Enter to install · Esc to cancel · Ctrl+W to delete word · Ctrl+U to clear",
            theme::dim(),
        )]))
        .wrap(Wrap { trim: false });
        f.render_widget(hint, layout[2]);
    }

    let footer = Paragraph::new(Line::from(vec![Span::styled(
        if finished.is_some() {
            "Esc / Enter to close"
        } else if progress.is_some() {
            "Working — Esc to detach"
        } else {
            ""
        },
        theme::dim(),
    )]));
    f.render_widget(footer, layout[3]);
}

fn render_uninstall_modal(
    f: &mut Frame,
    _app: &App,
    area: Rect,
    id: &str,
    name: &str,
    in_flight: bool,
    finished: Option<&Result<(), String>>,
) {
    let block = modal_block(" Confirm uninstall ");
    let inner = block.inner(area);
    f.render_widget(block, area);
    let lines = match finished {
        Some(Ok(())) => vec![
            Line::from(Span::styled(format!("Uninstalled {id}."), theme::ok())),
            Line::from(""),
            Line::from(Span::styled("Esc to close", theme::dim())),
        ],
        Some(Err(e)) => vec![
            Line::from(Span::styled("Uninstall failed:", theme::err())),
            Line::from(e.clone()),
            Line::from(""),
            Line::from(Span::styled("Esc to close", theme::dim())),
        ],
        None if in_flight => vec![Line::from(format!("Removing {id} …"))],
        None => vec![
            Line::from(vec![
                Span::raw("Remove "),
                Span::styled(
                    name.to_string(),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!(" (id: {id})?")),
            ]),
            Line::from(""),
            Line::from(Span::styled(
                "Files under <app_data>/extensions/<id>/ will be deleted.",
                theme::dim(),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "y / Enter to confirm · n / Esc to cancel",
                theme::accent(),
            )),
        ],
    };
    let p = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
    f.render_widget(
        p,
        inner.inner(Margin {
            horizontal: 1,
            vertical: 0,
        }),
    );
}

fn render_set_enabled_modal(
    f: &mut Frame,
    _app: &App,
    area: Rect,
    id: &str,
    on: bool,
    in_flight: bool,
    finished: Option<&Result<(), String>>,
) {
    let action = if on { "Enable" } else { "Disable" };
    let block = modal_block(&format!(" Confirm {} ", action.to_lowercase()));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let lines = match finished {
        Some(Ok(())) => vec![
            Line::from(Span::styled(format!("{action}d {id}."), theme::ok())),
            Line::from(""),
            Line::from(Span::styled("Esc to close", theme::dim())),
        ],
        Some(Err(e)) => vec![
            Line::from(Span::styled(format!("{action} failed:"), theme::err())),
            Line::from(e.clone()),
            Line::from(""),
            Line::from(Span::styled("Esc to close", theme::dim())),
        ],
        None if in_flight => vec![Line::from(format!("{action}ing {id} …"))],
        None => vec![
            Line::from(vec![
                Span::raw(format!("{action} ")),
                Span::styled(
                    id.to_string(),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::raw("?"),
            ]),
            Line::from(""),
            Line::from(Span::styled(
                "y / Enter to confirm · n / Esc to cancel",
                theme::accent(),
            )),
        ],
    };
    let p = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
    f.render_widget(
        p,
        inner.inner(Margin {
            horizontal: 1,
            vertical: 0,
        }),
    );
}

#[allow(clippy::too_many_arguments)]
fn render_update_one_modal(
    f: &mut Frame,
    app: &App,
    area: Rect,
    id: &str,
    from: &str,
    to: &str,
    source: &str,
    progress: Option<&ProgressView>,
    finished: Option<&Result<super::app::InstalledSummary, String>>,
) {
    let block = modal_block(" Confirm update ");
    let inner = block.inner(area);
    f.render_widget(block, area);
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(5), Constraint::Min(3)])
        .split(inner.inner(Margin {
            horizontal: 1,
            vertical: 0,
        }));
    let header_lines = vec![
        Line::from(vec![
            Span::raw("Updating "),
            Span::styled(
                id.to_string(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::raw(" from "),
            Span::styled(format!("v{from}"), theme::dim()),
            Span::raw(" to "),
            Span::styled(format!("v{to}"), theme::warn()),
        ]),
        Line::from(Span::styled(format!("source: {source}"), theme::dim())),
        Line::from(""),
        Line::from(if progress.is_some() || finished.is_some() {
            Span::raw("")
        } else {
            Span::styled("y / Enter to confirm · n / Esc to cancel", theme::accent())
        }),
    ];
    let head = Paragraph::new(Text::from(header_lines)).wrap(Wrap { trim: false });
    f.render_widget(head, layout[0]);
    if let Some(p) = progress {
        render_progress_block(
            f,
            app,
            layout[1],
            p,
            finished
                .map(|r| match r {
                    Ok(s) => Ok(s.clone()),
                    Err(e) => Err(e.clone()),
                })
                .as_ref(),
        );
    } else if let Some(fin) = finished {
        render_finished_message(f, layout[1], fin);
    }
}

#[allow(clippy::too_many_arguments)]
fn render_update_all_modal(
    f: &mut Frame,
    app: &App,
    area: Rect,
    remaining_in_queue: usize,
    current: usize,
    total: usize,
    progress: Option<&ProgressView>,
    finished: &[(String, Result<(), String>)],
    running: bool,
) {
    let block = modal_block(" Update all ");
    let inner = block.inner(area);
    f.render_widget(block, area);
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Length(5),
            Constraint::Min(3),
        ])
        .split(inner.inner(Margin {
            horizontal: 1,
            vertical: 0,
        }));

    let done_count = finished.len();
    let header = Paragraph::new(Line::from(vec![
        Span::styled(format!("{} / {} ", done_count, total), theme::accent()),
        Span::styled("complete", theme::dim()),
        Span::styled(format!("  · {remaining_in_queue} queued"), theme::dim()),
    ]));
    f.render_widget(header, layout[0]);

    if let Some(p) = progress {
        render_progress_block(f, app, layout[1], p, None);
    } else if !running && remaining_in_queue == 0 {
        let p = Paragraph::new(Line::from(Span::styled(
            "All done — Esc / Enter to close",
            theme::ok(),
        )));
        f.render_widget(p, layout[1]);
    } else if !running {
        let p = Paragraph::new(Line::from(Span::styled(
            "Enter to start the next update · Esc to abort",
            theme::accent(),
        )));
        f.render_widget(p, layout[1]);
    }

    let log_lines: Vec<Line> = finished
        .iter()
        .map(|(id, r)| match r {
            Ok(()) => Line::from(vec![Span::styled("✓ ", theme::ok()), Span::raw(id.clone())]),
            Err(e) => Line::from(vec![
                Span::styled("✗ ", theme::err()),
                Span::raw(id.clone()),
                Span::raw(": "),
                Span::styled(e.clone(), theme::err()),
            ]),
        })
        .collect();
    let log = Paragraph::new(Text::from(log_lines)).wrap(Wrap { trim: false });
    f.render_widget(log, layout[2]);
    let _ = current;
}

fn render_progress_block(
    f: &mut Frame,
    app: &App,
    area: Rect,
    p: &ProgressView,
    finished: Option<&Result<super::app::InstalledSummary, String>>,
) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(0),
        ])
        .split(area);

    let phase_line = Line::from(vec![
        Span::styled(theme::spinner_frame(app.tick).to_string(), theme::accent()),
        Span::raw("  "),
        Span::styled(
            p.phase_text.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(
            if p.bytes_total.is_some() && p.bytes_done > 0 {
                format_bytes(p.bytes_done)
            } else if p.file_total > 0 {
                format!("{}/{} files", p.file_index + 1, p.file_total)
            } else {
                String::new()
            },
            theme::dim(),
        ),
    ]);
    f.render_widget(Paragraph::new(phase_line), layout[0]);

    let ratio = compute_ratio(p);
    let label = match (p.bytes_total, p.file_total) {
        (Some(total), _) if p.phase_text == "Downloading" => {
            format!("{} / {}", format_bytes(p.bytes_done), format_bytes(total))
        }
        (_, n) if n > 0 => format!("{} / {}", p.file_index + 1, p.file_total),
        _ => String::new(),
    };
    let gauge = Gauge::default()
        .gauge_style(theme::accent())
        .label(label)
        .ratio(ratio);
    f.render_widget(gauge, layout[1]);

    if !p.current_file.is_empty() {
        let file = Paragraph::new(Line::from(Span::styled(
            format!("  {}", p.current_file),
            theme::dim(),
        )));
        f.render_widget(file, layout[2]);
    }

    if let Some(r) = finished {
        render_finished_message(f, layout[3], r);
    }
}

fn render_finished_message(
    f: &mut Frame,
    area: Rect,
    fin: &Result<super::app::InstalledSummary, String>,
) {
    let line = match fin {
        Ok(s) => Line::from(vec![
            Span::styled("✓ ", theme::ok()),
            Span::raw(format!("Installed {} v{}", s.id, s.version)),
        ]),
        Err(e) => Line::from(vec![
            Span::styled("✗ ", theme::err()),
            Span::styled(e.clone(), theme::err()),
        ]),
    };
    let p = Paragraph::new(line).wrap(Wrap { trim: false });
    f.render_widget(p, area);
}

fn render_simple_modal(f: &mut Frame, area: Rect, title: &str, body: &str, body_style: Style) {
    let lines = vec![
        Line::from(Span::styled(body.to_string(), body_style)),
        Line::from(""),
        Line::from(Span::styled("Esc / Enter to close", theme::dim())),
    ];
    let p = Paragraph::new(Text::from(lines))
        .block(modal_block(title))
        .wrap(Wrap { trim: false });
    f.render_widget(p, area);
}

fn modal_block(title: &str) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(theme::border_focus())
        .padding(Padding::uniform(1))
        .title(Span::styled(title.to_string(), theme::accent()))
}

fn compute_ratio(p: &ProgressView) -> f64 {
    if let Some(total) = p.bytes_total {
        if total > 0 {
            return (p.bytes_done as f64 / total as f64).clamp(0.0, 1.0);
        }
    }
    if p.file_total > 0 {
        return ((p.file_index as f64 + 1.0) / p.file_total as f64).clamp(0.0, 1.0);
    }
    0.0
}

fn format_bytes(b: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    if b >= MB {
        format!("{:.1} MiB", b as f64 / MB as f64)
    } else if b >= KB {
        format!("{:.1} KiB", b as f64 / KB as f64)
    } else {
        format!("{b} B")
    }
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}
