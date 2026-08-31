//! The schema as data: what a `worktable!` declaration says, and nothing more.
//!
//! Every field here is something the DSL states outright. Anything derived,
//! the relationships above all, lives in [`crate::relate`] and is labelled with
//! where it came from, so a reader can always tell a declaration from a guess.

use serde::{Deserialize, Serialize};

/// One `worktable!` invocation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Table {
    /// The Rust identifier, e.g. `AgentIoRow`.
    pub name: String,
    /// The snake_case name the store and the schema fingerprint use, e.g.
    /// `agent_io_row`. Derived from `name` the same way the macro derives it.
    pub table_name: String,
    /// Source file, relative to the root the reader was pointed at.
    pub file: String,
    /// The `//!` module header, which in this codebase is where the reasoning
    /// for a table's shape is written. Empty when the file has none.
    pub doc: String,
    /// `persist: true` / `false`, or `None` when the declaration omits it.
    pub persist: Option<bool>,
    /// `version: N`. The macro defaults it to 1 when absent; absent is kept
    /// distinct from an explicit 1 because only one of them was a decision.
    pub version: Option<u32>,
    /// `partition_by: <name>: <type>`.
    pub partition_by: Option<PartitionKey>,
    /// `config: { page_size: N }`.
    pub page_size: Option<u32>,
    /// In declaration order, which is the order rkyv writes them on disk. The
    /// order is load-bearing: see `db/fingerprint.rs` in the GUI.
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    #[serde(default)]
    pub queries: Queries,
}

impl Table {
    /// The table's segment of the GUI's `SCHEMA_FINGERPRINT`, e.g.
    /// `kv(key,value,updated_at)`.
    ///
    /// Here rather than in the test that uses it, because it is the one string
    /// that lets an outside party check this parser against a declaration
    /// nobody generated from it.
    #[must_use]
    pub fn fingerprint_segment(&self) -> String {
        let columns: Vec<&str> = self.columns.iter().map(|c| c.name.as_str()).collect();
        format!("{}({})", self.table_name, columns.join(","))
    }

    /// The primary key column, when one is declared.
    #[must_use]
    pub fn primary_key(&self) -> Option<&Column> {
        self.columns.iter().find(|c| c.primary_key)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    /// The type as written: `String`, `u32`, `i64`, `bool`.
    #[serde(rename = "type")]
    pub ty: String,
    pub primary_key: bool,
    /// `autoincrement` or `custom`, when the declaration names one.
    pub generator: Option<String>,
    /// `optional`, which the macro widens to `Option<T>`.
    pub optional: bool,
    /// `using <backend>` on the column's own index.
    pub index_backend: Option<String>,
    /// The `//` comment block directly above the column. Ordinary comments, so
    /// the token stream has already dropped them; they are recovered by line
    /// number. Empty when there is none.
    pub doc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Index {
    pub name: String,
    /// The column it indexes.
    pub column: String,
    pub unique: bool,
    pub backend: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Queries {
    #[serde(default)]
    pub updates: Vec<Operation>,
    #[serde(default)]
    pub deletes: Vec<Operation>,
    #[serde(default)]
    pub in_place: Vec<Operation>,
}

impl Queries {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.updates.is_empty() && self.deletes.is_empty() && self.in_place.is_empty()
    }
}

/// One generated query: `FinalizeById(usage, stop, exit_code) by id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Operation {
    pub name: String,
    /// The columns it writes. Empty for a `delete`, which names none.
    pub columns: Vec<String>,
    /// The column it selects rows by.
    pub by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PartitionKey {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// `AgentIoRow` to `agent_io_row`, matching what the macro generates.
#[must_use]
pub fn snake_case(ident: &str) -> String {
    let mut out = String::with_capacity(ident.len() + 4);
    for (i, ch) in ident.char_indices() {
        if ch.is_ascii_uppercase() {
            if i != 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::snake_case;

    #[test]
    fn snake_case_matches_the_macro() {
        assert_eq!(snake_case("Kv"), "kv");
        assert_eq!(snake_case("AgentIoRow"), "agent_io_row");
        assert_eq!(snake_case("ProjectItem"), "project_item");
        assert_eq!(snake_case("UsageLedger"), "usage_ledger");
    }
}
