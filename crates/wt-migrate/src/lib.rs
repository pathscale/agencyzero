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

/// Result of rebuilding a task log through its surviving project index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskLogRecoveryReport {
    pub rows: usize,
    pub projects: usize,
}

#[cfg(test)]
mod profile_repair_tests {
    use super::*;
    use app_schema::kv::{KvPersistenceEngine, KvWorkTable};
    use app_schema::message::{MessagePersistenceEngine, MessageRow, MessageWorkTable};

    async fn open_messages(dir: &Path) -> MessageWorkTable {
        let config = DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            MessageWorkTable::name_snake_case(),
            MessageWorkTable::version(),
        );
        let engine = MessagePersistenceEngine::new(config).await.unwrap();
        MessageWorkTable::load(engine).await.unwrap()
    }

    fn message(id: &str, project: &str, at: &str) -> MessageRow {
        MessageRow {
            id: id.into(),
            project_id: project.into(),
            item_id: String::new(),
            author: "user".into(),
            agent: "codex".into(),
            moderation: String::new(),
            model: "gpt-test".into(),
            permission: "auto".into(),
            usage: String::new(),
            stop: "completed".into(),
            exit_code: 0,
            body: id.into(),
            created_at: at.into(),
        }
    }

    #[tokio::test]
    async fn message_window_merge_is_bounded_verified_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let source_table = open_messages(&source).await;
        for row in [
            message("before", "project", "2026-08-09T20:01:59+00:00"),
            message("wanted", "project", "2026-08-09T20:02:00+00:00"),
            message("other-project", "other", "2026-08-09T20:03:00+00:00"),
            message("after", "project", "2026-08-09T20:20:00+00:00"),
        ] {
            source_table.insert(row).unwrap();
        }
        source_table.wait_for_ops().await.unwrap();
        source_table.close().await.unwrap();

        let report = merge_message_window(
            &source,
            &target,
            "project",
            "2026-08-09T20:02:00+00:00",
            "2026-08-09T20:20:00+00:00",
        )
        .await
        .unwrap();
        assert_eq!(
            report,
            MessageMergeReport {
                candidates: 1,
                inserted: 1,
                already_present: 0,
            }
        );
        let repeated = merge_message_window(
            &source,
            &target,
            "project",
            "2026-08-09T20:02:00+00:00",
            "2026-08-09T20:20:00+00:00",
        )
        .await
        .unwrap();
        assert_eq!(repeated.inserted, 0);
        assert_eq!(repeated.already_present, 1);
    }

    #[tokio::test]
    async fn session_restore_refuses_to_replace_a_different_live_pointer() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        restore_provider_session(&target, "project", "codex", "recovered")
            .await
            .unwrap();
        restore_provider_session(&target, "project", "codex", "recovered")
            .await
            .unwrap();
        let error = restore_provider_session(&target, "project", "codex", "different")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("another nonempty session"));

        let config = DiskConfig::new_with_table_name(
            target.to_string_lossy().into_owned(),
            KvWorkTable::name_snake_case(),
            KvWorkTable::version(),
        );
        let engine = KvPersistenceEngine::new(config).await.unwrap();
        let table = KvWorkTable::load(engine).await.unwrap();
        let row = table
            .select_all()
            .execute()
            .unwrap()
            .into_iter()
            .find(|row| row.key == "session:codex:project")
            .unwrap();
        assert_eq!(row.value, "recovered");
    }
}

/// Result of rebuilding a transcript through its surviving primary index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageRecoveryReport {
    pub rows: usize,
    pub projects: usize,
}

/// Result of merging an explicitly bounded transcript window into a store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageMergeReport {
    pub candidates: usize,
    pub inserted: usize,
    pub already_present: usize,
}

/// Result of rebuilding pull requests through their surviving primary index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PullRequestRecoveryReport {
    pub rows: usize,
    pub projects: usize,
}

/// Result of rebuilding pull requests while omitting rows whose indexed bytes
/// no longer validate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestSalvageReport {
    pub rows: usize,
    pub projects: usize,
    pub skipped: Vec<String>,
}

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

/// `project_item` as it shipped before `priority` was added.
mod v2 {
    use worktable::prelude::*;
    use worktable::worktable_version;

    worktable_version!(
        name: ProjectItem,
        version: 2,
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
}

// The current shape, restated so the engine has a target. It must match
// `apps/gui/src/db/schema/project_item.rs`, and `the_target_matches_the_app`
// asserts that rather than trusting whoever edits one of them next.
worktable!(
    name: ProjectItem,
    version: 3,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        title: String,
        status: String,
        position: u32,
        reference: String,
        priority: u8,
    },
    indexes: {
        project_idx: project_id,
    },
);

