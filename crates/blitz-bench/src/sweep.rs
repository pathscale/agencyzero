//! Click every button and check that it did what it says.
//!
//! # Why this exists
//!
//! The audit next door measures what a control *shows*. That is not what a
//! button is for. A `Delete` that paints perfectly and deletes nothing is a
//! working picture of a broken feature, and the owner asked, correctly and more
//! than once, for the thing that presses them.
//!
//! So this presses them. Against a throwaway profile, so a destructive control
//! is safe to try: `AZ_DATA_DIR` points the store at a temporary directory that
//! is deleted afterwards, which is what makes clicking `Delete` a test rather
//! than an incident.
//!
//! # What an expectation is
//!
//! Every button claims something in its accessible name. `Collapse Items` says
//! a section will collapse; `Delete X` says a row will disappear; `Close X` says
//! a tab will go. Each of those is a statement about the tree *after* the click,
//! and the tree is readable, so each is checkable without knowing anything about
//! the application's internals.
//!
//! The check is deliberately shallow and mechanical: does the control's own
//! promise hold. It does not know what a project is, and it does not need to.
//! That is what lets one rule cover forty buttons and keep covering them when
//! forty-one appear.

use blitz_control_protocol::SemanticNode;

/// What a button's own name promises will happen when it is pressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expectation {
    /// The button is replaced by its opposite: `Collapse X` becomes `Expand X`.
    ///
    /// The strongest cheap signal available. A disclosure control that does not
    /// swap did not act, and the swap is visible in the tree with no knowledge
    /// of what was disclosed.
    Toggles { into: String },
    /// A named row disappears from the tree.
    Removes { subject: String },
    /// Something new appears: the tree grows.
    Adds,
    /// The tree changes in some way, which is all a generic action promises.
    Changes,
    /// Pressing it must be safe and change nothing observable.
    Inert,
}

/// One button, its promise, and how to recognise it afterwards.
#[derive(Debug, Clone)]
pub struct Case {
    pub id: u64,
    pub name: String,
    pub family: &'static str,
    pub expect: Expectation,
}

/// What the tree should look like after the click, from the button's name.
///
/// Derived rather than configured. A table of button-name-to-behaviour would be
/// another thing to keep in step with the application, and the day it drifts is
/// the day the sweep starts lying; the accessible name is already the contract
/// and is already asserted by the accessibility layer.
pub fn expectation_for(name: &str) -> Expectation {
    let lower = name.to_lowercase();

    /*
     * Disclosure pairs, which name their own inverse.
     *
     * Built from the *original* name, not the lowercased one: the comparison
     * downstream is case-insensitive, but a subject taken from `lower` and
     * pasted after a capitalised verb produces a string that matches nothing
     * and reports every working toggle as broken.
     */
    for (from, to) in [("collapse ", "Expand "), ("expand ", "Collapse ")] {
        if lower.starts_with(from) {
            let subject = &name[from.len()..];
            return Expectation::Toggles {
                into: format!("{to}{subject}"),
            };
        }
    }
    if lower.starts_with("hide ") {
        return Expectation::Changes;
    }

    // Destructive controls name their subject: "Delete Foo", "Close Foo".
    for prefix in ["delete ", "close ", "retire ", "remove "] {
        if let Some(subject) = lower.strip_prefix(prefix) {
            return Expectation::Removes {
                subject: subject.to_owned(),
            };
        }
    }

    if lower.starts_with("add ") || lower.starts_with("new ") || lower.contains("create") {
        return Expectation::Adds;
    }

    // A copy control writes to the clipboard and must not disturb the document.
    if lower.starts_with("copy") {
        return Expectation::Inert;
    }

    /*
     * A re-fetch is allowed to find nothing new.
     *
     * `Refresh` and `Re-check` ask the backend for a status they already have.
     * Both were reported dead for weeks on "nothing in the tree changed", and
     * both are fine: driven against a running build, `Re-check` sends
     * `list_agent_status` (417ms) and `Refresh` sends `get_agent_proxy_status`
     * (2ms). Nothing moved because nothing had changed since the last fetch,
     * which is the correct outcome, not a dead button.
     *
     * `Changes` cannot express that, so these are `Inert`: the weaker claim
     * that pressing them does not corrupt the document. Catching a re-fetch
     * that silently fails needs the backend call itself asserted, which this
     * harness reads no channel for.
     */
    if lower == "refresh" || lower == "re-check" || lower == "recheck" {
        return Expectation::Inert;
    }

    Expectation::Changes
}

