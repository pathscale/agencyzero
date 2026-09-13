//! Read-only bridge from AgencyZero's final WorkTable v2 store.
//!
//! Only archived rows cross this crate boundary. The WorkTable 1.9 migration
//! coordinator decodes them against the current schema and creates v3 pages.

use std::path::Path;

use sha2::{Digest as _, Sha256};
use worktable::PersistedWorkTable;
use worktable::persistence::ReadOnlyPersistenceEngine;
use worktable::prelude::{DiskConfig, SelectQueryExecutor};

#[path = "../../../../apps/gui/src/db/schema"]
mod schema {
    pub mod agent_io;
    pub mod approval_rule;
    pub mod item_completion;
    pub mod kv;
    pub mod message;
    pub mod message_chunk;
    pub mod project;
    pub mod project_item;
    pub mod pull_request;
    pub mod question;
    pub mod question_reply;
    pub mod reply_checkpoint;
    pub mod study_event;
    pub mod task_log;
    pub mod usage_cache;
    pub mod usage_ledger;
    pub mod usage_session;
}

/// One table's version-neutral row archives.
pub struct TableExport {
    pub name: &'static str,
    pub rows: Vec<Vec<u8>>,
    pub digest: [u8; 32],
}

/// Every AgencyZero table, including empty and not-yet-created tables.
pub struct StoreExport {
    pub tables: Vec<TableExport>,
}

fn digest_rows(rows: &mut [Vec<u8>]) -> [u8; 32] {
    rows.sort_unstable();
    let mut digest = Sha256::new();
    for row in rows {
        digest.update((row.len() as u64).to_le_bytes());
        digest.update(row);
    }
    digest.finalize().into()
}

macro_rules! export_table {
    ($source:expr, $module:ident, $Table:ident) => {{
        use schema::$module::$Table;

        let name = $Table::name_snake_case();
        let table_path = $source.join(name);
        let mut rows = Vec::new();
        if table_path.is_dir() {
            let config = DiskConfig::new_with_table_name(
                $source.to_string_lossy().into_owned(),
                name,
                $Table::version(),
            );
            let engine = ReadOnlyPersistenceEngine::create(config)
                .await
                .map_err(|error| eyre::eyre!("v2 {name} would not open: {error}"))?;
            let table = $Table::load(engine)
                .await
                .map_err(|error| eyre::eyre!("v2 {name} would not load: {error}"))?;
            for row in table
                .select_all()
                .execute()
                .map_err(|error| eyre::eyre!("v2 {name} would not scan: {error}"))?
            {
                rows.push(
                    rkyv::to_bytes::<rkyv::rancor::Error>(&row)
                        .map_err(|error| eyre::eyre!("v2 {name} row would not archive: {error}"))?
                        .to_vec(),
                );
            }
        }
        let digest = digest_rows(&mut rows);
        TableExport { name, rows, digest }
    }};
}

/// Read all 17 tables through the final v2 engine without modifying them.
///
/// # Errors
/// A present table cannot be opened or scanned against AgencyZero's v2 row
/// schema, or a row cannot be archived.
pub async fn export(source: &Path) -> eyre::Result<StoreExport> {
    Ok(StoreExport {
        tables: vec![
            export_table!(source, kv, KvWorkTable),
            export_table!(source, project, ProjectWorkTable),
            export_table!(source, project_item, ProjectItemWorkTable),
            export_table!(source, item_completion, ItemCompletionWorkTable),
            export_table!(source, message, MessageWorkTable),
            export_table!(source, message_chunk, MessageChunkWorkTable),
            export_table!(source, task_log, TaskLogWorkTable),
            export_table!(source, agent_io, AgentIoRowWorkTable),
            export_table!(source, usage_ledger, UsageLedgerWorkTable),
            export_table!(source, usage_cache, UsageCacheWorkTable),
            export_table!(source, usage_session, UsageSessionWorkTable),
            export_table!(source, approval_rule, ApprovalRuleWorkTable),
            export_table!(source, pull_request, PullRequestWorkTable),
            export_table!(source, question, QuestionWorkTable),
            export_table!(source, question_reply, QuestionReplyWorkTable),
            export_table!(source, reply_checkpoint, ReplyCheckpointWorkTable),
            export_table!(source, study_event, StudyEventWorkTable),
        ],
    })
}

/// Write a neutral, checksummed archive set for the WorkTable 1.9 importer.
///
/// # Errors
/// The destination already exists, the source cannot be exported, or an
/// archive file cannot be written and synced.
pub async fn export_to(source: &Path, destination: &Path) -> eyre::Result<()> {
    use std::io::Write as _;

    std::fs::create_dir(destination)?;
    let exported = export(source).await?;
    for table in exported.tables {
        let path = destination.join(format!("{}.rows", table.name));
        let mut output = std::io::BufWriter::new(std::fs::File::create(path)?);
        output.write_all(b"AZWT2ROWS\0")?;
        output.write_all(&(table.rows.len() as u64).to_le_bytes())?;
        output.write_all(&table.digest)?;
        for row in table.rows {
            output.write_all(&(row.len() as u64).to_le_bytes())?;
            output.write_all(&row)?;
        }
        output.flush()?;
        output.get_ref().sync_all()?;
    }
    std::fs::File::open(destination)?.sync_all()?;
    Ok(())
}
