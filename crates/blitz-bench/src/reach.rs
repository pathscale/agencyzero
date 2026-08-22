//! Getting a control on screen before judging it.
//!
//! # Why this exists
//!
//! The sweep next door plans from one snapshot of whatever surface the app
//! happened to open on, and drops any button whose box is `0x0`. Measured
//! against a real QA profile that is not a detail: 286 buttons in the tree, 64
//! with a box, and 222 quietly discarded. None of the 222 were hidden. They
//! were `Pin project` thirty times over, `Rename <project>` twenty, `Delete
//! <project>` fifteen: the row controls the owner asked to have audited, on a
//! Home surface the sweep never visited.
//!
//! A skip is indistinguishable from a pass in the output, so a run that touched
//! a fifth of the window reported "every button acted". That is the whole bug.
//! Coverage was one screen deep and the report did not say so.
//!
//! # What this does instead
//!
//! Reaching is a first-class step with its own verdict. Before a control is
//! judged it is *brought into view*: its surface is opened, its section is
//! expanded, its row is hovered, and it is scrolled to. Only then is it clicked.
//! If none of that gives it a box it is counted as *unreachable* and printed,
//! rather than dropped, because a control the harness cannot reach is either a
//! real defect or a gap in this file, and both need to be visible.
//!
//! The rule the whole module turns on: **never silently skip.** Every button in
//! the tree ends in exactly one bucket, and the buckets are printed.

use std::collections::HashMap;

use blitz_control_protocol::SemanticNode;

/// A surface the sweep must visit, named by the control that opens it.
///
/// Home is not reachable by a nav button on every build, so it is addressed by
/// the tab strip's own entry, which is always present.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Surface {
    /// Shown in the report.
    pub name: &'static str,
    /// The accessible name of the control that navigates here.
    pub opener: &'static str,
}

/// Every top-level surface, in the order they are swept.
///
/// Home last: it owns the destructive project-row controls, so visiting it
/// before the others would delete the rows those others are reached through.
///
/// Every surface names an opener, including the one the app happens to launch
/// on. An empty opener meant "wherever we already are", which held only until
/// the first control that changed pane: the run pressed one button, navigated,
/// and counted the remaining 169 as vanished.
pub const SURFACES: &[Surface] = &[
    /*
     * Project first, because it is the only surface reached by a gesture on
     * another one's content.
     *
     * Its opener is a double click on a Home row, and Home's rows are exactly
     * what the other surfaces disturb: by the time the sweep had been through
     * Settings and Analytics the row it wanted was folded, scrolled past, or
     * below the fold, and the pane went unswept while the report said only
     * "could not be opened".
     */
    Surface {
        name: "project",
        // Resolved at run time to the first project tab in the strip: the QA
        // profile's names are scrubbed, so there is no fixed string to aim at.
        opener: PROJECT_TAB,
    },
    Surface {
        name: "settings",
        opener: "Settings",
    },
    Surface {
        name: "analytics",
        opener: "Analytics",
    },
    Surface {
        name: "home",
        opener: "Home",
    },
];

/// Stands in for "the first project tab in the strip", resolved when the sweep
/// runs because the profile's project names are scrubbed and vary per profile.
pub const PROJECT_TAB: &str = "\u{0}project-tab";

