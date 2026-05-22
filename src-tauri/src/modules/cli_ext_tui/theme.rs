//! Shared visual tokens for the `tedi ext` TUI. Kept tiny — three accent
//! colors, plain borders, one spinner. Designed to look acceptable on both
//! light and dark terminal backgrounds (no hard-coded BG).

use ratatui::style::{Color, Modifier, Style};

pub fn accent() -> Style {
    Style::default()
        .fg(Color::Cyan)
        .add_modifier(Modifier::BOLD)
}

pub fn dim() -> Style {
    Style::default().fg(Color::DarkGray)
}

pub fn ok() -> Style {
    Style::default().fg(Color::Green)
}

pub fn warn() -> Style {
    Style::default().fg(Color::Yellow)
}

pub fn err() -> Style {
    Style::default().fg(Color::Red)
}

pub fn highlight() -> Style {
    Style::default()
        .bg(Color::DarkGray)
        .fg(Color::White)
        .add_modifier(Modifier::BOLD)
}

pub fn border_focus() -> Style {
    Style::default()
        .fg(Color::Cyan)
        .add_modifier(Modifier::BOLD)
}

pub fn border_idle() -> Style {
    Style::default().fg(Color::DarkGray)
}

const SPINNER: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Returns one frame of a 10-frame braille spinner. `tick` increments once
/// per render tick (~80ms in the main loop). Caller does not have to bound
/// `tick` — modulo is taken here.
pub fn spinner_frame(tick: u64) -> &'static str {
    SPINNER[(tick as usize) % SPINNER.len()]
}