/// Buttons worth clicking, in the order they appear.
///
/// Only visible, enabled, named buttons with a box: a control the owner cannot
/// reach is not one whose behaviour can be asserted, and pressing it would test
/// the harness rather than the application.
pub fn cases(
    nodes: &[SemanticNode],
    family: Option<&str>,
    family_of: impl Fn(&str) -> &'static str,
) -> Vec<Case> {
    nodes
        .iter()
        .filter(|node| node.role == "button" && node.visible && node.enabled)
        .filter(|node| !node.name.trim().is_empty())
        .filter(|node| node.bounds.is_some_and(|b| b[2] > 0.0 && b[3] > 0.0))
        .map(|node| {
            let family_name = family_of(&node.name);
            Case {
                id: node.id,
                name: node.name.clone(),
                family: family_name,
                expect: expectation_for(&node.name),
            }
        })
        .filter(|case| family.is_none_or(|want| case.family == want))
        .collect()
}

/// Whether a button of this name exists in the tree.
pub fn has_button(nodes: &[SemanticNode], name: &str) -> bool {
    let wanted = name.to_lowercase();
    nodes
        .iter()
        .any(|node| node.role == "button" && node.name.to_lowercase() == wanted)
}

/// The result of pressing one button.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub case: Case,
    /// `None` when the button did what it promised.
    pub failure: Option<String>,
}

/// Judge one click from the trees either side of it.
pub fn judge(case: &Case, before: &[SemanticNode], after: &[SemanticNode]) -> Option<String> {
    match &case.expect {
        Expectation::Toggles { into } => {
            if has_button(after, into) {
                None
            } else if has_button(after, &case.name) {
                Some(format!("still reads {:?}; it did not toggle", case.name))
            } else {
                Some(format!(
                    "neither {:?} nor {into:?} is present now",
                    case.name
                ))
            }
        }
        Expectation::Removes { subject } => {
            /*
             * A confirmation is the control working, not failing.
             *
             * `Delete` on a project row does not delete: it swaps the row for
             * an inline "Delete? Delete Cancel", and the row is still there
             * until the second press. Judging only on the row's absence called
             * every one of those broken - six of them in one run - when the
             * guard is the feature. What the first press promises is that it
             * asks, and that is what is checked.
             */
            if confirmation_appeared(before, after) {
                return None;
            }
            // The subject may be named by more than one control, so what is
            // asserted is that *this* button is gone, not every mention of it.
            if has_button(after, &case.name) {
                Some(format!("{:?} is still there; nothing was removed", subject))
            } else {
                None
            }
        }
        Expectation::Adds => {
            if after.len() > before.len() {
                None
            } else {
                Some(format!(
                    "the tree did not grow: {} nodes before, {} after",
                    before.len(),
                    after.len()
                ))
            }
        }
        Expectation::Changes => {
            if tree_fingerprint(before) == tree_fingerprint(after) {
                Some("nothing in the tree changed".to_owned())
            } else {
                None
            }
        }
        Expectation::Inert => {
            /*
             * Its own "Copied" feedback is not a document change.
             *
             * A copy control flips a label or shows a tick for a second, which
             * is the only way the owner knows it worked. Once visibility joined
             * the fingerprint - needed to catch controls that only reveal
             * something - that feedback started reading as a violation, and
             * every `Copy` in the app was reported for mutating the document
             * while the node count was identical either side.
             *
             * What `Inert` is actually for is a copy that adds, removes or
             * disables something, so that is what is checked.
             */
            /*
             * Counted, not diffed, and only for the controls.
             *
             * A running app's tree drifts on its own - it grew by a hundred
             * nodes between two reads here with nothing pressed, which is the
             * degradation this harness has open as a separate bug - so any
             * exact before/after comparison reports every `Copy` in the app for
             * mutating the document. What `Inert` is for is a copy that adds,
             * removes or disables a control, and that survives the drift.
             */
            let controls = |nodes: &[SemanticNode]| {
                let mut rows: Vec<(String, bool)> = nodes
                    .iter()
                    .filter(|node| node.role == "button")
                    .map(|node| (node.name.clone(), node.enabled))
                    .collect();
                rows.sort();
                rows
            };
            if controls(before) == controls(after) {
                None
            } else {
                Some("a control appeared, vanished or changed state; this should only copy".to_owned())
            }
        }
    }
}