/// A control that opens a project, either its tab or its row on Home.
///
/// Prefers a tab already in the strip, because activating one is a pane switch
/// rather than a load. A fresh profile has no project tabs open at all - the
/// strip is just `HomeHome` - so the fallback is a project row on Home, which
/// is what the owner clicks to open one.
///
/// A row is recognised by the summary the list renders into its name ("0 open ·
/// 1 turns"), which every row has and no other control does. Matching the
/// scrubbed project name itself is not possible: it differs per profile.
pub fn project_opener(nodes: &[SemanticNode]) -> Option<String> {
    let closes: Vec<String> = nodes
        .iter()
        .filter(|n| n.role == "button" && onscreen(n))
        .filter_map(|n| n.name.strip_prefix("Close ").map(str::to_owned))
        .collect();
    /*
     * A project tab, which is any doubled label that is not one of the three
     * permanent surfaces.
     *
     * This used to filter on `!navigates(name)`, which was correct until
     * `navigates` was taught that project tabs are navigation - after that it
     * excluded every candidate and the project surface could never be opened.
     * The two need different questions: `navigates` asks "does pressing this
     * leave the surface I am sweeping", and this asks "is this the way in".
     */
    let tab = nodes
        .iter()
        .filter(|n| n.role == "button" && onscreen(n))
        .filter(|n| !PERMANENT.contains(&n.name.as_str()))
        .find(|n| {
            doubled(&n.name).is_some_and(|label| !PERMANENT.contains(&label))
                || closes
                    .iter()
                    .any(|subject| n.name == format!("{subject}{subject}"))
        });
    if let Some(tab) = tab {
        return Some(tab.name.clone());
    }
    /*
     * Otherwise a project row on Home, which is what the owner clicks to open
     * one. A fresh profile has no project tabs in the strip at all, so without
     * this the surface is unreachable on exactly the runs that matter.
     *
     * Rows are recognised by the summary the list renders into their name - a
     * working directory, an age, or an open/turn count - because the project
     * names themselves are scrubbed and differ per profile.
     */
    /*
     * Preferring a project that has items in it.
     *
     * The first row on Home has none, and an empty project renders `Items0`,
     * `Running0`, `Task log 0` with every per-item control absent: the panel
     * the owner cares about most was on screen as four empty headers. A row
     * whose summary says "1 open" opens a panel with something in it, so
     * `New item`, `Copy`, `Clear` and the item rows are there to be pressed.
     */
    let rows = || {
        nodes
            .iter()
            .filter(|n| n.role == "button" && onscreen(n))
            .filter(|n| !n.name.starts_with("Close ") && !n.name.starts_with("Rename "))
    };
    let populated = rows().find(|n| {
        n.name
            .split(" open · ")
            .next()
            .and_then(|head| head.rsplit(')').next())
            .and_then(|count| count.trim().rsplit(' ').next())
            .and_then(|count| count.parse::<u32>().ok())
            .is_some_and(|open| open > 0)
    });
    if let Some(row) = populated {
        return Some(row.name.clone());
    }
    rows()
        .find(|n| {
            n.name.contains(" open · ")
                || n.name.contains("no working directory")
                || n.name.contains(" ago")
        })
        .map(|n| n.name.clone())
}

/// The surfaces that are always in the strip and are never "the project".
const PERMANENT: &[&str] = &["Home", "Settings", "Analytics", "HomeHome"];

/// Whether a node is on screen well enough to click.
///
/// Both dimensions, because a control laid out at zero width is one no pointer
/// can land on even though the tree lists a box for it.
pub fn onscreen(node: &SemanticNode) -> bool {
    node.visible && node.bounds.is_some_and(|b| b[2] > 0.0 && b[3] > 0.0)
}

/// Whether pressing this leaves the surface, invalidating the rest of the plan.
///
/// The first repeatable run planned 173 buttons, pressed `Home` as the first of
/// them, and lost the other 169: they were all on the surface it had just
/// navigated away from. A control that changes surface has to be swept last, or
/// it takes the plan with it.
///
/// Matched on the tab-strip and nav entries by name. Deliberately a small,
/// explicit list rather than a guess about which names look like navigation:
/// over-matching here silently drops controls from the sweep, which is the
/// failure this whole module exists to end.
pub fn navigates(name: &str) -> bool {
    const NAV: &[&str] = &["Home", "Settings", "Analytics"];
    if NAV.iter().any(|entry| {
        // The tab strip repeats its label ("HomeHome"), so an exact match is
        // too strict and a `contains` would catch "Close Home".
        name == *entry || name == format!("{entry}{entry}")
    }) {
        return true;
    }
    /*
     * A tab in the strip, whose label the strip doubles.
     *
     * These are the controls that cost the sweep Home: clicking `ee` switched
     * to that project's pane, and Home's 160 remaining controls went to
     * `visible=false` while staying in the retained DOM. They were reported as
     * vanished when the sweep had simply walked off the surface.
     *
     * A project tab is swept as the opener of the project surface, so skipping
     * it here loses no coverage.
     */
    doubled(name).is_some()
}

/// The single label behind a doubled tab-strip name, if it is one.
///
/// `"ee"` -> `"e"`, `"HomeHome"` -> `"Home"`. An odd length or a mismatched
/// half is not a tab.
fn doubled(name: &str) -> Option<&str> {
    if name.is_empty() || !name.len().is_multiple_of(2) {
        return None;
    }
    let (left, right) = name.split_at(name.len() / 2);
    (left == right && !left.trim().is_empty()).then_some(left)
}

/// Whether the window is still showing the surface a plan was made against.
///
/// Each surface is recognised by a control only it renders. That is enough to
/// answer the one question the sweep needs - "did the last click take us
/// somewhere else" - without a route or a title to read, neither of which the
/// semantic tree exposes.
pub fn on_surface(nodes: &[SemanticNode], surface: &Surface) -> bool {
    let Some(marker) = surface_marker(surface) else {
        return true;
    };
    nodes
        .iter()
        .any(|n| onscreen(n) && n.name.contains(marker))
}

