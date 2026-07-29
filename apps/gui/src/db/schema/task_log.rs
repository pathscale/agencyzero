//! Finished tool calls, one row per call.
//!
//! The panel's badge counts every call a project has ever made while the list
//! holds one page, so this is a real table rather than a bounded in-memory
//! ring: a page cannot report the size of the thing it is a page of.
//!
//! # Why `ok` is an integer
//!
//! `ok` is **nullable in the model** — null means the agent did not say whether
//! the call succeeded, which is not the same as failure and must not render as
//! one. WorkTable columns are not nullable, so the tri-state is carried as
//! `-1` unknown / `0` failed / `1` succeeded and mapped back at the edge.
//! `duration_ms` and `exit_code` use `-1` the same way, matching how
//! `MessageRow.exit_code` already encodes an absent code.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: TaskLog,
    persist: true,
    columns: {
        id: String primary_key,
        // The agent's own id for the call, empty when it did not supply one.
        // Without it a running row cannot be correlated to its result.
        tool_call_id: String,
        project_id: String,
        // Soft association to a `ProjectItem`, never enforced. Empty is normal.
        item_id: String,
        // What the row reads as: built from the tool's input, agent-side shapes
        // and all, because only Rust has seen them.
        label: String,
        tool: String,
        // -1 unknown | 0 failed | 1 succeeded. See the module doc.
        ok: i64,
        output: String,
        // -1 when the call was not timed.
        duration_ms: i64,
        // -1 when the agent did not report one.
        exit_code: i64,
        // ISO 8601. Newest first in the panel, and the cursor for older pages.
        finished_at: String,
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
