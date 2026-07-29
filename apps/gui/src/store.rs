//! The one thing this build persists: a keyed blob table on WorkTable.
//!
//! Two keys live here today, `settings` and `agents`, which is why the schema is
//! a key and a value rather than a column per field. Two reasons for that shape:
//! a settings record is nested (a moderator block, a notification block, a model
//! selection per agent) and does not flatten into columns without inventing a
//! join, and a column-per-field table would need a `worktable_version!`
//! migration every time the frontend adds a setting. A blob keeps schema change
//! in serde, where `#[serde(default)]` already handles a field arriving or
//! leaving.
//!
//! The trade is that WorkTable's indexes and generated queries do nothing for us
//! here. That is the right trade for two rows, and the wrong one for projects and
//! messages, which get their own typed tables when the read path lands.

use std::path::Path;

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: Store,
    persist: true,
    columns: {
        key: String primary_key,
        value: String,
        updated_at: String,
    },
);

/// Everything the GUI keeps between launches.
pub struct Store {
    table: StoreWorkTable,
}

impl Store {
    /// Open the store under `dir`, creating it on first run.
    ///
    /// # Errors
    /// Propagates whatever WorkTable reports when the directory cannot be read
    /// or the on-disk table cannot be opened. A caller that cannot persist
    /// should say so rather than silently running in memory: settings that
    /// appear to save and then vanish are worse than settings that refuse to
    /// save.
    pub async fn open(dir: &Path) -> Result<Store, Box<dyn std::error::Error + Send + Sync>> {
        std::fs::create_dir_all(dir)?;
        let config = DiskConfig::new_with_table_name(
            dir.to_string_lossy().as_ref(),
            StoreWorkTable::name_snake_case(),
            StoreWorkTable::version(),
        );
        let engine = StorePersistenceEngine::new(config).await?;
        let table = StoreWorkTable::new(engine).await?;
        Ok(Store { table })
    }

    /// The value at `key`, or `None` when nothing was ever written there.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<String> {
        self.table.select(key.to_string()).map(|row| row.value)
    }

    /// Write `value` at `key`, replacing whatever was there.
    ///
    /// # Errors
    /// Propagates WorkTable's own error when the row cannot be written.
    pub async fn put(
        &self,
        key: &str,
        value: String,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.table
            .upsert(StoreRow {
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

    /// A round trip through a fresh directory, which is the only behaviour the
    /// rest of the app depends on.
    #[tokio::test]
    async fn a_value_survives_being_written_and_read_back() {
        let dir = std::env::temp_dir().join(format!("az-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let store = Store::open(&dir).await.expect("should open");
        assert_eq!(store.get("settings"), None, "a fresh store holds nothing");

        store
            .put("settings", "{\"a\":1}".into())
            .await
            .expect("should write");
        assert_eq!(store.get("settings"), Some("{\"a\":1}".to_string()));

        store
            .put("settings", "{\"a\":2}".into())
            .await
            .expect("should overwrite");
        assert_eq!(
            store.get("settings"),
            Some("{\"a\":2}".to_string()),
            "a second write replaces rather than appends"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
