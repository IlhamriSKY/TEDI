//! App state for the `tedi ext` TUI. Pure data + thin transition methods.
//! Async work and rendering live in sibling modules (`actions`, `ui`).
//!
//! The TUI has three tabs (Installed / Registry / Updates) and a single
//! modal slot for confirmations and detail/help overlays. Most state is
//! shaped as [`Loadable<T>`] so the renderer can show a spinner while a
//! background task is in flight without juggling separate flags.

use std::collections::HashMap;

use crate::modules::cli_ext::{
    focus_for_subcommand, InitialFocus, InstalledRow, RegistryEntry, UpdateRow,
};
use crate::modules::extensions::install::{InstallOutcome, InstallPhase};

use super::input::Input;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tab {
    Installed,
    Registry,
    Updates,
}

impl Tab {
    pub fn label(self) -> &'static str {
        match self {
            Tab::Installed => "Installed",
            Tab::Registry => "Registry",
            Tab::Updates => "Updates",
        }
    }

    pub fn next(self) -> Self {
        match self {
            Tab::Installed => Tab::Registry,
            Tab::Registry => Tab::Updates,
            Tab::Updates => Tab::Installed,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Tab::Installed => Tab::Updates,
            Tab::Registry => Tab::Installed,
            Tab::Updates => Tab::Registry,
        }
    }
}

/// Generic "loading" wrapper. `Idle` is the pre-load state; `Loading` shows
/// the spinner; `Loaded` carries data; `Error` carries the failure message.
#[derive(Debug, Clone)]
pub enum Loadable<T> {
    Idle,
    Loading,
    Loaded(T),
    Error(String),
}

impl<T> Loadable<T> {
    pub fn is_idle(&self) -> bool {
        matches!(self, Loadable::Idle)
    }
    #[allow(dead_code)]
    pub fn is_loading(&self) -> bool {
        matches!(self, Loadable::Loading)
    }
}

/// Registry rows flattened across "official" / "unofficial". Group label
/// is kept so the list can render a header above each group.
#[derive(Debug, Clone)]
pub struct RegistryFlat {
    pub group: &'static str,
    pub entry: RegistryEntry,
}

#[derive(Debug, Clone)]
pub struct ProgressView {
    pub phase_text: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    /// (file_index, file_total). `(0, 0)` while download / verify is still
    /// running (extract hasn't started ticking yet).
    pub file_index: usize,
    pub file_total: usize,
    pub current_file: String,
}

impl ProgressView {
    pub fn new() -> Self {
        Self {
            phase_text: "Preparing".into(),
            bytes_done: 0,
            bytes_total: None,
            file_index: 0,
            file_total: 0,
            current_file: String::new(),
        }
    }

    pub fn apply_phase(&mut self, phase: InstallPhase) {
        match phase {
            InstallPhase::Downloading {
                bytes_done,
                bytes_total,
            } => {
                self.phase_text = "Downloading".into();
                self.bytes_done = bytes_done;
                self.bytes_total = bytes_total;
            }
            InstallPhase::Verifying => self.phase_text = "Verifying".into(),
            InstallPhase::Extracting => self.phase_text = "Extracting".into(),
            InstallPhase::Finalizing => self.phase_text = "Finalizing".into(),
            InstallPhase::Done => self.phase_text = "Done".into(),
        }
    }

    pub fn apply_file(&mut self, index: usize, total: usize, path: String) {
        self.file_index = index;
        self.file_total = total;
        self.current_file = path;
    }
}

#[allow(dead_code)] // Toast/Error variants reserved for future use.
#[derive(Debug)]
pub enum Modal {
    Help,
    Detail(InstalledRow),
    InstallConfirm {
        /// What the user typed / what we pre-filled. Editable until they
        /// press Enter.
        input: Input,
        /// `Some` while install is in flight, `None` before the user
        /// confirms.
        progress: Option<ProgressView>,
        /// Set after `InstallDone` arrives so we can show success/error.
        finished: Option<Result<InstalledSummary, String>>,
    },
    UninstallConfirm {
        id: String,
        name: String,
        in_flight: bool,
        finished: Option<Result<(), String>>,
    },
    SetEnabledConfirm {
        id: String,
        on: bool,
        in_flight: bool,
        finished: Option<Result<(), String>>,
    },
    UpdateConfirm {
        id: String,
        from: String,
        to: String,
        source: String,
        progress: Option<ProgressView>,
        finished: Option<Result<InstalledSummary, String>>,
    },
    UpdateAll {
        /// Updates that still need to be applied. Drained head-first.
        queue: Vec<UpdateRow>,
        /// Current item index for display (1-based, snapshot of `total`
        /// at start).
        current: usize,
        total: usize,
        progress: Option<ProgressView>,
        finished: Vec<(String, Result<(), String>)>,
        running: bool,
    },
    Toast(String),
    Error(String),
}

#[derive(Debug, Clone)]
pub struct InstalledSummary {
    pub id: String,
    pub version: String,
}

impl From<&InstallOutcome> for InstalledSummary {
    fn from(o: &InstallOutcome) -> Self {
        Self {
            id: o.manifest.id.clone(),
            version: o.manifest.version.clone(),
        }
    }
}

