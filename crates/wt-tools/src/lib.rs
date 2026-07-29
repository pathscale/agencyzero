//! Read-only queries over the GUI's WorkTable store, for agents.
//!
//! The GUI persists everything with rkyv — a binary layout with no text form —
//! so an agent pointed at the store directory sees bytes. This crate is the
//! query surface `docs/task-manager.md` calls for: a headless binary an agent
//! can run in its working directory, printing one JSON object per line.
//!
//! # Never writes, by construction
//!
//! WorkTable is a single-writer store and the GUI usually holds it. Every open
//! here goes through [`ReadOnlyPersistenceEngine`], whose `apply_operation` is
//! a no-op, and the load path underneath it opens the table files with plain
//! `File::open` — no write handle, no lock, no file creation. A missing table
//! directory loads as an empty table rather than creating one. The GUI can
//! hold the store the whole time; the one hazard left is catching a flush
//! mid-write, which surfaces as a parse error and is retried (see
//! [`OPEN_ATTEMPTS`]).
//!
//! # The schema is the gui's, not a copy
//!
//! The `#[path]` includes below compile the gui's own schema files into this
//! crate. Two declarations of a rkyv layout drift apart silently — the reader
//! then misparses every row without an error anywhere — so there must be
//! exactly one source file per table. A shared `crates/db-schema` extraction
//! is the cleaner endpoint, but the schema files are mid-flight in another
//! session right now, and moving files someone else is editing is how merges
//! go wrong; the includes buy the single-source property today without
//! touching them. If you extract later, these includes become `pub use`s of
//! the shared crate and nothing else here changes.
//!
//! Anything schema-adjacent the gui enforces (the `SCHEMA_FINGERPRINT` bump
//! discipline in `apps/gui/src/db/tables.rs`) applies to readers too: a column
//! change lands here on the next build automatically, but stores written by
//! older builds are as unreadable to us as to the gui.

use std::path::Path;

use serde::Serialize;
// `load` is a `PersistedWorkTable` method and `execute` a
// `SelectQueryExecutor` one, so both traits have to be in scope even though
// nothing here names them.
use worktable::PersistedWorkTable;
use worktable::persistence::ReadOnlyPersistenceEngine;
use worktable::prelude::{DiskConfig, SelectQueryExecutor};

#[path = "../../../apps/gui/src/db/schema/agent_io.rs"]
pub mod agent_io;
#[path = "../../../apps/gui/src/db/schema/kv.rs"]
pub mod kv;
#[path = "../../../apps/gui/src/db/location.rs"]
pub mod location;
#[path = "../../../apps/gui/src/db/schema/message.rs"]
pub mod message;
#[path = "../../../apps/gui/src/db/schema/project.rs"]
pub mod project;
#[path = "../../../apps/gui/src/db/schema/project_item.rs"]
pub mod project_item;
#[path = "../../../apps/gui/src/db/schema/task_log.rs"]
pub mod task_log;

use project::{ProjectRow, ProjectWorkTable};
use project_item::{ProjectItemRow, ProjectItemWorkTable};

/// How often a torn read is retried before giving up.
///
/// The GUI flushes pages while we read, so a parse can catch a page half
/// written. That state is transient — the next flush completes it — so a
/// couple of short retries distinguish "caught mid-write" from "actually
/// corrupt", and only the latter reaches the user.
const OPEN_ATTEMPTS: u32 = 3;

/// Delay between attempts, multiplied by the attempt number.
const RETRY_BASE_MS: u64 = 50;

/// The store directory, resolved exactly the way the GUI resolves it.
///
/// Same three-step order as `location::resolve` — because it **is**
/// `location::resolve`, fed the same platform directories Tauri feeds it:
/// `AZ_DATA_DIR`, then the pointer file in the app config directory, then
/// `<app data>/db`. An agent and the GUI disagreeing about where the store
/// lives would be worse than either being wrong.
///
/// # Errors
/// Only when the platform reports no home directory at all, which means there
/// is no default and no pointer file location to check.
pub fn data_location() -> eyre::Result<location::DataLocation> {
    const IDENTIFIER: &str = "com.pathscale.agencyzero";
    let config_dir = dirs::config_dir()
        .ok_or_else(|| eyre::eyre!("no config directory on this platform"))?
        .join(IDENTIFIER);
    let data_dir = dirs::data_dir()
        .ok_or_else(|| eyre::eyre!("no data directory on this platform"))?
        .join(IDENTIFIER);
    Ok(location::resolve(&config_dir, &data_dir))
}

