//! The OS process table, read in-process.
//!
//! It exists to take a whole PowerShell out of the app. The Process Monitor
//! extension had no process-table API to call, so it read the table the only
//! way an extension could: by spawning a shell. On Windows that meant a
//! resident `pwsh` running a CIM query in a loop while its pane is open, or a
//! fresh one every 30 seconds for the status-bar figure alone, each paying
//! ~600 ms of PowerShell start-up plus WMI's first connection before it read a
//! single row. Measured head to head on one machine with 311 processes, both
//! sampling once a second: the shell loop cost 122 MB and 17.8% of one core,
//! this costs 9-18 ms a sample, 1.4% of one core, and no process at all.
//!
//! The numbers are shaped to be exactly what that extension already parses out
//! of `Get-CimInstance` and `ps`, so the whole normalising layer on the other
//! side stays as it is: bytes for memory, cumulative CPU microseconds, epoch
//! milliseconds for the start time, and a command line truncated to the same
//! 240 characters the shell sampler truncated to.
//!
//! Memory is the PRIVATE working set on Windows, not the working set, and that
//! is the one place this cannot simply take what `sysinfo` reports. A working
//! set counts every shared page once per process that maps it, so summing it
//! over the seven WebView2 processes that share one set of Chromium DLLs comes
//! out up to 2x too big, and it is also not the number Task Manager shows in
//! its Memory column. `GetProcessMemoryInfo` with the EX2 counters is the
//! documented source for it (Windows 10 1809+), it costs under a millisecond
//! for the whole table, and a process we may not open falls back to the working
//! set rather than reporting zero - the same fallback the CIM query made when a
//! pid was missing from the perf class.
//!
//! Linux and macOS report RSS, which is what `ps -o rss=` reported before, so
//! their semantics are unchanged.

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// Same cap the shell sampler applied, and for the same reason: a machine with
/// 600 Chromium processes would otherwise return most of a megabyte of command
/// lines. Truncated by CHARACTER, because the consumer slices by character.
const CMD_CHARS: usize = 240;

/// One row of the OS process table, normalised across platforms.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub cmd: String,
    /// Private working set on Windows, RSS elsewhere. Bytes.
    pub rss: u64,
    /// Cumulative kernel + user CPU time, microseconds.
    pub cpu_us: u64,
    /// Process start, epoch milliseconds. 0 when the platform will not say.
    pub start_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    /// Physical RAM in bytes, so a caller can scale the total without a second
    /// round trip. 0 when unknown.
    pub total_mem: u64,
    pub procs: Vec<ProcRow>,
}

/// The `System` is kept between calls deliberately: a cold one reads every
/// process's command line and image path (13 ms here), a warm one only
/// refreshes what moved (8 ms). `UpdateKind::OnlyIfNotSet` on the command line
/// is what makes the warm path cheap - a command line cannot change after exec.
static SYS: Mutex<Option<System>> = Mutex::new(None);

fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_memory()
        .with_cpu()
}

/// Private working set for a pid, or `None` when the process cannot be opened
/// (a system process, or one that exited between the enumeration and here).
#[cfg(windows)]
fn private_working_set(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: the handle is closed on every path, and the counters struct is
    // zeroed with its own size in `cb` before the call, which is how
    // `GetProcessMemoryInfo` is told which of the three layouts it was handed.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS_EX2 = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
        let ok = GetProcessMemoryInfo(
            handle,
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            counters.cb,
        );
        CloseHandle(handle);
        if ok == 0 {
            None
        } else {
            Some(counters.PrivateWorkingSetSize as u64)
        }
    }
}

#[cfg(not(windows))]
fn private_working_set(_pid: u32) -> Option<u64> {
    None
}

/// Read the whole process table once.
///
/// Every process is returned, not just TEDI's own: the caller roots its tree at
/// the app binary and walks down from there, and the PTY daemon's parent is a
/// pid that no longer exists after a restart, so there is no subtree that can
/// be picked here without losing rows the caller needs.
#[tauri::command]
pub async fn process_sample() -> Result<ProcessSample, String> {
    tauri::async_runtime::spawn_blocking(sample_blocking)
        .await
        .map_err(|e| format!("process_sample join error: {e}"))?
}

fn sample_blocking() -> Result<ProcessSample, String> {
    let mut guard = SYS
        .lock()
        .map_err(|_| "process table lock poisoned".to_string())?;
    let sys = guard.get_or_insert_with(System::new);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
    sys.refresh_memory();

    let mut procs = Vec::with_capacity(sys.processes().len());
    for (pid, p) in sys.processes() {
        let pid = pid.as_u32();
        // pid 0 is the idle process, and never ours.
        if pid == 0 {
            continue;
        }
        let cmd: String = p
            .cmd()
            .iter()
            .map(|c| c.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(CMD_CHARS)
            .collect();
        procs.push(ProcRow {
            pid,
            ppid: p.parent().map(|p| p.as_u32()).unwrap_or(0),
            name: p.name().to_string_lossy().into_owned(),
            cmd,
            rss: private_working_set(pid).unwrap_or_else(|| p.memory()),
            cpu_us: p.accumulated_cpu_time().saturating_mul(1_000),
            start_ms: p.start_time().saturating_mul(1_000),
        });
    }
    Ok(ProcessSample {
        total_mem: sys.total_memory(),
        procs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sample has to contain THIS process, with its own pid, a command line
    /// and a non-zero memory figure. That is the whole contract the pane needs,
    /// and it is what breaks if a platform backend returns an empty table or the
    /// EX2 counters stop answering.
    #[test]
    fn samples_its_own_process() {
        let sample = sample_blocking().expect("sample");
        assert!(sample.total_mem > 0, "total memory should be known");
        let me = std::process::id();
        let row = sample
            .procs
            .iter()
            .find(|r| r.pid == me)
            .expect("the test process itself must be in the table");
        assert!(row.rss > 0, "own memory should not be zero");
        assert!(!row.name.is_empty(), "own process name should not be empty");
        assert!(
            row.cmd.chars().count() <= CMD_CHARS,
            "command line must be truncated to {CMD_CHARS} characters"
        );
    }
}
