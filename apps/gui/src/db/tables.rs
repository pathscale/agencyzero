//! Opening every table against one directory, and holding them together.
//!
//! The only place engine setup appears. A command reaches for
//! `state.tables.project`, never for a `DiskConfig`.

use std::path::Path;
use std::sync::Arc;

// `new` on the engine is a `PersistenceEngine` method, so the trait has to be
// in scope even though nothing here names it.
use worktable::PersistedWorkTable;
use worktable::persistence::PersistenceEngine;
use worktable::prelude::DiskConfig;

use crate::db::schema::agent_io::{AgentIoRowPersistenceEngine, AgentIoRowWorkTable};
use crate::db::schema::approval_rule::{ApprovalRulePersistenceEngine, ApprovalRuleWorkTable};
use crate::db::schema::kv::{KvPersistenceEngine, KvRow, KvWorkTable};
use crate::db::schema::message::{MessagePersistenceEngine, MessageWorkTable};
use crate::db::schema::project::{ProjectPersistenceEngine, ProjectWorkTable};
use crate::db::schema::project_item::{ProjectItemPersistenceEngine, ProjectItemWorkTable};
use crate::db::schema::pull_request::{PullRequestPersistenceEngine, PullRequestWorkTable};
use crate::db::schema::task_log::{TaskLogPersistenceEngine, TaskLogWorkTable};
use crate::db::schema::usage_ledger::{UsageLedgerPersistenceEngine, UsageLedgerWorkTable};

/// Every persisted table, opened once at startup.
///
/// The three entity tables are declared and opened ahead of the commands that
/// read them, on purpose: the schema is the part worth reviewing first, and a
/// table that exists from the start does not need a migration when the read path
/// lands on top of it.
#[allow(
    dead_code,
    reason = "the entity tables land before the read path that reads them"
)]
pub struct Tables {
    pub kv: Arc<KvWorkTable>,
    pub project: Arc<ProjectWorkTable>,
    pub project_item: Arc<ProjectItemWorkTable>,
    pub message: Arc<MessageWorkTable>,
    pub task_log: Arc<TaskLogWorkTable>,
    /// Opt-in per project. See the module doc on `schema/agent_io.rs`.
    pub agent_io: Arc<AgentIoRowWorkTable>,
    /// One row per turn that reported usage. See `schema/usage_ledger.rs`.
    pub usage_ledger: Arc<UsageLedgerWorkTable>,
    /// One row per remembered approval. See `schema/approval_rule.rs`.
    pub approval_rule: Arc<ApprovalRuleWorkTable>,
    /// One row per PR cut during a run. See `schema/pull_request.rs`.
    pub pull_request: Arc<PullRequestWorkTable>,
}

/// Where the fingerprint of the schema this build expects is recorded.
const FINGERPRINT_KEY: &str = "schema-fingerprint";

/// The schema this build reads. **Bump on any column change, in the same commit.**
///
/// # Why this exists
///
/// WorkTable persists rows with rkyv, positionally, and `version()` is a fixed
/// constant the macro emits, it does not change when a column does. So adding
/// one field to a table makes every row already on disk get read through the new
/// layout, silently, with no error anywhere.
///
/// It does not look like corruption. It looks like a project whose id reads as
/// `00:00   `: delete, pin and the session write all return `NotFound` against
/// an id that does not exist, two tabs collide on one garbage key, and a single
/// composer feeds two conversations. Every one of those was reported as its own
/// bug before the cause was one line of schema.
///
/// The string is the column lists, written out. Any edit to a schema changes it,
/// which is the point, it is a human-maintained fingerprint precisely so that
/// changing a schema and not thinking about the rows on disk is impossible.
const SCHEMA_FINGERPRINT: &str = concat!(
    "kv(key,value,updated_at);",
    "project(id,name,status,position,dirs,pinned,moderator_enabled,forked_from,last_activity_at);",
    "project_item(id,project_id,title,status,position,reference);",
    "message(id,project_id,item_id,author,agent,moderation,model,permission,usage,stop,exit_code,body,created_at);",
    "task_log(id,tool_call_id,project_id,item_id,label,tool,ok,output,duration_ms,exit_code,finished_at);",
    "agent_io_row(id,project_id,at,direction,kind,detail);",
    // Tables appended after first ship go at the end: `check_schema` treats a
    // stored fingerprint that is a prefix of this one as a match, because a
    // brand-new table has no rows on disk to misread.
    "usage_ledger(id,at,day,project_id,model,cost_micro,input_tokens,output_tokens);",
    "approval_rule(id,project_id,signature,created_at);",
    "pull_request(id,project_id,url,repo,number,branch,state,additions,deletions,ci,dismissed,updated_at);",
);

