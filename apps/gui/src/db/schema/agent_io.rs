//! The raw exchange with the agent, when a project asks for it to be kept.
//!
//! # Off by default, and per project
//!
//! This is the highest-volume thing the app could write. A single turn emits a
//! text event per delta, so a long run is thousands of rows for data whose
//! value drops off within minutes — the panel answers "what just happened".
//! Writing that for every project by default would put continuous load on a
//! store the whole workspace depends on, and WorkTable is sensitive to a
//! half-written page.
//!
//! So it is opt-in per project, recorded in `kv` under `io-persist:<project_id>`
//! and toggled from the project's Settings section. Turn it on for the project
//! you are debugging; leave it off for the rest.
//!
//! Rows are trimmed to the newest [`crate::projects::MAX_IO_ENTRIES`] per
//! project on write, so a session left recording overnight cannot grow without
//! bound.
//!
//! **Adding a column here changes the rkyv layout of every row on disk.** Bump
//! `SCHEMA_FINGERPRINT` in `db/tables.rs` in the same commit — see the module
//! doc on `db/schema/project.rs` for what happens otherwise.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: AgentIoRow,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        // ISO 8601. Sort key, and the cursor for trimming.
        at: String,
        // sent | received | gui.
        direction: String,
        // request | started | text | tool_call | tool_result | rate_limit |
        // stop | stderr | unparsed | action.
        kind: String,
        detail: String,
    },
    indexes: {
        project_idx: project_id,
    },
    queries: {
        delete: {
            ByProject() by project_id,
        }
    }
);