/// Whether the click put a confirmation in front of the user.
///
/// Recognised by a `Cancel` that was not there before: a guarded action offers
/// a way out, and an ordinary re-render does not grow one. Deliberately narrow,
/// because treating any new control as a confirmation would excuse a `Delete`
/// that merely redrew its own row.
fn confirmation_appeared(before: &[SemanticNode], after: &[SemanticNode]) -> bool {
    let cancels = |nodes: &[SemanticNode]| {
        nodes
            .iter()
            .filter(|node| {
                let lower = node.name.to_lowercase();
                lower == "cancel" || lower.ends_with("cancel") || lower.contains("delete?")
            })
            .count()
    };
    cancels(after) > cancels(before)
}

/// A cheap summary of the tree, for "did anything happen".
///
/// Names and roles rather than geometry: a hover highlight or a scroll moves
/// boxes without the application having done anything, and counting that as a
/// change would make every button appear to work.
///
/// Visibility is in the summary because plenty of controls do nothing else. The
/// rename pencil swaps a `hidden` class on two already-mounted spans, and with
/// visibility left out this said "nothing in the tree changed" whether the
/// editor opened or not - it could not have caught the bug it was pointed at.
fn tree_fingerprint(nodes: &[SemanticNode]) -> Vec<(String, String, bool, bool)> {
    nodes
        .iter()
        .map(|node| {
            (
                node.role.clone(),
                node.name.clone(),
                node.enabled,
                node.visible,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button(name: &str) -> SemanticNode {
        SemanticNode {
            id: 0,
            parent: None,
            role: "button".to_owned(),
            name: name.to_owned(),
            value: None,
            enabled: true,
            visible: true,
            selected: false,
            bounds: Some([0.0, 0.0, 10.0, 10.0]),
        }
    }

    #[test]
    fn a_delete_that_asks_first_has_done_its_job() {
        // The real shape from a running Home: the row grows an inline
        // "Delete? Delete Cancel" and the project stays until it is confirmed.
        let case = Case {
            id: 1,
            name: "Delete e".to_owned(),
            family: "delete",
            expect: expectation_for("Delete e"),
        };
        let before = vec![button("Delete e"), button("Rename e")];
        let after = vec![
            button("Delete e"),
            button("Rename e"),
            button("Cancel"),
        ];
        assert_eq!(judge(&case, &before, &after), None);
    }

    #[test]
    fn a_control_that_only_reveals_something_counts_as_acting() {
        /*
         * The rename pencil's whole effect. Nothing is added, removed, renamed
         * or disabled: one already-mounted span stops being hidden and another
         * starts. With visibility out of the fingerprint this read as "nothing
         * in the tree changed" whether the editor opened or not.
         */
        let case = Case {
            id: 1,
            name: "Rename e".to_owned(),
            family: "edit",
            expect: expectation_for("Rename e"),
        };
        let mut field = button("Project name");
        field.role = "textbox".to_owned();
        field.visible = false;
        let before = vec![button("Rename e"), field.clone()];

        let mut revealed = field;
        revealed.visible = true;
        let after = vec![button("Rename e"), revealed];

        assert_eq!(judge(&case, &before, &after), None);
        // And the failing case the app actually shows: nothing moves at all.
        assert!(judge(&case, &before, &before).is_some());
    }

    #[test]
    fn a_delete_that_does_nothing_at_all_still_fails() {
        let case = Case {
            id: 1,
            name: "Delete e".to_owned(),
            family: "delete",
            expect: expectation_for("Delete e"),
        };
        let before = vec![button("Delete e"), button("Rename e")];
        assert!(judge(&case, &before, &before).is_some());
    }

    #[test]
    fn a_refetch_that_finds_nothing_new_is_not_a_dead_button() {
        // Both were reported dead for weeks on "nothing in the tree changed",
        // and both are fine: driven against a running build, `Re-check` sends
        // `list_agent_status` and `Refresh` sends `get_agent_proxy_status`.
        // Nothing moved because nothing had changed since the last fetch.
        for name in ["Refresh", "Re-check"] {
            let case = Case {
                id: 1,
                name: name.to_owned(),
                family: "other",
                expect: expectation_for(name),
            };
            let tree = vec![button(name), button("Default agent")];
            assert!(
                judge(&case, &tree, &tree).is_none(),
                "{name} should be allowed to leave the tree alone"
            );
        }
    }

    #[test]
    fn a_refresh_that_wrecks_the_document_still_fails() {
        // `Inert` is a weaker claim than `Changes`, not no claim at all: the
        // re-fetch may find nothing, but it may not tear down the surface.
        let case = Case {
            id: 1,
            name: "Refresh".to_owned(),
            family: "other",
            expect: expectation_for("Refresh"),
        };
        let before = vec![button("Refresh"), button("Default agent")];
        let after = vec![button("Refresh")];
        assert!(judge(&case, &before, &after).is_some());
    }
}
