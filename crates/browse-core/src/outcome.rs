//! How a load went.

use serde::{Deserialize, Serialize};

/// How a load went, in the five states a tab indicator can show.
///
/// Ordered by severity so a page with more than one thing wrong reports the
/// worst of them. Deliberately not a boolean pair: "loaded" and "loaded with
/// something missing" are the states a person actually wants to tell apart at
/// a glance, and a browser that only says loading/not-loading makes a page
/// whose scripts all 404'd look exactly like one that worked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PageOutcome {
    /// Nothing has been asked for yet. A new tab, before an address.
    #[default]
    Empty,
    /// Everything the page asked for arrived.
    Loaded,
    /// The document arrived; some subresource did not.
    Partial,
    /// The document arrived and something in it failed to run.
    Degraded,
    /// The document itself did not arrive.
    Error,
}

impl PageOutcome {
    /// The name the frontend switches on. Stable: it is part of the wire
    /// contract with the chrome, not a debug rendering.
    pub fn name(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Loaded => "loaded",
            Self::Partial => "partial",
            Self::Degraded => "degraded",
            Self::Error => "error",
        }
    }

    /// Fold another observation into this one, keeping the worse.
    ///
    /// A load reports many things as it proceeds — a missing stylesheet, then
    /// a script that threw — and the tab shows one state. Taking the maximum
    /// means the order the observations arrive in cannot change the answer,
    /// which is exactly the property a running load needs.
    pub fn worse_of(self, other: Self) -> Self {
        self.max(other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_folds_regardless_of_arrival_order() {
        let a = PageOutcome::Loaded
            .worse_of(PageOutcome::Partial)
            .worse_of(PageOutcome::Degraded);
        let b = PageOutcome::Degraded
            .worse_of(PageOutcome::Loaded)
            .worse_of(PageOutcome::Partial);
        assert_eq!(a, b);
        assert_eq!(a, PageOutcome::Degraded);
    }

    #[test]
    fn an_error_beats_everything_below_it() {
        assert_eq!(
            PageOutcome::Error.worse_of(PageOutcome::Loaded),
            PageOutcome::Error
        );
    }

    /// The frontend switches on these. Renaming one silently breaks a status
    /// dot rather than failing a build, so they are pinned here.
    #[test]
    fn the_wire_names_are_fixed() {
        assert_eq!(PageOutcome::Empty.name(), "empty");
        assert_eq!(PageOutcome::Loaded.name(), "loaded");
        assert_eq!(PageOutcome::Partial.name(), "partial");
        assert_eq!(PageOutcome::Degraded.name(), "degraded");
        assert_eq!(PageOutcome::Error.name(), "error");
    }
}
