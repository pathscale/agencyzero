//! Durable links from owner messages to the questions they answer.
//!
//! Separate from both rows so the existing persisted layouts never change.
//! A message can eventually answer more than one question and a question can
//! be reopened without rewriting transcript history, so this is a relation,
//! not a column smuggled into either entity.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: QuestionReply,
    persist: true,
    columns: {
        id: String primary_key,
        project_id: String,
        question_id: String,
        message_id: String,
        created_at: String,
    },
    indexes: {
        question_reply_project_idx: project_id,
        question_reply_question_idx: question_id,
        question_reply_message_idx: message_id,
    },
    queries: {
        delete: {
            ByProject() by project_id,
        }
    }
);
