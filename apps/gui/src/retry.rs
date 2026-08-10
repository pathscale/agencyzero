//! Shared retry policy for recoverable provider and network operations.
//!
//! Keep attempt count and timing here so each integration does not invent a
//! subtly different sleep loop. Callers still decide which errors are safe to
//! retry; destructive or non-idempotent operations must opt out.

use backon::{BackoffBuilder, ExponentialBuilder};
use std::time::Duration;

pub(crate) const MAX_RECOVERY_RETRIES: usize = 3;

/// Short bounded exponential backoff for interactive operations.
pub(crate) fn interactive_backoff() -> ExponentialBuilder {
    ExponentialBuilder::default()
        .with_min_delay(Duration::from_millis(250))
        .with_max_delay(Duration::from_secs(1))
        .with_max_times(MAX_RECOVERY_RETRIES)
}

/// Return the delay for a persisted one-based retry attempt.
pub(crate) fn interactive_delay(attempt: u32) -> Option<Duration> {
    let index = usize::try_from(attempt.saturating_sub(1)).ok()?;
    interactive_backoff().build().nth(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interactive_policy_is_bounded_exponential_backoff() {
        assert_eq!(interactive_delay(1), Some(Duration::from_millis(250)));
        assert_eq!(interactive_delay(2), Some(Duration::from_millis(500)));
        assert_eq!(interactive_delay(3), Some(Duration::from_secs(1)));
        assert_eq!(interactive_delay(4), None);
    }
}
