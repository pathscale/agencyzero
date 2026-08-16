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
#[path = "../../../apps/gui/src/db/schema/approval_rule.rs"]
pub mod approval_rule;
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
pub mod ps_usage;
#[path = "../../../apps/gui/src/db/schema/study_event.rs"]
pub mod study_event;
#[path = "../../../apps/gui/src/db/schema/task_log.rs"]
pub mod task_log;
#[path = "../../../apps/gui/src/db/schema/usage_cache.rs"]
pub mod usage_cache;
#[path = "../../../apps/gui/src/db/schema/usage_ledger.rs"]
pub mod usage_ledger;

use approval_rule::{ApprovalRuleRow, ApprovalRuleWorkTable};
use kv::KvWorkTable;
use message::{MessageRow, MessageWorkTable};
use project::{ProjectRow, ProjectWorkTable};
use project_item::{ProjectItemRow, ProjectItemWorkTable};
use study_event::StudyEventWorkTable;
use usage_cache::UsageCacheWorkTable;
use usage_ledger::UsageLedgerWorkTable;

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
    data_location_for(IDENTIFIER_STABLE)
}

/// The bundle identifier of the standard build.
pub const IDENTIFIER_STABLE: &str = "com.pathscale.agencyzero";

/// The bundle identifier of the experimental build.
///
/// A separate identifier means a separate config directory, a separate pointer
/// file and a separate store. Reading the stable store while the experimental
/// window is the one running reports another profile's data as if it were this
/// one's, which is worse than reporting nothing.
pub const IDENTIFIER_EXPERIMENTAL: &str = "com.pathscale.agencyzero.experimental";

/// The store directory for one bundle identifier.
///
/// # Errors
/// Only when the platform reports no home directory at all.
pub fn data_location_for(identifier: &str) -> eyre::Result<location::DataLocation> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| eyre::eyre!("no config directory on this platform"))?
        .join(identifier);
    let data_dir = dirs::data_dir()
        .ok_or_else(|| eyre::eyre!("no data directory on this platform"))?
        .join(identifier);
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
open_read_only!(
    /// The key/value table holding item descriptions, read-only.
    open_kv,
    KvWorkTable
);
open_read_only!(
    /// The remembered-approval table, read-only.
    open_rules,
    ApprovalRuleWorkTable
);
open_read_only!(
    /// The usage ledger, read-only: one row per agent turn that reported usage.
    open_usage,
    UsageLedgerWorkTable
);
open_read_only!(
    /// The cache table, read-only: the cache-read/write split per turn.
    open_usage_cache,
    UsageCacheWorkTable
);
open_read_only!(
    /// The transcript, read-only.
    ///
    /// Added to answer one question the GUI cannot: does the *store* hold what
    /// the window is showing? A transcript that comes back short after a tab
    /// switch is either a persistence bug or a render bug, and telling those
    /// apart needs a reader that is not the app.
    open_messages,
    MessageWorkTable
);
open_read_only!(
    /// The content-free directive-usage table, read-only.
    ///
    /// Written only while the opt-in setting is on, and holding no prompt text,
    /// titles, paths or URLs by construction. `ps_usage_report` reads it to
    /// count how the declared operations were used.
    open_study_events,
    StudyEventWorkTable
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
    pub description: String,
}

impl From<ProjectItemRow> for ItemOut {
    fn from(row: ProjectItemRow) -> Self {
        ItemOut {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            status: row.status,
            position: row.position,
            description: String::new(),
        }
    }
}

/// A remembered approval as the CLI prints it: a standing permission grant.
#[derive(Debug, Serialize)]
pub struct RuleOut {
    pub id: String,
    pub project_id: String,
    /// e.g. "Bash: cargo test" or "Edit: apps/gui/src". Computed by the GUI;
    /// see `projects::approval_signature` there for what "similar" means.
    pub signature: String,
    pub created_at: String,
}