/// The controls that belong to the surface in front, by ancestry.
///
/// # Why not position, and not visibility
///
/// Both were tried against the running app and both are wrong. A retained Home
/// sits *behind* an open project pane and its rows keep real boxes in the same
/// horizontal band: `Items1` in the panel measured x=953 and Home's
/// `Recent247` x=965, so a `PANEL_LEFT` cut cannot separate them. Worse, the
/// retained rows still report `visible` with a non-zero box, so filtering on
/// visibility keeps every one of them too.
///
/// The consequence was not a small error. Home's ~160 row controls were swept
/// as though they were the project panel's, the panel's own controls were
/// crowded out of the plan, and the owner - who reports the side panels as
/// where most problems are - was reading coverage numbers for the wrong
/// surface.
///
/// Ancestry is the one thing that does separate them: a pane is a subtree, and
/// the marker control that identifies a surface lives inside it. Walking up
/// from the marker to the pane root and then taking that root's descendants
/// gives exactly the controls a person is looking at.
pub fn on_surface_subtree(nodes: &[SemanticNode], surface: &Surface) -> Vec<u64> {
    let Some(marker) = surface_marker(surface) else {
        return nodes.iter().map(|n| n.id).collect();
    };
    let by_id: HashMap<u64, &SemanticNode> = nodes.iter().map(|n| (n.id, n)).collect();
    let Some(anchor) = nodes
        .iter()
        .find(|n| onscreen(n) && n.name.contains(marker))
    else {
        return Vec::new();
    };

    /*
     * Up a fixed number of levels, not to the document root.
     *
     * Walking all the way up lands on the window, whose subtree is every
     * surface at once - which is the situation this exists to end. Eight is
     * deep enough to clear a control's own chrome and reach the pane, and
     * shallow enough not to swallow its neighbour; it is the same depth
     * `EditableTitle`'s notes use for "an input that is merely hidden still
     * walks eight levels to the window root".
     */
    /*
     * The shallowest ancestor that holds most of what is on screen.
     *
     * A fixed climb cannot work for every surface: eight levels from Home's
     * sort control landed above its list and returned nothing at all, while the
     * same depth from a project's `Send` was right. So the depth is chosen by
     * measurement - climb one level at a time and keep the first ancestor whose
     * subtree covers a majority of the on-screen controls. That is the pane,
     * whichever surface it belongs to, and it stops before the window root,
     * whose subtree is every surface at once.
     */
    let onscreen_total = nodes.iter().filter(|n| n.role == "button" && onscreen(n)).count();
    /*
     * Descended from the root, not climbed from every node.
     *
     * The per-node climb needed a hop limit to stay bounded, and any limit is
     * wrong: this tree runs to 8317 nodes and a project row sits deeper than
     * thirty-two ancestors, so the cap silently dropped exactly the controls
     * the sweep exists to press and Home reported zero buttons. Walking down
     * from the root visits each node once and has no depth to guess at.
     */
    let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
    for node in nodes {
        if let Some(parent) = node.parent {
            children.entry(parent).or_default().push(node.id);
        }
    }
    let subtree_of = |root: u64| -> Vec<u64> {
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            out.push(id);
            if let Some(kids) = children.get(&id) {
                stack.extend(kids.iter().copied());
            }
        }
        out
    };

    /*
     * The ancestor holding the most on-screen controls, chosen over the whole
     * climb rather than at the first one to clear a threshold.
     *
     * A majority test looks reasonable and fails exactly when it matters: after
     * a full run the window holds several retained panes, no single ancestor
     * reaches half the on-screen buttons, the loop exhausts, and it returns
     * whatever the last ancestor happened to be. Home reported zero buttons
     * that way while sweeping it alone found 145 - a coverage hole that only
     * appeared in the run that was supposed to cover everything.
     *
     * Taking the maximum has no threshold to be wrong about. The climb stops
     * short of the document root, whose subtree is every surface at once.
     */
    let mut cursor = anchor.id;
    let mut best: Vec<u64> = Vec::new();
    let mut best_covered = 0usize;
    for _ in 0..12 {
        let Some(parent) = by_id.get(&cursor).and_then(|n| n.parent) else {
            break;
        };
        cursor = parent;
        let kept = subtree_of(cursor);
        let covered = kept
            .iter()
            .filter(|id| {
                by_id
                    .get(id)
                    .is_some_and(|n| n.role == "button" && onscreen(n))
            })
            .count();
        // Everything on screen means this is the root, not a pane.
        if onscreen_total > 0 && covered >= onscreen_total {
            break;
        }
        if covered > best_covered {
            best_covered = covered;
            best = kept;
        }
    }
    best
}