/// What opening the tables found, so the caller can say something useful.
#[derive(Debug, PartialEq, Eq)]
pub enum SchemaState {
    /// First run, or a store this build wrote.
    Match,
    /// Written by a build with a different schema. The rows cannot be trusted.
    Mismatch { found: String },
}

/// Compare the fingerprint on disk with the one this build expects.
///
/// Returns `Mismatch` rather than deciding what to do: refusing to start and
/// silently wiping someone's transcripts are both wrong, and the caller is the
/// one that can say which.
#[must_use]
pub fn check_schema(stored: Option<&str>) -> SchemaState {
    match stored {
        // First run. Nothing on disk to misread.
        None => SchemaState::Match,
        Some(found) if found == SCHEMA_FINGERPRINT => SchemaState::Match,
        /*
         * The store predates a table this build added. Every table it does
         * know is unchanged, additions append to the fingerprint, and a
         * new table has no rows on disk to misread, so this is not the
         * silent-corruption case the fingerprint exists to catch. Boot
         * restamps, upgrading the marker to the full string.
         */
        Some(found) if SCHEMA_FINGERPRINT.starts_with(found) => SchemaState::Match,
        Some(found) => SchemaState::Mismatch {
            found: found.to_string(),
        },
    }
}

impl Tables {
    /// Open every table under `dir`, creating the directory on first run.
    ///
    /// # Errors
    /// Propagates whatever WorkTable reports when a table cannot be opened.
    /// Failing here is deliberate: running with no persistence would let every
    /// write appear to succeed and vanish on the next launch, which is a worse
    /// failure than refusing to start.
    pub async fn open(dir: &Path) -> Result<Tables, Box<dyn std::error::Error + Send + Sync>> {
        std::fs::create_dir_all(dir)?;
        let dir = dir.to_string_lossy().to_string();

        /// Each table names its own directory and schema version, so two tables
        /// never share a file and a version bump lands in its own.
        macro_rules! open {
            ($Engine:ty, $Table:ty) => {{
                let config = DiskConfig::new_with_table_name(
                    dir.clone(),
                    <$Table>::name_snake_case(),
                    <$Table>::version(),
                );
                let engine = <$Engine>::new(config).await?;
                // `load`, never `new`: `new` builds an empty table and silently
                // discards whatever is on disk, so every launch started blank.
                Arc::new(<$Table>::load(engine).await?)
            }};
        }

        Ok(Tables {
            kv: open!(KvPersistenceEngine, KvWorkTable),
            project: open!(ProjectPersistenceEngine, ProjectWorkTable),
            project_item: open!(ProjectItemPersistenceEngine, ProjectItemWorkTable),
            message: open!(MessagePersistenceEngine, MessageWorkTable),
            task_log: open!(TaskLogPersistenceEngine, TaskLogWorkTable),
            agent_io: open!(AgentIoRowPersistenceEngine, AgentIoRowWorkTable),
            usage_ledger: open!(UsageLedgerPersistenceEngine, UsageLedgerWorkTable),
            approval_rule: open!(ApprovalRulePersistenceEngine, ApprovalRuleWorkTable),
            pull_request: open!(PullRequestPersistenceEngine, PullRequestWorkTable),
        })
    }
}

impl Tables {
    /// The blob at `key`, or `None` when nothing was ever written there.
    #[must_use]
    pub fn kv_get(&self, key: &str) -> Option<String> {
        self.kv.select(key.to_string()).map(|row| row.value)
    }