impl From<ApprovalRuleRow> for RuleOut {
    fn from(row: ApprovalRuleRow) -> Self {
        RuleOut {
            id: row.id,
            project_id: row.project_id,
            signature: row.signature,
            created_at: row.created_at,
        }
    }
}

/// Remembered approvals, optionally narrowed to one project, ordered by
/// project then creation time then id — the audit view over what "always
/// allow similar" has been taught.
///
/// # Errors
/// Propagates WorkTable's own error when the scan fails.
pub fn list_rules(
    table: &ApprovalRuleWorkTable,
    project: Option<&str>,
) -> eyre::Result<Vec<RuleOut>> {
    let mut rows = table.select_all().execute()?;
    if let Some(project) = project {
        rows.retain(|row| row.project_id == project);
    }
    rows.sort_by(|a, b| {
        a.project_id
            .cmp(&b.project_id)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(rows.into_iter().map(RuleOut::from).collect())
}

/// A usage rollup as the CLI prints it: the whole-store totals, the single
/// biggest turn (the "is any one request enormous?" answer), and per-model /
/// per-day breakdowns.
///
/// The token decomposition comes from the cache table (`usage_cache`), which
/// carries the whole picture: uncached input, cache reads, cache writes and
/// output. The ledger's bare `input_tokens` is only the *uncached* remainder —
/// on a long Claude conversation nearly everything is a cache read, so reading
/// the ledger alone makes a heavy session look near-empty. Cost comes from the
/// ledger. These are independent per-turn rows; nothing here is cumulative
/// context. A turn's `processed` is what the model actually handled that turn
/// (input + reads + writes + output) — the number to watch when one request
/// feels huge.
#[derive(Debug, Serialize)]
pub struct UsageOut {
    pub turns: usize,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    /// input + cache_read + cache_write + output, across every turn.
    pub processed_tokens: i64,
    pub cost_usd: f64,
    /// The single turn that processed the most tokens.
    pub largest_turn: Option<UsageTurnOut>,
    pub by_model: Vec<UsageGroupOut>,
    pub by_day: Vec<UsageGroupOut>,
}

/// One turn, as the agent reported it.
#[derive(Debug, Serialize)]
pub struct UsageTurnOut {
    pub at: String,
    pub project_id: String,
    pub model: String,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub processed_tokens: i64,
}

/// A bucket (a model, or a day) with its totals.
#[derive(Debug, Serialize)]
pub struct UsageGroupOut {
    pub key: String,
    pub turns: usize,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub processed_tokens: i64,
    pub cost_usd: f64,
}

/// Roll up usage across the whole token decomposition, optionally narrowed to
/// one project.
///
/// Tokens come from `usage_cache` (the full split); cost is summed from the
/// ledger separately, since the two tables key by turn independently and a
/// per-row join is unnecessary for a store total.
///
/// # Errors
/// Propagates WorkTable's own error when either scan fails.
pub fn usage_summary(
    cache: &UsageCacheWorkTable,
    ledger: &UsageLedgerWorkTable,
    project: Option<&str>,
) -> eyre::Result<UsageOut> {
    let mut rows = cache.select_all().execute()?;
    if let Some(project) = project {
        rows.retain(|row| row.project_id == project);
    }

    let mut ledger_rows = ledger.select_all().execute()?;
    if let Some(project) = project {
        ledger_rows.retain(|row| row.project_id == project);
    }
    let cost_micro: i64 = ledger_rows.iter().map(|row| row.cost_micro).sum();
    let output_by_day: std::collections::BTreeMap<String, i64> =
        ledger_rows.iter().fold(Default::default(), |mut acc, row| {
            *acc.entry(row.day.clone()).or_default() += row.output_tokens;
            acc
        });
    let output_by_model: std::collections::BTreeMap<String, i64> =
        ledger_rows.iter().fold(Default::default(), |mut acc, row| {
            *acc.entry(row.model.clone()).or_default() += row.output_tokens;
            acc
        });
    let output_total: i64 = ledger_rows.iter().map(|row| row.output_tokens).sum();

    let processed = |row: &usage_cache::UsageCacheRow, output: i64| -> i64 {
        row.input_tokens + row.cache_read_tokens + row.cache_write_tokens + output
    };

    let mut by_model: std::collections::BTreeMap<String, UsageGroupOut> =
        std::collections::BTreeMap::new();
    let mut by_day: std::collections::BTreeMap<String, UsageGroupOut> =
        std::collections::BTreeMap::new();
    let (mut input, mut reads, mut writes) = (0i64, 0i64, 0i64);
    let mut largest: Option<UsageTurnOut> = None;

    for row in &rows {
        input += row.input_tokens;
        reads += row.cache_read_tokens;
        writes += row.cache_write_tokens;

        // Per-turn output is not in the cache table; the group output totals are
        // folded in from the ledger after this loop.
        for (map, key) in [
            (&mut by_model, row.model.clone()),
            (&mut by_day, row.day.clone()),
        ] {
            let group = map.entry(key.clone()).or_insert(UsageGroupOut {
                key,
                turns: 0,
                input_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                output_tokens: 0,
                processed_tokens: 0,
                cost_usd: 0.0,
            });
            group.turns += 1;
            group.input_tokens += row.input_tokens;
            group.cache_read_tokens += row.cache_read_tokens;
            group.cache_write_tokens += row.cache_write_tokens;
        }

        // The turn's own output is unknown here, so rank the biggest turn by
        // input + cache only; output is a small tail next to a six-figure read.
        let turn_processed = processed(row, 0);
        let bigger = largest
            .as_ref()
            .is_none_or(|current| turn_processed > current.processed_tokens);
        if bigger {
            largest = Some(UsageTurnOut {
                at: row.at.clone(),
                project_id: row.project_id.clone(),
                model: row.model.clone(),
                input_tokens: row.input_tokens,
                cache_read_tokens: row.cache_read_tokens,
                cache_write_tokens: row.cache_write_tokens,
                processed_tokens: turn_processed,
            });
        }
    }

    // Fold the ledger's output totals into each group and finalise processed.
    for group in by_model.values_mut() {
        group.output_tokens = output_by_model.get(&group.key).copied().unwrap_or(0);
        group.cost_usd = ledger_rows
            .iter()
            .filter(|r| r.model == group.key)
            .map(|r| r.cost_micro as f64 / 1e6)
            .sum();
        group.processed_tokens = group.input_tokens
            + group.cache_read_tokens
            + group.cache_write_tokens
            + group.output_tokens;
    }
    for group in by_day.values_mut() {
        group.output_tokens = output_by_day.get(&group.key).copied().unwrap_or(0);
        group.cost_usd = ledger_rows
            .iter()
            .filter(|r| r.day == group.key)
            .map(|r| r.cost_micro as f64 / 1e6)
            .sum();
        group.processed_tokens = group.input_tokens
            + group.cache_read_tokens
            + group.cache_write_tokens
            + group.output_tokens;
    }

    Ok(UsageOut {
        turns: rows.len(),
        input_tokens: input,
        cache_read_tokens: reads,
        cache_write_tokens: writes,
        output_tokens: output_total,
        processed_tokens: input + reads + writes + output_total,
        cost_usd: cost_micro as f64 / 1e6,
        largest_turn: largest,
        by_model: by_model.into_values().collect(),
        by_day: by_day.into_values().collect(),
    })
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

/// Items with their owner-authored descriptions joined from the key/value table.
///
/// Descriptions deliberately remain outside the item schema so adding this UI
/// field never requires migrating every item row. The read-only CLI joins the
/// two app-owned tables for the same complete view Home renders.
///
/// # Errors
/// Returns a read error from either table.
pub fn list_items_with_descriptions(
    items: &ProjectItemWorkTable,
    kv: &KvWorkTable,
    project: Option<&str>,
) -> eyre::Result<Vec<ItemOut>> {
    const ITEM_CONTEXT_PREFIX: &str = "item-context:";
    let descriptions: std::collections::HashMap<String, String> = kv
        .select_all()
        .execute()?
        .into_iter()
        .filter_map(|row| {
            row.key
                .strip_prefix(ITEM_CONTEXT_PREFIX)
                .map(|id| (id.to_string(), row.value))
        })
        .collect();
    let mut rows = list_items(items, project)?;
    for row in &mut rows {
        row.description = descriptions.get(&row.id).cloned().unwrap_or_default();
    }
    Ok(rows)
}

/// One provider-session ownership row from the app's key/value table.
///
/// Empty session ids are included because an explicit reset is materially
/// different from a key that was never created, and that distinction is the
/// evidence needed when recovering a session from a pre-migration snapshot.
#[derive(Clone, Debug, Serialize)]
pub struct SessionOut {
    pub project_id: String,
    pub agent: String,
    pub session_id: String,
    pub updated_at: String,
}

/// A provider session present in a retained WorkTable snapshot but not owned
/// by the current project row. This is the actionable recovery view: project
/// name, both pointers, and every snapshot that independently confirms the
/// candidate.
#[derive(Debug, Serialize)]
pub struct SessionRecoveryOut {
    pub project_id: String,
    pub project_name: String,
    pub agent: String,
    pub current_session_id: String,
    pub current_updated_at: String,
    pub recoverable_session_id: String,
    pub recoverable_updated_at: String,
    pub snapshots: Vec<String>,
    pub action: String,
}

fn provider_session_key(key: &str) -> Option<(&str, &str)> {
    if let Some(project) = key.strip_prefix("session:codex:") {
        Some(("codex", project))
    } else if let Some(project) = key.strip_prefix("session:copilot:") {
        Some(("copilot", project))
    } else {
        key.strip_prefix("session:")
            .filter(|project| !project.contains(':'))
            .map(|project| ("claude", project))
    }
}

/// Provider-session ownership, optionally narrowed to one project.
///
/// # Errors
/// Returns WorkTable's read error when the key/value scan fails.
pub fn list_sessions(kv: &KvWorkTable, project: Option<&str>) -> eyre::Result<Vec<SessionOut>> {
    let mut rows: Vec<SessionOut> = kv
        .select_all()
        .execute()?
        .into_iter()
        .filter_map(|row| {
            let (agent, project_id) = provider_session_key(&row.key)?;
            if project.is_some_and(|wanted| wanted != project_id) {
                return None;
            }
            Some(SessionOut {
                project_id: project_id.to_string(),
                agent: agent.to_string(),
                session_id: row.value,
                updated_at: row.updated_at,
            })
        })
        .collect();
    rows.sort_by(|left, right| {
        left.project_id
            .cmp(&right.project_id)
            .then_with(|| left.agent.cmp(&right.agent))
    });
    Ok(rows)
}

/// Sessions recoverable from retained snapshot rows.
///
/// Identical candidates in multiple snapshots collapse into one report row,
/// with every confirming snapshot named. A different non-empty current pointer
/// is reported as `inspect_divergence`; an absent or explicitly empty pointer
/// is a direct `restore_snapshot_session` candidate.
///
/// # Errors
/// Returns WorkTable's read error when project names cannot be scanned.
pub fn session_recovery_report(
    projects: &ProjectWorkTable,
    current: &[SessionOut],
    snapshots: &[(String, Vec<SessionOut>)],
    project: Option<&str>,
) -> eyre::Result<Vec<SessionRecoveryOut>> {
    use std::collections::{BTreeMap, HashMap};

    let names: HashMap<String, String> = projects
        .select_all()
        .execute()?
        .into_iter()
        .map(|row| (row.id, row.name))
        .collect();
    let current: HashMap<(String, String), &SessionOut> = current
        .iter()
        .map(|row| ((row.project_id.clone(), row.agent.clone()), row))
        .collect();
    let mut candidates: BTreeMap<(String, String, String), SessionRecoveryOut> = BTreeMap::new();

    for (snapshot, rows) in snapshots {
        for row in rows {
            if row.session_id.is_empty() || project.is_some_and(|wanted| wanted != row.project_id) {
                continue;
            }
            let owned = current.get(&(row.project_id.clone(), row.agent.clone()));
            if owned.is_some_and(|current| current.session_id == row.session_id) {
                continue;
            }
            let key = (
                row.project_id.clone(),
                row.agent.clone(),
                row.session_id.clone(),
            );
            let report = candidates.entry(key).or_insert_with(|| SessionRecoveryOut {
                project_id: row.project_id.clone(),
                project_name: names.get(&row.project_id).cloned().unwrap_or_default(),
                agent: row.agent.clone(),
                current_session_id: owned.map_or_else(String::new, |row| row.session_id.clone()),
                current_updated_at: owned.map_or_else(String::new, |row| row.updated_at.clone()),
                recoverable_session_id: row.session_id.clone(),
                recoverable_updated_at: row.updated_at.clone(),
                snapshots: Vec::new(),
                action: if owned.is_none_or(|row| row.session_id.is_empty()) {
                    "restore_snapshot_session".into()
                } else {
                    "inspect_divergence".into()
                },
            });
            if !report.snapshots.contains(snapshot) {
                report.snapshots.push(snapshot.clone());
            }
            if row.updated_at > report.recoverable_updated_at {
                report.recoverable_updated_at.clone_from(&row.updated_at);
            }
        }
    }
    Ok(candidates.into_values().collect())
}

/// One transcript row as the CLI prints it.
///
/// The body is reported by length rather than printed: a transcript is the
/// largest thing in the store and the question this answers is "how many rows,
/// in what order, how big" — not "what did it say". `--bodies` prints them when
/// the words themselves are the question.
///
/// The usage rides along because the other question asked of a transcript is
/// what it cost, and the window is otherwise the only place that figure exists.
/// A token count that looks wrong on screen could not be checked against the
/// store at all, which is how one shipped reading "60 tokens" for a ten-minute
/// turn.
#[derive(Debug, Serialize)]
pub struct MessageOut {
    pub id: String,
    pub project_id: String,
    pub author: String,
    pub model: String,
    pub stop: String,
    pub chars: usize,
    pub created_at: String,
    /// The turn's own report, as stored. Absent on user rows, which have none,
    /// and on any row whose JSON will not parse — printed as the object it is
    /// rather than as an escaped string, so the line stays greppable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

impl MessageOut {
    fn from_row(row: MessageRow, bodies: bool) -> Self {
        MessageOut {
            id: row.id,
            project_id: row.project_id,
            author: row.author,
            model: row.model,
            stop: row.stop,
            chars: row.body.chars().count(),
            created_at: row.created_at,
            // A row that stored nothing, or stored something unparseable, reads
            // as absent rather than as a zero: this tool exists to report what
            // is there, and an invented 0 would be a usage figure of its own.
            usage: serde_json::from_str(&row.usage).ok(),
            body: bodies.then_some(row.body),
        }
    }
}

/// The transcript, oldest first — the order the GUI renders.
///
/// # Errors
/// Returns the read error when the table cannot be scanned.
pub fn list_messages(
    table: &MessageWorkTable,
    project: Option<&str>,
    bodies: bool,
) -> eyre::Result<Vec<MessageOut>> {
    let mut rows = table.select_all().execute()?;
    if let Some(project) = project {
        rows.retain(|row| row.project_id == project);
    }
    rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(rows
        .into_iter()
        .map(|row| MessageOut::from_row(row, bodies))
        .collect())
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
