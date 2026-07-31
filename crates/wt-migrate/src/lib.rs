//! Carrying a store forward when a table's columns change.
//!
//! # Why anything is needed
//!
//! WorkTable persists rows with rkyv, positionally, and nothing on disk records
//! which columns produced them. A table whose columns change reads every
//! existing row through the *new* layout, and rkyv obliges. Nothing errors. The
//! table opens cleanly and every field has shifted by one:
//!
//! ```text
//! id:         "ment)\0\0\0"          <- debris
//! project_id: "item-03fd09c6-..."    <- the real id
//! title:      "proj-846b5542-..."    <- the real project_id
//! status:     "Reflect PR merge..."  <- the real title
//! ```
//!
//! Real output, from this repository's `project_item` on 2026-08-01, after a
//! `reference` column was added and the fingerprint was not.
//!
//! The fingerprint catches that, and the recovery was to move the whole store
//! aside and start clean: safe, and it costs every project, transcript, task log
//! and item over one changed column.
//!
//! # What happens instead
//!
//! A changed table is **migrated**, row by row, through
//! [`worktable::migration_engine`]. Every other table is copied across
//! untouched, which is correct because an unchanged column list means the rows
//! are still exactly readable.
//!
//! Which tables are unchanged is not a hand-maintained list. The schema
//! fingerprint is already a per-table column list, so the stored one and the
//! current one are diffed: identical entry, copy it. That way a future column
//! change is handled without editing this file, and a table nobody thought
//! about cannot be silently dropped.
//!
//! # Source and target are different directories
//!
//! The source is only read, so a run that fails partway leaves the only copy of
//! the data intact and there is nothing to undo. The caller keeps the source
//! until it is satisfied with the target.
//!
//! Migration needed worktable 0.9.3: `worktable_version!` would not compile for
//! a `String` primary key before it, and every table here has one.

use std::collections::BTreeMap;
use std::path::Path;

// The app's own fingerprint, included rather than copied: a second copy of this
// string would defeat the point of having one.
#[path = "../../../apps/gui/src/db/fingerprint.rs"]
#[allow(
    dead_code,
    reason = "the app uses check_schema; this crate wants only the string"
)]
mod fingerprint;
pub use fingerprint::{FINGERPRINT_KEY, SCHEMA_FINGERPRINT as CURRENT_FINGERPRINT};

use worktable::migration::Migration;
use worktable::prelude::*;
use worktable::{migration_engine, worktable};

/// `project_item` as it shipped before `reference` was added.
///
/// `worktable_version!` rather than `worktable!`: a historical shape exists to
/// be read once, in order, and dropped. The table *name* is what ties the two
/// together on disk, so this keeps `ProjectItem` and differs only by version.
mod v1 {
    use worktable::prelude::*;
    use worktable::worktable_version;

    worktable_version!(
        name: ProjectItem,
        version: 1,
        columns: {
            id: String primary_key,
            project_id: String,
            title: String,
            status: String,
            position: u32,
        },
        indexes: {
            project_idx: project_id,
        },
    );
}

// The current shape, restated so the engine has a target. It must match
// `apps/gui/src/db/schema/project_item.rs`, and `the_target_matches_the_app`
// asserts that rather than trusting whoever edits one of them next.
worktable!(
    name: ProjectItem,
    version: 2,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        title: String,
        status: String,
        position: u32,
        reference: String,
    },
    indexes: {
        project_idx: project_id,
    },
);

/// Nothing outside a row is needed to carry one forward, so far. A later
/// migration that needs a key, a clock or a lookup puts it here.
#[derive(Debug, Default)]
pub struct Context;

pub struct Migrator;

impl Migration<v1::ProjectItemRow, ProjectItemRow> for Migrator {
    type Context = Context;

    fn migrate(row: v1::ProjectItemRow, _ctx: &Self::Context) -> ProjectItemRow {
        ProjectItemRow {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            status: row.status,
            position: row.position,
            /*
             * Empty, not a guess. `reference` holds the pull request an item
             * shipped as, and a row written before the column existed shipped
             * as nothing. Inventing a number would put a link in the UI that
             * goes somewhere real and wrong.
             */
            reference: String::new(),
        }
    }
}

migration_engine!(
    migration: Migrator,
    current: ProjectItemWorkTable,
    ctx: Context,
    version_tables: {
        1 => v1::ProjectItemWorkTable,
    },
);

/// Tables this crate knows how to migrate, by directory name.
///
/// Anything else with a changed column list is left behind rather than
/// guessed at, and [`Report::reset`] says so out loud.
const MIGRATABLE: [&str; 1] = ["project_item"];

/// Split a fingerprint into table name and column list.
///
/// The format is its own documentation: `name(col,col);name(col);`. An entry
/// that does not parse is skipped rather than guessed at, because a fingerprint
/// this code cannot read is exactly when it must not claim a table is
/// unchanged.
#[must_use]
pub fn columns_by_table(fingerprint: &str) -> BTreeMap<String, String> {
    fingerprint
        .split(';')
        .filter_map(|entry| {
            let entry = entry.trim();
            let open = entry.find('(')?;
            let close = entry.rfind(')')?;
            (close > open).then(|| {
                (
                    entry[..open].to_string(),
                    entry[open + 1..close].to_string(),
                )
            })
        })
        .collect()
}