/// The control that only this surface renders.
fn surface_marker(surface: &Surface) -> Option<&'static str> {
    match surface.name {
        "home" => Some("Cycle Home sort"),
        "settings" => Some("Appearance"),
        "analytics" => Some("Outcome per dollar"),
        "project" => Some("Send"),
        _ => None,
    }
}

/// Whether pressing this hands control to the operating system.
///
/// A native file chooser is not part of the webview: it is a modal the harness
/// cannot see in the semantic tree, cannot dismiss with a click, and which
/// takes the owner's screen until a person closes it. A sweep that presses one
/// stops being unattended, and the owner reported exactly that - "the open file
/// dialog is stuck open on the GUI" - mid-run.
///
/// These are skipped rather than judged, and counted in their own bucket so the
/// report never implies they passed.
pub fn opens_native_dialog(name: &str) -> bool {
    /*
     * Only the controls that hand the screen to macOS.
     *
     * This list used to carry "Choose", "Browse" and "Open folder" as well,
     * which is how it grew from "skip the OS file chooser" into a general
     * posture of not opening things. That posture is what let the fork dialog
     * ship with a dead Cancel: the sweep never opened an in-app modal, so it
     * never asked whether it could get back out, and the owner found a trap the
     * harness had reported as a clean run.
     *
     * An in-app dialog is a surface like any other and gets swept. Only a
     * native chooser is exempt, because it is not in the webview at all: the
     * tree cannot see it, no click can dismiss it, and it takes the owner's
     * screen until a person closes it.
     */
    /*
     * The only exception, and it is documented rather than silent.
     *
     * Everything else is pressed, including in-app modals: the old list had
     * grown into a general posture of not opening things, which is how a fork
     * dialog shipped with a Cancel that does nothing - no run ever opened it.
     *
     * A macOS file chooser is genuinely outside what this harness can drive.
     * It is not in the webview, so the semantic tree cannot see it and no
     * synthesised click can reach it; Escape through the control protocol goes
     * to the window underneath, and driving it through System Events needs
     * assistive access this process does not have. Pressing one leaves a panel
     * on the owner's screen until a person closes it, which happened twice
     * during this audit.
     *
     * These are counted in the `native` bucket and printed, so the report says
     * how many controls were not exercised and why. They need a person:
     * `scripts/button-sweep.sh` documents the manual pass.
     */
    NATIVE_CHOOSERS
        .iter()
        .any(|exception| name.starts_with(exception.label))
}

/// One control the sweep will not press, and why.
pub struct Exception {
    /// The accessible-name prefix that identifies it.
    pub label: &'static str,
    /// The Tauri command that raises the panel, so the list can be re-derived.
    pub command: &'static str,
}

/// Every control this harness cannot exercise, enumerated.
///
/// Seven, all of them macOS file panels, each traced to the `app.dialog()` call
/// that raises it. There are no other exceptions: in-app modals are opened and
/// swept like any other surface.
///
/// Re-derive with `grep -n '\.dialog()' apps/gui/src/*.rs` - it is seven call
/// sites, and if that number changes this list is stale.
pub const NATIVE_CHOOSERS: &[Exception] = &[
    Exception { label: "Attach files", command: "choose_attachments" },
    Exception { label: "Add dir", command: "choose_project_directory" },
    Exception { label: "Choose a working directory", command: "choose_project_directory" },
    Exception { label: "Choose the agencyzero data directory", command: "(startup data dir)" },
    Exception { label: "Select backup file", command: "select_store_backup" },
    // `Back up & close`, not the panel's own title: same mismatch as `Choose…`.
    Exception { label: "Back up & close", command: "create_store_backup" },
    Exception { label: "Export", command: "export_study_events" },
    // `Restore` raises the restore picker; the old entry named the panel.
    Exception { label: "Restore", command: "select_store_backup" },
    /*
     * The button reads `Choose…`, not anything about a proxy.
     *
     * This entry used to say "Agent proxy binary", which is what the row is
     * called, and matched nothing: the exception is tested against the
     * *button's* accessible name, and the button beside the AgencyProxy path
     * is labelled `Choose…` alone. So the sweep pressed it, raised
     * `Choose an AgencyProxy executable`, and stranded a macOS open panel on
     * the owner's screen with no way back - `pgrep -lf openAndSavePanel`
     * shows the residue.
     *
     * The lesson for the next entry: check that each label here matches the
     * control's accessible name in a running build. Counting `.dialog()` call
     * sites proves the list is the right length, not that any of it matches.
     */
    Exception { label: "Choose…", command: "choose_agent_proxy_binary" },
];

