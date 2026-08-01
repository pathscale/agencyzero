//! Pull requests cut during a project's runs, tracked as chips over the composer.
//!
//! One row per PR URL per project, created from an authored PS directive and
//! refreshed through `gh` when available. `state` is GitHub's own word
//! (`OPEN` | `MERGED` | `CLOSED`, or `unknown` before the first refresh);
//! `ci` is the check rollup reduced to `pass` | `fail` | `pending` | `none` |
//! `unknown`. Dismissed rows stay on disk — a chip the owner waved away is
//! not a PR that stopped existing, and un-dismissing is then possible.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: PullRequest,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        url: String,
        // "owner/repo", straight from the URL.
        repo: String,
        number: u32,
        // Head branch, from `gh`; empty until a refresh answers.
        branch: String,
        state: String,
        additions: u32,
        deletions: u32,
        ci: String,
        dismissed: bool,
        updated_at: String,
    },
    indexes: {
        pr_project_idx: project_id,
    },
    queries: {
        update: {
            PrFactsById(branch, state, additions, deletions, ci, updated_at) by id,
            PrDismissedById(dismissed) by id,
        },
        delete: {
            ByProject() by project_id,
        }
    }
);
