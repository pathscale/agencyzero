//! Layer 2: the work items inside a project.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: ProjectItem,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        // One short line, not a body.
        title: String,
        // Same `ProjectStatus` vocabulary as the parent project.
        status: String,
        position: u32,
        // Where the work went: a pull request or issue number without the `#`.
        // Empty until there is one.
        //
        // Its own column rather than a suffix on the title, because the title
        // is the match key for every later status change. A row renamed to
        // "Fix copy (#35)" would stop matching the line that closes it, and
        // stripping the suffix back off at match time is a parse nobody would
        // remember was there.
        reference: String,
    },
    indexes: {
        project_idx: project_id,
    },
    queries: {
        update: {
            StatusById(status) by id,
            PositionById(position) by id,
            TitleById(title) by id,
            ReferenceById(reference) by id,
        },
        delete: {
            ByProject() by project_id,
        }
    }
);