/// Whether the window is showing a modal that has to be dismissed to continue.
///
/// A modal is the one thing a sweep cannot treat as ordinary: every control
/// behind it is unreachable until it closes, so a dialog that will not dismiss
/// does not fail one button, it ends the run. The check is therefore not "did
/// this button act" but "can I still get out of here".
pub fn modal_open(nodes: &[SemanticNode]) -> bool {
    nodes.iter().any(|node| {
        onscreen(node)
            && node.role == "button"
            && (node.name == "Cancel" || node.name == "Dismiss")
    })
}

/// The controls that would dismiss the modal in front, best first.
///
/// `Cancel` before `Close`, because a fork dialog renders both an × in its
/// header and a `Cancel` in its footer and either should work; trying the named
/// one first keeps the report readable when neither does.
pub fn dismissers(nodes: &[SemanticNode]) -> Vec<(u64, String)> {
    let mut found: Vec<(u64, String)> = nodes
        .iter()
        .filter(|n| n.role == "button" && onscreen(n))
        .filter(|n| matches!(n.name.as_str(), "Cancel" | "Dismiss" | "Close"))
        .map(|n| (n.id, n.name.clone()))
        .collect();
    found.sort_by_key(|(_, name)| match name.as_str() {
        "Cancel" => 0,
        "Dismiss" => 1,
        _ => 2,
    });
    found
}

/// Whether this restarts the app or reopens onboarding.
///
/// `Welcome Tutorial` and `Restart` put a setup flow in front of everything and
/// open tabs of their own. After a Settings sweep pressed them the window was
/// left with `Close setup` in the strip and Analytics could not be opened at
/// all - three clicks, no navigation - while Home still worked. That is the
/// sweep breaking its own run, not a defect in the button.
///
/// Left to a person, because "does the tutorial replay" is a question about a
/// flow rather than about one control's promise.
pub fn restarts_the_app(name: &str) -> bool {
    const DISRUPTIVE: &[&str] = &["Welcome Tutorial", "Restart", "Reset all", "Sign out"];
    DISRUPTIVE.iter().any(|entry| name.starts_with(entry))
}

/// Whether this closes a surface the sweep still has to stand on.
///
/// `Close Settings` retires the tab that every later surface is reached
/// through, so pressing it early cost the run its own subject: Home planned 20
/// controls against a window that had 196 on screen, because the sweep was no
/// longer where it thought it was.
///
/// The tab is still exercised - `Close` on a project tab is swept - but the
/// three permanent surfaces keep theirs.
pub fn closes_a_surface(name: &str) -> bool {
    /*
     * Every `Close` in the strip, not a fixed list of three.
     *
     * A project tab's close was left in the sweep on the grounds that it is an
     * ordinary control - but closing a project tab falls the window back to
     * Home, retires the pane later surfaces are reached through, and in a full
     * run left Home reporting zero buttons where sweeping it alone finds 145.
     * The close controls are worth pressing; they are not worth pressing in the
     * middle of a plan that stands on what they remove.
     */
    name.starts_with("Close ")
}

/// The subtree of the dialog that owns this dismiss control.
///
/// A modal does not remove the surface behind it: that surface stays in the
/// tree, `visible` and sized, the same way a retained pane does. So "everything
/// on screen" is not "everything in the dialog", and sweeping the former made
/// the fork dialog's pass press `HomeHome`, `Settings` and `Attach files` -
/// controls that are not in the dialog at all, one of which raises a macOS
/// panel onto the owner's screen.
///
/// Found by climbing from the dismiss control until the subtree stops growing
/// quickly, which is the dialog's own container: a modal is a small, self
/// contained box next to a large surface, so the first ancestor holding more
/// than a handful of controls is already too big.
pub fn enclosing_dialog(nodes: &[SemanticNode], dismiss_id: u64) -> Vec<u64> {
    let by_id: HashMap<u64, &SemanticNode> = nodes.iter().map(|n| (n.id, n)).collect();
    let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
    for node in nodes {
        if let Some(parent) = node.parent {
            children.entry(parent).or_default().push(node.id);
        }
    }
    let subtree_of = |root: u64| -> Vec<u64> {
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            out.push(id);
            if let Some(kids) = children.get(&id) {
                stack.extend(kids.iter().copied());
            }
        }
        out
    };

    let mut cursor = dismiss_id;
    let mut best = vec![dismiss_id];
    for _ in 0..8 {
        let Some(parent) = by_id.get(&cursor).and_then(|n| n.parent) else {
            break;
        };
        cursor = parent;
        let kept = subtree_of(cursor);
        let buttons = kept
            .iter()
            .filter(|id| by_id.get(id).is_some_and(|n| n.role == "button"))
            .count();
        /*
         * A dialog holds a handful of controls. Past that this is the pane
         * behind it, and taking that would sweep the whole surface again from
         * inside the modal.
         */
        if buttons > 12 {
            break;
        }
        best = kept;
    }
    best
}

