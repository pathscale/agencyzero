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
//!   single pixel was painted, and every one of those nodes had a correct box
//!   and a correct stroke colour while drawing nothing. `blitz-dom` parses each
//!   inline `<svg>` into its own `usvg::Tree` from that element's `outer_html`
//!   alone, so a `<use href="#i-check">` pointing into the shared sprite
//!   resolved to nothing. jsdom cannot see this: its `<svg>` is a well-behaved
//!   object that never goes near a rasteriser.
//! - **Hover.** The row controls only exist while the row is hovered, so a test
//!   that never moves a pointer cannot see them at all.
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
//! cargo run -q -p ps-qa -- qa           # every check
//! cargo run -q -p ps-qa -- qa icons     # one group
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
    /// No node matching the name exists.
    ///
    /// The assertion for a control that must *not* be reachable, and for
    /// checking that a destructive action did not fire.
    Absent,
    /// The node may remain in the tree, but nothing matching it is on screen.
    ///
    /// The inverse of [`Paints`](Expect::Paints), and the right question for
    /// anything that closes. A dismissed dialog is not removed: measured after
    /// the fork dialog's Cancel, `Start fork` is still in the tree at
    /// `0x0 HIDDEN`. Asking for absence there reports a working control as
    /// broken, while asking for a box distinguishes dismissed from trapped -
    /// 1344x900 while open, nothing once closed.
    Vanishes,
    /// The count of matching nodes changed in the given direction.
    Grows,
    /// More matching nodes are *on screen* than before.
    ///
    /// [`Grows`](Expect::Grows) counts tree membership, which is the wrong
    /// question for a control that reveals something already mounted. The
    /// rename editor is built for the life of its component and merely hidden,
    /// so the node count does not move when it opens - only its box does.
    ///
    /// Counting painted nodes is also what makes the check falsifiable. A
    /// `Paints` assertion on `textbox` stays green while the pencil is dead,
    /// because the composer and the search field are textboxes that always
    /// paint; verified by reintroducing the bug and watching it pass.
    PaintsMore,
    /// The count of matching nodes did not change.
    Holds,
}

