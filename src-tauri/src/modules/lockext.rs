//! Poison-safe lock acquisition for long-lived, unsupervised threads.
//!
//! A `Mutex` is *poisoned* when a thread panics while holding the guard. The
//! default `.lock().unwrap()` then propagates that panic to every later
//! acquirer. On detached pump / reader / fan-out threads (PTY readers, the
//! daemon's per-session sinks, background-command stdout pumps) a poison
//! panic silently kills the stream with no supervisor to restart it.
//!
//! [`LockExt::lock_or_recover`] recovers the inner guard instead
//! (`unwrap_or_else(|e| e.into_inner())`), which is the right call when the
//! protected data is a buffer / map that is fully replaced or simply
//! appended to: a half-finished mutation from a panicking thread is at worst
//! a few stale bytes, far better than a dead output stream.
//!
//! Use this on the hot, unsupervised threads. Where a poisoned lock is a
//! genuine "this invariant is broken, fail fast" signal, keep the plain
//! `.lock()?` / `.unwrap()` instead.
//!
//! Only a `Mutex` flavour exists today because the hot threads use `Mutex`
//! exclusively; add an `RwLock` equivalent here if that ever changes.

use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    /// Acquire the mutex, recovering the guard if the lock was poisoned by a
    /// panicking thread rather than re-panicking.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}