/// Whether pressing this is likely to raise a macOS file chooser.
///
/// Not an exclusion - these are pressed like everything else - but a cue to
/// send Escape straight afterwards. A native panel is not in the webview: the
/// semantic tree cannot see it, no synthesised click can dismiss it, and it
/// holds the owner's screen until a person closes it. Testing the control and
/// then getting out of the way is what a person does, and it is the only shape
/// that satisfies "test everything" without leaving the app wedged.
pub fn may_open_native_chooser(name: &str) -> bool {
    const NATIVE: &[&str] = &[
        "Attach files",
        "Add dir",
        "Select backup file",
        "Choose",
        "Browse",
        "Open folder",
        "Import",
        "Export",
    ];
    NATIVE.iter().any(|entry| name.starts_with(entry))
}

/// Whether this is a panel section header, which folds the rows beneath it.
///
/// The panel's headers are named for their contents and count - `Items1`,
/// `Running0`, `Task log22`, `Agent I/O0` - not "Collapse Items", so a
/// name-prefix rule for disclosures misses every one of them. Pressing `Items1`
/// folds the section, and with it `Fork <item> into a fresh chat`, `Change the
/// status of ...`, `Edit the description for ...` and `New item`.
///
/// That is precisely how the fork dialog escaped the audit: the sweep folded
/// the Items section a dozen controls before it reached the rows, so every
/// per-item control read as vanished and the dialog was never opened.
pub fn folds_a_section(name: &str) -> bool {
    const SECTIONS: &[&str] = &[
        "Items",
        "Running",
        "Task log",
        "Agent I/O",
        "Kept across compaction",
        "Recent",
    ];
    SECTIONS.iter().any(|section| {
        name.strip_prefix(section)
            // The header carries a count, so what follows must be a number or
            // nothing at all; "Items" matches, "Items1" matches, and
            // "Item sort between status and time" does not.
            .is_some_and(|rest| rest.is_empty() || rest.chars().all(|c| c.is_ascii_digit()))
    })
}

/// The disclosure controls that must be opened before a sweep of this surface.
///
/// Collapsed sections are the second-largest source of unreached controls after
/// the wrong surface: `Items` alone hides a row of controls per item, and the
/// QA profile carries twenty-three of them.
pub fn expanders(nodes: &[SemanticNode]) -> Vec<(u64, String)> {
    nodes
        .iter()
        .filter(|node| node.role == "button" && onscreen(node))
        .filter(|node| node.name.to_lowercase().starts_with("expand "))
        .map(|node| (node.id, node.name.clone()))
        .collect()
}

/// Rows worth hovering, as the point at the middle of each.
///
/// Row actions do not exist until `pointerenter`, so a sweep that never moves
/// the pointer cannot see them at all. Hovering the row rather than the control
/// is the only order that works: the control is not in the tree to be aimed at
/// until the row it lives in is hovered.
/// Only rows whose middle is inside the window: a transcript keeps hundreds of
/// rows at negative coordinates, and moving the pointer to y=-9726 reveals
/// nothing while costing a round trip each.
pub fn hover_points(
    nodes: &[SemanticNode],
    row_role: &str,
    window: (f64, f64),
) -> Vec<(u64, String)> {
    nodes
        .iter()
        .filter(|node| node.role == row_role && onscreen(node))
        .filter_map(|node| {
            let b = node.bounds?;
            let (x, y) = (b[0] + b[2] / 2.0, b[1] + b[3] / 2.0);
            (y >= window.0 && y <= window.1 && x >= 0.0).then(|| (node.id, format!("{x},{y}")))
        })
        .collect()
}