// `task_log` restated for `rebuild_task_log`, column for column against
// `apps/gui/src/db/schema/task_log.rs`; `the_task_log_matches_the_app` holds
// the two together. Same shape, not a migration: the rebuild exists to launder
// a table's internal page accounting, not its rows.
worktable!(
    name: TaskLog,
    persist: true,
    columns: {
        id: String primary_key,
        tool_call_id: String,
        project_id: String,
        item_id: String,
        label: String,
        tool: String,
        ok: i64,
        output: String,
        duration_ms: i64,
        exit_code: i64,
        finished_at: String,
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

// The engine walks the versions in order, so each step carries a row one
// shape forward: v1 to v2 adds `reference`, v2 to current adds `priority`.
impl Migration<v1::ProjectItemRow, v2::ProjectItemRow> for Migrator {
    type Context = Context;

    fn migrate(row: v1::ProjectItemRow, _ctx: &Self::Context) -> v2::ProjectItemRow {
        v2::ProjectItemRow {
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

impl Migration<v2::ProjectItemRow, ProjectItemRow> for Migrator {
    type Context = Context;

    fn migrate(row: v2::ProjectItemRow, _ctx: &Self::Context) -> ProjectItemRow {
        ProjectItemRow {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            status: row.status,
            position: row.position,
            reference: row.reference,
            /*
             * Normal, which is the only honest answer. Priority says how much
             * an item matters relative to its neighbours, and a store written
             * before the column existed holds no evidence either way.
             * Promoting rows by position would invent an ordering the owner
             * never expressed.
             */
            priority: NORMAL_PRIORITY,
        }
    }
}

/// What an unprioritised item carries. Restated from `projects.rs` rather than
/// imported: `wt-migrate` does not depend on the app, deliberately, so that a
/// migration keeps compiling when the app moves on.
const NORMAL_PRIORITY: u8 = 0;

migration_engine!(
    migration: Migrator,
    current: ProjectItemWorkTable,
    ctx: Context,
    version_tables: {
        1 => v1::ProjectItemWorkTable,
        2 => v2::ProjectItemWorkTable,
    },
);

/// Tables this crate knows how to migrate, by directory name.
///
/// Anything else with a changed column list is left behind rather than
/// guessed at, and [`Report::reset`] says so out loud.
const MIGRATABLE: [&str; 1] = ["project_item"];

/// Why the store lock could not be taken.
#[derive(Debug)]
pub enum StoreLockError {
    /// Another live process owns the advisory lock. The optional owner text is
    /// diagnostic metadata written by recent AgencyZero and `wt-migrate`
    /// builds; the kernel lock, never this text, is the source of truth.
    Busy {
        store: std::path::PathBuf,
        lock: std::path::PathBuf,
        owner: Option<String>,
    },
    /// The lock could not be created, opened, or operated for another reason.
    Unavailable(String),
}

impl StoreLockError {
    /// True only for a normal single-writer collision. GUI startup treats this
    /// as an already-open profile and exits cleanly; filesystem failures remain
    /// real startup errors.
    #[must_use]
    pub const fn is_busy(&self) -> bool {
        matches!(self, Self::Busy { .. })
    }
}

impl std::fmt::Display for StoreLockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy { store, lock, owner } => {
                write!(
                    formatter,
                    "another process holds the store at {store:?} (lock {lock:?}). The store is \
                     single-writer: close the other AgencyZero instance or migration tool first"
                )?;
                if let Some(owner) = owner {
                    write!(formatter, "; lock owner reports {owner}")?;
                }
                Ok(())
            }
            Self::Unavailable(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for StoreLockError {}

fn lock_owner() -> String {
    let executable = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    format!("pid={} executable={executable}", std::process::id())
}

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
/// A typed busy result when another process holds it, or an unavailable result
/// when the lock file cannot be created or operated at all.
pub fn lock_store(store: &std::path::Path) -> Result<std::fs::File, StoreLockError> {
    use std::io::{Seek, Write};
    use std::os::fd::AsRawFd;

    /*
     * Appended, not `with_extension`, which replaces everything after the last
     * dot. `db`, `db.next-<stamp>` and `db.pre-migration-<stamp>` all reduced
     * to the single path `db.lock`, so the lock guarded a name rather than a
     * store. Two consequences, both real: `salvage-items db.pre-migration-X db`
     * took the same lock twice in one process and always failed, since flock
     * conflicts across open file descriptions even within a process; and
     * recovering from a kept backup was refused whenever the GUI was open,
     * naming a store the command was not touching.
     *
     * Appending keeps `db` on `db.lock`, which is the file the GUI holds, so
     * the one collision that matters still works.
     */
    let mut lock_name = store.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock_path = std::path::PathBuf::from(lock_name);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            StoreLockError::Unavailable(format!(
                "could not create {parent:?} for the store lock: {error}"
            ))
        })?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            StoreLockError::Unavailable(format!(
                "could not open the store lock {lock_path:?}: {error}"
            ))
        })?;

    // Safety: a valid fd from the file just opened; flock takes no pointers.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            let owner = std::fs::read_to_string(&lock_path)
                .ok()
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty());
            return Err(StoreLockError::Busy {
                store: store.to_path_buf(),
                lock: lock_path,
                owner,
            });
        }
        return Err(StoreLockError::Unavailable(format!(
            "could not lock the store at {store:?} with {lock_path:?}: {error}"
        )));
    }

    // The advisory lock is the authority. This short record only makes a
    // collision actionable in logs and shell probes, instead of leaving an
    // empty lock file that cannot say which live process owns it.
    file.set_len(0).map_err(|error| {
        StoreLockError::Unavailable(format!(
            "could not clear store lock metadata at {lock_path:?}: {error}"
        ))
    })?;
    file.rewind().map_err(|error| {
        StoreLockError::Unavailable(format!(
            "could not seek store lock metadata at {lock_path:?}: {error}"
        ))
    })?;
    file.write_all(lock_owner().as_bytes()).map_err(|error| {
        StoreLockError::Unavailable(format!(
            "could not write store lock metadata at {lock_path:?}: {error}"
        ))
    })?;
    file.flush().map_err(|error| {
        StoreLockError::Unavailable(format!(
            "could not flush store lock metadata at {lock_path:?}: {error}"
        ))
    })?;

    Ok(file)
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
            // Two steps, because each migration carries a row one shape
            // forward: v1 gains `reference`, then v2 gains `priority`.
            let carried: v2::ProjectItemRow = Migrator::migrate(row, &Context);
            let carried: ProjectItemRow = Migrator::migrate(carried, &Context);
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
    target_table
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("project_item persistence failed: {error}"))?;
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
    table
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("project_item persistence failed: {error}"))?;
    Ok(count)
}

/// The app's schema, included whole so [`rebuild_store`] can open every
/// table by its real shape. Included rather than restated: nine tables
/// restated by hand is nine chances to drift, and the two restatements this
/// crate already carries each needed a test to hold them still.
#[path = "../../../apps/gui/src/db/schema"]
pub mod app_schema {
    pub mod agent_io;
    pub mod approval_rule;
    pub mod kv;
    pub mod message;
    pub mod project;
    pub mod project_item;
    pub mod pull_request;
    pub mod task_log;
    pub mod usage_ledger;
}

/// Merge one project's bounded message window into an existing store.
///
/// Rows retain their original ids and timestamps. Existing ids are skipped,
/// making a repair safe to re-run after interruption. The caller must hold
/// both stores' process locks for the whole operation.
pub async fn merge_message_window(
    source: &Path,
    target: &Path,
    project_id: &str,
    after_inclusive: &str,
    before_exclusive: &str,
) -> eyre::Result<MessageMergeReport> {
    use app_schema::message::{MessagePersistenceEngine, MessageWorkTable};

    let open = |dir: &Path| {
        let config = DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            MessageWorkTable::name_snake_case(),
            MessageWorkTable::version(),
        );
        async move {
            let engine = MessagePersistenceEngine::new(config).await?;
            MessageWorkTable::load(engine).await
        }
    };

    let source_table = open(source).await?;
    let mut candidates: Vec<_> = source_table
        .select_all()
        .execute()?
        .into_iter()
        .filter(|row| {
            row.project_id == project_id
                && row.created_at.as_str() >= after_inclusive
                && row.created_at.as_str() < before_exclusive
        })
        .collect();
    candidates.sort_by(|left, right| left.created_at.cmp(&right.created_at));

    let target_table = open(target).await?;
    let mut target_ids: BTreeSet<String> = target_table
        .select_all()
        .execute()?
        .into_iter()
        .map(|row| row.id)
        .collect();
    let mut inserted = 0;
    for row in &candidates {
        if target_ids.insert(row.id.clone()) {
            target_table
                .insert(row.clone())
                .map_err(|error| eyre::eyre!("message {}: {error}", row.id))?;
            inserted += 1;
        }
    }
    target_table
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("message persistence failed: {error}"))?;

    let verified: BTreeSet<String> = target_table
        .select_all()
        .execute()?
        .into_iter()
        .map(|row| row.id)
        .collect();
    if let Some(missing) = candidates.iter().find(|row| !verified.contains(&row.id)) {
        return Err(eyre::eyre!(
            "message {} was absent after the merge drained",
            missing.id
        ));
    }
    source_table
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close source message table: {error}"))?;
    target_table
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close target message table: {error}"))?;

    Ok(MessageMergeReport {
        candidates: candidates.len(),
        inserted,
        already_present: candidates.len() - inserted,
    })
}

