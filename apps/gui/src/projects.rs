//! Projects, their items, their transcripts, and the agent run that fills them.
//!
//! # Streaming, and when a row is written
//!
//! Events reach the UI as they arrive; the database is written once, when the
//! run finishes. A row per token would hammer the table for data that is
//! superseded microseconds later, and `Outcome::text` is the authoritative body
//! anyway: the deltas are for the eye, the outcome is for the record.
//!
//! That means an interrupted run persists nothing. Deliberate for now, and the
//! thing to revisit first if a long run lost to a crash starts hurting.
//!
//! # Naming
//!
//! Stage 0 only, per `docs/gui-wiring-plan.md`: the name is taken from the front
//! of the first prompt, locally and immediately, so a tab is never blank and
//! never waits on a model. The cheap second call that improves it, and the manual
//! rename that outranks both, are not built yet.

use agent_abstraction::{Agent, Event, Permission, Request, Stop};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
// `execute` on a select builder is a trait method.
use worktable::prelude::*;

use crate::AppState;
use crate::db::schema::message::MessageRow;
use crate::db::schema::project::ProjectRow;
use crate::db::schema::project_item::ProjectItemRow;

// — wire shapes ————————————————————————————————————————————————————

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    pub status: String,
    pub order: u32,
    pub dirs: Vec<String>,
    pub pinned: bool,
    pub moderator_enabled: bool,
    pub forked_from: Option<serde_json::Value>,
    pub last_activity_at: String,
}

