//! Settings and the agent probe cache: two keyed blobs.
//!
//! A blob rather than a column per field, unlike every other table here. The
//! settings record is nested and does not flatten into columns without inventing
//! a join, and a typed table would need a `worktable_version!` migration every
//! time the frontend adds a setting. Serde defaults carry that instead.
//!
//! That reasoning does **not** extend to the entities below it. A transcript
//! wants columns, indexes and queries, which is what the rest of this directory
//! is for.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: Kv,
    persist: true,
    columns: {
        key: String primary_key,
        value: String,
        updated_at: String,
    },
);
