//! Layer 1 of the Home list: one open tab per project.
//!
//! `dirs` and `forked_from` are JSON rather than columns. WorkTable has no list
//! column and no join, and a `project_dir` side table would buy ordering and
//! referential integrity that a handful of paths read together do not need.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: Project,
    persist: true,
    columns: {
        id: String primary_key,
        name: String,
        // `ProjectStatus`: pending | active | finished | canceled.
        status: String,
        // Home order, and the tab-strip order it is written back from.
        position: u32,
        // Working directories, JSON-encoded.
        dirs: String,
        pinned: bool,
        // Per-session override of the global moderator setting.
        moderator_enabled: bool,
        // `{projectId, messageId}` when this is a fork, else empty.
        forked_from: String,
        // ISO 8601, orders the Recent list.
        last_activity_at: String,
    },
    indexes: {
        status_idx: status,
    },
    queries: {
        update: {
            StatusById(status) by id,
            PinnedById(pinned) by id,
            PositionById(position) by id,
            LastActivityById(last_activity_at) by id,
        },
    }
);
