//! Crash recovery for the one agent reply currently streaming per project.
//!
//! Checkpoints are immutable rows. A new snapshot is inserted before older
//! snapshots are deleted, so a crash can leave several recoverable versions
//! but can never expose the resize-in-place failure that the old KV design did.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: ReplyCheckpoint,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        payload: String,
        created_at: String,
    },
    indexes: {
        reply_checkpoint_project_idx: project_id,
    },
    queries: {
        delete: {
            ByProject() by project_id,
        }
    }
);