/// One read-only open per table type; the body is identical so it is stamped
/// out rather than hand-copied six ways.
macro_rules! open_read_only {
    ($(#[$doc:meta])* $name:ident, $Table:ident) => {
        $(#[$doc])*
        ///
        /// Opens through [`ReadOnlyPersistenceEngine`]: never writes, never
        /// creates files, and a missing table directory loads as an empty
        /// table. Retries a failed parse [`OPEN_ATTEMPTS`] times, since the
        /// likeliest cause is the GUI flushing mid-read.
        ///
        /// # Errors
        /// The last parse error, when every attempt failed.
        pub async fn $name(dir: &Path) -> eyre::Result<$Table> {
            let dir = dir.to_string_lossy().to_string();
            let mut last_error = None;
            for attempt in 0..OPEN_ATTEMPTS {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        RETRY_BASE_MS * u64::from(attempt),
                    ))
                    .await;
                }
                let config = DiskConfig::new_with_table_name(
                    dir.clone(),
                    $Table::name_snake_case(),
                    $Table::version(),
                );
                let engine = ReadOnlyPersistenceEngine::create(config).await?;
                match $Table::load(engine).await {
                    Ok(table) => return Ok(table),
                    Err(error) => last_error = Some(error),
                }
            }
            Err(last_error.expect("loop ran at least once"))
        }
    };
}

open_read_only!(
    /// The project table, read-only.
    open_projects,
    ProjectWorkTable
);
open_read_only!(
    /// The project-item table, read-only.
    open_items,
    ProjectItemWorkTable
);

/// A project row as the CLI prints it: one JSON object, one line.
///
/// `dirs` and `forked_from` are JSON-encoded strings in the store (WorkTable
/// has no list column); they are decoded here so consumers get real values
/// rather than JSON-in-JSON. A value that fails to decode is passed through as
/// the raw string — surfacing the bytes beats hiding the row.
#[derive(Debug, Serialize)]
pub struct ProjectOut {
    pub id: String,
    pub name: String,
    pub status: String,
    pub position: u32,
    pub pinned: bool,
    pub moderator_enabled: bool,
    pub dirs: serde_json::Value,
    /// `null` when the project is not a fork.
    pub forked_from: serde_json::Value,
    pub last_activity_at: String,
}

impl From<ProjectRow> for ProjectOut {
    fn from(row: ProjectRow) -> Self {
        ProjectOut {
            id: row.id,
            name: row.name,
            status: row.status,
            position: row.position,
            pinned: row.pinned,
            moderator_enabled: row.moderator_enabled,
            dirs: decode_embedded_json(&row.dirs),
            forked_from: if row.forked_from.is_empty() {
                serde_json::Value::Null
            } else {
                decode_embedded_json(&row.forked_from)
            },
            last_activity_at: row.last_activity_at,
        }
    }
}

/// An item row as the CLI prints it.
#[derive(Debug, Serialize)]
pub struct ItemOut {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: String,
    pub position: u32,
}

impl From<ProjectItemRow> for ItemOut {
    fn from(row: ProjectItemRow) -> Self {
        ItemOut {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            status: row.status,
            position: row.position,
        }
    }
}

fn decode_embedded_json(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
}

/// Every project, ordered the way Home orders them: by `position`, id as the
/// tie-break so output is stable across runs.
///
/// # Errors
/// Propagates WorkTable's own error when the scan fails.
pub fn list_projects(table: &ProjectWorkTable) -> eyre::Result<Vec<ProjectOut>> {
    let mut rows = table.select_all().execute()?;
    rows.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
    Ok(rows.into_iter().map(ProjectOut::from).collect())
}

/// Items, optionally narrowed to one project, ordered by project then
/// `position` then id.
///
/// A full scan rather than the `project_idx` index on purpose: the unfiltered
/// listing needs the scan anyway, the store is desktop-sized, and one code
/// path means the two forms cannot disagree about ordering.
///
/// # Errors
/// Propagates WorkTable's own error when the scan fails.
pub fn list_items(
    table: &ProjectItemWorkTable,
    project: Option<&str>,
) -> eyre::Result<Vec<ItemOut>> {
    let mut rows = table.select_all().execute()?;
    if let Some(project) = project {
        rows.retain(|row| row.project_id == project);
    }
    sort_items(&mut rows);
    Ok(rows.into_iter().map(ItemOut::from).collect())
}

/// Items whose title contains `query`, case-insensitively.
///
/// Substring rather than tokens or fuzz: an agent's query is usually a word it
/// just wrote into a task title, and a match rule you can predict beats a
/// cleverer one you cannot.
///
/// # Errors
/// Propagates WorkTable's own error when the scan fails.
pub fn search_items(table: &ProjectItemWorkTable, query: &str) -> eyre::Result<Vec<ItemOut>> {
    let needle = query.to_lowercase();
    let mut rows = table.select_all().execute()?;
    rows.retain(|row| row.title.to_lowercase().contains(&needle));
    sort_items(&mut rows);
    Ok(rows.into_iter().map(ItemOut::from).collect())
}

fn sort_items(rows: &mut [ProjectItemRow]) {
    rows.sort_by(|a, b| {
        a.project_id
            .cmp(&b.project_id)
            .then_with(|| a.position.cmp(&b.position))
            .then_with(|| a.id.cmp(&b.id))
    });
}
