//! The threads az's own detached work runs on.
//!
//! # What this is not for
//!
//! It is not for a read whose answer a caller needs. Five commands used to
//! hand a synchronous store read to this pool and await the result, and that
//! await was a defect rather than a cost: the caller is a `#[tauri::command]`
//! parked on Tauri's tokio executor while the work finishes on a nagoya
//! worker, so the waker is registered with one executor and woken from the
//! other. A wake lost in that handoff is not a slow command, it is a command
//! that never returns, and the webview promise behind it stays pending for the
//! life of the window. `discover_chat_imports` was dispatched sixteen times in
//! one session and answered seven, the last eight wedged, which left Settings
//! showing "No sessions discovered" while discovery itself worked.
//!
//! Those five are plain synchronous `#[tauri::command]` functions now. Tauri
//! runs those on the invoke thread rather than the async runtime, which is
//! what they wanted in the first place: the measurement at
//! [`crate::projects::list_item_rows`] is about staying off the async workers,
//! where `list_quota` averages over a second, and a synchronous command is
//! never on them. No executor between the caller and the answer means no
//! handoff to lose.
//!
//! # What it is for
//!
//! Work nobody waits for. The run loop's liveness ping and its cliff steers
//! are the cases: each has to happen somewhere other than the task draining
//! provider events, because `control.send` waits for a provider that
//! acknowledges only after emitting a burst of events, and none of them has an
//! answer the loop reads. [`Pool::spawn`] takes those, and it returns nothing
//! precisely so that no caller can reintroduce the await this module exists
//! without.
//!
//! # Why az owns a pool rather than calling `nagoya::runtime::background()`
//!
//! Nagoya ships a shared pool started on first use, and it is honest about
//! being the same shape as tokio's global: it exists so five library crates in
//! one process do not start five pools. That reasoning is about *libraries*.
//! az is the binary. It is the one component that knows how many threads the
//! machine should give this app and when the app is exiting, and a binary
//! reaching for the convenience global gives away both.
//!
//! # Why `Drop` is not the shutdown
//!
//! Nagoya's `Runtime` detaches its threads when dropped, deliberately: the
//! tasks on it are the ones nobody is watching, and tearing them down under a
//! running sweep is worse than letting them finish. That makes drop the wrong
//! shutdown here and an explicit [`Pool::stop`] the right one, called from the
//! persistence drain, after the last send that could still be in flight.

use std::future::Future;
use std::time::Duration;

use nagoya::runtime::Runtime;

/// A pool for work whose answer nobody is waiting for.
///
/// Everything submitted here is detached: a liveness ping, a cliff steer. It
/// is sent from the task that must keep draining provider events, and the
/// sender carries its own failure back rather than returning one, because
/// there is no handle to return it through. See the module for why the
/// answer-returning half of this was a defect and is gone.
///
/// That is what bounds the size. A pool for futures wants a thread per core; a
/// pool that also absorbs blocking wants tokio's 512, because it cannot know
/// how long a unit holds its thread. This one can: what it holds is a provider
/// send waiting on an acknowledgement, and there are a handful per turn, so a
/// worker per core leaves one able to start immediately while another waits,
/// without dedicating hundreds of stacks to proving it.
pub struct Pool {
    runtime: Runtime,
}

impl Pool {
    /// Start the pool, sized to the machine.
    #[must_use]
    pub fn new() -> Self {
        // `available_parallelism` fails on a container with no cpuset visible.
        // Two is the floor rather than one because a single worker turns the
        // pool back into a queue: a transcript scan would hold the only thread
        // and the store read it is supposed to run beside would wait for it.
        let workers = std::thread::available_parallelism().map_or(2, std::num::NonZeroUsize::get);
        Self {
            // `spread`, not the `locality` default. Locality keeps a woken task
            // on the worker that woke it, which is the right answer for tasks
            // that suspend and resume: the cache is already warm there. Nothing
            // submitted here ever wakes, because nothing here ever suspends, so
            // that policy has no work to do and the only scheduling decision
            // left is which worker takes a job handed in from outside. `spread`
            // puts it where any idle worker can take it.
            //
            // Not `throughput`, which is the other outside-submission preset:
            // its eight-job injector batch lets one worker claim a run of jobs
            // its neighbours cannot see. That is a win for a firehose of
            // uniform short jobs and a loss here, where a batch can contain one
            // transcript scan and seven store reads that then wait behind it.
            runtime: Runtime::with_tuning(workers, nagoya::Tuning::spread(), "az"),
        }
    }

    /// Start `work` on the pool and do not wait for it.
    ///
    /// For a send whose answer the caller does not need and must not block
    /// for. The run loop's liveness ping is the case: it has to keep draining
    /// provider events, and awaiting the send fills the bounded event channel
    /// and manufactures the deadlock the ping exists to detect.
    ///
    /// Nothing is returned, so a panic inside `work` is lost rather than
    /// propagated. `work` should carry its own failure back, the way the ping
    /// sets a latch the loop reads.
    ///
    /// This is a future rather than a closure, unlike [`Self::run`]: the point
    /// is work that suspends, where `run`'s point is work that does not.
    pub fn spawn<F>(&self, work: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        // The handle is dropped, which detaches rather than cancels, so the
        // task runs to completion with nobody watching.
        drop(self.runtime.spawn(work));
    }

    /// Stop the workers and let their threads exit.
    ///
    /// Idempotent, and safe to call with work still queued: a worker finishes
    /// the unit it is running before it sees the shutdown. Called from the one
    /// drain every exit path shares, so a read in flight when the window closes
    /// completes rather than vanishing with the process.
    pub fn stop(&self) {
        self.runtime.pool().shut_down();
    }
}

impl Default for Pool {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for Pool {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Pool").finish_non_exhaustive()
    }
}

/// A deadline `duration` from now, on the clock [`nagoya::now_ns`] reads.
///
/// Nagoya has `sleep_until` but no `timeout_at`, so a deadline shared by
/// several awaits is held as an absolute instant here and converted back to
/// what is left of it at each call, by [`remaining`]. That is what
/// `tokio::time::timeout_at` gave: one budget spanning a sequence of steps,
/// rather than a fresh full timeout for each.
#[must_use]
pub fn deadline_in(duration: Duration) -> u64 {
    nagoya::now_ns().saturating_add(u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
}

/// What is left of `deadline`, saturating at zero.
///
/// A deadline already passed returns zero rather than wrapping, and a timeout
/// of zero fires on its first poll, which is the answer a caller past its
/// budget is owed.
#[must_use]
pub fn remaining(deadline: u64) -> Duration {
    Duration::from_nanos(deadline.saturating_sub(nagoya::now_ns()))
}