/// How every button in the tree was accounted for.
///
/// Printed at the end of a run so a coverage regression is visible as a number
/// rather than as silence. `swept + unreachable + hidden` must equal the button
/// count in the tree; if it does not, this file has a hole in it.
#[derive(Debug, Default, Clone, Copy)]
pub struct Coverage {
    pub in_tree: usize,
    pub swept: usize,
    pub unreachable: usize,
    pub hidden: usize,
    /// Planned, then gone by the time its turn came.
    ///
    /// Not a fault and not a skip: closing one tab removes its neighbours'
    /// close buttons, so a working control legitimately retires others. It gets
    /// its own bucket so it cannot be confused with a control that was never
    /// tried.
    pub vanished: usize,
    /// Leaves the surface, so it is exercised as an opener instead.
    pub navigation: usize,
    /// Hands the screen to a native modal, so it is never pressed unattended.
    pub native: usize,
    /// Left unreachable behind a dialog that would not dismiss.
    ///
    /// Its own bucket because it is neither a pass nor a skip: these controls
    /// were planned, are on the surface, and could not be reached because one
    /// bug upstream of them traps the window. Counting them as anything else
    /// hides the blast radius of that bug.
    pub blocked: usize,
}

impl Coverage {
    /// Every button ended in a bucket.
    pub fn accounted(&self) -> bool {
        self.bucketed() == self.in_tree
    }

    fn bucketed(&self) -> usize {
        self.swept
            + self.unreachable
            + self.hidden
            + self.vanished
            + self.navigation
            + self.native
            + self.blocked
    }

