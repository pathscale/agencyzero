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
    /// Shared, because [`Signals`] gives three facts one queue: a loop waiting
    /// on all three then parks once rather than holding three registrations.
    /// A `Cancel` built on its own still owns an `Arc` nobody else holds.
    wake: Arc<Notify>,
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
            wake: Arc::new(Notify::new()),
        }))
    }

    /// A switch that rings `wake` rather than a queue of its own.
    ///
    /// For [`Signals`], where three facts share one wake so a loop waiting on
    /// all of them parks once.
    #[must_use]
    fn sharing(wake: &Arc<Notify>) -> Self {
        Self(Arc::new(Inner {
            stopped: AtomicBool::new(false),
            wake: Arc::clone(wake),
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
            wake: Arc::new(Notify::new()),
        }))
    }

    /// A latch that rings `wake` rather than a queue of its own. See
    /// [`Cancel::sharing`].
    #[must_use]
    fn sharing(wake: &Arc<Notify>) -> Self {
        Self(Arc::new(Inner {
            stopped: AtomicBool::new(false),
            wake: Arc::clone(wake),
        }))
    }

    /// Record that it happened, waking every waiter. Idempotent.
    pub fn set(&self) {
        if self.0.stopped.swap(true, Ordering::Release) {
            return;
        }
        self.0.wake.notify_waiters();
    }

    /// A future that completes when it happens, or at once if it already has.
    ///
    /// The run loop reaches for [`Signals::stopped`] or [`Signals::changed`]
    /// instead, which is the point of those: three facts behind one wake. This
    /// stays because it is a latch's defining behaviour and the tests below
    /// assert it - a latch is observed by every waiter rather than consumed by
    /// one, which is the property that makes sharing a wake safe.
    #[allow(dead_code, reason = "the primitive's contract; asserted in tests")]
    #[must_use]
    pub fn waited(&self) -> Cancelled<'_> {
        Cancelled {
            inner: &self.0,
            waiting: None,
        }
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

    /// One wait, woken by whichever of the three fires.
    #[test]
    fn any_signal_wakes_the_single_wait() {
        for which in 0..3 {
            let signals = Signals::new();
            let firing = signals.clone();
            let fire = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                match which {
                    0 => firing.cancel.cancel(),
                    1 => firing.injection_failure.set(),
                    _ => firing.ping_failed.set(),
                }
            });
            // Completes for any of the three, through one registration.
            nagoya::block_on(async { signals.changed(Handled::default()).await });
            assert!(
                signals.pending(Handled::default()),
                "signal {which} was observed"
            );
            fire.join().expect("firing thread");
        }
    }

    /// The race a shared wake must not lose: fire first, wait second.
    #[test]
    fn a_signal_set_before_the_wait_is_still_observed() {
        let signals = Signals::new();
        signals.ping_failed.set();
        // Must not hang: `changed` reads the flags before parking.
        nagoya::block_on(async { signals.changed(Handled::default()).await });
        assert!(signals.ping_failed.is_set());
        assert!(!signals.cancel.is_cancelled(), "only the one that fired");
    }

    /// Two facts arriving together are both readable, not one consumed.
    ///
    /// This is what a queue could not give and why the flags are level
    /// triggered: the loop reads all three on wake and acts on each.
    #[test]
    fn two_signals_are_both_visible() {
        let signals = Signals::new();
        signals.cancel.cancel();
        signals.injection_failure.set();
        nagoya::block_on(async { signals.changed(Handled::default()).await });
        assert!(signals.cancel.is_cancelled());
        assert!(signals.injection_failure.is_set());
        assert!(!signals.ping_failed.is_set());
    }

    /// A handled fact stops waking the caller, so the loop cannot spin.
    ///
    /// `ping_failed` never clears, so once the run loop has noted it and
    /// decided to continue, a wait that still counted it would return
    /// instantly forever.
    #[test]
    fn a_handled_signal_no_longer_wakes_the_wait() {
        let signals = Signals::new();
        signals.ping_failed.set();
        let handled = Handled { ping_failed: true };
        assert!(
            !signals.pending(handled),
            "a handled ping is not a reason to wake"
        );
        // Still true, and still readable by anyone who cares.
        assert!(signals.ping_failed.is_set());
        // A terminal fact still gets through the same filter.
        signals.cancel.cancel();
        assert!(
            signals.pending(handled),
            "cancellation is never handled away"
        );
        nagoya::block_on(async { signals.changed(handled).await });
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

/// The run's three stop-or-retry facts, behind one wake.
///
/// # Why these are one object
///
/// The run loop waited on `cancel`, `injection_failure` and `ping_failed` as
/// three separate `select!` arms. Each is a [`Cancel`] or [`Latch`], which is
/// to say each is an `AtomicBool` that already knows exactly when it changed
/// and a `Notify` that already wakes whoever is parked on it. Putting three
/// such things in a poll set asks the loop to re-poll all three every time any
/// one of them — or a provider event, or a timer — fires.
///
/// So they share a wake instead. "Something wants this loop to stop or retry"
/// is one event; *which* of the three it was is a question the loop answers by
/// reading the flags, which is three `Acquire` loads and no allocation.
///
/// That works only because the flags are level-triggered: a fact that is set
/// stays set, so reading after the wake cannot miss one, and two arriving
/// together are both seen rather than one being consumed. An edge-triggered
/// signal would need a branch per source to avoid losing the second.
///
/// The three keep their own types rather than becoming an enum. `Cancel` and
/// `Latch` mean different things, they are held by different parts of the run,
/// and the places that *set* them should not gain the ability to set the others.
#[derive(Clone, Debug)]
pub struct Signals {
    /// The owner or a teardown path asked this run to stop.
    pub cancel: Cancel,
    /// A mid-turn message could not be delivered into the live turn.
    pub injection_failure: Latch,
    /// A liveness ping could not be delivered, so nothing will answer it.
    pub ping_failed: Latch,
    /// The one queue every fact above rings.
    wake: Arc<Notify>,
}

impl Signals {
    /// Three unset facts sharing one wake.
    #[must_use]
    pub fn new() -> Self {
        let wake = Arc::new(Notify::new());
        Self {
            cancel: Cancel::sharing(&wake),
            injection_failure: Latch::sharing(&wake),
            ping_failed: Latch::sharing(&wake),
            wake,
        }
    }

    /// Two fresh latches joining an existing switch's wake.
    ///
    /// A run's `Cancel` is created by whoever starts the run, because stopping
    /// it is something the outside world does; the two failure latches belong
    /// to the run itself and do not exist until it is under way. This adopts
    /// the caller's switch rather than replacing it, so a stop requested
    /// through the original handle still reaches this loop.
    #[must_use]
    pub fn around(cancel: Cancel) -> Self {
        let wake = Arc::clone(&cancel.0.wake);
        Self {
            injection_failure: Latch::sharing(&wake),
            ping_failed: Latch::sharing(&wake),
            cancel,
            wake,
        }
    }

    /// Whether either fact that *ends a run* has fired.
    ///
    /// `ping_failed` is deliberately not one of them. It says a liveness probe
    /// did not reach the provider, which is a reason for the main loop to stop
    /// expecting an answer, not a reason to abandon whatever is in flight. A
    /// waiter that treated it as terminal would tear down a run that is merely
    /// unmonitored.
    #[must_use]
    pub fn stopping(&self) -> bool {
        self.cancel.is_cancelled() || self.injection_failure.is_set()
    }

    /// Wait until this run is being stopped, by cancellation or a failed
    /// injection.
    ///
    /// The counterpart to [`Self::stopping`], for a wait that must end when the
    /// run ends but has no interest in liveness. It still shares the one wake,
    /// so a `ping_failed` that rings the queue simply re-checks and parks
    /// again rather than waking the caller spuriously.
    pub async fn stopped(&self) {
        loop {
            if self.stopping() {
                return;
            }
            let waiting = self.wake.notified();
            if self.stopping() {
                return;
            }
            waiting.await;
        }
    }

    /// Wait until a fact the caller has not already handled fires.
    ///
    /// Returns as soon as one is set, so a fact that arrived before the wait
    /// began is not missed. The caller then reads the individual flags to learn
    /// which, and may see more than one.
    ///
    /// # Why this takes `handled`
    ///
    /// The flags are level triggered and a [`Latch`] never clears, which is
    /// what makes two simultaneous facts both visible. It also means a fact the
    /// caller has *acted on* and decided not to stop for stays set forever, so
    /// a bare "is anything set" wait would return instantly on every call and
    /// spin the loop at full tilt.
    ///
    /// `ping_failed` is exactly that case: the run loop notes it, clears its
    /// own outstanding-ping state, and carries on. Passing it here afterwards
    /// says "I know, do not wake me for this again", which is the honest way to
    /// say it - clearing the flag would lie to every other reader.
    pub async fn changed(&self, handled: Handled) -> () {
        loop {
            if self.pending(handled) {
                return;
            }
            let waiting = self.wake.notified();
            // Re-check between registering and parking: a fact set in that
            // window has already rung the queue, and without this the loop
            // would park on a wake that has been and gone.
            if self.pending(handled) {
                return;
            }
            waiting.await;
        }
    }

    /// Whether a fact outside `handled` is set.
    #[must_use]
    fn pending(&self, handled: Handled) -> bool {
        if self.cancel.is_cancelled() || self.injection_failure.is_set() {
            return true;
        }
        !handled.ping_failed && self.ping_failed.is_set()
    }
}

/// Facts the caller has already acted on and does not want woken for again.
///
/// Only the non-terminal ones can be named: cancellation and a failed
/// injection end the run, so "I have handled that and wish to continue" is not
/// a thing a caller can mean about them.
#[derive(Clone, Copy, Debug, Default)]
pub struct Handled {
    /// The liveness ping's failure has been noted and the run continues.
    pub ping_failed: bool,
}

impl Default for Signals {
    fn default() -> Self {
        Self::new()
    }
}