/// Restore one explicit provider-session pointer without overwriting a
/// different nonempty pointer. The caller must hold the store lock.
pub async fn restore_provider_session(
    target: &Path,
    project_id: &str,
    agent: &str,
    session_id: &str,
) -> eyre::Result<()> {
    restore_provider_session_forced(target, project_id, agent, session_id, false).await
}

/// As [`restore_provider_session`], but `force` allows redirecting a project
/// that already points somewhere else.
///
/// The guard exists because silently repointing a live conversation is the
/// worse failure. Correcting a pointer that was written to the wrong project
/// is the case it gets in the way of, so that case has to say so explicitly.
pub async fn restore_provider_session_forced(
    target: &Path,
    project_id: &str,
    agent: &str,
    session_id: &str,
    force: bool,
) -> eyre::Result<()> {
    use app_schema::kv::{KvPersistenceEngine, KvRow, KvWorkTable};

    if session_id.is_empty() {
        return Err(eyre::eyre!("a session id may not be empty"));
    }
    let key = match agent {
        "claude" => format!("session:{project_id}"),
        "codex" => format!("session:codex:{project_id}"),
        other => return Err(eyre::eyre!("unsupported provider: {other}")),
    };
    let config = DiskConfig::new_with_table_name(
        target.to_string_lossy().into_owned(),
        KvWorkTable::name_snake_case(),
        KvWorkTable::version(),
    );
    let engine = KvPersistenceEngine::new(config).await?;
    let table = KvWorkTable::load(engine).await?;
    if let Some(existing) = table
        .select_all()
        .execute()?
        .into_iter()
        .find(|row| row.key == key)
        && !existing.value.is_empty()
        && existing.value != session_id
        && !force
    {
        return Err(eyre::eyre!(
            "{agent} already points at another nonempty session: {}",
            existing.value
        ));
    }
    table
        .upsert(KvRow {
            key,
            value: session_id.to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        })
        .await?;
    table
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("kv persistence failed: {error}"))?;
    table
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close kv table: {error}"))?;
    Ok(())
}

/// Drop a pending-reset marker, so the project resumes its pointer again.
///
/// The marker shadows a perfectly good session id: the pointer survives a
/// reset, but every reader that asks "what continues next" is told nothing
/// does. Clearing it is the difference between a session that is present and
/// one that is merely stored.
pub async fn clear_fresh_session(target: &Path, project_id: &str, agent: &str) -> eyre::Result<()> {
    use app_schema::kv::{KvPersistenceEngine, KvRow, KvWorkTable};

    let key = format!("fresh-session-next:{agent}:{project_id}");
    let config = DiskConfig::new_with_table_name(
        target.to_string_lossy().into_owned(),
        KvWorkTable::name_snake_case(),
        KvWorkTable::version(),
    );
    let engine = KvPersistenceEngine::new(config).await?;
    let table = KvWorkTable::load(engine).await?;
    let existing = table
        .select_all()
        .execute()?
        .into_iter()
        .find(|row| row.key == key);
    match existing {
        None => {
            println!("no pending reset for {agent} on {project_id}");
            return Ok(());
        }
        Some(row) => println!("clearing pending reset (value {:?})", row.value),
    }
    // Emptied rather than deleted: the reader tests for "1", so an empty value
    // is already "no pending reset", and it avoids a delete on a table this
    // tool has no other reason to remove rows from.
    table
        .upsert(KvRow {
            key,
            value: String::new(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        })
        .await?;
    table
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("kv persistence failed: {error}"))?;
    table
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close kv table: {error}"))?;
    Ok(())
}

/// Rebuild every table of a store, row by row, into a brand-new store.
///
/// The nuclear form of [`rebuild_task_log`], for when the poisoned table
/// cannot be named: every row that reads through the current schema is
/// inserted into a fresh table in `target`, and every table's internal page
/// accounting starts from zero. The kv rows carry the schema fingerprint
/// across, so the result boots as a current store.
///
/// Rows are carried verbatim and unfiltered: the poison this launders lives
/// in page accounting, not in rows, and a row that reads at all reads
/// correctly. Returns (table, rows carried) per table.
///
/// # Errors
/// When any table cannot be opened or any insert fails: a half-rebuilt store
/// must not pass as a whole one, so the caller deletes the target and
/// investigates. Run it against a copy or a snapshot, never the live store.
pub async fn rebuild_store(source: &Path, target: &Path) -> eyre::Result<Vec<(String, usize)>> {
    macro_rules! carry {
        ($module:ident, $engine:ident, $table:ident) => {{
            // Progress to stderr before the scan, so the one line a fatal
            // signal cuts off names the table that killed it.
            eprintln!(
                "scanning {}...",
                app_schema::$module::$table::name_snake_case()
            );
            let open = |dir: &Path| {
                let config = worktable::prelude::DiskConfig::new_with_table_name(
                    dir.to_string_lossy().into_owned(),
                    app_schema::$module::$table::name_snake_case(),
                    app_schema::$module::$table::version(),
                );
                async move {
                    let engine = app_schema::$module::$engine::new(config).await?;
                    app_schema::$module::$table::load(engine).await
                }
            };
            let rows = {
                let table = open(source).await?;
                table.select_all().execute()?
            };
            let count = rows.len();
            let fresh = open(target).await?;
            for row in rows {
                fresh.insert(row).map_err(|error| {
                    eyre::eyre!(
                        "{}: {error}",
                        app_schema::$module::$table::name_snake_case()
                    )
                })?;
            }
            fresh.wait_for_ops().await.map_err(|error| {
                eyre::eyre!(
                    "{} persistence failed: {error}",
                    app_schema::$module::$table::name_snake_case()
                )
            })?;
            (
                app_schema::$module::$table::name_snake_case().to_string(),
                count,
            )
        }};
    }

    Ok(vec![
        carry!(kv, KvPersistenceEngine, KvWorkTable),
        carry!(project, ProjectPersistenceEngine, ProjectWorkTable),
        carry!(
            project_item,
            ProjectItemPersistenceEngine,
            ProjectItemWorkTable
        ),
        carry!(message, MessagePersistenceEngine, MessageWorkTable),
        carry!(task_log, TaskLogPersistenceEngine, TaskLogWorkTable),
        carry!(agent_io, AgentIoRowPersistenceEngine, AgentIoRowWorkTable),
        carry!(
            usage_ledger,
            UsageLedgerPersistenceEngine,
            UsageLedgerWorkTable
        ),
        carry!(
            approval_rule,
            ApprovalRulePersistenceEngine,
            ApprovalRuleWorkTable
        ),
        carry!(
            pull_request,
            PullRequestPersistenceEngine,
            PullRequestWorkTable
        ),
    ])
}

