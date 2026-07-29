//! One row per agent turn that reported usage: the durable cost record.
//!
//! # Why a ledger and not the messages table
//!
//! Messages already carry each turn's usage blob, but they die with their
//! project and they answer "what did this conversation cost", not "what did
//! this week cost". The ledger survives project deletion and is shaped for the
//! only question Settings asks: sums over date ranges.
//!
//! # Micro-dollars, not floats
//!
//! `cost_micro` is USD × 1,000,000 as an integer. The figure is the agent's
//! own (`cost_usd` from the turn's usage — nothing here computes a price) and
//! summing integers keeps the ledger exact; the display divides once at the
//! end.
//!
//! `day` is the UTC date (`YYYY-MM-DD`) carved off `at` at write time, so the
//! range queries are string comparisons — ISO dates sort lexicographically.
//!
//! **Adding a column here changes the rkyv layout of every row on disk.** Bump
//! `SCHEMA_FINGERPRINT` in `db/tables.rs` in the same commit — see the module
//! doc on `db/schema/project.rs` for what happens otherwise.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: UsageLedger,
    persist: true,
    columns: {
        id: String primary_key,
        // ISO 8601, the turn's finish time.
        at: String,
        // UTC date bucket, "YYYY-MM-DD".
        day: String,
        project_id: String,
        // The model the run was asked for; the agent may resolve an alias.
        model: String,
        // USD × 1e6, as reported by the agent itself.
        cost_micro: i64,
        input_tokens: i64,
        output_tokens: i64,
    },
    indexes: {
        day_idx: day,
    }
);
