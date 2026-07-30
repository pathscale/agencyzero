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
    },
    indexes: {
        project_idx: project_id,
    },
    queries: {
        update: {
            StatusById(status) by id,
            PositionById(position) by id,
            TitleById(title) by id,
        },
        delete: {
            ByProject() by project_id,
        }
    }
);