/// Rebuild `task_log` row by row into a fresh table, discarding the old
/// table's internal page accounting.
///
/// # Why a rebuild verb exists at all
///
/// An oversized insert (a row larger than a 16K page) does not fail cleanly:
/// it leaves the table's free-page accounting inconsistent while every
/// existing row still reads back fine. The damage is invisible until the next
/// append lands on a poisoned page, and then the store dies of SIGBUS. A file
/// copy of such a table copies the poison; twice this store was "repaired"
/// that way and twice it died on the next session. Reading the rows out and
/// inserting them into a brand-new table is the only copy that launders the
/// accounting.
///
/// `target` must not already contain a `task_log` table: the point is a fresh
/// one, and merging into damaged accounting would defeat it. Rows that do not
/// look like task-log rows (id `log-*`, project `proj-*`) are dropped as
/// debris and counted.
///
/// Returns (rebuilt, dropped-as-debris).
///
/// # Errors
/// When the source cannot be opened or the target insert fails. Run against a
/// copy of the source: the engine used to scan it is the ordinary read-write
/// one.
pub async fn rebuild_task_log(source: &Path, target: &Path) -> eyre::Result<(usize, usize)> {
    let open = |dir: &Path| {
        let config = worktable::prelude::DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            TaskLogWorkTable::name_snake_case(),
            TaskLogWorkTable::version(),
        );
        async move {
            let engine = TaskLogPersistenceEngine::new(config).await?;
            TaskLogWorkTable::load(engine).await
        }
    };

    let mut rebuilt = 0usize;
    let mut dropped = 0usize;
    let rows = {
        let table = open(source).await?;
        table.select_all().execute()?
    };
    let target_table = open(target).await?;
    for row in rows {
        if row.id.starts_with("log-") && row.project_id.starts_with("proj-") {
            target_table
                .insert(row)
                .map_err(|error| eyre::eyre!("{error}"))?;
            rebuilt += 1;
        } else {
            dropped += 1;
        }
    }
    target_table
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("task_log persistence failed: {error}"))?;
    Ok((rebuilt, dropped))
}

/// Recover a task log whose string primary index is unreadable.
///
/// The non-unique `project_idx` remains an independent map from project ids to
/// row links. Recovery copies only `task_log` into private scratch space,
/// replaces the scratch primary index with an empty one, then uses WorkTable's
/// explicit recovery load to validate and read every surviving secondary-index
/// entry. Rows are inserted into a fresh target table, which reconstructs both
/// indexes and data-page accounting.
///
/// `source` is never opened for writing and is never modified. `target` must
/// not exist. A caller can validate the result before swapping only the
/// repaired table into a store.
pub async fn recover_task_log_index(
    source: &Path,
    target: &Path,
) -> eyre::Result<TaskLogRecoveryReport> {
    use std::collections::{BTreeMap, BTreeSet};

    let scratch = tempfile::tempdir()?;
    let scratch_store = scratch.path().join("store");
    let scratch_table = scratch_store.join("task_log");
    copy_dir(&source.join("task_log"), &scratch_table).await?;

    // Read the surviving secondary index directly to discover every key,
    // including projects that may since have been deleted from the project
    // table. This handle writes nothing because no events are applied.
    let mut project_index =
        <SpaceIndexUnsized<String, { INNER_PAGE_SIZE as u32 }> as SpaceIndexOps<String>>::secondary_from_table_files_path(
            scratch_table.to_string_lossy().into_owned(),
            "project_idx",
            TaskLogWorkTable::version(),
        )
        .await?;
    let project_ids: BTreeSet<String> = project_index
        .parse_indexset()
        .await?
        .iter()
        .map(|(project_id, _)| project_id.clone())
        .collect();
    drop(project_index);

    // Preserve the bad file inside the disposable scratch directory. Recovery
    // mode permits the now-empty primary index to disagree with project_idx,
    // but still validates every surviving project-index key and row link.
    tokio::fs::rename(
        scratch_table.join("primary.wt.idx"),
        scratch_table.join("primary.wt.idx.corrupt"),
    )
    .await?;

    let open = |dir: &Path| {
        let config = worktable::prelude::DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            TaskLogWorkTable::name_snake_case(),
            TaskLogWorkTable::version(),
        );
        async move {
            let engine = TaskLogPersistenceEngine::new(config).await?;
            TaskLogWorkTable::load(engine).await
        }
    };

    let config = worktable::prelude::DiskConfig::new_with_table_name(
        scratch_store.to_string_lossy().into_owned(),
        TaskLogWorkTable::name_snake_case(),
        TaskLogWorkTable::version(),
    );
    let engine = TaskLogPersistenceEngine::new(config).await?;
    let damaged = TaskLogWorkTable::load_with(engine, LoadMode::Recovery).await?;
    let mut rows = BTreeMap::new();
    for project_id in &project_ids {
        for row in damaged.select_by_project_id(project_id.clone()).execute()? {
            rows.insert(row.id.clone(), row);
        }
    }

    let fresh = open(target).await?;
    for row in rows.values().cloned() {
        fresh
            .insert(row)
            .map_err(|error| eyre::eyre!("task_log: {error}"))?;
    }
    fresh
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("task_log persistence failed: {error}"))?;

    let recovered = fresh.select_all().execute()?.len();
    if recovered != rows.len() {
        return Err(eyre::eyre!(
            "verification counted {recovered} row(s), but recovery read {}",
            rows.len()
        ));
    }
    fresh
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close rebuilt task_log: {error}"))?;
    damaged
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close scratch task_log: {error}"))?;

    Ok(TaskLogRecoveryReport {
        rows: recovered,
        projects: project_ids.len(),
    })
}

