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

use std::collections::{BTreeMap, BTreeSet};
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

/// Take the store's exclusive advisory lock, or say who cannot.
///
/// The single-writer rule used to live in prose; on 2026-08-01 a second
/// process wrote table files the running GUI already had open and the store
/// was corrupted into a bus error. The lock is a sibling file (`db.lock`
/// beside `db`), `flock(LOCK_EX | LOCK_NB)`: advisory, cheap, released by the
/// OS however the process dies, so a crash can never wedge the next launch.
/// Every tool that opens the store for writing takes it; wt-migrate does.
///
/// # Errors
/// A message naming the lock when another process holds it, or when the lock
/// file cannot be created at all.
pub fn lock_store(store: &std::path::Path) -> Result<std::fs::File, String> {
    use std::os::fd::AsRawFd;

    let lock_path = store.with_extension("lock");
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {parent:?} for the store lock: {error}"))?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("could not open the store lock {lock_path:?}: {error}"))?;

    // Safety: a valid fd from the file just opened; flock takes no pointers.
    let taken = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    if taken {
        Ok(file)
    } else {
        Err(format!(
            "another process holds the store at {store:?} (lock {lock_path:?}). The store is \
             single-writer: close the other AgencyZero instance or migration tool first."
        ))
    }
}

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
    /// Tables whose migration was attempted and failed, with the reason. A
    /// subset of `reset`, kept apart because "no migration exists" and "the
    /// migration ran and could not" are different things to be told.
    pub failed: Vec<(String, String)>,
    /// Rows dropped from an otherwise-migrated table because they failed the
    /// sanity check — the field-shifted debris a mixed-shape source produces.
    pub dropped: Vec<(String, usize)>,
}

/// Salvage a mixed-shape `project_item` table, row by row, both readings.
///
/// A table written on both sides of a schema change holds v1 and v2 rows with
/// no per-row version to tell them apart, and any single reading misreads the
/// other generation into field-shifted debris. But the misreads are mutually
/// recognizable: a real item row has an `item-<uuid>` id and a real project
/// reference, and a shifted one cannot fake both. So the table is read twice,
/// once through each shape, each pass keeps only the rows that read sane, and
/// the union is the table's actual content. Rows already in `target` keep the
/// target's version (the newer store wins).
///
/// Returns (salvaged, skipped as already present, unreadable-in-both-shapes).
///
/// # Errors
/// When either store cannot be opened at all.
pub async fn salvage_items(source: &Path, target: &Path) -> eyre::Result<(usize, usize, usize)> {
    let open_v2 = |dir: &Path| {
        let config = worktable::prelude::DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            ProjectItemWorkTable::name_snake_case(),
            ProjectItemWorkTable::version(),
        );
        async move {
            let engine = ProjectItemPersistenceEngine::new(config).await?;
            ProjectItemWorkTable::load(engine).await
        }
    };

    // Pass one: the current shape. True v2 rows read correctly; v1 rows come
    // out shifted and fail the sanity check.
    let mut sane: BTreeMap<String, ProjectItemRow> = BTreeMap::new();
    let mut seen = 0usize;
    {
        let table = open_v2(source).await?;
        for row in table.select_all().execute()? {
            seen += 1;
            if looks_like_an_item(&row) {
                sane.insert(row.id.clone(), row);
            }
        }
    }

    // Pass two: the v1 shape, read the way the migration engine reads it.
    // True v1 rows read correctly (and gain an empty `reference` through the
    // same mapping the migration uses); v2 rows come out shifted and fail.
    // A row both passes read sanely is the same row.
    {
        let config = worktable::prelude::DiskConfig::new_with_table_name(
            source.to_string_lossy().into_owned(),
            "project_item",
            1,
        );
        let engine = worktable::prelude::ReadOnlyPersistenceEngine::create(config).await?;
        let table = v1::ProjectItemWorkTable::load(engine).await?;
        for row in table.select_all().execute()? {
            let carried = Migrator::migrate(row, &Context);
            if looks_like_an_item(&carried) {
                sane.entry(carried.id.clone()).or_insert(carried);
            }
        }
    }

    let unreadable = seen.saturating_sub(sane.len());
    let target_table = open_v2(target).await?;
    // The target is held to the same standard: debris rows it already carries
    // (the incident's shifted writes) leave as the history arrives.
    let mut existing: std::collections::BTreeSet<String> = BTreeSet::new();
    for row in target_table.select_all().execute()? {
        if looks_like_an_item(&row) {
            existing.insert(row.id);
        } else {
            target_table
                .delete(row.id)
                .await
                .map_err(|error| eyre::eyre!("{error}"))?;
        }
    }

    let mut salvaged = 0usize;
    let mut skipped = 0usize;
    for (id, row) in sane {
        if existing.contains(&id) {
            skipped += 1;
            continue;
        }
        target_table
            .insert(row)
            .map_err(|error| eyre::eyre!("{error}"))?;
        salvaged += 1;
    }
    target_table.wait_for_ops().await;
    Ok((salvaged, skipped, unreadable))
}

