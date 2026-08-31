//! Where the edges come from, and how honest each one is.
//!
//! # The DSL declares no relationships
//!
//! A `worktable!` has columns, a primary key, indexes and queries. It has no
//! foreign keys, and `project_id` is a plain `String` like any other. So a
//! diagram's edges are not read out of the schema; they are proposed here and
//! then either confirmed or corrected by a human.
//!
//! That is why every edge carries its [`Origin`]. An inferred edge is a naming
//! convention holding up, and conventions have exceptions. This store has
//! several. An overlay edge is somebody's decision. A drawing that renders the
//! two identically is claiming to know something it does not, so the two are
//! kept apart all the way to the surface.
//!
//! Anything the convention cannot resolve becomes an [`Unresolved`] entry
//! rather than being dropped. A missing edge that nobody is told about is the
//! failure mode this whole design exists to avoid.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::Table;

/// How the edge came to be known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// A `*_id` column whose stem names a table. A convention, not a fact.
    Inferred,
    /// Written down by a person in the overlay. Wins over inference.
    Overlay,
}

/// Whether the reference is always populated.
///
/// WorkTable columns are not nullable, so "absent" is the empty string. An
/// optional edge is one the source itself documents as often empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Required,
    Optional,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relationship {
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
    pub kind: Kind,
    pub origin: Origin,
    /// Why this edge is here, in one line: the convention that produced it or
    /// the note the overlay carries.
    pub note: String,
}

/// A `*_id` column that names no table this reader has seen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Unresolved {
    pub table: String,
    pub column: String,
    /// Tables whose name ends with the column's stem, e.g. `project_item` for
    /// `item_id`. A suggestion for the overlay, never applied on its own.
    pub suggestions: Vec<String>,
}

/// Human corrections, loaded from a JSON file the editor owns.
///
/// Seeded by inference, corrected by a person, and persisted in the repository
/// so a correction outlives the session that made it and shows up in review as
/// a diff rather than as a change of mind.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Overlay {
    /// `"message.item_id": "project_item.id"`, an edge inference could not
    /// reach, or one it got wrong.
    #[serde(default)]
    pub edges: Vec<OverlayEdge>,
    /// `"study_event.turn_id"`, a `*_id` that genuinely references nothing,
    /// so it stops being reported as unresolved.
    #[serde(default)]
    pub ignore: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayEdge {
    /// `<table>.<column>`, in snake_case table names.
    pub from: String,
    /// `<table>` or `<table>.<column>`. The column defaults to the target's
    /// primary key.
    pub to: String,
    #[serde(default = "default_kind")]
    pub kind: Kind,
    #[serde(default)]
    pub note: String,
}

fn default_kind() -> Kind {
    Kind::Required
}

/// Phrases a column comment uses when the reference is often absent.
///
/// Read off this codebase's own schema files rather than invented: `item_id`
/// on `message` and `task_log` says "Soft association ... Empty is normal",
/// and `issue_url` says "Empty when none".
const OPTIONAL_MARKERS: [&str; 4] = [
    "soft association",
    "empty is normal",
    "optional",
    "empty when",
];

/// Propose edges from naming, then let the overlay have the last word.
#[must_use]
pub fn relate(tables: &[Table], overlay: &Overlay) -> (Vec<Relationship>, Vec<Unresolved>) {
    let by_name: BTreeMap<&str, &Table> =
        tables.iter().map(|t| (t.table_name.as_str(), t)).collect();

    let ignored: Vec<&str> = overlay.ignore.iter().map(String::as_str).collect();
    let overridden: Vec<&str> = overlay.edges.iter().map(|e| e.from.as_str()).collect();

    let mut edges = Vec::new();
    let mut unresolved = Vec::new();

    for table in tables {
        for column in &table.columns {
            if column.primary_key {
                continue;
            }
            let Some(stem) = column.name.strip_suffix("_id") else {
                continue;
            };
            let key = format!("{}.{}", table.table_name, column.name);
            if ignored.contains(&key.as_str()) || overridden.contains(&key.as_str()) {
                continue;
            }

            // The macro appends nothing, but this codebase names one row type
            // `AgentIoRow`, so a table called `<stem>_row` is the same entity.
            let target = by_name
                .get(stem)
                .or_else(|| by_name.get(format!("{stem}_row").as_str()));

            match target {
                Some(target) if target.table_name != table.table_name => {
                    let to_column = target
                        .primary_key()
                        .map_or_else(|| "id".to_string(), |c| c.name.clone());
                    edges.push(Relationship {
                        from_table: table.table_name.clone(),
                        from_column: column.name.clone(),
                        to_table: target.table_name.clone(),
                        to_column,
                        kind: kind_from_comment(&column.doc),
                        origin: Origin::Inferred,
                        note: format!("`{}` names the `{}` table", column.name, target.table_name),
                    });
                }
                // A self-reference by convention is almost always a coincidence
                // of naming rather than a parent link, so it is reported for a
                // human instead of drawn as a loop.
                _ => unresolved.push(Unresolved {
                    table: table.table_name.clone(),
                    column: column.name.clone(),
                    suggestions: suggest(stem, tables, &table.table_name),
                }),
            }
        }
    }

    for edge in &overlay.edges {
        let Some((from_table, from_column)) = edge.from.split_once('.') else {
            continue;
        };
        let (to_table, to_column) = match edge.to.split_once('.') {
            Some((t, c)) => (t.to_string(), c.to_string()),
            None => {
                let column = by_name
                    .get(edge.to.as_str())
                    .and_then(|t| t.primary_key())
                    .map_or_else(|| "id".to_string(), |c| c.name.clone());
                (edge.to.clone(), column)
            }
        };
        edges.push(Relationship {
            from_table: from_table.to_string(),
            from_column: from_column.to_string(),
            to_table,
            to_column,
            kind: edge.kind,
            origin: Origin::Overlay,
            note: edge.note.clone(),
        });
    }

    edges.sort_by(|a, b| {
        (&a.from_table, &a.from_column, &a.to_table).cmp(&(
            &b.from_table,
            &b.from_column,
            &b.to_table,
        ))
    });
    unresolved.sort_by(|a, b| (&a.table, &a.column).cmp(&(&b.table, &b.column)));
    (edges, unresolved)
}

/// Tables whose name ends with the stem, e.g. `project_item` for `item`.
///
/// Offered, never applied: `item_id` really does mean `project_item` here, and
/// a reader that acted on that alone would just as happily invent an edge from
/// any column that happens to end in a shared word.
fn suggest(stem: &str, tables: &[Table], self_name: &str) -> Vec<String> {
    let suffix = format!("_{stem}");
    tables
        .iter()
        .filter(|t| t.table_name != self_name && t.table_name.ends_with(&suffix))
        .map(|t| t.table_name.clone())
        .collect()
}

fn kind_from_comment(doc: &str) -> Kind {
    let lowered = doc.to_lowercase();
    if OPTIONAL_MARKERS.iter().any(|m| lowered.contains(m)) {
        Kind::Optional
    } else {
        Kind::Required
    }
}
