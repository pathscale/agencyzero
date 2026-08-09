//! Questions an agent raised during a run, tracked inline in the transcript.
//!
//! An authored `@agency:ask` is the source: it turns the agent's question into a
//! row the owner answers at the conversation tail. A question is not a work
//! item and not a tool approval. `urgency` decides how loudly the tab calls:
//! `critical` (now),
//! `blocking` (the agent is stopped until answered), `passive` (answer when free).

use serde::Serialize;
use tauri::Emitter;
// `execute` on a select builder is a trait method.
use worktable::prelude::*;

use crate::AppHandle;
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

/// Record one `@agency:ask`, and announce its transcript card.
///
/// `reference` is split by shape, the same way `pr.link` tells a URL from a
/// number: an `https://` value is a GitHub issue, anything else is an item id.
/// The row is always emitted so the card lands the moment the directive parses,
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

/// Resolve which standing question a newly accepted owner message answers.
///
/// A chip names its question exactly. Untagged prose never answers a tracked
/// question: even one open question can coexist with unrelated feedback, and
/// inferring intent from ordinary text closes the card without owner action.
pub fn reply_target(
    tables: &Tables,
    project_id: &str,
    requested_id: Option<&str>,
) -> Result<Option<QuestionRow>, String> {
    let open: Vec<QuestionRow> = tables
        .question
        .select_by_project_id(project_id.to_owned())
        .execute()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| !row.answered)
        .collect();

    let Some(requested_id) = requested_id else {
        return Ok(None);
    };
    let Some(row) = open.into_iter().find(|row| row.id == requested_id) else {
        return Err(format!(
            "question {requested_id} is not open in project {project_id}"
        ));
    };
    Ok(Some(row))
}

/// Mark one linked question answered after the owner message is durable.
pub async fn answer_for_reply(
    app: &AppHandle,
    tables: &Tables,
    project_id: &str,
    question_id: &str,
) {
    if let Some(updated) = mark_for_reply(tables, project_id, question_id).await {
        let _ = app.emit("question:updated", updated);
    }
}

/// Store half of [`answer_for_reply`], split out for direct regression tests.
async fn mark_for_reply(
    tables: &Tables,
    project_id: &str,
    question_id: &str,
) -> Option<QuestionDto> {
    let row = tables.question.select(question_id.to_owned())?;
    if row.project_id != project_id || row.answered {
        return None;
    }
    if let Err(error) = tables
        .question
        .update_question_answered_by_id(
            QuestionAnsweredByIdQuery { answered: true },
            question_id.to_owned(),
        )
        .await
    {
        crate::log!(
            crate::log::Level::Error,
            "questions",
            "{project_id}: could not clear answered question {question_id}: {error}"
        );
        return None;
    }
    tables
        .question
        .select(question_id.to_owned())
        .map(QuestionDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_tagged_reply_closes_only_its_question() {
        let dir = std::env::temp_dir().join(format!(
            "az-question-reply-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let tables = Tables::open(&dir).await.expect("question store opens");
        let question = |id: &str, project_id: &str, answered: bool| QuestionRow {
            id: id.into(),
            project_id: project_id.into(),
            text: "Can I continue?".into(),
            urgency: "blocking".into(),
            item_id: String::new(),
            issue_url: String::new(),
            answered,
            created_at: "2026-08-06T00:00:00Z".into(),
        };
        tables
            .question
            .insert(question("open", "project-a", false))
            .expect("open question inserts");
        tables
            .question
            .insert(question("second-open", "project-a", false))
            .expect("second question inserts");
        tables
            .question
            .insert(question("other-project", "project-b", false))
            .expect("other project question inserts");

        let target = reply_target(&tables, "project-a", Some("open"))
            .expect("target validates")
            .expect("target exists");
        assert_eq!(target.id, "open");
        let changed = mark_for_reply(&tables, "project-a", &target.id)
            .await
            .expect("question changes");
        assert_eq!(changed.id, "open");
        assert!(changed.answered);
        assert!(tables.question.select("open".to_string()).unwrap().answered);
        assert!(
            !tables
                .question
                .select("second-open".to_string())
                .unwrap()
                .answered,
            "a tagged reply must not close a different standing question"
        );
        assert!(
            !tables
                .question
                .select("other-project".to_string())
                .unwrap()
                .answered,
            "a reply must not clear another project's indicator"
        );

        tables.shutdown().await.expect("tables drain");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn untagged_prose_never_answers_a_question() {
        let dir = std::env::temp_dir().join(format!(
            "az-question-inference-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let tables = Tables::open(&dir).await.expect("question store opens");
        let question = |id: &str| QuestionRow {
            id: id.into(),
            project_id: "project-a".into(),
            text: format!("Question {id}?"),
            urgency: "blocking".into(),
            item_id: String::new(),
            issue_url: String::new(),
            answered: false,
            created_at: "2026-08-06T00:00:00Z".into(),
        };
        tables
            .question
            .insert(question("only"))
            .expect("question inserts");
        assert!(
            reply_target(&tables, "project-a", None)
                .expect("untagged prose is valid")
                .is_none(),
            "one open question still requires an explicit reply chip"
        );
        tables
            .question
            .insert(question("ambiguous"))
            .expect("second question inserts");
        assert!(
            reply_target(&tables, "project-a", None)
                .expect("ambiguity is valid")
                .is_none(),
            "plain prose must not guess between stacked questions"
        );

        tables.shutdown().await.expect("tables drain");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_question_reply_link_survives_reopen() {
        let dir = std::env::temp_dir().join(format!(
            "az-question-link-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let tables = Tables::open(&dir).await.expect("question store opens");
        tables
            .question_reply
            .insert(crate::db::schema::question_reply::QuestionReplyRow {
                id: "link-1".into(),
                project_id: "project-a".into(),
                question_id: "question-a".into(),
                message_id: "message-a".into(),
                created_at: "2026-08-07T00:00:00Z".into(),
            })
            .expect("reply link inserts");
        tables.shutdown().await.expect("tables drain");

        let reopened = Tables::open(&dir).await.expect("question store reopens");
        let links = reopened
            .question_reply
            .select_by_message_id("message-a".into())
            .execute()
            .expect("reply links read");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].question_id, "question-a");

        reopened.shutdown().await.expect("reopened tables drain");
        let _ = std::fs::remove_dir_all(dir);
    }
}
