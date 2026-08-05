//! One row per remembered approval: a standing "always allow similar" grant.
//!
//! # Why a table and not a kv blob
//!
//! These are permission grants, and grants deserve the same standing as any
//! other row: queryable one at a time (per-rule deletion is a `delete`, not a
//! parse-edit-rewrite of a JSON string), visible to `agency-tools` for auditing,
//! and shaped honestly — a list of rows is rows, not a string that happens to
//! contain them.
//!
//! `signature` is computed only in Rust (`projects::approval_signature`):
//! Bash rules are program plus subcommand, file rules the parent directory,
//! URL rules the host. Uniqueness of `(project_id, signature)` is enforced by
//! the writer, not the table — the single writer makes that safe.
//!
//! **Adding a column here changes the rkyv layout of every row on disk.** Bump
//! `SCHEMA_FINGERPRINT` in `db/tables.rs` in the same commit — see the module
//! doc on `db/schema/project.rs` for what happens otherwise.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: ApprovalRule,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        // The remembered shape, e.g. "Bash: cargo test" or "Edit: apps/gui/src".
        signature: String,
        // ISO 8601 — when the user taught it.
        created_at: String,
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