/// Whether a migrated item row is shaped like an item row at all.
///
/// The checkable facts: item ids are minted as `item-<uuid>` and a project
/// reference is `proj-<uuid>` or the task manager's fixed id. A field-shifted
/// row fails both instantly. Statuses are deliberately not checked — the
/// vocabulary grows (`shipped`, `planning`) and a new word must not read as
/// corruption.
fn looks_like_an_item(row: &ProjectItemRow) -> bool {
    row.id.starts_with("item-")
        && (row.project_id.starts_with("proj-") || row.project_id == "home-task-manager")
}

/// Delete migrated item rows that cannot be item rows. Returns how many.
async fn scrub_items(target: &Path) -> eyre::Result<usize> {
    let config = worktable::prelude::DiskConfig::new_with_table_name(
        target.to_string_lossy().into_owned(),
        ProjectItemWorkTable::name_snake_case(),
        ProjectItemWorkTable::version(),
    );
    let engine = ProjectItemPersistenceEngine::new(config).await?;
    let table = ProjectItemWorkTable::load(engine).await?;
    let doomed: Vec<String> = table
        .select_all()
        .execute()?
        .into_iter()
        .filter(|row| !looks_like_an_item(row))
        .map(|row| row.id)
        .collect();
    let count = doomed.len();
    for id in doomed {
        table
            .delete(id)
            .await
            .map_err(|error| eyre::eyre!("{error}"))?;
    }
    table.wait_for_ops().await;
    Ok(count)
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
                Ok(_) => {
                    /*
                     * The engine cannot tell a v2 row misread as v1 from a real
                     * v1 row — there is no per-row version — so a mixed-shape
                     * source comes out with some rows field-shifted: a project
                     * id where the item id belongs, a title where the project
                     * belongs. Those are checkable facts, so check them, and a
                     * row that fails is dropped and counted rather than kept as
                     * data. Losing a garbled row is a report line; keeping it
                     * is a store nobody can trust.
                     */
                    let dropped = scrub_items(target).await?;
                    if dropped > 0 {
                        report.dropped.push((table.clone(), dropped));
                    }
                    report.migrated.push(table);
                }
                Err(error) if error.to_string().contains("Unsupported version") => {
                    // Already current. Copy rather than fail, so a re-run is
                    // harmless.
                    copy_dir(&from, &target.join(&table)).await?;
                    report.copied.push(table);
                }
                /*
                 * One table that cannot be engine-migrated must not cost the
                 * others, and it must not cost its own readable rows either.
                 *
                 * The engine is all-or-nothing per table and a mixed-shape
                 * table defeats it: rows written on both sides of a schema
                 * change, no per-row version, so any single reading misreads
                 * one generation and the duplicate keys the misreads produce
                 * abort the run. That abort once took the transcripts, task
                 * log and projects with it (tables walked alphabetically),
                 * and its partial output was left behind as data.
                 *
                 * So: delete the partial output, then salvage. The table is
                 * read through both shapes, each pass keeps only rows that
                 * read sane, and the union carries forward. Only what is
                 * unreadable in both shapes is lost, and it is counted.
                 */
                Err(error) => {
                    let _ = tokio::fs::remove_dir_all(target.join(&table)).await;
                    match salvage_items(source, target).await {
                        Ok((salvaged, _, unreadable)) if salvaged > 0 => {
                            if unreadable > 0 {
                                report.dropped.push((table.clone(), unreadable));
                            }
                            report.failed.push((
                                table.clone(),
                                format!(
                                    "engine migration failed ({error}); salvaged {salvaged} \
                                     row(s) by two-shape reading instead"
                                ),
                            ));
                            report.migrated.push(table);
                        }
                        salvage => {
                            if let Err(salvage_error) = salvage {
                                let _ = tokio::fs::remove_dir_all(target.join(&table)).await;
                                report.failed.push((
                                    table.clone(),
                                    format!("{error}; salvage also failed: {salvage_error}"),
                                ));
                            } else {
                                report.failed.push((table.clone(), error.to_string()));
                            }
                            report.reset.push(table);
                        }
                    }
                }
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

#[cfg(test)]
mod scrub_tests {
    use super::*;

    fn item(id: &str, project: &str) -> ProjectItemRow {
        ProjectItemRow {
            id: id.into(),
            project_id: project.into(),
            title: "a title".into(),
            status: "pending".into(),
            position: 0,
            reference: String::new(),
        }
    }

    /*
     * The debris this guards against is real: the live store held a row whose
     * id slot carried a project id and whose title slot carried a status,
     * written by the engine reading a v2 row through the v1 shape. The scrub
     * keeps every row that is shaped like an item — including task-manager
     * rows and unfamiliar statuses — and drops only what cannot be one.
     */
    #[tokio::test]
    async fn shifted_debris_is_dropped_and_real_rows_survive() {
        let dir = std::env::temp_dir().join(format!("wt-migrate-scrub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp dir");

        {
            let config = DiskConfig::new_with_table_name(
                dir.to_string_lossy().into_owned(),
                ProjectItemWorkTable::name_snake_case(),
                ProjectItemWorkTable::version(),
            );
            let engine = ProjectItemPersistenceEngine::new(config)
                .await
                .expect("engine");
            let table = ProjectItemWorkTable::load(engine).await.expect("table");

            table.insert(item("item-1", "proj-846b")).expect("good row");
            table
                .insert(item("item-2", "home-task-manager"))
                .expect("tm row");
            let mut odd = item("item-3", "proj-846b");
            odd.status = "someday-maybe".into();
            table.insert(odd).expect("odd status row");
            // The real debris shapes, verbatim from the incident.
            table
                .insert(item("proj-6cf80cb0", "Recover the item list"))
                .expect("shifted row");
            table
                .insert(item("ment)", "item-03fd09c6"))
                .expect("worse row");
            table.wait_for_ops().await;
        }

        let dropped = scrub_items(&dir).await.expect("scrub");
        assert_eq!(dropped, 2, "exactly the two debris rows go");

        let config = DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            ProjectItemWorkTable::name_snake_case(),
            ProjectItemWorkTable::version(),
        );
        let engine = ProjectItemPersistenceEngine::new(config)
            .await
            .expect("engine");
        let table = ProjectItemWorkTable::load(engine).await.expect("table");
        let mut kept: Vec<String> = table
            .select_all()
            .execute()
            .expect("rows")
            .into_iter()
            .map(|row| row.id)
            .collect();
        kept.sort();
        assert_eq!(kept, vec!["item-1", "item-2", "item-3"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
