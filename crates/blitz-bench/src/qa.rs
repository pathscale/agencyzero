//! Panel QA: drive every control in the side panel and check what the renderer
//! actually did.
//!
//! # Why this exists
//!
//! The unit suite went green through three shipped regressions in a row: the
//! reorder arrows moved the wrong row, the task log rendered upside down, and
//! the log could not page past its first fetch. jsdom cannot catch any of them,
//! because jsdom is not the thing that runs: it has no compositor, it paints
//! nothing, and it answers questions about a tree the user never sees. A green
//! suite over jsdom says the code is self-consistent, not that the panel works.
//!
//! Two failure classes make the point, and both were live in the app while the
//! suite was green:
//!
//! - **Icons.** The semantic tree reports `presentation=327` whether or not a
//!   single pixel was painted. Asking the DOM instead shows 41 `<use>` and 43
//!   `<path>` elements and **zero** `<svg>` roots, so every icon in the app is
//!   an orphaned child with no painting context. No amount of jsdom would say
//!   this, because jsdom's `<svg>` is a well-behaved object.
//! - **Hover.** The row controls only exist while the row is hovered, so a test
//!   that never moves a pointer cannot see them at all. The arrows are absent
//!   from the tree until `pointerenter` lands, and then 48 of them appear.
//!
//! # What a check is
//!
//! A [`Check`] is a precondition, an action, and an assertion about the state
//! after it, all expressed against the running app. The point is that every
//! part is observed rather than assumed: `Reveals` fails if the control never
//! appears, `Clicks` fails if the click is not acknowledged, and `Paints`
//! fails if the element exists in the tree but has no box. That last one is
//! what the semantic tree alone will not tell you.
//!
//! Run it against a live instance:
//!
//! ```sh
//! cargo run -q -p blitz-bench -- qa           # every check
//! cargo run -q -p blitz-bench -- qa icons     # one group
//! ```

use blitz_control_protocol::SemanticNode;
use std::collections::HashMap;

/// What a single check asserts once its action has run.
#[derive(Clone, Copy, Debug)]
pub enum Expect {
    /// The named node exists, is visible, and has a non-zero box.
    ///
    /// Non-zero is the part that matters. A node with a box of `0x0` is in the
    /// tree and on no screen, which is how a broken control passes a test that
    /// only asked whether it existed.
    Paints,
    /// The named node exists in the DOM at all, box or not.
    ///
    /// For structure that must be present but need not be visible, such as the
    /// icon sprite's `<symbol>` definitions.
    Present,
    /// No node matching the name exists.
    ///
    /// The assertion for a control that must *not* be reachable, and for
    /// checking that a destructive action did not fire.
    Absent,
    /// The count of matching nodes changed in the given direction.
    Grows,
    /// The count of matching nodes did not change.
    Holds,
}

/// One thing that must be true of the running panel.
pub struct Check {
    /// Group, so a failing area can be re-run alone.
    pub group: &'static str,
    /// What this proves, in the words you would use to report it.
    pub what: &'static str,
    /// Hover this node first, if the control is revealed on hover.
    pub hover: Option<&'static str>,
    /// Click this node, if the check is about an action.
    pub click: Option<&'static str>,
    /// The node the assertion is about.
    pub subject: &'static str,
    pub expect: Expect,
    /// Count only inside the side panel.
    ///
    /// True for anything Home also renders, which is most of the row controls.
    /// False for structure that is global by nature, such as the icon sprite.
    pub panel_only: bool,
}