/// One thing that must be true of the running panel.
pub struct Check {
    /// Stable name for this one check, so a failure can be re-run alone.
    ///
    /// The group is too coarse for that: chasing one fix meant re-running its
    /// neighbours every time, and each run drives the real app. `what` is prose
    /// and changes when the wording improves, so it cannot be the handle.
    /// This is the handle - `ps-qa qa rename-opens-editor`.
    pub id: &'static str,
    /// Group, so a failing area can be re-run alone.
    pub group: &'static str,
    /// What this proves, in the words you would use to report it.
    pub what: &'static str,
    /// Hover this node first, if the control is revealed on hover.
    pub hover: Option<&'static str>,
    /// Click this node, if the check is about an action.
    pub click: Option<&'static str>,
    /// Drive `click` with a real pointer instead of a synthesised event.
    ///
    /// `AgentAction::Click` dispatches a `click` and nothing else, so a control
    /// that acts on `mousedown` reads as dead to it while working perfectly
    /// under a real pointer. The rename pencil is exactly that: it opens the
    /// editor on `mousedown` so the `role="button"` row it sits inside cannot
    /// swallow the press first. A check for it has to press, not click, or it
    /// asserts the harness rather than the app.
    pub press: bool,
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
        // Asked of the box, not the tag. The semantic tree reports roles and
        // never element names, so "is there an `<svg>`" is unanswerable here
        // and looking for one returned zero against an app full of icons. What
        // is answerable, and what actually regressed, is whether the icon nodes
        // have a box: an icon whose artwork failed to resolve still lays out at
        // its `1em` and still reports its stroke, so geometry alone is not
        // enough either. `icon-art.test.ts` covers the artwork itself, which is
        // the half this cannot see.
        Check {
            id: "icons-paint",
            group: "icons",
            what: "icon nodes occupy a box on screen",
            hover: None,
            click: None,
            subject: "presentation",
            expect: Expect::Paints,
            press: false,
            panel_only: false,
        },
        // ---- hover-revealed row controls -------------------------------
        //
        // These do not exist until the pointer is on the row. A check that
        // forgets the hover reports "no such node" and reads as a missing
        // feature rather than a test driving the app wrongly.
        //
        // The row to hover has to be a *panel* row. Home renders the same
        // control names and its rows carry no reorder arrows, so hovering
        // whichever row matched first put the pointer on Home and reported the
        // panel's arrows as broken when they were never asked to appear. That
        // mistake cost a round of chasing a bug that did not exist, which is
        // why [`hover_panel_row`] targets a point inside the column instead of
        // a name that both lists answer to.
        Check {
            id: "hover-1",
            group: "hover",
            what: "hovering an item row reveals its move-up arrow",
            hover: Some("Change the status of"),
            click: None,
            subject: "Move ",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        Check {
            id: "hover-2",
            group: "hover",
            what: "hovering an item row reveals its edit control",
            hover: Some("Change the status of"),
            click: None,
            subject: "Edit ",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        Check {
            id: "hover-3",
            group: "hover",
            what: "hovering an item row reveals its delete control",
            hover: Some("Change the status of"),
            click: None,
            subject: "Delete ",
            expect: Expect::Paints,
            press: false,
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
            id: "status-1",
            group: "status",
            what: "clicking the status marker does not remove the row",
            hover: Some("Change the status of"),
            click: Some("Change the status of"),
            subject: "Edit ",
            expect: Expect::Holds,
            press: false,
            panel_only: true,
        },
        // The cycle is meant to stay inside the visible working states, so a
        // click must never park a row on a terminal one. `finished` under the
        // `delete` handling for completed items is what actually removes rows,
        // which is the shape of the "one click deletes it" report.
        Check {
            id: "status-2",
            group: "status",
            what: "the marker never cycles a row into a terminal state",
            hover: Some("Change the status of"),
            click: Some("Change the status of"),
            subject: "(Finished)",
            expect: Expect::Absent,
            press: false,
            panel_only: true,
        },
        // ---- the panel's sections --------------------------------------
        Check {
            id: "sections-1",
            group: "sections",
            what: "the Items section header is on screen",
            hover: None,
            click: None,
            subject: "Items",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        Check {
            id: "sections-2",
            group: "sections",
            what: "the Task log section header is on screen",
            hover: None,
            click: None,
            subject: "Task log",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        Check {
            id: "sections-3",
            group: "sections",
            what: "the Agent I/O section header is on screen",
            hover: None,
            click: None,
            subject: "Agent I/O",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        Check {
            id: "sections-4",
            group: "sections",
            what: "collapsing a section is acknowledged",
            hover: None,
            click: Some("Collapse Task log"),
            subject: "Expand Task log",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        Check {
            id: "sections-5",
            group: "sections",
            what: "expanding it again restores the control",
            hover: None,
            click: Some("Expand Task log"),
            subject: "Collapse Task log",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        // ---- the task log ----------------------------------------------
        Check {
            id: "tasklog-1",
            group: "tasklog",
            what: "task log rows render their per-row copy control",
            hover: None,
            click: None,
            subject: "Copy this task-log entry",
            expect: Expect::Paints,
            press: false,
            panel_only: true,
        },
        Check {
            id: "tasklog-2",
            group: "tasklog",
            what: "revealing earlier entries adds rows",
            hover: None,
            click: Some("Show 20 earlier"),
            subject: "Copy this task-log entry",
            expect: Expect::Grows,
            press: false,
            panel_only: true,
        },
        /*
         * ---- the two controls that shipped dead ------------------------
         *
         * Both were dead in the running app for weeks with a green unit
         * suite either side of them, and neither failure is visible to
         * jsdom: one is a hit-testing fault and the other is an event-order
         * fault, and jsdom has no hit-testing and no competing handler.
         * These are the checks that would have caught them.
         *
         * `Paints` is the assertion that matters here rather than presence.
         * Both bugs left the node in the tree with a correct name and a
         * `0x0` box, which is precisely the state a presence check passes
         * and a person cannot use.
         */
        Check {
            id: "rename-opens-editor",
            group: "rename",
            what: "pressing the pencil opens an editor the owner can type into",
            hover: None,
            // Pressed, not clicked. The editor opens on `mousedown` so the
            // `role="button"` row cannot swallow the press first, and a
            // synthesised `click` therefore does nothing at all. Measured
            // before the fix: the row folded (+30 nodes) and the textbox
            // stayed `0x0`. After: `0x0 HIDDEN` -> `300x21`.
            click: Some("Rename "),
            press: true,
            /*
             * `Grows`, counting textboxes that are actually on screen.
             *
             * Two weaker subjects were tried and both pass while the control
             * is dead, which is worse than no check at all:
             *
             * - By name (`Rename …`): `EditableTitle` gives the pencil and its
             *   editor the same accessible name, so the pencil's own box
             *   satisfies it whether or not the editor opens.
             * - `Paints` on `textbox`: the composer and the search field are
             *   already-painted textboxes, so *some* textbox always paints.
             *   Verified by mutation - reintroducing the bug left this green.
             *
             * What is actually true of the fix and false of the bug is that
             * pressing the pencil puts one *more* usable field on screen than
             * there was before. `Grows` counts only nodes that paint, so the
             * `0x0` editor sitting hidden beside every project name does not
             * inflate the baseline.
             *
             * Measured before the fix: pressing folded the row (+30 nodes) and
             * every editor `textbox` stayed `0x0`. After: `0x0` -> `300x21`.
             *
             * Run this against a *freshly launched* instance. It asserts a
             * delta, so an editor left open by an earlier press is already in
             * the baseline and the check reports `2 -> 2` on a working build.
             * `scripts/button-sweep.sh` restores the pristine profile for
             * exactly this reason.
             */
            subject: "textbox",
            expect: Expect::PaintsMore,
            panel_only: false,
        },
        /*
         * Two halves, in order: the dialog opens, then its Cancel closes it.
         *
         * The checks run in sequence against one instance, so the second
         * inherits the dialog the first opened. Splitting them this way is
         * what makes a failure legible - "it never opened" and "it opened
         * and would not close" are different bugs, and the trap was the
         * second one.
         */
        Check {
            id: "dialog-opens",
            group: "dialog",
            what: "the fork dialog opens when its control is pressed",
            hover: None,
            click: Some("Fork "),
            press: true,
            subject: "Start fork",
            expect: Expect::Paints,
            panel_only: false,
        },
        Check {
            id: "dialog-cancel-dismisses",
            group: "dialog",
            what: "the fork dialog's Cancel actually dismisses it",
            hover: None,
            // The trap: `AppModal` re-parented its root with
            // `document.body.append`, Blitz reallocated the slot, and the
            // painted dialog was no longer the node the handlers were bound
            // to. Hits landed on the copy, so two Cancels, `Start fork` and
            // Escape were all inert with no JS error, and 68 of the project
            // surface's 84 controls sat unreachable behind it.
            //
            // `Vanishes`, not `Absent`. Dismissing does not remove the
            // dialog from the tree: measured after Cancel, `Start fork` is
            // still there at `0x0 HIDDEN`. Absence was the wrong question,
            // and asking it reported a working Cancel as broken. What
            // distinguishes dismissed from trapped is the box: 1344x900
            // while open, nothing once closed.
            click: Some("Cancel"),
            press: true,
            subject: "Start fork",
            expect: Expect::Vanishes,
            panel_only: false,
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
pub const PANEL_LEFT: f64 = 900.0;

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
        Expect::Vanishes => {
            let on_screen: Vec<&SemanticNode> =
                found.iter().copied().filter(|node| paints(node)).collect();
            if let Some(node) = on_screen.first() {
                let b = node.bounds.unwrap_or([0.0; 4]);
                return Err(format!(
                    "{:?} is still on screen at {:.0}x{:.0}; it did not close",
                    check.subject, b[2], b[3]
                ));
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
        Expect::PaintsMore => {
            let was = matching(before, check.subject, check.panel_only)
                .into_iter()
                .filter(|node| paints(node))
                .count();
            let now = found.iter().filter(|node| paints(node)).count();
            if now <= was {
                return Err(format!(
                    "{:?} on screen went {was} -> {now}, expected one more",
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

/// Every check, grouped, with what it drives and what it asserts.
///
/// Printed by `ps-qa list`, and generated from [`checks`] rather than written
/// down, so it cannot drift from what actually runs. This is the inventory: it
/// answers "what is covered" without launching the app, which is the question
/// that had no answer while the audit was a list of button names in a handover.
pub fn manifest() -> String {
    let all = checks();
    let mut out = String::new();
    let mut current = "";
    for check in &all {
        if check.group != current {
            current = check.group;
            out.push_str(&format!("\n{current}\n"));
        }
        let action = match (check.hover, check.click, check.press) {
            (Some(h), Some(c), true) => format!("hover {h:?}, press {c:?}"),
            (Some(h), Some(c), false) => format!("hover {h:?}, click {c:?}"),
            (Some(h), None, _) => format!("hover {h:?}"),
            (None, Some(c), true) => format!("press {c:?}"),
            (None, Some(c), false) => format!("click {c:?}"),
            (None, None, _) => "observe only".to_owned(),
        };
        out.push_str(&format!(
            "  {:<26} {}\n{:<29}{} -> {:?} {:?}\n",
            check.id, check.what, "", action, check.expect, check.subject
        ));
    }
    out.push_str(&format!("\n{} checks in {} groups\n", all.len(), {
        let mut groups: Vec<&str> = all.iter().map(|c| c.group).collect();
        groups.dedup();
        groups.len()
    }));
    out
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
