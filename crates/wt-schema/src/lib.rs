//! Reads WorkTable's DSL and reports what it found, as data.
//!
//! Deliberately read-only. A designer that edits a `worktable!` has to drive
//! the schema fingerprint and a migration in the same breath, because
//! WorkTable persists rows with rkyv positionally and nothing on disk records
//! which columns produced them: change a table's columns without bumping the
//! fingerprint and every existing row is read through the new layout, silently,
//! with every field shifted. That has already cost this repository a table and
//! an afternoon, and `docs/store-recovery.md` is the account of it. So this crate
//! parses and describes; it never writes Rust.
//!
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let schema = wt_schema::read_dir(std::path::Path::new("apps/gui/src/db/schema"))?;
//! println!("{} tables", schema.tables.len());
//! # Ok(()) }
//! ```

pub mod model;
pub mod parse;
pub mod relate;

use std::path::Path;

use serde::{Deserialize, Serialize};

pub use model::{Column, Index, Operation, PartitionKey, Queries, Table};
pub use parse::Error;
pub use relate::{Kind, Origin, Overlay, Relationship, Unresolved};

/// Everything the reader found: the declarations, and the edges proposed over
/// them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schema {
    /// Sorted by table name, so the output of two runs can be diffed.
    pub tables: Vec<Table>,
    pub relationships: Vec<Relationship>,
    /// `*_id` columns that name no table. Reported rather than dropped.
    pub unresolved: Vec<Unresolved>,
}

/// Parse every `.rs` file directly inside `dir`, with no overlay.
///
/// # Errors
/// Returns an error when the directory cannot be listed, or when any file in
/// it fails to parse.
pub fn read_dir(dir: &Path) -> Result<Schema, Error> {
    read_dir_with(dir, &Overlay::default())
}

/// Parse every `.rs` file directly inside `dir` and apply `overlay`.
///
/// Non-recursive on purpose: `mod.rs` sits beside the schemas and a schema
/// directory is flat. Point the reader at each directory you mean.
///
/// # Errors
/// Returns an error when the directory cannot be listed, or when any file in
/// it fails to parse.
pub fn read_dir_with(dir: &Path, overlay: &Overlay) -> Result<Schema, Error> {
    let label = dir.display().to_string();
    let entries = std::fs::read_dir(dir).map_err(|e| Error {
        file: label.clone(),
        line: 0,
        message: format!("cannot list directory: {e}"),
    })?;

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| Error {
            file: label.clone(),
            line: 0,
            message: format!("cannot read directory entry: {e}"),
        })?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "rs") {
            files.push(path);
        }
    }
    // Directory order is filesystem order, which is not stable across machines.
    files.sort();

    read_files(&files, overlay)
}

/// Parse an explicit list of files and apply `overlay`.
///
/// # Errors
/// Returns an error when any file cannot be read or does not parse.
pub fn read_files(files: &[std::path::PathBuf], overlay: &Overlay) -> Result<Schema, Error> {
    let mut tables = Vec::new();
    for path in files {
        let label = path.file_name().map_or_else(
            || path.display().to_string(),
            |n| n.to_string_lossy().into_owned(),
        );
        tables.extend(parse::parse_file(path, &label)?);
    }
    tables.sort_by(|a, b| a.table_name.cmp(&b.table_name));

    let (relationships, unresolved) = relate::relate(&tables, overlay);
    Ok(Schema {
        tables,
        relationships,
        unresolved,
    })
}