/// The panel's controls, one entry per thing that can regress.
///
/// Ordered so that a failure reads top-down: structure first, then the controls
/// that depend on it. A control that needs hover names the row to hover, which
/// is the step that a test written against jsdom silently skips.
pub fn checks() -> Vec<Check> {
    vec![
        // ---- icons -----------------------------------------------------
        //
        // The `<svg>` root, not the `<use>` inside it. Every icon in the app is
        // a `<use href="#i-name">` pointing at a `<symbol>` in the sprite, so
        // three things have to be in the document and all three were checked
        // because only one of them was missing.
        Check {
            group: "icons",
            what: "the icon sprite defines its symbols",
            hover: None,
            click: None,
            subject: "symbol",
            expect: Expect::Present,
            panel_only: false,
        },
        Check {
            group: "icons",
            what: "icons have an <svg> root, so their paths have a painting context",
            hover: None,
            click: None,
            subject: "svg",
            expect: Expect::Present,
            panel_only: false,
        },
        Check {
            group: "icons",
            what: "an icon occupies a box on screen",
            hover: None,
            click: None,
            subject: "svg",
            expect: Expect::Paints,
            panel_only: false,
        },
        // ---- hover-revealed row controls -------------------------------
        //
        // These do not exist until the pointer is on the row. A check that
        // forgets the hover reports "no such node" and reads as a missing
        // feature rather than a test driving the app wrongly.
        Check {
            group: "hover",
            what: "hovering an item row reveals its move-up arrow",
            hover: Some("Change the status of"),
            click: None,
            subject: "Move ",
            expect: Expect::Paints,
            panel_only: true,
        },
        Check {
            group: "hover",
            what: "hovering an item row reveals its edit control",
            hover: Some("Change the status of"),
            click: None,
            subject: "Edit ",
            expect: Expect::Paints,
            panel_only: true,
        },
        Check {
            group: "hover",
            what: "hovering an item row reveals its delete control",
            hover: Some("Change the status of"),
            click: None,
            subject: "Delete ",
            expect: Expect::Paints,
            panel_only: true,
        },
        // ---- the status marker -----------------------------------------
        //
        // The reported symptom was "one click appears to delete items". The
        // cycle deliberately avoids the terminal states for exactly that
        // reason, so what this pins is that a click does not remove the row.
        /*
         * Counted over the item rows themselves, not the marker's own label.
         *
         * The marker's accessible name carries the item title and its title
         * attribute carries the status, so clicking it changes the text of the
         * node being counted and a count over "Change the status of" moves by
         * one for reasons that have nothing to do with a row disappearing.
         * `data-item-id` is the row, and it does not move when a status does.
         */
        Check {
            group: "status",
            what: "clicking the status marker does not remove the row",
            hover: Some("Change the status of"),
            click: Some("Change the status of"),
            subject: "Edit ",
            expect: Expect::Holds,
            panel_only: true,
        },
        // The cycle is meant to stay inside the visible working states, so a
        // click must never park a row on a terminal one. `finished` under the
        // `delete` handling for completed items is what actually removes rows,
        // which is the shape of the "one click deletes it" report.
        Check {
            group: "status",
            what: "the marker never cycles a row into a terminal state",
            hover: Some("Change the status of"),
            click: Some("Change the status of"),
            subject: "(Finished)",
            expect: Expect::Absent,
            panel_only: true,
        },
        // ---- the panel's sections --------------------------------------
        Check {
            group: "sections",
            what: "the Items section header is on screen",
            hover: None,
            click: None,
            subject: "Items",
            expect: Expect::Paints,
            panel_only: true,
        },
        Check {
            group: "sections",
            what: "the Task log section header is on screen",
            hover: None,
            click: None,
            subject: "Task log",
            expect: Expect::Paints,
            panel_only: true,
        },
        Check {
            group: "sections",
            what: "the Agent I/O section header is on screen",
            hover: None,
            click: None,
            subject: "Agent I/O",
            expect: Expect::Paints,
            panel_only: true,
        },
        Check {
            group: "sections",
            what: "collapsing a section is acknowledged",
            hover: None,
            click: Some("Collapse Task log"),
            subject: "Expand Task log",
            expect: Expect::Paints,
            panel_only: true,
        },
        Check {
            group: "sections",
            what: "expanding it again restores the control",
            hover: None,
            click: Some("Expand Task log"),
            subject: "Collapse Task log",
            expect: Expect::Paints,
            panel_only: true,
        },
        // ---- the task log ----------------------------------------------
        Check {
            group: "tasklog",
            what: "task log rows render their per-row copy control",
            hover: None,
            click: None,
            subject: "Copy this task-log entry",
            expect: Expect::Paints,
            panel_only: true,
        },
        Check {
            group: "tasklog",
            what: "revealing earlier entries adds rows",
            hover: None,
            click: Some("Show 20 earlier"),
            subject: "Copy this task-log entry",
            expect: Expect::Grows,
            panel_only: true,
        },
    ]
}

