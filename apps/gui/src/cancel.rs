//! Cancellation that is waited on, never polled.
//!
//! # Why this exists
//!
//! The run loop's stop signal was a `tokio::sync::watch::Sender<bool>`, waited
//! on as `cancel.changed()`. Moving to Nagoya loses that: Nagoya's [`Cancel`]
//! is an `Arc<AtomicBool>` with `is_cancelled()`, which is a *poll*. Asking a
//! loop to check a flag is a worse design than letting it sleep until the flag
//! moves: it either burns a core spinning or it adds latency equal to whatever
//! interval it settles for, and it is the kind of thing that looks fine on an
//! idle machine and shows up as a hot core on a busy one.
//!
//! So the state and the wake are kept as one object. The flag answers "is it
//! cancelled" for free, and [`Cancelled`] is a real future: it registers a
//! waker with `nagoya::sync::Notify` and is woken by [`Cancel::cancel`]. No
//! interval, no spin, no wakeup that is not a cancellation.
//!
//! # Why not just `Notify`
//!
//! A bare `Notify` loses the answer once the wake is consumed, so a task that
//! arrives after cancellation waits forever for a signal that already fired.
//! The `AtomicBool` is what makes this edge-triggered *and* level-readable:
//! [`Cancelled`] checks the flag before it ever registers, so cancelling then
//! awaiting is the same as awaiting then cancelling. `notify_waiters` wakes
//! every current waiter rather than one, because a stop is a broadcast.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};

use nagoya::sync::Notify;

/// The shared half: the flag and the wake queue that belong to one run.
#[derive(Debug)]
struct Inner {
    stopped: AtomicBool,
    wake: Notify,
}

/// A cancellation switch, cloneable and cheap.
///
/// Clones share one flag, so any holder can stop the run and every waiter
/// observes it. This replaces a `watch::Sender<bool>` and its receivers both:
/// `watch` distinguishes the two ends, and nothing here needs that.
#[derive(Clone, Debug)]
pub struct Cancel(Arc<Inner>);

impl Cancel {
    /// A switch that has not been thrown.
    #[must_use]
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            stopped: AtomicBool::new(false),
            wake: Notify::new(),
        }))
    }

    /// Stop the run, waking everything waiting on it.
    ///
    /// Idempotent, and safe to call from inside a task this cancels. The store
    /// is `Release` and [`Cancelled`]'s load is `Acquire`, so a waiter that
    /// observes the flag also observes whatever the canceller wrote first.
    pub fn cancel(&self) {
        // Already stopped: the waiters were woken by whoever got here first,
        // and waking them again would be a spurious wake for no state change.
        if self.0.stopped.swap(true, Ordering::Release) {
            return;
        }
        // Every waiter, not one. A stop is a broadcast: a run with a reader and
        // a supervisor both parked on it must not leave one of them asleep.
        self.0.wake.notify_waiters();
    }

    /// Whether the switch has been thrown, without waiting.
    ///
    /// For the branch that has already been woken and needs to know *why*, not
    /// for a loop to call on an interval. Use [`Self::cancelled`] to wait.
    ///
    /// Kept even with no caller in the tree: being level-readable as well as
    /// awaitable is the property that separates this from a bare `Notify`, and
    /// the tests assert it. A future caller that has a `Cancel` in hand and
    /// needs the answer without awaiting should reach for this rather than
    /// inventing a second flag beside it.
    #[allow(dead_code, reason = "part of the primitive's contract; see above")]
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.stopped.load(Ordering::Acquire)
    }

    /// A future that completes when, and only when, the run is cancelled.
    ///
    /// Resolves immediately if it already was, so there is no race between
    /// cancelling and starting to wait.
    #[must_use]
    pub fn cancelled(&self) -> Cancelled<'_> {
        Cancelled {
            inner: &self.0,
            waiting: None,
        }
    }
}

impl Default for Cancel {
    fn default() -> Self {
        Self::new()
    }
}

/// A one-shot latch: something happened, and it stays happened.
///
/// # Why this is not a channel
///
/// The run loop used `mpsc::unbounded_channel::<()>()` for three of these. A
/// queue whose payload is `()` carries no data: it allocates a node, takes a
/// lock and wakes a task to transmit one bit that a single atomic already
/// holds. Worse, a queue is *consuming*: `recv()` takes the message, so two
/// `select!` arms waiting on the same failure race, and only one of them ever
/// learns about it. `injection_failure` is awaited from two different loops
/// for exactly that reason.
///
/// A latch is level-triggered. Once [`Latch::set`] runs, every waiter past and
/// future completes, in any order, as many times as they ask. That is the real
/// semantic: "this run's injection failed" is a fact about the run, not a
/// message that one observer can take off a queue and hide from the others.
///
/// Identical machinery to [`Cancel`] and deliberately a separate type: a stop
/// and a failure read the same way but mean different things, and naming them
/// apart keeps a `select!` arm honest about which it is waiting for.
#[derive(Clone, Debug)]
pub struct Latch(Arc<Inner>);

impl Latch {
    /// A latch that has not fired.
    #[must_use]
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            stopped: AtomicBool::new(false),
            wake: Notify::new(),
        }))
    }

    /// Record that it happened, waking every waiter. Idempotent.
    pub fn set(&self) {
        if self.0.stopped.swap(true, Ordering::Release) {
            return;
        }
        self.0.wake.notify_waiters();
    }

    /// Whether it has happened, without waiting.
    ///
    /// Kept for the same reason as [`Cancel::is_cancelled`]: level-readable as
    /// well as awaitable is what makes this safe to observe from two places.
    #[allow(dead_code, reason = "part of the primitive's contract")]
    #[must_use]
    pub fn is_set(&self) -> bool {
        self.0.stopped.load(Ordering::Acquire)
    }

    /// A future that completes when it happens, or at once if it already has.
    #[must_use]
    pub fn waited(&self) -> Cancelled<'_> {
        Cancelled {
            inner: &self.0,
            waiting: None,
        }
    }
}

