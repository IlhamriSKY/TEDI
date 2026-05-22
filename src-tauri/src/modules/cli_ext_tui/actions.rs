//! Async / blocking work backing the TUI. Every entry point spawns its
//! task on tokio's blocking pool (we use sync helpers from `cli_ext`),
//! builds a one-shot current-thread runtime when the work needs HTTP, and
//! pushes progress + outcome through an `mpsc::UnboundedSender<AppMsg>`.
//!
//! The TUI's main loop owns the receiver and translates each `AppMsg`
//! into a state mutation in `App`.

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;

use crate::modules::cli_ext::{
    self, check_updates_only, do_set_enabled, do_uninstall, fetch_registry,
    install_reference_with_progress, load_installed_rows, InstalledRow, UpdateRow,
};
use crate::modules::extensions::install::{InstallOutcome, InstallPhase, InstallProgress};

use super::app::{InstalledSummary, RegistryFlat};

/// Pump for every async or blocking thing the TUI starts. Cloneable so
/// the event handler can hand it off to long-lived modals (UpdateAll).
#[derive(Clone)]
pub struct Bridge {
    pub tx: UnboundedSender<AppMsg>,
}

/// Outcome of a non-install operation that mutates state.json.
#[derive(Debug)]
pub struct UninstallOk {
    pub id: String,
}

#[derive(Debug)]
pub struct SetEnabledOk {
    pub id: String,
    pub on: bool,
}

#[derive(Debug)]
pub enum AppMsg {
    InstalledLoaded(Result<Vec<InstalledRow>, String>),
    RegistryLoaded(Result<Vec<RegistryFlat>, String>),
    UpdatesChecked(Result<Vec<UpdateRow>, String>),
    InstallPhaseUpdate(InstallPhase),
    InstallFileUpdate {
        index: usize,
        total: usize,
        path: String,
    },
    /// Boxed so the variant doesn't dominate the enum's size — `InstallOutcome`
    /// carries a full `Manifest` (~200 bytes), while every other variant is
    /// tiny. Without the Box, every channel slot pays for the largest case.
    InstallDone(Box<Result<InstallOutcome, String>>),
    /// Update flow uses the same install pipeline; surface a distinct
    /// outcome so the UpdateAll modal can keep iterating.
    UpdateOneDone(Result<InstalledSummary, String>),
    UninstallDone(Result<UninstallOk, String>),
    SetEnabledDone(Result<SetEnabledOk, String>),
}

impl Bridge {
    pub fn new(tx: UnboundedSender<AppMsg>) -> Self {
        Self { tx }
    }

    fn send(&self, msg: AppMsg) {
        // Unbounded channel never refuses; only fails if receiver dropped.
        let _ = self.tx.send(msg);
    }

    pub fn load_installed(&self) {
        let tx = self.tx.clone();
        tokio::task::spawn_blocking(move || {
            let _ = tx.send(AppMsg::InstalledLoaded(load_installed_rows()));
        });
    }

    pub fn load_registry(&self) {
        let tx = self.tx.clone();
        tokio::task::spawn_blocking(move || {
            let result = (|| -> Result<Vec<RegistryFlat>, String> {
                let rt = cli_ext::build_runtime()?;
                let doc = fetch_registry(&rt)?;
                let mut flat: Vec<RegistryFlat> = Vec::new();
                for e in doc.official {
                    flat.push(RegistryFlat {
                        group: "official",
                        entry: e,
                    });
                }
                for e in doc.unofficial {
                    flat.push(RegistryFlat {
                        group: "unofficial",
                        entry: e,
                    });
                }
                Ok(flat)
            })();
            let _ = tx.send(AppMsg::RegistryLoaded(result));
        });
    }

    pub fn check_updates(&self, filter: Option<String>) {
        let tx = self.tx.clone();
        tokio::task::spawn_blocking(move || {
            let result = (|| -> Result<Vec<UpdateRow>, String> {
                let rt = cli_ext::build_runtime()?;
                check_updates_only(filter.as_deref(), &rt)
            })();
            let _ = tx.send(AppMsg::UpdatesChecked(result));
        });
    }

    pub fn install(&self, reference: String) {
        let tx = self.tx.clone();
        tokio::task::spawn_blocking(move || {
            let progress = ChannelProgress {
                tx: Arc::new(tx.clone()),
            };
            let result = (|| -> Result<InstallOutcome, String> {
                let rt = cli_ext::build_runtime()?;
                install_reference_with_progress(&reference, &rt, &progress)
            })();
            let _ = tx.send(AppMsg::InstallDone(Box::new(result)));
        });
    }

    /// Apply a single update — the install pipeline does both fresh and
    /// in-place; this just renames the outgoing message variant so the
    /// caller (UpdateAll modal) can iterate.
    pub fn update_one(&self, reference: String) {
        let tx = self.tx.clone();
        tokio::task::spawn_blocking(move || {
            let progress = ChannelProgress {
                tx: Arc::new(tx.clone()),
            };
            let result = (|| -> Result<InstalledSummary, String> {
                let rt = cli_ext::build_runtime()?;
                let outcome = install_reference_with_progress(&reference, &rt, &progress)?;
                Ok((&outcome).into())
            })();
            let _ = tx.send(AppMsg::UpdateOneDone(result));
        });
    }

    pub fn uninstall(&self, id: String) {
        let tx = self.tx.clone();
        tokio::task::spawn_blocking(move || {
            let result = do_uninstall(&id).map(|()| UninstallOk { id });
            let _ = tx.send(AppMsg::UninstallDone(result));
        });
    }

    pub fn set_enabled(&self, id: String, on: bool) {
        let tx = self.tx.clone();
        tokio::task::spawn_blocking(move || {
            let result = do_set_enabled(&id, on).map(|()| SetEnabledOk { id, on });
            let _ = tx.send(AppMsg::SetEnabledDone(result));
        });
    }
}

/// `InstallProgress` impl that forwards every callback into the TUI's
/// message channel. Arc-wrapped sender so spawning install + holding the
/// progress sink doesn't pay for two cloned `UnboundedSender`s per call.
struct ChannelProgress {
    tx: Arc<UnboundedSender<AppMsg>>,
}

impl InstallProgress for ChannelProgress {
    fn phase(&self, phase: InstallPhase) {
        let _ = self.tx.send(AppMsg::InstallPhaseUpdate(phase));
    }
    fn file(&self, index: usize, total: usize, path: &str) {
        let _ = self.tx.send(AppMsg::InstallFileUpdate {
            index,
            total,
            path: path.to_string(),
        });
    }
}

// Eat unused import warning when the Bridge::send helper is dead code.
#[allow(dead_code)]
fn _keep_bridge_send_referenced(b: &Bridge, m: AppMsg) {
    b.send(m);
}
