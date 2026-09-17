//! The threads az's own synchronous work runs on.
//!
//! # Why az owns a pool at all
//!
//! Several reads here are cheap and synchronous, and every one of them was
//! written as `tokio::task::spawn_blocking` for a measured reason recorded at
//! [`crate::projects::list_item_rows`]: running them as a plain `async fn` put
//! them on Tauri's async workers, where the slow network commands already live,
//! and `list_items` went from 10.8ms to 52.5ms because a store read started
//! queueing behind a quota call that has been seen to take five seconds.
//!
//! `spawn_blocking` fixed that by moving the work somewhere else. What it did
//! not fix is *whose* somewhere else. Tokio's blocking pool is process-wide and
//! implicit: az does not size it, does not name its threads, cannot tell its
//! work apart from a dependency's on a stack trace, and has nothing to shut
//! down at exit. It is the ambient runtime in another costume, and finding it
//! by calling a free function is precisely the shape this port is removing.
//!
//! So az owns one. The work is the same work; the difference is that the pool
//! is a field on [`crate::AppState`], sized here, named here, and stopped on
//! the same drain every exit path already shares.
//!
//! # Why not `nagoya::runtime::background()`
//!
//! Nagoya ships a shared pool started on first use. It is honest about being
//! the same shape as tokio's global and about why it exists: so that five
//! library crates in one process do not start five pools. That reasoning is
//! about *libraries*. az is the binary. It is the one component that knows how
//! many threads the machine should give this app and when the app is exiting,
//! and a binary reaching for the convenience global gives away both.
//!
//! # Why `Drop` is not the shutdown
//!
//! Nagoya's `Runtime` detaches its threads when dropped, deliberately: the
//! tasks on it are the ones nobody is watching, and tearing them down under a
//! running sweep is worse than letting them finish. That makes drop the wrong
//! shutdown here and an explicit [`Pool::stop`] the right one, called from
//! the persistence drain, after the last read that could still be in flight.

use nagoya::runtime::Runtime;

/// A pool for work that finishes rather than work that waits.
///
/// Everything submitted here is a synchronous unit with no suspension point: a
/// WorkTable select, a transcript parse, a mutex read. It occupies one worker
/// start to finish and hands back an answer.
///
/// That is what bounds the size. A pool for futures wants a thread per core; a
/// pool that also absorbs blocking wants tokio's 512, because it cannot know
/// how long a unit holds its thread. This one can: the long unit is a chat
/// transcript scan, which happens once per Import click, and the short unit is
/// a store read measured in milliseconds. Concurrency here is single digits,
/// so a worker per core leaves a read able to start immediately even while a
/// scan is running, without dedicating hundreds of stacks to proving it.
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

    /// Run `work` on the pool and wait for what it returns.
    ///
    /// The error is a cancellation, not a failure of `work`: nagoya propagates
    /// a panic to whoever awaits the handle, so a closure that panics unwinds
    /// here rather than arriving as a string. Nothing in az cancels one of
    /// these, which is why the message says so instead of guessing.
    pub async fn run<T, F>(&self, work: F) -> Result<T, String>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        self.runtime
            .spawn(async move { work() })
            .await
            .ok_or_else(|| "the work was cancelled before it produced an answer".to_string())
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