impl Default for Latch {
    fn default() -> Self {
        Self::new()
    }
}

/// The future returned by [`Cancel::cancelled`].
///
/// Holds no timer and no interval. Its only wake comes from
/// [`Cancel::cancel`], through the waker it registered with `Notify`.
pub struct Cancelled<'a> {
    inner: &'a Inner,
    /// The registered wait, built on first poll. `Notified` borrows the
    /// `Notify`, so it cannot be created until the future is pinned.
    ///
    /// `+ Send` is load bearing: the run loop awaits this from tasks that
    /// cross threads, and a bare `dyn Future` is not `Send` even when the
    /// concrete future is.
    waiting: Option<Pin<Box<dyn Future<Output = ()> + Send + 'a>>>,
}

impl Future for Cancelled<'_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        // The flag first, both on entry and after a wake. Cancelling before
        // anyone waits has to be observable, or a late waiter parks forever.
        if this.inner.stopped.load(Ordering::Acquire) {
            return Poll::Ready(());
        }
        // Register once and keep the same registration across polls: a fresh
        // `notified()` each time would drop the queued waker and could miss
        // the broadcast that arrives between two polls.
        let waiting = this
            .waiting
            .get_or_insert_with(|| Box::pin(this.inner.wake.notified()));
        match waiting.as_mut().poll(context) {
            // Woken. Re-read the flag rather than trusting the wake: a
            // `notify_waiters` this future was not the target of still wakes
            // it, and only the flag says whether the run actually stopped.
            Poll::Ready(()) => {
                this.waiting = None;
                if this.inner.stopped.load(Ordering::Acquire) {
                    Poll::Ready(())
                } else {
                    // Spurious. Re-register and park again; do not spin.
                    let waiting = this
                        .waiting
                        .get_or_insert_with(|| Box::pin(this.inner.wake.notified()));
                    match waiting.as_mut().poll(context) {
                        Poll::Ready(()) => Poll::Ready(()),
                        Poll::Pending => Poll::Pending,
                    }
                }
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    /// The ordinary case: a waiter is parked, and cancelling wakes it.
    #[test]
    fn a_waiter_is_woken_by_a_later_cancel() {
        let cancel = Cancel::new();
        let waker_side = cancel.clone();
        let stop = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            waker_side.cancel();
        });
        nagoya::block_on(async {
            // Completes only because `cancel` fired. Nothing here polls.
            cancel.cancelled().await;
        });
        assert!(cancel.is_cancelled());
        stop.join().expect("waker thread");
    }

    /// The race that a bare `Notify` gets wrong: cancel first, wait second.
    #[test]
    fn cancelling_before_the_wait_is_still_observed() {
        let cancel = Cancel::new();
        cancel.cancel();
        nagoya::block_on(async {
            // Must not hang: the flag is read before any registration.
            cancel.cancelled().await;
        });
        assert!(cancel.is_cancelled());
    }

    /// A stop is a broadcast, so every parked waiter has to wake, not one.
    #[test]
    fn every_waiter_wakes_not_just_one() {
        let cancel = Cancel::new();
        let woken = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let cancel = cancel.clone();
            let woken = woken.clone();
            handles.push(std::thread::spawn(move || {
                nagoya::block_on(async { cancel.cancelled().await });
                woken.fetch_add(1, Ordering::Relaxed);
            }));
        }
        std::thread::sleep(Duration::from_millis(20));
        cancel.cancel();
        for handle in handles {
            handle.join().expect("waiter thread");
        }
        assert_eq!(woken.load(Ordering::Relaxed), 4, "all four waiters woke");
    }

    /// Cancelling twice must not wake anyone a second time, and must not panic.
    #[test]
    fn cancelling_twice_is_idempotent() {
        let cancel = Cancel::new();
        cancel.cancel();
        cancel.cancel();
        assert!(cancel.is_cancelled());
    }

    /// The property a `()` channel cannot give: two observers, both told.
    ///
    /// `injection_failure` is awaited from two different loops. With a queue,
    /// `recv()` consumes, so whichever arm polls first takes the message and
    /// the other waits forever for a failure that already happened.
    #[test]
    fn a_latch_is_observed_by_every_waiter_not_consumed_by_one() {
        let latch = Latch::new();
        latch.set();
        nagoya::block_on(async {
            // Both complete. A channel would hand the single `()` to one.
            latch.waited().await;
            latch.waited().await;
        });
        assert!(latch.is_set());
    }

    /// A latch set after the wait began still wakes what is parked on it.
    #[test]
    fn a_latch_wakes_a_parked_waiter() {
        let latch = Latch::new();
        let firing = latch.clone();
        let fire = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            firing.set();
        });
        nagoya::block_on(async { latch.waited().await });
        assert!(latch.is_set());
        fire.join().expect("firing thread");
    }

    /// Clones share the flag: stopping through one stops the run.
    #[test]
    fn a_clone_stops_the_same_run() {
        let cancel = Cancel::new();
        let clone = cancel.clone();
        clone.cancel();
        assert!(cancel.is_cancelled(), "the clone shares one flag");
    }
}
