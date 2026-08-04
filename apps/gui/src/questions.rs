//! Questions an agent raised during a run, tracked as chips over the composer.
//!
//! An authored `@agency:ask` is the source: it turns the agent's question into a
//! row the owner answers, beside the PR chips because it is the same kind of
//! standing fact. A question is not a work item and not a tool approval: the
//! owner reads it here rather than scrolling the transcript, and answers it in
//! place. `urgency` decides how loudly the tab calls: `critical` (now),
//! `blocking` (the agent is stopped until answered), `passive` (answer when free).

use serde::Serialize;
use tauri::{AppHandle, Emitter};
// `execute` on a select builder is a trait method.
use worktable::prelude::*;

use crate::db::schema::question::{QuestionAnsweredByIdQuery, QuestionRow};
use crate::db::tables::Tables;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDto {
    pub id: String,
    pub project_id: String,
    pub text: String,
    pub urgency: String,
    /// The item this is about, when one was named. `None` otherwise.
    pub item_id: Option<String>,
    /// The GitHub issue this is about, when one was named. `None` otherwise.
    pub issue_url: Option<String>,
    pub answered: bool,
    pub created_at: String,
}

impl From<QuestionRow> for QuestionDto {
    fn from(row: QuestionRow) -> Self {
        QuestionDto {
            id: row.id,
            project_id: row.project_id,
            text: row.text,
            urgency: row.urgency,
            item_id: (!row.item_id.is_empty()).then_some(row.item_id),
            issue_url: (!row.issue_url.is_empty()).then_some(row.issue_url),
            answered: row.answered,
            created_at: row.created_at,
        }
    }
}

/// Record one `@agency:ask`, and announce its chip.
///
/// `reference` is split by shape, the same way `pr.link` tells a URL from a
/// number: an `https://` value is a GitHub issue, anything else is an item id.
/// The row is always emitted so the chip lands the moment the directive parses,
/// not at the next project load.
pub fn record(
    app: &AppHandle,
    tables: &Tables,
    project_id: &str,
    text: &str,
    urgency: &str,
    reference: Option<&str>,
) -> Result<String, String> {
    let (item_id, issue_url) = match reference {
        Some(reference) if reference.starts_with("https://") => {
            (String::new(), reference.to_string())
        }
        Some(reference) => (reference.to_string(), String::new()),
        None => (String::new(), String::new()),
    };
    let row = QuestionRow {
        id: crate::projects::id("q"),
        project_id: project_id.to_string(),
        text: text.to_string(),
        urgency: urgency.to_string(),
        item_id,
        issue_url,
        answered: false,
        created_at: crate::projects::now(),
    };
    tables.question.insert(row.clone()).map_err(|error| {
        crate::log!(
            crate::log::Level::Error,
            "questions",
            "{project_id}: could not record a question: {error}"
        );
        format!("WRITE_FAILED: {error}")
    })?;
    let id = row.id.clone();
    let _ = app.emit("question:updated", QuestionDto::from(row));
    Ok(id)
}

/// Every question raised in a project, newest first, answered ones included.
#[tauri::command]
pub fn list_questions(
    project_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Vec<QuestionDto> {
    let mut rows: Vec<QuestionDto> = state
        .tables
        .question
        .select_by_project_id(project_id)
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(QuestionDto::from)
        .collect();
    // Newest first: a question just asked is the one the owner most likely means.
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    rows
}

/// Mark a question answered (or reopen it), and announce the change.
#[tauri::command]
pub async fn answer_question(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    id: String,
    answered: bool,
) -> Result<(), String> {
    state
        .tables
        .question
        .update_question_answered_by_id(QuestionAnsweredByIdQuery { answered }, id.clone())
        .await
        .map_err(|error| format!("WRITE_FAILED: {error}"))?;
    if let Some(row) = state.tables.question.select(id) {
        let _ = app.emit("question:updated", QuestionDto::from(row));
    }
    Ok(())
}