/// Recover a transcript whose string secondary index is unreadable.
///
/// The primary index remains the authoritative map from message ids to row
/// links. Each linked row is read directly from the data file, validated, and
/// inserted into a brand-new table that rebuilds both indexes. The source is
/// never opened as a WorkTable and is not modified.
pub async fn recover_message_index(
    source: &Path,
    target: &Path,
) -> eyre::Result<MessageRecoveryReport> {
    use app_schema::message::{MessagePersistenceEngine, MessageRow, MessageWorkTable};
    use std::collections::HashSet;
    use tokio::io::AsyncReadExt;

    type StoredMessage = <MessageRow as StorableRow>::WrappedRow;

    let table_path = source.join("message");
    let mut primary = <SpaceIndexUnsized<String, { INNER_PAGE_SIZE as u32 }> as SpaceIndexOps<
        String,
    >>::primary_from_table_files_path(
        table_path.to_string_lossy().into_owned(),
        MessageWorkTable::version(),
    )
    .await?;
    let primary_index = primary.parse_indexset().await?;
    let mut data_file = tokio::fs::File::open(table_path.join(".wt.data")).await?;
    let mut rows = BTreeMap::new();
    for (id, link) in primary_index.iter() {
        worktable::data_bucket::seek_by_link(&mut data_file, *link).await?;
        let mut bytes = vec![0u8; link.length as usize];
        data_file.read_exact(&mut bytes).await?;
        let stored = rkyv::from_bytes::<StoredMessage, rkyv::rancor::Error>(&bytes)
            .map_err(|error| eyre::eyre!("message {id} failed row validation: {error}"))?;
        if stored.is_deleted() || stored.is_ghosted() || stored.is_vacuumed() {
            return Err(eyre::eyre!(
                "message {id} points to a deleted, ghosted, or vacuumed row"
            ));
        }
        let row = stored.get_inner();
        if row.id != *id {
            return Err(eyre::eyre!("primary key {id} points to row {}", row.id));
        }
        rows.insert(id.clone(), row);
    }
    drop(primary);

    let open = |dir: &Path| {
        let config = DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            MessageWorkTable::name_snake_case(),
            MessageWorkTable::version(),
        );
        async move {
            let engine = MessagePersistenceEngine::new(config).await?;
            MessageWorkTable::load(engine).await
        }
    };

    let fresh = open(target).await?;
    for row in rows.values().cloned() {
        fresh
            .insert(row)
            .map_err(|error| eyre::eyre!("message: {error}"))?;
    }
    fresh
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("message persistence failed: {error}"))?;

    let recovered = fresh.select_all().execute()?.len();
    if recovered != rows.len() {
        return Err(eyre::eyre!(
            "verification counted {recovered} row(s), but recovery read {}",
            rows.len()
        ));
    }
    fresh
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close rebuilt message: {error}"))?;

    let project_ids: HashSet<&str> = rows.values().map(|row| row.project_id.as_str()).collect();

    Ok(MessageRecoveryReport {
        rows: recovered,
        projects: project_ids.len(),
    })
}

/// Recover pull requests whose project secondary index is unreadable or torn.
///
/// The primary index remains the authoritative map from pull-request ids to
/// row links. Each linked row is read directly from the data file, validated,
/// and inserted into a brand-new table that rebuilds both indexes. The source
/// is never opened as a WorkTable and is not modified.
pub async fn recover_pull_request_index(
    source: &Path,
    target: &Path,
) -> eyre::Result<PullRequestRecoveryReport> {
    let report = rebuild_pull_request_index(source, target, false).await?;
    Ok(PullRequestRecoveryReport {
        rows: report.rows,
        projects: report.projects,
    })
}

/// Rebuild the pull-request table while omitting primary-index entries whose
/// row bytes are corrupt.
///
/// The source is never modified. Every surviving row is validated and written
/// into a brand-new table, and the skipped primary keys are returned for an
/// operator to inspect before swapping anything into place.
pub async fn salvage_pull_request_index(
    source: &Path,
    target: &Path,
) -> eyre::Result<PullRequestSalvageReport> {
    rebuild_pull_request_index(source, target, true).await
}