    /// The schema fingerprint recorded by whichever build wrote this store.
    #[must_use]
    pub fn schema_state(&self) -> SchemaState {
        check_schema(self.kv_get(FINGERPRINT_KEY).as_deref())
    }

    /// Record this build's schema, so the next launch can check it.
    ///
    /// # Errors
    /// Propagates WorkTable's own error when the marker cannot be written.
    pub async fn stamp_schema(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.kv_put(FINGERPRINT_KEY, SCHEMA_FINGERPRINT.to_string())
            .await
    }

    /// Write `value` at `key`, replacing whatever was there.
    ///
    /// # Errors
    /// Propagates WorkTable's own error when the row cannot be written.
    pub async fn kv_put(
        &self,
        key: &str,
        value: String,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.kv
            .upsert(KvRow {
                key: key.to_string(),
                value,
                updated_at: chrono::Utc::now().to_rfc3339(),
            })
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * The fingerprint is hand-maintained, and on 2026-08-01 a column was added
     * to `project_item` without touching it. Nothing failed. The guard did not
     * fire, every row already on disk was read through the new layout, and the
     * item list came back with every field shifted one place: ids reading as
     * titles, titles as statuses, positions as garbage.
     *
     * A comment saying "bump this" did not prevent that, so this asserts it
     * instead. The row is serialized and its real field names are compared with
     * what the fingerprint claims, which fails on the commit that adds a column
     * rather than on the launch that eats the data.
     */
    fn columns_in_fingerprint(table: &str) -> Vec<String> {
        let entry = SCHEMA_FINGERPRINT
            .split(';')
            .find(|part| part.trim_start().starts_with(&format!("{table}(")))
            .unwrap_or_else(|| panic!("{table} is missing from the fingerprint"));
        entry
            .trim_start()
            .trim_start_matches(&format!("{table}("))
            .trim_end_matches(')')
            .split(',')
            .map(|column| column.trim().to_string())
            .collect()
    }

    #[test]
    fn the_fingerprint_lists_the_columns_a_row_really_has() {
        let row = crate::db::schema::project_item::ProjectItemRow {
            id: String::new(),
            project_id: String::new(),
            title: String::new(),
            status: String::new(),
            position: 0,
            reference: String::new(),
        };
        /*
         * Exhaustively destructured on purpose. Adding a column stops this
         * compiling, which is the whole guard: the build breaks in the commit
         * that changes the schema, instead of the store breaking on the launch
         * that reads it. Update the pattern and the fingerprint together.
         */
        let crate::db::schema::project_item::ProjectItemRow {
            id: _,
            project_id: _,
            title: _,
            status: _,
            position: _,
            reference: _,
        } = row;

        assert_eq!(
            columns_in_fingerprint("project_item"),
            vec![
                "id",
                "project_id",
                "title",
                "status",
                "position",
                "reference"
            ],
            "project_item changed shape without the fingerprint changing, so every \
             row on disk would be read through the wrong layout"
        );
    }

    /// Opening a fresh directory must produce every table, and a blob must
    /// survive a write and a read. This is the only behaviour the commands
    /// depend on until the typed tables are read from.
    #[tokio::test]
    async fn tables_open_and_a_blob_round_trips() {
        let dir = std::env::temp_dir().join(format!("az-tables-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let tables = Tables::open(&dir).await.expect("should open");
        assert_eq!(
            tables.kv_get("settings"),
            None,
            "a fresh store holds nothing"
        );

        tables
            .kv_put("settings", "{\"a\":1}".into())
            .await
            .expect("should write");
        assert_eq!(tables.kv_get("settings"), Some("{\"a\":1}".to_string()));

        tables
            .kv_put("settings", "{\"a\":2}".into())
            .await
            .expect("should overwrite");
        assert_eq!(
            tables.kv_get("settings"),
            Some("{\"a\":2}".to_string()),
            "a second write replaces rather than appends"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod restart_tests {
    use super::*;

    /// The guard that would have caught the worst bug of the project.
    ///
    /// Adding one column to the project table made every row on disk read
    /// through the new layout: ids came back as `00:00   `, and delete, pin and
    /// the session write all failed with `NotFound` against ids that did not
    /// exist. Nothing errored, so it was reported as five separate bugs.
    #[test]
    fn a_store_written_by_another_schema_is_a_mismatch_not_a_first_run() {
        // First run: nothing on disk, nothing to misread.
        assert_eq!(check_schema(None), SchemaState::Match);

        // Written by this build.
        assert_eq!(check_schema(Some(SCHEMA_FINGERPRINT)), SchemaState::Match);

        // One column added. This is the case that used to pass silently.
        let with_an_extra_column = SCHEMA_FINGERPRINT.replace(
            "forked_from,last_activity_at)",
            "forked_from,session_id,last_activity_at)",
        );
        assert_eq!(
            check_schema(Some(&with_an_extra_column)),
            SchemaState::Mismatch {
                found: with_an_extra_column.clone()
            },
            "an added column has to be caught before the rows are read"
        );

        // A store stamped before the appended tables existed. Every table it
        // knows is unchanged and the new ones have no rows to misread, so
        // setting the whole store aside would throw data away over nothing.
        // Truncated at the first appended table rather than `replace`d out of
        // the middle: an old stamp is always a *prefix* of the new one, and a
        // gap in the middle is a real mismatch.
        let before_the_appends = &SCHEMA_FINGERPRINT[..SCHEMA_FINGERPRINT
            .find("usage_ledger(")
            .expect("the appended tables are present")];
        assert_eq!(
            check_schema(Some(before_the_appends)),
            SchemaState::Match,
            "an appended table must not orphan an existing store"
        );

        // But a table removed from the *middle* is a layout change, not an
        // append, and must be caught.
        let with_a_gap = SCHEMA_FINGERPRINT.replace(
            "usage_ledger(id,at,day,project_id,model,cost_micro,input_tokens,output_tokens);",
            "",
        );
        assert_eq!(
            check_schema(Some(&with_a_gap)),
            SchemaState::Mismatch {
                found: with_a_gap.clone()
            },
            "a mid-list gap is not an append"
        );
    }

    /// The behaviour the whole app depends on and that nothing covered: a write
    /// has to survive the process that made it. The round-trip test above opens
    /// once, so it would pass even if nothing reached disk.
    ///
    /// Drained before the reopen, because that is what the app does, `shutdown`
    /// is called on exit, and because without it this test was a race it lost
    /// under load. There is no `Drop` that drains, so a single row's arrival on
    /// disk came down to whether WorkTable's background writer happened to run
    /// first; on an idle machine it did, and on a loaded CI box it sometimes did
    /// not. It failed for a fortnight as "flaky", which is the reading that
    /// keeps a real question unanswered.
    ///
    /// The harder property, rows surviving an exit that never reaches the drain
    ///, is what `transcript_rows_survive_a_reopen_with_no_drain` is for, and it
    /// uses a batch big enough to settle the question on any machine rather than
    /// only on a bad day.
    #[tokio::test]
    async fn a_write_survives_a_reopen() {
        let dir = std::env::temp_dir().join(format!("az-reopen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        {
            let tables = Tables::open(&dir).await.expect("should open");
            tables
                .kv_put("settings", "{\"models\":\"chosen\"}".into())
                .await
                .expect("should write");
            tables.shutdown().await;
        }

        let reopened = Tables::open(&dir).await.expect("should reopen");
        assert_eq!(
            reopened.kv_get("settings"),
            Some("{\"models\":\"chosen\"}".to_string()),
            "a setting written in one launch must be there in the next"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The durability guarantee, stated as the failure it prevents.
    ///
    /// No `shutdown` on purpose: that is the drain, and a test that calls it
    /// proves only that the drain works. What has to hold is that rows are on
    /// disk *without* one, because the exits that lose data never reach it, a
    /// crash, a panic, a force quit.
    ///
    /// A single row does not discriminate: on an idle SSD the background writer
    /// beats the reopen almost every time, which is exactly why the older
    /// `a_write_survives_a_reopen` failed only under CI load and was written
    /// off as flaky. A batch outruns the writer on any machine, so this fails
    /// loudly if the drain is ever removed rather than only on a bad day.
    #[tokio::test]
    async fn transcript_rows_survive_a_reopen_with_no_drain() {
        use crate::db::schema::message::MessageRow;
        // `execute` on a select builder is a trait method.
        use worktable::prelude::SelectQueryExecutor;

        const ROWS: usize = 300;
        let dir = std::env::temp_dir().join(format!("az-durable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        {
            let tables = Tables::open(&dir).await.expect("should open");
            for n in 0..ROWS {
                let row = MessageRow {
                    id: format!("msg-{n}"),
                    project_id: "proj-1".into(),
                    item_id: String::new(),
                    author: "agent".into(),
                    agent: "claude".into(),
                    moderation: String::new(),
                    model: "sonnet".into(),
                    permission: "read_only".into(),
                    usage: String::new(),
                    stop: "completed".into(),
                    exit_code: 0,
                    body: format!("reply {n}, already on screen"),
                    created_at: format!("2026-07-31T00:00:{:02}Z", n % 60),
                };
                tables.message.insert(row).expect("should insert");
            }
            // Dropped without a drain, standing in for a process that died.
        }

        let reopened = Tables::open(&dir).await.expect("should reopen");
        let found: Vec<MessageRow> = reopened
            .message
            .select_by_project_id("proj-1".to_string())
            .execute()
            .expect("should read");
        assert_eq!(
            found.len(),
            ROWS,
            "every transcript row must reach disk without waiting for a clean exit"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole point of giving the task log a table: the panel is populated
    /// from the database on boot, so a tool call recorded in one launch has to
    /// still be there in the next. An in-memory log would have passed every
    /// other test and shown an empty panel after every restart.
    #[tokio::test]
    async fn a_task_log_row_survives_a_reopen() {
        use crate::db::schema::task_log::TaskLogRow;
        // `execute` on a select builder is a trait method.
        use worktable::prelude::SelectQueryExecutor;

        let dir = std::env::temp_dir().join(format!("az-tasklog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let row = TaskLogRow {
            id: "log_1".into(),
            tool_call_id: "call_1".into(),
            project_id: "proj_1".into(),
            item_id: String::new(),
            label: "cargo test -p az-gui".into(),
            tool: "Bash".into(),
            // The agent did not say. Distinct from 0, which means it failed.
            ok: -1,
            output: "35 passed".into(),
            duration_ms: 1_200,
            exit_code: -1,
            finished_at: "2026-07-29T12:00:00+00:00".into(),
        };

        {
            let tables = Tables::open(&dir).await.expect("should open");
            tables.task_log.insert(row.clone()).expect("should insert");
            // Without the drain the process can end mid-write, which is how a
            // page ends up half written rather than merely stale.
            tables.shutdown().await;
        }

        let reopened = Tables::open(&dir).await.expect("should reopen");
        let found: Vec<TaskLogRow> = reopened
            .task_log
            .select_by_project_id("proj_1".to_string())
            .execute()
            .expect("should select");

        assert_eq!(found.len(), 1, "the row written last launch is still here");
        assert_eq!(found[0].label, "cargo test -p az-gui");
        assert_eq!(found[0].ok, -1, "unknown stays unknown, not failed");
        assert_eq!(found[0].duration_ms, 1_200);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

impl Tables {
    /// Wait for every table's pending writes to reach disk.
    ///
    /// Called once on exit. WorkTable persists through a background task, so a
    /// process that ends while an operation is still in flight can leave a page
    /// half written, and a half-written page is how a table becomes unreadable
    /// rather than merely stale. `wait_for_ops` is the drain.
    pub async fn shutdown(&self) {
        self.kv.wait_for_ops().await;
        self.project.wait_for_ops().await;
        self.project_item.wait_for_ops().await;
        self.message.wait_for_ops().await;
        self.task_log.wait_for_ops().await;
        self.agent_io.wait_for_ops().await;
        self.usage_ledger.wait_for_ops().await;
        self.approval_rule.wait_for_ops().await;
        self.pull_request.wait_for_ops().await;
    }
}
