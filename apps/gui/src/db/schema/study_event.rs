//! Content-free events for the opt-in PromptSyntax deployment study.
//!
//! The table records how a declared operation travelled through AgencyZero,
//! not what the user or agent said. Prompt bodies, task titles, project names,
//! paths, URLs, tool output and agent prose do not belong here. Local ids are
//! kept only so an export can link a later manual correction to the operation
//! it followed; the export command replaces every one with a per-export
//! pseudonym.
//!
//! Collection is disabled by default. Callers go through `crate::study`, which
//! checks the persisted setting before any row is written.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: StudyEvent,
    persist: true,
    columns: {
        id: String primary_key,
        study_id: String,
        at: String,
        project_id: String,
        turn_id: String,
        // Links one parsed PS segment to its one terminal result.
        interaction_id: String,
        agent: String,
        pathway: String,
        operation: String,
        stage: String,
        outcome: String,
        code: String,
        target_kind: String,
        target_id: String,
        latency_ms: i64,
        // Allow-listed JSON counters and booleans, never source text.
        detail: String,
        app_version: String,
        parser_version: String,
        protocol_version: String,
    },
    indexes: {
        study_idx: study_id,
        project_idx: project_id,
    },
    queries: {
        delete: {
            ByStudy() by study_id,
        }
    }
);
