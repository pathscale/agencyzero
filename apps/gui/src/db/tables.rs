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

use crate::db::schema::kv::{KvPersistenceEngine, KvRow, KvWorkTable};
use crate::db::schema::message::{MessagePersistenceEngine, MessageWorkTable};
use crate::db::schema::project::{ProjectPersistenceEngine, ProjectWorkTable};
use crate::db::schema::project_item::{ProjectItemPersistenceEngine, ProjectItemWorkTable};

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
        })
    }
}

impl Tables {
    /// The blob at `key`, or `None` when nothing was ever written there.
    #[must_use]
    pub fn kv_get(&self, key: &str) -> Option<String> {
        self.kv.select(key.to_string()).map(|row| row.value)
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

    /// The behaviour the whole app depends on and that nothing covered: a write
    /// has to survive the process that made it. The round-trip test above opens
    /// once, so it would pass even if nothing reached disk.
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
        }

        let reopened = Tables::open(&dir).await.expect("should reopen");
        assert_eq!(
            reopened.kv_get("settings"),
            Some("{\"models\":\"chosen\"}".to_string()),
            "a setting written in one launch must be there in the next"
        );

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
    }
}