/// Which tables can be copied across as they are.
///
/// A table qualifies when it appears in both fingerprints with an identical
/// column list. A table new in `current` has nothing on disk to copy; a table
/// that changed needs migrating, not copying.
#[must_use]
pub fn unchanged(stored: &str, current: &str) -> Vec<String> {
    let stored = columns_by_table(stored);
    columns_by_table(current)
        .into_iter()
        .filter(|(table, columns)| stored.get(table) == Some(columns))
        .map(|(table, _)| table)
        .collect()
}

/// What a run did, for the log and for telling the user.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Tables whose rows were rewritten into the new shape.
    pub migrated: Vec<String>,
    /// Tables copied across untouched.
    pub copied: Vec<String>,
    /// Tables that start empty because their columns changed and nothing here
    /// knows how to convert them.
    pub reset: Vec<String>,
}

/// Carry a store from `source` to `target`.
///
/// `target` is created and only written to. `source` is only read.
///
/// A table already at the current version is copied rather than migrated, which
/// is what makes this safe to run twice: the engine reports that case as
/// `Unsupported version: N`, having no hop from the version it is already at.
///
/// # Errors
/// When a directory cannot be read or written. A failure leaves `source`
/// untouched, so the caller can retry or fall back to starting clean.
pub async fn carry_forward(
    source: &Path,
    target: &Path,
    stored: &str,
    current: &str,
) -> eyre::Result<Report> {
    tokio::fs::create_dir_all(target).await?;
    let safe = unchanged(stored, current);
    let mut report = Report::default();

    for table in columns_by_table(current).into_keys() {
        let from = source.join(&table);
        if !from.exists() {
            // Nothing on disk yet, so nothing is lost by leaving it out.
            continue;
        }
        if safe.contains(&table) {
            copy_dir(&from, &target.join(&table)).await?;
            report.copied.push(table);
            continue;
        }
        if MIGRATABLE.contains(&table.as_str()) {
            match MigratorEngine::migrate(
                &source.to_string_lossy(),
                &target.to_string_lossy(),
                &Context,
            )
            .await
            {
                Ok(_) => report.migrated.push(table),
                Err(error) if error.to_string().contains("Unsupported version") => {
                    // Already current. Copy rather than fail, so a re-run is
                    // harmless.
                    copy_dir(&from, &target.join(&table)).await?;
                    report.copied.push(table);
                }
                Err(error) => return Err(error),
            }
            continue;
        }
        report.reset.push(table);
    }

    Ok(report)
}

/// Copy a directory, contents and all.
async fn copy_dir(from: &Path, to: &Path) -> eyre::Result<()> {
    tokio::fs::create_dir_all(to).await?;
    let mut entries = tokio::fs::read_dir(from).await?;
    while let Some(entry) = entries.next_entry().await? {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if entry.file_type().await?.is_dir() {
            Box::pin(copy_dir(&source, &target)).await?;
        } else {
            tokio::fs::copy(&source, &target).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str =
        "kv(key,value);project(id,name);project_item(id,project_id,title,status,position);";
    const NEW: &str = "kv(key,value);project(id,name);project_item(id,project_id,title,status,position,reference);";

    /// One column moved on one table, and only that table needs any work.
    #[test]
    fn only_the_changed_table_needs_migrating() {
        let safe = unchanged(OLD, NEW);
        assert_eq!(safe, vec!["kv".to_string(), "project".to_string()]);
        assert!(!safe.contains(&"project_item".to_string()));
    }

    /// A table added since the store was written has no rows on disk, so there
    /// is nothing to carry and nothing to report as lost.
    #[test]
    fn a_brand_new_table_is_not_treated_as_a_loss() {
        assert_eq!(
            unchanged("kv(key,value);", "kv(key,value);pull_request(id,url);"),
            vec!["kv".to_string()]
        );
    }

    /// Reordering columns changes the on-disk layout as much as adding one, so
    /// it must not read as unchanged.
    #[test]
    fn a_reordered_column_list_is_a_change() {
        assert!(unchanged("t(a,b);", "t(b,a);").is_empty());
    }

    /// A fingerprint this code cannot parse must not produce a confident
    /// "unchanged": being wrong there means reading rows through the wrong
    /// layout, which is the failure the fingerprint exists to catch.
    #[test]
    fn an_unparseable_entry_is_skipped_rather_than_guessed_at() {
        assert!(columns_by_table("garbage without parens;").is_empty());
        assert!(unchanged("t(a);", "garbage;").is_empty());
    }

    /*
     * The target shape is restated in this crate, so it can drift from the one
     * the app writes. If it does, a migration produces rows the app then
     * misreads, which is the original bug wearing a migration as a disguise.
     * Exhaustive on both sides, so a column added to either stops this
     * compiling in the commit that adds it.
     */
    #[test]
    fn the_target_matches_the_app() {
        let ProjectItemRow {
            id,
            project_id,
            title,
            status,
            position,
            reference,
        } = ProjectItemRow {
            id: "i".into(),
            project_id: "p".into(),
            title: "t".into(),
            status: "new".into(),
            position: 1,
            reference: "36".into(),
        };
        let theirs = app_project_item::ProjectItemRow {
            id,
            project_id,
            title,
            status,
            position,
            reference,
        };
        assert_eq!(theirs.status, "new");
        assert_eq!(theirs.reference, "36");
    }
}

/// The app's own `project_item`, for the drift check above.
#[cfg(test)]
#[path = "../../../apps/gui/src/db/schema/project_item.rs"]
mod app_project_item;