#[derive(Debug)]
pub struct App {
    pub focus: Tab,
    pub installed: Loadable<Vec<InstalledRow>>,
    pub registry: Loadable<Vec<RegistryFlat>>,
    pub updates: Loadable<Vec<UpdateRow>>,
    pub selection: HashMap<Tab, usize>,
    pub filter: Input,
    pub filtering: bool,
    pub modal: Option<Modal>,
    pub status: Option<String>,
    pub should_quit: bool,
    pub tick: u64,
    /// Set when the TUI was opened from a non-Dashboard subcommand. Used
    /// by `bootstrap_focus` to dispatch the right initial action.
    pub initial: InitialFocus,
}

impl App {
    pub fn new(initial: InitialFocus) -> Self {
        let focus = match &initial {
            InitialFocus::Dashboard => Tab::Installed,
            InitialFocus::Installed => Tab::Installed,
            InitialFocus::Registry => Tab::Registry,
            InitialFocus::InstallPrompt { .. } => Tab::Registry,
            InitialFocus::Updates { .. } => Tab::Updates,
            InitialFocus::UninstallConfirm { .. } => Tab::Installed,
            InitialFocus::SetEnabled { .. } => Tab::Installed,
        };
        Self {
            focus,
            installed: Loadable::Idle,
            registry: Loadable::Idle,
            updates: Loadable::Idle,
            selection: HashMap::new(),
            filter: Input::new(),
            filtering: false,
            modal: None,
            status: None,
            should_quit: false,
            tick: 0,
            initial,
        }
    }

    /// Build an App from raw CLI args. Convenience for callers that have
    /// already extracted the subcommand argv (used by the TUI entry point).
    #[allow(dead_code)]
    pub fn from_args(args: &[String]) -> Self {
        Self::new(focus_for_subcommand(args))
    }

    pub fn set_focus(&mut self, tab: Tab) {
        self.focus = tab;
        // Reset filter on tab switch so a stale "/foo" doesn't apply to a
        // newly-opened tab.
        self.filter.clear();
        self.filtering = false;
    }

    pub fn cursor(&self) -> usize {
        *self.selection.get(&self.focus).unwrap_or(&0)
    }

    pub fn set_cursor(&mut self, idx: usize) {
        self.selection.insert(self.focus, idx);
    }

    /// Length of the currently-displayed (post-filter) list.
    pub fn current_len(&self) -> usize {
        match self.focus {
            Tab::Installed => match &self.installed {
                Loadable::Loaded(v) => self.filtered_installed_indices(v).len(),
                _ => 0,
            },
            Tab::Registry => match &self.registry {
                Loadable::Loaded(v) => self.filtered_registry_indices(v).len(),
                _ => 0,
            },
            Tab::Updates => match &self.updates {
                Loadable::Loaded(v) => self.filtered_updates_indices(v).len(),
                _ => 0,
            },
        }
    }

    pub fn move_cursor(&mut self, delta: isize) {
        let len = self.current_len();
        if len == 0 {
            self.set_cursor(0);
            return;
        }
        let cur = self.cursor() as isize;
        let next = (cur + delta).clamp(0, (len - 1) as isize) as usize;
        self.set_cursor(next);
    }

    pub fn jump_top(&mut self) {
        self.set_cursor(0);
    }

    pub fn jump_bottom(&mut self) {
        let len = self.current_len();
        if len > 0 {
            self.set_cursor(len - 1);
        }
    }

    /// Filter helpers — return the original indices that survive the
    /// filter (case-insensitive substring on id+name+description).
    pub fn filtered_installed_indices(&self, rows: &[InstalledRow]) -> Vec<usize> {
        if self.filter.is_empty() {
            return (0..rows.len()).collect();
        }
        let needle = self.filter.value().to_ascii_lowercase();
        rows.iter()
            .enumerate()
            .filter(|(_, r)| {
                r.id.to_ascii_lowercase().contains(&needle)
                    || r.name.to_ascii_lowercase().contains(&needle)
            })
            .map(|(i, _)| i)
            .collect()
    }

    pub fn filtered_registry_indices(&self, rows: &[RegistryFlat]) -> Vec<usize> {
        if self.filter.is_empty() {
            return (0..rows.len()).collect();
        }
        let needle = self.filter.value().to_ascii_lowercase();
        rows.iter()
            .enumerate()
            .filter(|(_, r)| {
                r.entry.id.to_ascii_lowercase().contains(&needle)
                    || r.entry.publisher.to_ascii_lowercase().contains(&needle)
                    || r.entry.description.to_ascii_lowercase().contains(&needle)
            })
            .map(|(i, _)| i)
            .collect()
    }

    pub fn filtered_updates_indices(&self, rows: &[UpdateRow]) -> Vec<usize> {
        if self.filter.is_empty() {
            return (0..rows.len()).collect();
        }
        let needle = self.filter.value().to_ascii_lowercase();
        rows.iter()
            .enumerate()
            .filter(|(_, r)| r.id.to_ascii_lowercase().contains(&needle))
            .map(|(i, _)| i)
            .collect()
    }

    pub fn close_modal(&mut self) {
        self.modal = None;
    }

    pub fn open_help(&mut self) {
        self.modal = Some(Modal::Help);
    }

    pub fn toast(&mut self, msg: impl Into<String>) {
        self.status = Some(msg.into());
    }
}
