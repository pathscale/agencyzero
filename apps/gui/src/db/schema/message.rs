//! The transcript, one row per message.
//!
//! Agent, model, permission and usage are recorded per message rather than read
//! from the project, so history stays readable after the tab's settings move on.
//! `moderation` and `usage` are JSON: both are optional nested records, and
//! spreading them across a dozen nullable columns would make every read
//! reassemble them.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: Message,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        // Soft association to a `ProjectItem`, never enforced. Empty is normal.
        item_id: String,
        // user | agent | moderator.
        author: String,
        agent: String,
        // `Moderation` as JSON, empty when this is not a moderator note.
        moderation: String,
        model: String,
        permission: String,
        // `Usage` as JSON, empty when the agent did not report any.
        usage: String,
        stop: String,
        exit_code: i64,
        // Markdown, as the agent emits it.
        body: String,
        // ISO 8601, transcript order.
        created_at: String,
    },
    indexes: {
        project_idx: project_id,
    },
    queries: {
        update: {
            FinalizeById(usage, stop, exit_code) by id,
        },
        delete: {
            ByProject() by project_id,
        }
    }
);
