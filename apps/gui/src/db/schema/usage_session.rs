//! Provider-session ownership for durable usage-ledger turns.
//!
//! The ledger intentionally survives project deletion, while the resumable
//! provider session id currently lives in project-scoped KV. This appended
//! relation snapshots that id at turn completion and keys it to the ledger row
//! without changing the layout of any existing persisted table.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: UsageSession,
    persist: true,
    columns: {
        // The matching usage-ledger row id.
        id: String primary_key,
        project_id: String,
        agent: String,
        // Empty only when the provider never supplied a resumable id.
        session_id: String,
        model: String,
        at: String,
    },
    indexes: {
        usage_session_project_idx: project_id,
        usage_session_id_idx: session_id,
    }
);
