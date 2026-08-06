//! Durable denominator for outcome-per-dollar analytics.
//!
//! Finished item rows retire from the working list, so counting the current
//! table makes historical productivity shrink over time. One row per item id
//! records its first accepted finish and survives item/project deletion.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: ItemCompletion,
    persist: true,
    columns: {
        // Item ids are installation-wide and never reused.
        id: String primary_key,
        project_id: String,
        // claude | codex | copilot | owner | unknown
        agent: String,
        completed_at: String,
    },
    indexes: {
        completion_project_idx: project_id,
        completion_agent_idx: agent,
    }
);