    pub fn line(&self) -> String {
        format!(
            "{} buttons: {} swept, {} unreachable, {} hidden, {} vanished, {} nav, {} native, {} blocked{}",
            self.in_tree,
            self.swept,
            self.unreachable,
            self.hidden,
            self.vanished,
            self.navigation,
            self.native,
            self.blocked,
            if self.accounted() {
                String::new()
            } else {
                format!(
                    " (UNACCOUNTED {})",
                    self.in_tree as i64 - self.bucketed() as i64
                )
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: u64, role: &str, name: &str, bounds: Option<[f64; 4]>) -> SemanticNode {
        SemanticNode {
            id,
            parent: None,
            role: role.to_owned(),
            name: name.to_owned(),
            value: None,
            enabled: true,
            visible: true,
            selected: false,
            bounds,
        }
    }

    #[test]
    fn a_zero_box_control_is_not_onscreen() {
        // The exact shape of the 222 discarded controls: in the tree, not
        // hidden, no box.
        assert!(!onscreen(&node(1, "button", "Pin project", Some([0.0; 4]))));
        assert!(onscreen(&node(
            2,
            "button",
            "Pin project",
            Some([10.0, 10.0, 20.0, 20.0])
        )));
    }

    #[test]
    fn only_onscreen_expanders_are_offered() {
        let nodes = vec![
            node(1, "button", "Expand Items", Some([0.0, 0.0, 20.0, 20.0])),
            node(2, "button", "Expand Hidden", Some([0.0; 4])),
            node(3, "button", "Collapse Running", Some([0.0, 0.0, 20.0, 20.0])),
        ];
        let found = expanders(&nodes);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, "Expand Items");
    }

    #[test]
    fn navigation_is_recognised_without_swallowing_its_neighbours() {
        // The tab strip doubles its label, which is why an exact match alone
        // is not enough.
        assert!(navigates("Home"));
        assert!(navigates("HomeHome"));
        assert!(navigates("Settings"));
        // Project tabs are doubled too, and clicking one leaves the surface:
        // this is what cost Home 160 controls in a run.
        assert!(navigates("ee"));
        assert!(navigates("delta/east/cobaltdelta/east/cobalt"));
        // A `contains` would catch these, and dropping a Close from the sweep
        // is the silent skip this module exists to end.
        assert!(!navigates("Close Home"));
        assert!(!navigates("Add dir"));
        assert!(!navigates("Rename project"));
        // Not every even-length name is a doubled label.
        assert!(!navigates("Send"));
        assert!(!navigates("Copy"));
    }

    #[test]
    fn only_the_documented_file_panels_are_exempt() {
        /*
         * The exception list is exactly the macOS file panels, and every entry
         * names the command that raises it.
         *
         * The old list had grown past that into a general posture of not
         * opening things, which is how the fork dialog shipped with a Cancel
         * that does nothing: no run ever opened it. In-app modals are swept
         * now; only panels outside the webview are exempt, because no
         * synthesised click or key can reach them.
         */
        for name in ["Attach files", "Add dir", "Select backup file…", "Export"] {
            assert!(opens_native_dialog(name), "{name} is a native panel");
        }
        /*
         * The AgencyProxy chooser, by the name the *button* carries.
         *
         * Its entry used to read "Agent proxy binary" - the row's label, not
         * the control's - so it matched nothing and the sweep raised a macOS
         * open panel it could not dismiss. The name here is what
         * `blitz-bench layout` reports for that button in a running build.
         */
        for name in ["Choose…", "Back up & close", "Restore", "Export JSONL"] {
            assert!(
                opens_native_dialog(name),
                "{name} raises a panel the harness cannot dismiss"
            );
        }
        for name in ["Add item", "Send", "Cancel", "Fork this item", "New item"] {
            assert!(!opens_native_dialog(name), "{name} must be swept");
        }
        // Every exception is traceable to the call site that raises it, so the
        // list can be re-derived rather than trusted.
        assert!(NATIVE_CHOOSERS.iter().all(|e| !e.command.is_empty()));
    }

    #[test]
    fn a_modal_is_recognised_and_offers_its_dismissers() {
        let dialog = vec![
            node(1, "button", "Cancel", Some([0.0, 0.0, 20.0, 20.0])),
            node(2, "button", "Fork", Some([0.0, 0.0, 20.0, 20.0])),
            node(3, "button", "Close", Some([0.0, 0.0, 20.0, 20.0])),
        ];
        assert!(modal_open(&dialog));
        // Cancel first: the fork dialog renders an x in its header and a
        // Cancel in its footer, and the named one reads better in a report.
        let ways_out = dismissers(&dialog);
        assert_eq!(ways_out[0].1, "Cancel");
        assert_eq!(ways_out.len(), 2);

        let ordinary = vec![node(1, "button", "Send", Some([0.0, 0.0, 20.0, 20.0]))];
        assert!(!modal_open(&ordinary));
    }

    #[test]
    fn onboarding_and_restart_are_left_alone() {
        // These left the window with `Close setup` in the strip and Analytics
        // unreachable for the rest of the run.
        assert!(restarts_the_app("Welcome Tutorial"));
        assert!(restarts_the_app("Restart"));
        // Ordinary Settings controls are still swept.
        assert!(!restarts_the_app("Re-check"));
        assert!(!restarts_the_app("Refresh"));
        assert!(!restarts_the_app("Default model"));
    }

    #[test]
    fn surface_tabs_are_not_closed_out_from_under_the_sweep() {
        assert!(closes_a_surface("Close Settings"));
        assert!(closes_a_surface("Close Analytics"));
        /*
         * A project tab's close counts too, which it did not used to.
         *
         * It is still pressed - the caller defers these to the end of the plan
         * rather than skipping them - but closing any tab falls the window back
         * to Home and retires a pane the rest of the plan stands on. Exempting
         * project tabs is what left Home reporting zero buttons in a full run.
         */
        assert!(closes_a_surface("Close delta/east/cobalt"));
        // Not a close at all.
        assert!(!closes_a_surface("Collapse Recent"));
        assert!(!closes_a_surface("Rename e"));
    }

    #[test]
    fn rows_off_the_top_of_a_transcript_are_not_hovered() {
        // The first run moved the pointer to y=-9726 eight times over. A row
        // above the window reveals nothing and costs a round trip.
        let nodes = vec![
            node(1, "listitem", "visible row", Some([10.0, 100.0, 200.0, 40.0])),
            node(2, "listitem", "scrolled off", Some([10.0, -9726.0, 200.0, 40.0])),
            node(3, "listitem", "below the fold", Some([10.0, 5000.0, 200.0, 40.0])),
        ];
        let points = hover_points(&nodes, "listitem", (0.0, 900.0));
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].0, 1);
    }

    #[test]
    fn coverage_reports_an_unaccounted_gap() {
        // Every bucket carries at least one control, so a bucket dropped from
        // `bucketed()` shows up here as an unaccounted gap rather than passing
        // on a zero that proves nothing. The fork dialog put real controls in
        // `blocked`, which is why it counts.
        let full = Coverage {
            in_tree: 10,
            swept: 3,
            unreachable: 2,
            hidden: 1,
            vanished: 1,
            navigation: 1,
            native: 1,
            blocked: 1,
        };
        assert!(full.accounted());
        assert!(!full.line().contains("UNACCOUNTED"));

        let leaky = Coverage {
            in_tree: 10,
            swept: 6,
            unreachable: 0,
            hidden: 0,
            vanished: 0,
            navigation: 0,
            native: 0,
            blocked: 0,
        };
        assert!(!leaky.accounted());
        assert!(leaky.line().contains("UNACCOUNTED 4"));
    }
}
