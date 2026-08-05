//! The prompt-cache split of a turn's usage, the metric that drives token
//! optimization.
//!
//! Separate from `usage_ledger` on purpose: adding columns to that table would
//! change its fingerprint mid-string and mark every existing store a mismatch
//! (and misread its rkyv rows positionally). A new table appends to the
//! fingerprint instead, which the prefix check treats as a clean addition with
//! no rows on disk to misread. One row per priced turn, keyed to the ledger by
//! the same day and project for aggregation.
//!
//! Cache *reads* bill at a tenth of input; cache *writes* at a premium (1.25x at
//! the five-minute TTL, 2x at the one-hour). The read-to-write ratio over time
//! is the single most useful signal for whether caching is actually working, so
//! it is worth persisting rather than leaving only in the live per-turn usage.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: UsageCache,
    persist: true,
    columns: {
        id: String primary_key,
        // UTC date bucket, "YYYY-MM-DD", matching the ledger's `day`.
        day: String,
        project_id: String,
        model: String,
        // Tokens served from cache this turn, billed at ~0.1x input.
        cache_read_tokens: i64,
        // Tokens written to cache this turn, billed at a premium.
        cache_write_tokens: i64,
        // The uncached input remainder, for the full decomposition. `input`
        // from the ledger already excludes cache reads on Claude.
        input_tokens: i64,
        // ISO 8601 finish time, for the time-series panels.
        at: String,
    },
    indexes: {
        cache_day_idx: day,
        cache_project_idx: project_id,
    }
);