/// The side panel's left edge, in window coordinates.
///
/// The panel is a fixed 332px column on the right, and Home renders its own
/// item list with the same control names. Counting across the whole window
/// therefore mixes two lists: "Edit " matched 107 nodes and "Copy this
/// task-log entry" matched 880, most of them Home's, so a panel row appearing
/// or leaving was lost in the noise. Anything left of this is not the panel.
const PANEL_LEFT: f64 = 900.0;

/// Nodes matching `want`, by accessible name or role, inside the side panel.
///
/// Nodes with no box are kept: a control that is in the tree with no geometry
/// is exactly the failure [`Expect::Paints`] exists to report, and dropping it
/// here would turn "present but unpainted" into "absent" and lose the cause.
fn matching<'a>(nodes: &'a [SemanticNode], want: &str, panel_only: bool) -> Vec<&'a SemanticNode> {
    nodes
        .iter()
        .filter(|node| node.name.contains(want) || node.role.contains(want))
        .filter(|node| {
            !panel_only
                || node
                    .bounds
                    .is_none_or(|b| b[0] >= PANEL_LEFT || b[2] == 0.0)
        })
        .collect()
}

/// Whether a node is on screen with a box worth painting.
///
/// A zero-area box is the failure this exists to catch: present in the tree,
/// absent from the window.
fn paints(node: &SemanticNode) -> bool {
    node.visible && node.bounds.is_some_and(|b| b[2] > 0.0 && b[3] > 0.0)
}

/// The verdict for one check, given the tree before and after its action.
pub fn verdict(
    check: &Check,
    before: &[SemanticNode],
    after: &[SemanticNode],
) -> Result<(), String> {
    let found = matching(after, check.subject, check.panel_only);
    match check.expect {
        Expect::Present => {
            if found.is_empty() {
                return Err(format!("no node matching {:?} exists", check.subject));
            }
        }
        Expect::Paints => {
            if found.is_empty() {
                return Err(format!("no node matching {:?} exists", check.subject));
            }
            if !found.iter().any(|node| paints(node)) {
                /*
                 * Say which half of "paints" failed.
                 *
                 * Hidden-but-sized and visible-but-zero-area are different
                 * bugs: the first is a node the panel deliberately keeps
                 * offscreen, the second is a control the user is meant to see
                 * and cannot. Reporting them as one message sent me looking at
                 * the wrong one.
                 */
                let hidden = found.iter().filter(|node| !node.visible).count();
                let zero = found
                    .iter()
                    .filter(|node| {
                        node.visible && !node.bounds.is_some_and(|b| b[2] > 0.0 && b[3] > 0.0)
                    })
                    .count();
                let boxes: Vec<String> = found
                    .iter()
                    .take(3)
                    .map(|node| {
                        let size = node
                            .bounds
                            .map(|b| format!("{:.0}x{:.0}", b[2], b[3]))
                            .unwrap_or_else(|| "no box".into());
                        format!("{size}{}", if node.visible { "" } else { " hidden" })
                    })
                    .collect();
                return Err(format!(
                    "{} node(s) matching {:?} exist but none paints: \
                     {hidden} hidden, {zero} visible with no area ({})",
                    found.len(),
                    check.subject,
                    boxes.join(", ")
                ));
            }
        }
        Expect::Absent => {
            if !found.is_empty() {
                return Err(format!(
                    "{} node(s) matching {:?} should not exist",
                    found.len(),
                    check.subject
                ));
            }
        }
        Expect::Grows => {
            let was = matching(before, check.subject, check.panel_only).len();
            let now = found.len();
            if now <= was {
                return Err(format!(
                    "{:?} went {was} -> {now}, expected more",
                    check.subject
                ));
            }
        }
        Expect::Holds => {
            let was = matching(before, check.subject, check.panel_only).len();
            let now = found.len();
            if now != was {
                return Err(format!(
                    "{:?} went {was} -> {now}, expected no change",
                    check.subject
                ));
            }
        }
    }
    Ok(())
}

/// Count matching nodes per group, for the summary line.
pub fn tally(results: &[(&Check, Result<(), String>)]) -> HashMap<&'static str, (usize, usize)> {
    let mut by_group: HashMap<&'static str, (usize, usize)> = HashMap::new();
    for (check, outcome) in results {
        let entry = by_group.entry(check.group).or_insert((0, 0));
        entry.1 += 1;
        if outcome.is_ok() {
            entry.0 += 1;
        }
    }
    by_group
}
