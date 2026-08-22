//! Every button in the running application, measured.
//!
//! # Why this exists
//!
//! The owner reported broken controls one at a time for a week, and each report
//! was a thing no test could see. The reason is that the checks available were
//! all *synthetic*: rendering a component in isolation says the component can
//! work, never that the button in the window does. An icon rendered alone drew
//! perfectly while fifteen of them in a real panel shared one DOM node and left
//! fourteen empty, and nothing but a person looking at the window caught it.
//!
//! So this does not render anything. It walks the semantic tree of the running
//! application, takes every button in it, and asks the renderer what each one
//! actually put on screen. There is no fixture, no mock and no isolated mount:
//! the subject is the app the owner is looking at.
//!
//! # What it can and cannot say
//!
//! It reports what a control *shows*. A button with no ink is one the owner
//! cannot see, which is the failure that kept shipping. It deliberately does
//! not click anything: `Delete` and `Close` are destructive, and an audit that
//! mutates the owner's data to prove a button works is worse than the bug.
//! Behaviour under click belongs in `qa`, against a throwaway profile.
//!
//! ```sh
//! cargo run -q -p blitz-bench -- audit          # every button
//! cargo run -q -p blitz-bench -- audit close    # one family
//! ```

use std::collections::BTreeMap;

use blitz_control_protocol::SemanticNode;

/// A control's visible state, as the renderer drew it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Ink on screen: the owner can see this control.
    Drawn,
    /// A box, but nothing in it. This is the failure that kept shipping.
    Blank,
    /// Present in the tree with no box, so nothing was drawn anywhere.
    NoBox,
    /// Deliberately offscreen or hidden, and not a fault.
    Hidden,
    /// On the page but scrolled out of the viewport.
    ///
    /// Separated from `Blank` because it is not a defect and reporting it as
    /// one buries the real faults: a transcript holds hundreds of controls at
    /// negative coordinates, and every one of them draws correctly the moment
    /// it is scrolled to.
    Offscreen,
}

impl Verdict {
    pub fn label(self) -> &'static str {
        match self {
            Verdict::Drawn => "drawn",
            Verdict::Blank => "BLANK",
            Verdict::NoBox => "NO BOX",
            Verdict::Hidden => "hidden",
            Verdict::Offscreen => "offscreen",
        }
    }

    /// Whether this verdict should fail the audit.
    ///
    /// Hidden is not a fault: a retained pane and a collapsed section both keep
    /// their controls in the tree on purpose.
    pub fn is_fault(self) -> bool {
        matches!(self, Verdict::Blank | Verdict::NoBox)
    }
}

/// One audited control.
#[derive(Debug, Clone)]
pub struct Audited {
    pub name: String,
    /// The family this belongs to, derived from its accessible name.
    pub family: &'static str,
    pub width: f64,
    pub height: f64,
    pub verdict: Verdict,
}

/// Which family a control belongs to, from its accessible name.
///
/// Grouped so a whole class failing is one line of output rather than forty.
/// When every `Close` in the window is blank that is one bug, and reading it as
/// forty separate findings is how a report becomes unusable.
pub fn family_of(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    const FAMILIES: &[(&str, &str)] = &[
        ("close", "close"),
        ("delete", "delete"),
        ("remove", "delete"),
        ("retire", "delete"),
        ("add", "add"),
        ("new ", "add"),
        ("create", "add"),
        ("edit", "edit"),
        ("rename", "edit"),
        ("collapse", "disclosure"),
        ("expand", "disclosure"),
        ("show", "disclosure"),
        ("hide", "disclosure"),
        ("copy", "copy"),
        ("move ", "reorder"),
        ("sort", "reorder"),
        ("run ", "run"),
        ("stop", "run"),
        ("cancel", "run"),
        ("change the status", "status"),
        ("fork", "fork"),
        ("reply", "reply"),
        ("attach", "attach"),
        ("clear", "clear"),
    ];
    for (needle, family) in FAMILIES {
        if lower.contains(needle) {
            return family;
        }
    }
    "other"
}

/// Every button worth auditing, in tree order.
///
/// Buttons only: a `generic` node with no box is ordinary layout, while a
/// button the owner cannot see is a bug. Keeping the subject narrow is what
/// makes a zero-fault run meaningful rather than noise.
pub fn buttons(nodes: &[SemanticNode]) -> Vec<&SemanticNode> {
    nodes
        .iter()
        .filter(|node| node.role == "button" && !node.name.trim().is_empty())
        .collect()
}

/// Summarise a finished audit by family.
pub fn by_family(rows: &[Audited]) -> BTreeMap<&'static str, (usize, usize)> {
    let mut totals: BTreeMap<&'static str, (usize, usize)> = BTreeMap::new();
    for row in rows {
        let entry = totals.entry(row.family).or_insert((0, 0));
        entry.1 += 1;
        if !row.verdict.is_fault() {
            entry.0 += 1;
        }
    }
    totals
}