impl From<ProjectRow> for ProjectDto {
    fn from(row: ProjectRow) -> Self {
        ProjectDto {
            id: row.id,
            name: row.name,
            status: row.status,
            order: row.position,
            dirs: serde_json::from_str(&row.dirs).unwrap_or_default(),
            pinned: row.pinned,
            moderator_enabled: row.moderator_enabled,
            forked_from: serde_json::from_str(&row.forked_from).ok(),
            last_activity_at: row.last_activity_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemDto {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: String,
    pub order: u32,
}

impl From<ProjectItemRow> for ProjectItemDto {
    fn from(row: ProjectItemRow) -> Self {
        ProjectItemDto {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            status: row.status,
            order: row.position,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub project_id: String,
    pub item_id: Option<String>,
    pub author: String,
    pub agent: String,
    pub moderation: Option<serde_json::Value>,
    pub model: String,
    pub permission: String,
    pub usage: Option<serde_json::Value>,
    pub stop: String,
    pub exit_code: Option<i64>,
    pub body: String,
    pub created_at: String,
}

impl From<MessageRow> for MessageDto {
    fn from(row: MessageRow) -> Self {
        MessageDto {
            id: row.id,
            project_id: row.project_id,
            item_id: (!row.item_id.is_empty()).then_some(row.item_id),
            author: row.author,
            agent: row.agent,
            moderation: serde_json::from_str(&row.moderation).ok(),
            model: row.model,
            permission: row.permission,
            usage: serde_json::from_str(&row.usage).ok(),
            stop: row.stop,
            // -1 is the absent marker: the column is not nullable and a real
            // exit code is never negative.
            exit_code: (row.exit_code >= 0).then_some(row.exit_code),
            body: row.body,
            created_at: row.created_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    pub project_id: String,
    pub body: String,
    pub item_id: Option<String>,
    pub model: Option<String>,
    pub permission: Option<String>,
    pub effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub first_message: String,
    pub model: Option<String>,
    pub permission: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub project: ProjectDto,
    pub items: Vec<ProjectItemDto>,
}

// — helpers ————————————————————————————————————————————————————————

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

/// Stage-0 naming: the front of the prompt, trimmed to something tab-sized.
///
/// Cuts on a word boundary so a name never ends mid-word, and falls back to
/// "Untitled" rather than to an empty string, which would render as a nameless
/// tab.
fn name_from_prompt(prompt: &str) -> String {
    let first_line = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    if first_line.is_empty() {
        return "Untitled".into();
    }
    const MAX: usize = 48;
    if first_line.chars().count() <= MAX {
        return first_line.to_string();
    }
    let clipped: String = first_line.chars().take(MAX).collect();
    match clipped.rsplit_once(char::is_whitespace) {
        Some((head, _)) if head.len() > MAX / 3 => format!("{head}…"),
        _ => format!("{clipped}…"),
    }
}

fn parse_permission(raw: Option<&str>) -> Permission {
    match raw.unwrap_or("read_only") {
        "plan" => Permission::Plan,
        "edit" => Permission::Edit,
        "auto" => Permission::Auto,
        "bypass" => Permission::Bypass,
        _ => Permission::ReadOnly,
    }
}

// — read path ——————————————————————————————————————————————————————

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Vec<ProjectDto> {
    let mut rows: Vec<ProjectDto> = state
        .tables
        .project
        .select_all()
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(ProjectDto::from)
        .collect();
    rows.sort_by_key(|project| project.order);
    rows
}

#[tauri::command]
pub fn list_items(project_id: String, state: State<'_, AppState>) -> Vec<ProjectItemDto> {
    let mut rows: Vec<ProjectItemDto> = state
        .tables
        .project_item
        .select_by_project_id(project_id)
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(ProjectItemDto::from)
        .collect();
    rows.sort_by_key(|item| item.order);
    rows
}

#[tauri::command]
pub fn list_messages(project_id: String, state: State<'_, AppState>) -> Vec<MessageDto> {
    let mut rows: Vec<MessageDto> = state
        .tables
        .message
        .select_by_project_id(project_id)
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(MessageDto::from)
        .collect();
    rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    rows
}

/// Nothing is persisted for these yet: a running task exists only while its run
/// does, and a task log needs the `ToolResult` capture the run path writes.
/// Returning empty rather than omitting the command keeps startup honest.
#[tauri::command]
pub fn list_running_tasks(_project_id: String) -> Vec<serde_json::Value> {
    Vec::new()
}

#[derive(Serialize)]
pub struct TaskLogPage {
    pub entries: Vec<serde_json::Value>,
    pub total: usize,
}

#[tauri::command]
pub fn list_task_log(_project_id: String, _limit: usize) -> TaskLogPage {
    TaskLogPage {
        entries: Vec::new(),
        total: 0,
    }
}

#[tauri::command]
pub fn list_rate_limits() -> Vec<serde_json::Value> {
    Vec::new()
}

// — mutations ——————————————————————————————————————————————————————

/// Create a project from its first message, and run the agent on it.
///
/// # Errors
/// Returns the store's error when the project cannot be written.
#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    input: CreateProjectInput,
    state: State<'_, AppState>,
) -> Result<CreatedProject, String> {
    let project_id = id("proj");
    let order = u32::try_from(list_projects(state.clone()).len()).unwrap_or(0);

    let row = ProjectRow {
        id: project_id.clone(),
        name: name_from_prompt(&input.first_message),
        status: "active".into(),
        position: order,
        dirs: "[]".into(),
        pinned: false,
        moderator_enabled: false,
        forked_from: String::new(),
        last_activity_at: now(),
    };
    state
        .tables
        .project
        .insert(row.clone())
        .map_err(|error| error.to_string())?;

    let project = ProjectDto::from(row);
    let _ = app.emit("project:created", &project);

    send_message(
        app,
        SendMessageInput {
            project_id,
            body: input.first_message,
            item_id: None,
            model: input.model,
            permission: input.permission,
            effort: None,
        },
        state,
    )
    .await?;

    Ok(CreatedProject {
        project,
        items: Vec::new(),
    })
}

/// Persist the user's message, then run the agent in the background.
///
/// Returns as soon as the user's message is stored, rather than when the run
/// finishes. A run takes minutes and the composer awaits this call before it
/// clears the draft; holding it open would freeze the prompt for the whole turn.
/// Everything after this point arrives as events.
///
/// # Errors
/// Returns the store's error when the user's message cannot be written. A
/// failure to *start* the agent is reported as a `run:stopped` event rather than
/// here, since by then the message is already in the transcript.
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    input: SendMessageInput,
    state: State<'_, AppState>,
) -> Result<MessageDto, String> {
    let model = input.model.clone().unwrap_or_default();
    let permission = input
        .permission
        .clone()
        .unwrap_or_else(|| "read_only".into());

    let user_row = MessageRow {
        id: id("msg"),
        project_id: input.project_id.clone(),
        item_id: input.item_id.clone().unwrap_or_default(),
        author: "user".into(),
        agent: "claude".into(),
        moderation: String::new(),
        model: model.clone(),
        permission: permission.clone(),
        usage: String::new(),
        stop: "completed".into(),
        exit_code: -1,
        body: input.body.clone(),
        created_at: now(),
    };
    state
        .tables
        .message
        .insert(user_row.clone())
        .map_err(|error| error.to_string())?;

    let user_message = MessageDto::from(user_row);
    let _ = app.emit("message:appended", &user_message);

    // The working directory: the project's own if it has one, else the
    // workspace root. An agent with no cwd inherits the app's, which for a
    // bundled .app is `/`.
    let cwd = state
        .tables
        .project
        .select(input.project_id.clone())
        .and_then(|row| {
            serde_json::from_str::<Vec<String>>(&row.dirs)
                .ok()
                .and_then(|dirs| dirs.first().cloned())
        })
        .unwrap_or_else(|| crate::workspace_root_path(&app, &state));

    let tables = state.tables.clone();
    let project_id = input.project_id.clone();
    let effort = input.effort.clone();

    tauri::async_runtime::spawn(async move {
        drive_run(
            app, tables, project_id, input.body, model, permission, effort, cwd,
        )
        .await;
    });

    Ok(user_message)
}

/// Stream one turn: events out as they arrive, one row in at the end.
#[allow(
    clippy::too_many_arguments,
    reason = "a turn genuinely has this many inputs"
)]
async fn drive_run(
    app: AppHandle,
    tables: std::sync::Arc<crate::db::tables::Tables>,
    project_id: String,
    prompt: String,
    model: String,
    permission: String,
    effort: Option<String>,
    cwd: String,
) {
    let mut request = Request::new(Agent::Claude, prompt)
        .permission(parse_permission(Some(&permission)))
        .cwd(&cwd);
    if !model.is_empty() {
        request = request.model(&model);
    }
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        request = request.effort(effort);
    }

    let mut run = match agent_abstraction::stream(&request) {
        Ok(run) => run,
        Err(error) => {
            let _ = app.emit(
                "run:stopped",
                serde_json::json!({
                    "projectId": project_id,
                    "stop": format!("could not start the agent: {error}"),
                    "exitCode": null,
                }),
            );
            return;
        }
    };

    while let Some(event) = run.recv().await {
        match event {
            Event::Text(delta) => {
                let _ = app.emit(
                    "run:text",
                    serde_json::json!({ "projectId": project_id, "delta": delta }),
                );
            }
            Event::Thinking(text) => {
                let _ = app.emit(
                    "run:thinking",
                    serde_json::json!({ "projectId": project_id, "text": text }),
                );
            }
            Event::ToolCall { id, name, input } => {
                let _ = app.emit(
                    "task:started",
                    serde_json::json!({
                        "toolCallId": id,
                        "projectId": project_id,
                        "itemId": null,
                        "name": name,
                        "label": input.to_string(),
                        "startedAt": now(),
                        "isCancelable": true,
                    }),
                );
            }
            Event::ToolResult { id, ok, output, .. } => {
                let _ = app.emit(
                    "task:finished",
                    serde_json::json!({
                        "id": crate::projects::id("log"),
                        "toolCallId": id,
                        "projectId": project_id,
                        "itemId": null,
                        "label": String::new(),
                        "tool": String::new(),
                        "ok": ok,
                        "output": output,
                        "durationMs": null,
                        "exitCode": null,
                        "finishedAt": now(),
                    }),
                );
            }
            Event::RateLimit(limit) => {
                // The crate reports the provider's own status and window rather
                // than a sentence, so the sentence is composed here. `resets_at`
                // is epoch seconds and the frontend reads ISO 8601.
                let message = match &limit.window {
                    Some(window) => format!("{} ({window})", limit.status),
                    None => limit.status.clone(),
                };
                let resets_at = limit
                    .resets_at
                    .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
                    .map(|at| at.to_rfc3339());
                let _ = app.emit(
                    "run:rate_limit",
                    serde_json::json!({
                        "projectId": project_id,
                        "message": message,
                        "resetsAt": resets_at,
                    }),
                );
            }
            Event::Started { .. } => {}
            _ => {}
        }
    }

    // One write, now that there is something final to write.
    match run.finish().await {
        Ok(outcome) => {
            let stop = match &outcome.stop {
                Stop::Completed => "completed".to_string(),
                Stop::Error => "error".to_string(),
                Stop::Other(other) => other.clone(),
                // `Stop` is #[non_exhaustive]: a stop reason added by a later
                // crate release must reach the transcript as itself rather than
                // be flattened into "error".
                other => format!("{other:?}"),
            };
            let row = MessageRow {
                id: id("msg"),
                project_id: project_id.clone(),
                item_id: String::new(),
                author: "agent".into(),
                agent: "claude".into(),
                moderation: String::new(),
                model: model.clone(),
                permission,
                usage: serde_json::to_string(&outcome.usage).unwrap_or_default(),
                stop: stop.clone(),
                exit_code: i64::from(outcome.exit_code),
                body: outcome.text.clone(),
                created_at: now(),
            };
            if let Err(error) = tables.message.insert(row.clone()) {
                eprintln!("[az-gui] could not persist the reply: {error}");
            }
            let _ = app.emit("message:appended", MessageDto::from(row));
            let _ = app.emit(
                "run:stopped",
                serde_json::json!({
                    "projectId": project_id,
                    "stop": stop,
                    "exitCode": outcome.exit_code,
                }),
            );
        }
        Err(error) => {
            let _ = app.emit(
                "run:stopped",
                serde_json::json!({
                    "projectId": project_id,
                    "stop": error.to_string(),
                    "exitCode": null,
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_taken_from_the_front_of_the_prompt() {
        assert_eq!(name_from_prompt("Fix the login bug"), "Fix the login bug");
    }

    /// A long prompt is cut on a word boundary. A name ending mid-word reads as
    /// broken rather than as truncated.
    #[test]
    fn a_long_prompt_is_cut_on_a_word_boundary() {
        let name = name_from_prompt(
            "Review the authentication middleware and report anything that could leak a session",
        );
        assert!(name.ends_with('…'), "should be marked as clipped: {name}");
        assert!(name.chars().count() <= 49, "too long: {name}");
        assert!(!name.contains("  "), "should not collapse oddly: {name}");
    }

    /// An empty prompt still has to produce a tab label.
    #[test]
    fn an_empty_prompt_still_gets_a_name() {
        assert_eq!(name_from_prompt("   \n  "), "Untitled");
        assert_eq!(name_from_prompt(""), "Untitled");
    }

    /// Leading blank lines are skipped rather than becoming the name.
    #[test]
    fn leading_blank_lines_are_skipped() {
        assert_eq!(
            name_from_prompt("\n\n  Ship the release"),
            "Ship the release"
        );
    }

    #[test]
    fn permissions_map_onto_the_crates_own_enum() {
        assert_eq!(parse_permission(Some("bypass")), Permission::Bypass);
        assert_eq!(parse_permission(Some("plan")), Permission::Plan);
        // Anything unrecognized is the safest posture, never the widest.
        assert_eq!(parse_permission(Some("nonsense")), Permission::ReadOnly);
        assert_eq!(parse_permission(None), Permission::ReadOnly);
    }
}
