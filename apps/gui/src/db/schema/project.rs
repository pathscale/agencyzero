//! Layer 1 of the Home list: one open tab per project.
//!
//! `dirs` and `forked_from` are JSON rather than columns. WorkTable has no list
//! column and no join, and a `project_dir` side table would buy ordering and
//! referential integrity that a handful of paths read together do not need.
//!
//! # Do not add a column here without reading this
//!
//! Rows are persisted with rkyv, positionally. Adding, removing or reordering a
//! column changes the layout, and **every row already on disk is then read
//! through the new one** — silently. `version()` is a fixed constant the macro
//! emits, so it does not change with the schema and catches none of this.
//!
//! What that looks like is not an error. It is a project whose id reads as
//! `00:00   `, whose name is nonsense, and which every command then fails to
//! find: delete, pin and the session write all return `NotFound`, two tabs
//! collide on one garbage key, and one composer feeds two conversations. That
//! is a real afternoon, spent here.
//!
//! The session id is in `kv` under `session:<project_id>` for exactly this
//! reason — it is a per-project fact that arrived after the schema, and `kv` is
//! a `String -> String` blob table whose layout cannot shift.
//!
//! If a column genuinely has to change, bump `SCHEMA_FINGERPRINT` in
//! `db/tables.rs` in the same commit. The guard there will then refuse to open
//! the old files rather than misread them.

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
        // Parent linkage when this is a fork. Item forks carry
        // `{projectId, itemId}`; legacy conversation forks may carry a message id.
        forked_from: String,
        // ISO 8601, orders the Recent list.
        last_activity_at: String,
    },
    indexes: {
        status_idx: status,
    },
    queries: {
        update: {
            NameById(name) by id,
            DirsById(dirs) by id,
            StatusById(status) by id,
            PinnedById(pinned) by id,
            ModeratorById(moderator_enabled) by id,
            PositionById(position) by id,
            LastActivityById(last_activity_at) by id,
        },
    }
);
