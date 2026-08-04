//! Questions an agent raised during a run, tracked as chips over the composer.
//!
//! A question is its own entity, not a work item and not a tool approval. An
//! `@agency:ask` directive is the source: it turns authored text into a row the
//! owner answers, the same way `@agency:pr.link` turns a URL into a PR chip. It
//! sits beside the PR chips precisely because it is the same kind of thing, a
//! standing fact about this project that the owner acts on, rather than a line
//! of prose to scroll back and find.
//!
//! `urgency` is how loudly it calls for attention: `critical` (answer now, e.g.
//! a security hole), `blocking` (the agent cannot proceed until answered), or
//! `passive` (answer when free, the agent keeps working). `item_id` and
//! `issue_url` are optional back-references, empty until given, so the IDE can
//! show what a question is about. `answered` rows stay on disk, like a dismissed
//! PR: a question the owner closed is not one that never happened.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: Question,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        // The question itself, as the agent authored it. The data plane: the
        // `questions` state transition is the execution plane, this is what
        // rides it.
        text: String,
        // `critical` | `blocking` | `passive`. Never empty: `ask` defaults a
        // missing urgency to `blocking`, the safe middle, so a question always
        // says how badly it is needed.
        urgency: String,
        // Optional back-reference to the item this is about. Empty when none.
        item_id: String,
        // Optional GitHub issue URL this is about. Empty when none.
        issue_url: String,
        // Cleared to `true` when the owner answers. An answered row stays for
        // history, like a dismissed PR, and un-answering is then possible.
        answered: bool,
        created_at: String,
    },
    indexes: {
        question_project_idx: project_id,
    },
    queries: {
        update: {
            QuestionAnsweredById(answered) by id,
        },
        delete: {
            ByProject() by project_id,
        }
    }
);