async fn rebuild_pull_request_index(
    source: &Path,
    target: &Path,
    skip_corrupt: bool,
) -> eyre::Result<PullRequestSalvageReport> {
    use app_schema::pull_request::{
        PullRequestPersistenceEngine, PullRequestRow, PullRequestWorkTable,
    };
    use tokio::io::AsyncReadExt;

    type StoredPullRequest = <PullRequestRow as StorableRow>::WrappedRow;

    let table_path = source.join("pull_request");
    let mut primary = <SpaceIndexUnsized<String, { INNER_PAGE_SIZE as u32 }> as SpaceIndexOps<
        String,
    >>::primary_from_table_files_path(
        table_path.to_string_lossy().into_owned(),
        PullRequestWorkTable::version(),
    )
    .await?;
    let primary_index = primary.parse_indexset().await?;
    let mut data_file = tokio::fs::File::open(table_path.join(".wt.data")).await?;
    let mut rows = BTreeMap::new();
    let mut skipped = Vec::new();
    for (id, link) in primary_index.iter() {
        if let Err(error) = worktable::data_bucket::seek_by_link(&mut data_file, *link).await {
            if skip_corrupt {
                skipped.push(id.clone());
                continue;
            }
            return Err(error);
        }
        let mut bytes = vec![0u8; link.length as usize];
        if let Err(error) = data_file.read_exact(&mut bytes).await {
            if skip_corrupt {
                skipped.push(id.clone());
                continue;
            }
            return Err(error.into());
        }
        let stored = match rkyv::from_bytes::<StoredPullRequest, rkyv::rancor::Error>(&bytes) {
            Ok(stored) => stored,
            Err(_) if skip_corrupt => {
                skipped.push(id.clone());
                continue;
            }
            Err(error) => {
                return Err(eyre::eyre!(
                    "pull request {id} at {link:?} failed row validation: {error}"
                ));
            }
        };
        if stored.is_deleted() || stored.is_ghosted() || stored.is_vacuumed() {
            if skip_corrupt {
                skipped.push(id.clone());
                continue;
            }
            return Err(eyre::eyre!(
                "pull request {id} points to a deleted, ghosted, or vacuumed row"
            ));
        }
        let row = stored.get_inner();
        if row.id != *id {
            if skip_corrupt {
                skipped.push(id.clone());
                continue;
            }
            return Err(eyre::eyre!("primary key {id} points to row {}", row.id));
        }
        rows.insert(id.clone(), row);
    }
    drop(primary);

    let open = |dir: &Path| {
        let config = DiskConfig::new_with_table_name(
            dir.to_string_lossy().into_owned(),
            PullRequestWorkTable::name_snake_case(),
            PullRequestWorkTable::version(),
        );
        async move {
            let engine = PullRequestPersistenceEngine::new(config).await?;
            PullRequestWorkTable::load(engine).await
        }
    };

    let fresh = open(target).await?;
    for row in rows.values().cloned() {
        fresh
            .insert(row)
            .map_err(|error| eyre::eyre!("pull_request: {error}"))?;
    }
    fresh
        .wait_for_ops()
        .await
        .map_err(|error| eyre::eyre!("pull_request persistence failed: {error}"))?;

    let recovered = fresh.select_all().execute()?.len();
    if recovered != rows.len() {
        return Err(eyre::eyre!(
            "verification counted {recovered} row(s), but recovery read {}",
            rows.len()
        ));
    }
    let mut expected_by_project: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in rows.values() {
        expected_by_project
            .entry(row.project_id.clone())
            .or_default()
            .insert(row.id.clone());
    }
    for (project_id, expected) in &expected_by_project {
        let found: BTreeSet<String> = fresh
            .select_by_project_id(project_id.clone())
            .execute()?
            .into_iter()
            .map(|row| row.id)
            .collect();
        if found != *expected {
            return Err(eyre::eyre!(
                "rebuilt pr_project_idx returned {} row(s) for {project_id}, expected {}",
                found.len(),
                expected.len()
            ));
        }
    }
    fresh
        .close()
        .await
        .map_err(|error| eyre::eyre!("could not close rebuilt pull_request: {error}"))?;

    Ok(PullRequestSalvageReport {
        rows: recovered,
        projects: expected_by_project.len(),
        skipped,
    })
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use app_schema::message::{MessagePersistenceEngine, MessageRow, MessageWorkTable};
    use app_schema::pull_request::{
        PullRequestPersistenceEngine, PullRequestRow, PullRequestWorkTable,
    };

    fn task(id: &str, project_id: &str) -> TaskLogRow {
        TaskLogRow {
            id: id.into(),
            tool_call_id: String::new(),
            project_id: project_id.into(),
            item_id: String::new(),
            label: "probe".into(),
            tool: "Bash".into(),
            ok: 1,
            output: "ok".into(),
            duration_ms: 1,
            exit_code: 0,
            finished_at: "2026-08-04T00:00:00Z".into(),
        }
    }

    fn message(id: &str, project_id: &str) -> MessageRow {
        MessageRow {
            id: id.into(),
            project_id: project_id.into(),
            item_id: String::new(),
            author: "user".into(),
            agent: "codex".into(),
            moderation: String::new(),
            model: "gpt-5".into(),
            permission: "workspace-write".into(),
            usage: String::new(),
            stop: "end_turn".into(),
            exit_code: 0,
            body: format!("body for {id}"),
            created_at: "2026-08-04T00:00:00Z".into(),
        }
    }

    fn pull_request(id: &str, project_id: &str) -> PullRequestRow {
        PullRequestRow {
            id: id.into(),
            project_id: project_id.into(),
            url: format!("https://github.com/pathscale/AgencyZero/pull/{id}"),
            repo: "pathscale/AgencyZero".into(),
            number: 1,
            branch: "fix/recovery".into(),
            state: "OPEN".into(),
            additions: 3,
            deletions: 1,
            ci: "pass".into(),
            dismissed: false,
            updated_at: "2026-08-06T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn an_intact_secondary_index_recovers_every_row_from_a_torn_primary() {
        let root = tempfile::tempdir().expect("temporary recovery store");
        let source = root.path().join("source");
        let target = root.path().join("target");
        let config = DiskConfig::new_with_table_name(
            source.to_string_lossy().into_owned(),
            TaskLogWorkTable::name_snake_case(),
            TaskLogWorkTable::version(),
        );
        let engine = TaskLogPersistenceEngine::new(config).await.expect("engine");
        let table = TaskLogWorkTable::load(engine).await.expect("table");
        table.insert(task("log-1", "proj-1")).expect("first row");
        table.insert(task("log-2", "proj-1")).expect("second row");
        table.insert(task("log-3", "proj-2")).expect("third row");
        table.close().await.expect("source closes cleanly");

        std::fs::write(source.join("task_log/primary.wt.idx"), b"torn primary")
            .expect("primary index is made unreadable");

        let report = recover_task_log_index(&source, &target)
            .await
            .expect("secondary-index recovery succeeds");
        assert_eq!(
            report,
            TaskLogRecoveryReport {
                rows: 3,
                projects: 2,
            }
        );

        let config = DiskConfig::new_with_table_name(
            target.to_string_lossy().into_owned(),
            TaskLogWorkTable::name_snake_case(),
            TaskLogWorkTable::version(),
        );
        let engine = TaskLogPersistenceEngine::new(config)
            .await
            .expect("rebuilt engine");
        let rebuilt = TaskLogWorkTable::load(engine).await.expect("rebuilt table");
        let mut ids: Vec<String> = rebuilt
            .select_all()
            .execute()
            .expect("rebuilt rows")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["log-1", "log-2", "log-3"]);
        rebuilt.close().await.expect("rebuilt table closes");
    }

    #[tokio::test]
    async fn task_log_recovery_refuses_a_corrupt_row_reached_through_the_secondary_index() {
        let root = tempfile::tempdir().expect("temporary recovery store");
        let source = root.path().join("source");
        let target = root.path().join("target");
        let config = DiskConfig::new_with_table_name(
            source.to_string_lossy().into_owned(),
            TaskLogWorkTable::name_snake_case(),
            TaskLogWorkTable::version(),
        );
        let engine = TaskLogPersistenceEngine::new(config).await.expect("engine");
        let table = TaskLogWorkTable::load(engine).await.expect("table");
        let id = "log-corrupt".to_string();
        let primary_key = table.insert(task(&id, "proj-1")).expect("row");
        let link = table
            .0
            .primary_index
            .pk_map
            .get_value(&primary_key)
            .expect("primary link")
            .0;
        table.close().await.expect("source closes cleanly");

        let data_path = source.join("task_log/.wt.data");
        let page_id: u32 = link.page_id.into();
        let byte_offset = u64::from(page_id) * PAGE_SIZE as u64
            + GENERAL_HEADER_SIZE as u64
            + u64::from(link.offset);
        {
            use std::io::{Seek, SeekFrom, Write};

            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(data_path)
                .expect("data file");
            file.seek(SeekFrom::Start(byte_offset)).expect("row offset");
            file.write_all(&vec![0; link.length as usize])
                .expect("corrupt row bytes");
            file.sync_all().expect("corruption reaches disk");
        }
        std::fs::write(source.join("task_log/primary.wt.idx"), b"torn primary")
            .expect("primary index is made unreadable");

        let error = recover_task_log_index(&source, &target)
            .await
            .expect_err("recovery must reject a corrupt row reached through project_idx");
        let reason = format!("{error:#}");
        assert!(
            reason.contains("project_idx")
                && (reason.contains("invalid row") || reason.contains("key does not match")),
            "unexpected recovery refusal: {reason}"
        );
    }

    #[tokio::test]
    async fn an_intact_primary_recovers_every_message_from_a_torn_secondary() {
        let root = tempfile::tempdir().expect("temporary recovery store");
        let source = root.path().join("source");
        let target = root.path().join("target");
        let config = DiskConfig::new_with_table_name(
            source.to_string_lossy().into_owned(),
            MessageWorkTable::name_snake_case(),
            MessageWorkTable::version(),
        );
        let engine = MessagePersistenceEngine::new(config).await.expect("engine");
        let table = MessageWorkTable::load(engine).await.expect("table");
        table.insert(message("msg-1", "proj-1")).expect("first row");
        table
            .insert(message("msg-2", "proj-1"))
            .expect("second row");
        table.insert(message("msg-3", "proj-2")).expect("third row");
        table.close().await.expect("source closes cleanly");

        std::fs::write(source.join("message/project_idx.wt.idx"), b"torn secondary")
            .expect("secondary index is made unreadable");

        let report = recover_message_index(&source, &target)
            .await
            .expect("primary-index recovery succeeds");
        assert_eq!(
            report,
            MessageRecoveryReport {
                rows: 3,
                projects: 2,
            }
        );

        let config = DiskConfig::new_with_table_name(
            target.to_string_lossy().into_owned(),
            MessageWorkTable::name_snake_case(),
            MessageWorkTable::version(),
        );
        let engine = MessagePersistenceEngine::new(config)
            .await
            .expect("rebuilt engine");
        let rebuilt = MessageWorkTable::load(engine).await.expect("rebuilt table");
        let mut ids: Vec<String> = rebuilt
            .select_all()
            .execute()
            .expect("rebuilt rows")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["msg-1", "msg-2", "msg-3"]);
        assert_eq!(
            rebuilt
                .select_by_project_id("proj-1".into())
                .execute()
                .expect("rebuilt secondary index")
                .len(),
            2
        );
        rebuilt.close().await.expect("rebuilt table closes");
    }

    #[tokio::test]
    async fn an_intact_primary_recovers_every_pull_request_from_a_torn_secondary() {
        let root = tempfile::tempdir().expect("temporary recovery store");
        let source = root.path().join("source");
        let target = root.path().join("target");
        let config = DiskConfig::new_with_table_name(
            source.to_string_lossy().into_owned(),
            PullRequestWorkTable::name_snake_case(),
            PullRequestWorkTable::version(),
        );
        let engine = PullRequestPersistenceEngine::new(config)
            .await
            .expect("engine");
        let table = PullRequestWorkTable::load(engine).await.expect("table");
        table
            .insert(pull_request("pr-1", "proj-1"))
            .expect("first row");
        table
            .insert(pull_request("pr-2", "proj-1"))
            .expect("second row");
        table
            .insert(pull_request("pr-3", "proj-2"))
            .expect("third row");
        table.close().await.expect("source closes cleanly");

        std::fs::write(
            source.join("pull_request/pr_project_idx.wt.idx"),
            b"torn secondary",
        )
        .expect("secondary index is made unreadable");

        let report = recover_pull_request_index(&source, &target)
            .await
            .expect("primary-index recovery succeeds");
        assert_eq!(
            report,
            PullRequestRecoveryReport {
                rows: 3,
                projects: 2,
            }
        );

        let config = DiskConfig::new_with_table_name(
            target.to_string_lossy().into_owned(),
            PullRequestWorkTable::name_snake_case(),
            PullRequestWorkTable::version(),
        );
        let engine = PullRequestPersistenceEngine::new(config)
            .await
            .expect("rebuilt engine");
        let rebuilt = PullRequestWorkTable::load(engine)
            .await
            .expect("rebuilt table");
        let mut ids: Vec<String> = rebuilt
            .select_all()
            .execute()
            .expect("rebuilt rows")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["pr-1", "pr-2", "pr-3"]);
        assert_eq!(
            rebuilt
                .select_by_project_id("proj-1".into())
                .execute()
                .expect("rebuilt secondary index")
                .len(),
            2
        );
        rebuilt.close().await.expect("rebuilt table closes");
    }

    #[tokio::test]
    async fn pull_request_salvage_reports_and_omits_a_corrupt_row() {
        let root = tempfile::tempdir().expect("temporary recovery store");
        let source = root.path().join("source");
        let strict_target = root.path().join("strict-target");
        let salvage_target = root.path().join("salvage-target");
        let config = DiskConfig::new_with_table_name(
            source.to_string_lossy().into_owned(),
            PullRequestWorkTable::name_snake_case(),
            PullRequestWorkTable::version(),
        );
        let engine = PullRequestPersistenceEngine::new(config)
            .await
            .expect("engine");
        let table = PullRequestWorkTable::load(engine).await.expect("table");
        table
            .insert(pull_request("pr-good-1", "proj-1"))
            .expect("first row");
        table
            .insert(pull_request("pr-corrupt", "proj-1"))
            .expect("corrupt row");
        table
            .insert(pull_request("pr-good-2", "proj-2"))
            .expect("third row");
        table.close().await.expect("source closes cleanly");

        let table_path = source.join("pull_request");
        let mut primary = <SpaceIndexUnsized<String, { INNER_PAGE_SIZE as u32 }> as SpaceIndexOps<
            String,
        >>::primary_from_table_files_path(
            table_path.to_string_lossy().into_owned(),
            PullRequestWorkTable::version(),
        )
        .await
        .expect("primary index");
        let primary_index = primary.parse_indexset().await.expect("primary rows");
        let corrupt_link = primary_index
            .iter()
            .find_map(|(id, link)| (id == "pr-corrupt").then_some(*link))
            .expect("corrupt row link");
        drop(primary);

        let data_path = source.join("pull_request/.wt.data");
        let page_id: u32 = corrupt_link.page_id.into();
        let byte_offset = u64::from(page_id) * PAGE_SIZE as u64
            + GENERAL_HEADER_SIZE as u64
            + u64::from(corrupt_link.offset);
        {
            use std::io::{Seek, SeekFrom, Write};

            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(data_path)
                .expect("data file");
            file.seek(SeekFrom::Start(byte_offset)).expect("row offset");
            file.write_all(&vec![0; corrupt_link.length as usize])
                .expect("corrupt row bytes");
            file.sync_all().expect("corruption reaches disk");
        }

        let _ = recover_pull_request_index(&source, &strict_target)
            .await
            .expect_err("strict recovery refuses the corrupt row");
        let report = salvage_pull_request_index(&source, &salvage_target)
            .await
            .expect("salvage keeps valid rows");
        assert_eq!(
            report,
            PullRequestSalvageReport {
                rows: 2,
                projects: 2,
                skipped: vec!["pr-corrupt".into()],
            }
        );

        let config = DiskConfig::new_with_table_name(
            salvage_target.to_string_lossy().into_owned(),
            PullRequestWorkTable::name_snake_case(),
            PullRequestWorkTable::version(),
        );
        let engine = PullRequestPersistenceEngine::new(config)
            .await
            .expect("rebuilt engine");
        let rebuilt = PullRequestWorkTable::load(engine)
            .await
            .expect("rebuilt table");
        let mut ids: Vec<String> = rebuilt
            .select_all()
            .execute()
            .expect("rebuilt rows")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["pr-good-1", "pr-good-2"]);
        rebuilt.close().await.expect("rebuilt table closes");
    }
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
            /*
             * Recorded, not propagated. The per-table isolation that this
             * crate was fixed for once already lived only inside the migrate
             * branch below, so a table that could not be *copied* still ended
             * the walk and took every table after it alphabetically. That is
             * the same loss, one branch over: an unreadable `agent_io_row`
             * sorts first and would cost `message`, `project` and the rest.
             */
            match copy_dir(&from, &target.join(&table)).await {
                Ok(()) => report.copied.push(table),
                Err(error) => {
                    let _ = tokio::fs::remove_dir_all(target.join(&table)).await;
                    report
                        .failed
                        .push((table.clone(), format!("could not copy: {error}")));
                    report.reset.push(table);
                }
            }
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
                    // Same rule: a scrub that fails is this table's problem.
                    match scrub_items(target).await {
                        Ok(dropped) => {
                            if dropped > 0 {
                                report.dropped.push((table.clone(), dropped));
                            }
                            report.migrated.push(table);
                        }
                        Err(error) => {
                            let _ = tokio::fs::remove_dir_all(target.join(&table)).await;
                            report
                                .failed
                                .push((table.clone(), format!("could not scrub: {error}")));
                            report.reset.push(table);
                        }
                    }
                }
                /*
                 * `Unsupported version` used to be caught here and answered by
                 * copying the table verbatim, on the reading that it was
                 * already current and a re-run should be harmless.
                 *
                 * A re-run is already harmless: an unchanged table never
                 * reaches the engine at all, because the fingerprint diff
                 * copies it above. So the only way to arrive here is with a
                 * table whose columns *have* changed and a version the engine
                 * has no hop for, and copying that is the field-shift this
                 * crate exists to prevent, performed by the migration and
                 * reported as `copied`.
                 *
                 * It is armed today rather than hypothetical: the generated
                 * engine stamps its target version 2, so every store that has
                 * already been carried forward once now answers 2, and the
                 * next column added to this table would land exactly here.
                 *
                 * So it falls through to salvage below with everything else.
                 */
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
            priority,
        } = ProjectItemRow {
            id: "i".into(),
            project_id: "p".into(),
            title: "t".into(),
            status: "new".into(),
            position: 1,
            reference: "36".into(),
            priority: 2,
        };
        let theirs = app_schema::project_item::ProjectItemRow {
            id,
            project_id,
            title,
            status,
            position,
            reference,
            priority,
        };
        assert_eq!(theirs.status, "new");
        assert_eq!(theirs.reference, "36");
        assert_eq!(theirs.priority, 2);
    }

    /// Same drift check for the rebuild verb's restated `task_log`.
    #[test]
    fn the_task_log_matches_the_app() {
        let TaskLogRow {
            id,
            tool_call_id,
            project_id,
            item_id,
            label,
            tool,
            ok,
            output,
            duration_ms,
            exit_code,
            finished_at,
        } = TaskLogRow {
            id: "log-1".into(),
            tool_call_id: String::new(),
            project_id: "proj-1".into(),
            item_id: String::new(),
            label: "l".into(),
            tool: "Bash".into(),
            ok: 1,
            output: "o".into(),
            duration_ms: -1,
            exit_code: 0,
            finished_at: "2026-08-01T00:00:00Z".into(),
        };
        let theirs = app_schema::task_log::TaskLogRow {
            id,
            tool_call_id,
            project_id,
            item_id,
            label,
            tool,
            ok,
            output,
            duration_ms,
            exit_code,
            finished_at,
        };
        assert_eq!(theirs.tool, "Bash");
        assert_eq!(theirs.ok, 1);
    }
}

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
            priority: NORMAL_PRIORITY,
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
            table.wait_for_ops().await.expect("items persist");
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

    /// `db`, `db.next-<stamp>` and `db.pre-migration-<stamp>` are three stores.
    ///
    /// They shared one lock file, because `with_extension` replaces everything
    /// after the last dot. So the documented recovery,
    /// `salvage-items db.pre-migration-X db`, locked the same file twice in one
    /// process and could never run: flock conflicts across open file
    /// descriptions even within a process. Both locks are taken here, in one
    /// process, which is exactly the case that used to fail.
    #[test]
    fn stores_that_share_a_stem_do_not_share_a_lock() {
        let dir = std::env::temp_dir().join(format!("wt-migrate-lock-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        let live = super::lock_store(&dir.join("db")).expect("the live store locks");
        let kept = super::lock_store(&dir.join("db.pre-migration-20260801T000000Z"))
            .expect("a store with the same stem must lock separately");

        drop((live, kept));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_writer_gets_a_typed_busy_probe_with_owner_metadata() {
        let dir = std::env::temp_dir().join(format!(
            "wt-migrate-busy-lock-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        let store = dir.join("db");

        let first = super::lock_store(&store).expect("the first writer owns the profile");
        let second = super::lock_store(&store).expect_err("a second writer must be refused");

        assert!(second.is_busy());
        let message = second.to_string();
        assert!(message.contains(&format!("pid={}", std::process::id())));
        assert!(message.contains("executable="));
        assert!(message.contains("another process holds the store"));

        drop(first);
        super::lock_store(&store).expect("the OS releases the lock with its owner");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
