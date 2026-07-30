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

use agent_abstraction::{Agent, Decision, Event, Permission, Request, Stop};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
// `execute` on a select builder is a trait method.
use worktable::prelude::*;

use crate::AppState;
use crate::db::schema::message::MessageRow;
use crate::db::schema::project::{NameByIdQuery, PinnedByIdQuery, ProjectRow};
use crate::db::schema::project_item::ProjectItemRow;
use crate::db::schema::task_log::TaskLogRow;

// — wire shapes ————————————————————————————————————————————————————

#[derive(Serialize, Deserialize, Clone)]
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
    /// The agent's own session id, once a run has revealed one. `None` before
    /// the first turn, which the header renders as "no session yet" rather than
    /// as an empty box.
    ///
    /// Filled from `kv` by [`with_session`] rather than read off the row: it is
    /// not a column, deliberately. See [`session_key`].
    pub session_id: Option<String>,
    pub last_activity_at: String,
}

/// Attach the project's session id, which lives in `kv` rather than on the row.
fn with_session(mut dto: ProjectDto, tables: &crate::db::tables::Tables) -> ProjectDto {
    dto.session_id = tables.kv_get(&session_key(&dto.id));
    dto
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
            // Filled by `with_session`, which has the tables to look it up in.
            session_id: None,
            last_activity_at: row.last_activity_at,
        }
    }
}

#[derive(Serialize, Clone)]
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

/// What the transcript shows for a turn's usage.
///
/// A translation of `agent_abstraction::Usage`, not a re-export, because the
/// two disagree on both names and shape: the crate reports `input_tokens` /
/// `output_tokens` / `cost_usd` in snake_case, and the webview reads a single
/// `tokens` total in camelCase. Writing the crate's struct straight to the wire
/// is what crashed the window — `usage.costUsd` came back `undefined`, which is
/// not `null`, so the "did the agent report a cost" guard passed and
/// `.toFixed()` threw **during render**. A transcript that cannot paint takes
/// the whole workspace with it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageDto {
    /// Input plus output for this turn: the new work it did.
    pub tokens: u64,
    /// Every input token the turn was charged for, cached or not — the size of
    /// the conversation as the model saw it.
    ///
    /// **Already cumulative.** The agent re-sends the whole conversation each
    /// turn and reports it, so summing this across turns counts the same
    /// conversation once per turn and the error grows with the session. The
    /// crate ships `Usage::accumulate` precisely because the obvious loop is
    /// wrong; the frontend's `usageTotals` follows the same rule.
    pub context_tokens: Option<u64>,
    /// The model's context window, where the agent reports one. Claude alone
    /// does, so a share of the limit is only shown when it is there.
    pub context_window: Option<u64>,
    /// Also cumulative rather than additive. Same reason.
    pub cache_reads: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    /// Copilot's only unit.
    pub premium_requests: Option<u64>,
    pub duration_ms: Option<u64>,
}

impl From<&agent_abstraction::Usage> for UsageDto {
    fn from(usage: &agent_abstraction::Usage) -> Self {
        UsageDto {
            tokens: usage.input_tokens.unwrap_or(0) + usage.output_tokens.unwrap_or(0),
            context_tokens: usage.context_tokens,
            context_window: usage.context_window,
            cache_reads: usage.cache_read_tokens,
            reasoning_tokens: usage.reasoning_tokens,
            cost_usd: usage.cost_usd,
            premium_requests: usage.premium_requests,
            duration_ms: usage.duration_ms,
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
    /// Reasoning effort, as `Request::effort`. `None` means the CLI's default.
    pub effort: Option<String>,
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

/// Where a project's session id is kept in `kv`.
///
/// Not a column on the project row. Adding one changes the rkyv layout and
/// misreads every row already on disk — which is exactly how project ids turned
/// into `00:00   ` and every command started returning `NotFound`. See the
/// module doc on `db/schema/project.rs`.
fn session_key(project_id: &str) -> String {
    format!("session:{project_id}")
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

/// The most items one reply may contribute.
///
/// A bound rather than trust: a long plan should not turn the Items panel into
/// a wall, and a malformed reply should not be able to write a thousand rows.
const MAX_ITEMS_PER_REPLY: usize = 20;

/// Work items found in the agent's reply.
///
/// **Markdown checkboxes only** — `- [ ] title` and `- [x] title`. Deliberately
/// not bullets, numbered lists or headings: a checkbox is unambiguously a task,
/// whereas a bulleted list is just as often prose. Reading structure into
/// ordinary paragraphs would write items the agent never proposed, and an
/// invented to-do in someone's workspace is worse than an empty panel.
///
/// Returns `(title, status)` in the order they appear, with `[x]` mapping onto
/// the `finished` status the panel already renders struck through.
fn items_from_reply(reply: &str) -> Vec<(String, String)> {
    reply
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            // A list marker, then the box. `1.` and `1)` count: an agent writing
            // an ordered checklist means the same thing.
            let rest = line
                .strip_prefix("- ")
                .or_else(|| line.strip_prefix("* "))
                .or_else(|| line.strip_prefix("+ "))
                .or_else(|| {
                    let digits = line.trim_start_matches(|c: char| c.is_ascii_digit());
                    (digits.len() < line.len())
                        .then(|| digits.strip_prefix(". ").or_else(|| digits.strip_prefix(") ")))
                        .flatten()
                })?
                .trim_start();

            let (marker, title) = match rest.strip_prefix("[ ] ") {
                Some(title) => ("pending", title),
                None => (
                    "finished",
                    rest.strip_prefix("[x] ")
                        .or_else(|| rest.strip_prefix("[X] "))?,
                ),
            };

            let title = title.trim();
            (!title.is_empty())
                .then(|| (truncate_on_char_boundary(title, 120), marker.to_string()))
        })
        .take(MAX_ITEMS_PER_REPLY)
        .collect()
}

/// What a task row reads as, built from the tool's own arguments.
///
/// This has to happen in Rust: `ToolCall::input` arrives in the *agent's* shape,
/// and the three CLIs disagree about it, so the webview would need every agent's
/// argument vocabulary to render one line of text.
///
/// The rule is to show the argument a human would have typed — the command, the
/// path, the pattern — and to fall back to compact JSON rather than to nothing.
/// A row labelled with the tool name alone cannot be told from the three
/// identical rows above it.
fn tool_label(name: &str, input: &serde_json::Value) -> String {
    const KEYS: [&str; 8] = [
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "prompt",
        "description",
    ];

    let argument = KEYS
        .iter()
        .find_map(|key| input.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let label = match argument {
        Some(argument) => argument.to_string(),
        // Not the empty string: a row has to say *something*, and the raw
        // arguments beat a blank even when they are ugly.
        None if input.is_null() => name.to_string(),
        None => input.to_string(),
    };

    truncate_on_char_boundary(&label.replace('\n', " "), 160)
}

/// Cut to `max` characters, never mid-character. See
/// [`truncate_on_char_boundary`]; re-exported for `tasks.rs`.
pub fn clip(text: &str, max: usize) -> String {
    truncate_on_char_boundary(text, max)
}

/// Cut to `max` characters, never mid-character.
///
/// Byte slicing a multi-byte character panics, and a tool argument is arbitrary
/// user text — a path with an accent in it would take the run down.
fn truncate_on_char_boundary(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

fn parse_permission(raw: Option<&str>) -> Permission {
    match raw.unwrap_or("read_only") {
        "plan" => Permission::Plan,
        // `ask` is Edit with a human answering each gated call. It cannot be
        // ReadOnly underneath: that posture strips the mutating tools, so
        // nothing would ever ask and the crate refuses the combination.
        "ask" | "edit" => Permission::Edit,
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
        .map(|row| with_session(ProjectDto::from(row), &state.tables))
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

/// A tool call in flight.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunningTaskDto {
    pub tool_call_id: Option<String>,
    pub project_id: String,
    pub item_id: Option<String>,
    pub name: String,
    pub label: String,
    pub started_at: String,
    pub is_cancelable: bool,
}

/// A finished one.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskLogEntryDto {
    pub id: String,
    pub tool_call_id: Option<String>,
    pub project_id: String,
    pub item_id: Option<String>,
    pub label: String,
    pub tool: String,
    /// Null means the agent did not say, which is **not** failure.
    pub ok: Option<bool>,
    pub output: String,
    pub duration_ms: Option<i64>,
    pub exit_code: Option<i64>,
    pub finished_at: String,
}

impl From<TaskLogRow> for TaskLogEntryDto {
    fn from(row: TaskLogRow) -> Self {
        TaskLogEntryDto {
            id: row.id,
            tool_call_id: (!row.tool_call_id.is_empty()).then_some(row.tool_call_id),
            project_id: row.project_id,
            item_id: (!row.item_id.is_empty()).then_some(row.item_id),
            label: row.label,
            tool: row.tool,
            // The tri-state the column cannot hold. See the schema's module doc.
            ok: match row.ok {
                1 => Some(true),
                0 => Some(false),
                _ => None,
            },
            output: row.output,
            duration_ms: (row.duration_ms >= 0).then_some(row.duration_ms),
            exit_code: (row.exit_code >= 0).then_some(row.exit_code),
            finished_at: row.finished_at,
        }
    }
}

impl From<&TaskLogEntryDto> for TaskLogRow {
    fn from(entry: &TaskLogEntryDto) -> Self {
        TaskLogRow {
            id: entry.id.clone(),
            tool_call_id: entry.tool_call_id.clone().unwrap_or_default(),
            project_id: entry.project_id.clone(),
            item_id: entry.item_id.clone().unwrap_or_default(),
            label: entry.label.clone(),
            tool: entry.tool.clone(),
            // The tri-state, flattened. `None` is -1 and stays distinct from
            // the `0` that means the agent said it failed.
            ok: match entry.ok {
                Some(true) => 1,
                Some(false) => 0,
                None => -1,
            },
            output: entry.output.clone(),
            duration_ms: entry.duration_ms.unwrap_or(-1),
            exit_code: entry.exit_code.unwrap_or(-1),
            finished_at: entry.finished_at.clone(),
        }
    }
}

/// Turn the task manager's JSONL block into item rows.
///
/// Separate from the checkbox scan the ordinary projects use: this reply is
/// answering a contract rather than writing prose, so a line that does not
/// parse is a broken contract worth reporting rather than a sentence to skip.
///
/// The count of rejected lines goes to the I/O panel. A model that has drifted
/// off the format produces a short list and no error anywhere else, which is
/// exactly the failure that looks like the feature not working.
async fn write_tasks_from_reply(
    app: &AppHandle,
    io: &AgentIo,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    reply: &str,
) {
    let harvest = crate::tasks::harvest(reply);

    note_io(
        app,
        io,
        project_id,
        "gui",
        "harvest",
        format!(
            "{} task(s) parsed from the reply, {} line(s) rejected",
            harvest.tasks.len(),
            harvest.rejected
        ),
    );
    crate::log!(
        crate::log::Level::Info,
        "tasks",
        "{project_id}: harvested {} task(s), rejected {}",
        harvest.tasks.len(),
        harvest.rejected
    );

    if harvest.tasks.is_empty() {
        return;
    }

    /*
     * Harvested tasks land on real projects: the `project` value names one,
     * matched case-insensitively against what exists, created bare when
     * nothing matches. This replaces the first design — items parked on the
     * task manager's own project with the name folded into the title — which
     * asked the user to re-type every line the model had already structured.
     *
     * A created project is bare on purpose: a row and a tab, no first message
     * and no agent run. The task manager organises; it does not start work.
     */
    let all_projects: Vec<ProjectRow> = tables.project.select_all().execute().unwrap_or_default();
    let mut project_ids: std::collections::HashMap<String, String> = all_projects
        .iter()
        .map(|row| (row.name.trim().to_lowercase(), row.id.clone()))
        .collect();
    let mut order = u32::try_from(all_projects.len()).unwrap_or(0);
    let mut created: Vec<String> = Vec::new();
    let mut placed = 0usize;

    let mut removed = 0usize;
    for task in harvest.tasks {
        let key = task.project.trim().to_lowercase();

        /*
         * The one destructive verb, and it only ever removes an exact match:
         * a delete against a project or title that does not exist is a no-op,
         * never a fuzzy guess. Absence from the output changes nothing — the
         * contract says so to the model, and this code says it to the store.
         */
        if task.status == "deleted" {
            let Some(target_id) = project_ids.get(&key).cloned() else {
                continue;
            };
            let existing: Vec<ProjectItemRow> = tables
                .project_item
                .select_by_project_id(target_id)
                .execute()
                .unwrap_or_default();
            for row in existing {
                if row.title.to_lowercase() == task.item.to_lowercase() {
                    match tables.project_item.delete(row.id.clone()).await {
                        Ok(()) => {
                            removed += 1;
                            let _ = app.emit(
                                "item:deleted",
                                serde_json::json!({ "id": row.id, "projectId": row.project_id }),
                            );
                        }
                        Err(error) => crate::log!(
                            crate::log::Level::Error,
                            "tasks",
                            "{project_id}: could not delete a task: {error}"
                        ),
                    }
                }
            }
            continue;
        }

        let target_id = match project_ids.get(&key) {
            Some(found) => found.clone(),
            None => {
                let row = ProjectRow {
                    id: id("proj"),
                    name: task.project.trim().to_string(),
                    status: "active".into(),
                    position: order,
                    dirs: "[]".into(),
                    pinned: false,
                    moderator_enabled: false,
                    forked_from: String::new(),
                    last_activity_at: now(),
                };
                if let Err(error) = tables.project.insert(row.clone()) {
                    crate::log!(
                        crate::log::Level::Error,
                        "tasks",
                        "could not create project {:?}: {error}",
                        task.project
                    );
                    continue;
                }
                order += 1;
                created.push(row.name.clone());
                let dto = with_session(ProjectDto::from(row.clone()), tables);
                let _ = app.emit("project:created", &dto);
                project_ids.insert(key, row.id.clone());
                row.id
            }
        };

        // Appended after what is there, duplicates skipped: a later prompt
        // restating the list must not stack the same line up or disturb rows
        // the user added themselves.
        let existing: Vec<ProjectItemRow> = tables
            .project_item
            .select_by_project_id(target_id.clone())
            .execute()
            .unwrap_or_default();
        if existing
            .iter()
            .any(|row| row.title.to_lowercase() == task.item.to_lowercase())
        {
            continue;
        }
        let row = ProjectItemRow {
            id: id("item"),
            project_id: target_id,
            title: task.item,
            status: task.status,
            position: u32::try_from(existing.len()).unwrap_or(0),
        };
        match tables.project_item.insert(row.clone()) {
            Ok(_) => {
                placed += 1;
                let _ = app.emit("item:created", ProjectItemDto::from(row));
            }
            Err(error) => crate::log!(
                crate::log::Level::Error,
                "tasks",
                "{project_id}: could not write a task: {error}"
            ),
        }
    }

    // Said where the harvest count already lives, so "where did my tasks go"
    // is answerable from the same panel that reported them parsed.
    let mut summary = format!("{placed} item(s) placed");
    if removed > 0 {
        summary.push_str(&format!(", {removed} deleted"));
    }
    if !created.is_empty() {
        summary.push_str(&format!("; created project(s): {}", created.join(", ")));
    }
    note_io(app, io, project_id, "gui", "harvest", summary);
}

/// Turn any checklist in the reply into item rows, appended after what is there.
///
/// Appends rather than replaces: the panel's items are the user's list too, and
/// a later turn restating the plan must not delete the rows they added or the
/// ones they already ticked off. Duplicate titles are skipped so an agent that
/// repeats its checklist each turn does not stack the same line up.
fn write_items_from_reply(
    app: &AppHandle,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    reply: &str,
) {
    let proposed = items_from_reply(reply);
    if proposed.is_empty() {
        return;
    }

    let existing: Vec<ProjectItemRow> = tables
        .project_item
        .select_by_project_id(project_id.to_string())
        .execute()
        .unwrap_or_default();
    let seen: std::collections::HashSet<String> = existing
        .iter()
        .map(|row| row.title.to_lowercase())
        .collect();
    let mut next = u32::try_from(existing.len()).unwrap_or(0);

    for (title, status) in proposed {
        if seen.contains(&title.to_lowercase()) {
            continue;
        }
        let row = ProjectItemRow {
            id: id("item"),
            project_id: project_id.to_string(),
            title,
            status,
            position: next,
        };
        match tables.project_item.insert(row.clone()) {
            Ok(_) => {
                next += 1;
                let _ = app.emit("item:created", ProjectItemDto::from(row));
            }
            Err(error) => crate::log!(
                crate::log::Level::Error,
                "items",
                "{project_id}: could not write an item: {error}"
            ),
        }
    }
    crate::log!(
        crate::log::Level::Info,
        "items",
        "{project_id}: {} item(s) after the reply",
        next
    );
}

/// Milliseconds between two RFC 3339 stamps, or `None` if either will not parse.
///
/// `None` rather than zero: an unparseable stamp means the duration is unknown,
/// and the panel renders unknown as an em dash. A zero would read as instant.
fn elapsed_ms(from: &str, to: &str) -> Option<i64> {
    let from = chrono::DateTime::parse_from_rfc3339(from).ok()?;
    let to = chrono::DateTime::parse_from_rfc3339(to).ok()?;
    Some((to - from).num_milliseconds().max(0))
}

/// One line of the raw exchange with the agent.
///
/// `direction` is from this app's point of view: `sent` is what we handed the
/// agent, `received` is what came back, and `gui` is something this application
/// did to the project on its own — a rename, a pin, a delete.
///
/// The third one matters because the panel is answering "what happened to this
/// project", and a timeline that shows only the agent's half cannot explain a
/// name that changed or a log that emptied.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentIoEntry {
    pub id: String,
    pub project_id: String,
    pub at: String,
    /// `sent` | `received`.
    pub direction: String,
    /// The event's own name — `request`, `text`, `tool_call`, `stderr`, `stop` …
    pub kind: String,
    pub detail: String,
}

/// How many lines are kept per project.
///
/// A long run emits thousands of text deltas, and this is a diagnostic panel
/// rather than a transcript — the durable copy is the log file. Oldest lines are
/// dropped first, so what is on screen is always the most recent exchange.
const MAX_IO_ENTRIES: usize = 500;

/// Where a project's "keep the raw exchange" flag lives in `kv`.
fn io_persist_key(project_id: &str) -> String {
    format!("io-persist:{project_id}")
}

/// Whether this project records its raw exchange to the database.
#[tauri::command]
pub fn get_io_persist(project_id: String, state: State<'_, AppState>) -> bool {
    state
        .tables
        .kv_get(&io_persist_key(&project_id))
        .is_some_and(|value| value == "true")
}

/// Turn recording on or off for one project.
///
/// Off by default and per project on purpose: a turn emits a text event per
/// delta, so recording every project would put continuous write load on the
/// store the whole workspace depends on, for data whose value drops off within
/// minutes. Turn it on for the project you are debugging.
///
/// Switching it off leaves what was already recorded — that is history, and
/// deleting someone's diagnostics as a side effect of a toggle is not what the
/// toggle says it does.
///
/// # Errors
/// Returns the store's error when the flag cannot be written.
#[tauri::command]
pub async fn set_io_persist(
    app: AppHandle,
    project_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .tables
        .kv_put(&io_persist_key(&project_id), enabled.to_string())
        .await
        .map_err(|error| error.to_string())?;
    note_gui(
        &app,
        &state,
        &project_id,
        format!(
            "raw agent I/O recording turned {}",
            if enabled { "on" } else { "off" }
        ),
    );
    Ok(enabled)
}

/// The raw exchange, by project id.
///
/// Always in memory, for the life of the process. Also written to the
/// `agent_io` table when the project has opted in, which is what lets the panel
/// survive a restart — see the module doc on `schema/agent_io.rs` for why that
/// is not the default.
pub type AgentIo = std::sync::Mutex<std::collections::HashMap<String, Vec<AgentIoEntry>>>;

/// Record one line and tell the window about it.
fn note_io(
    app: &AppHandle,
    io: &AgentIo,
    project_id: &str,
    direction: &str,
    kind: &str,
    detail: impl Into<String>,
) {
    let entry = AgentIoEntry {
        id: id("io"),
        project_id: project_id.to_string(),
        at: now(),
        direction: direction.to_string(),
        kind: kind.to_string(),
        detail: truncate_on_char_boundary(&detail.into(), 4_000),
    };

    if let Ok(mut io) = io.lock() {
        let lines = io.entry(project_id.to_string()).or_default();
        lines.push(entry.clone());
        // Drop from the front so the newest always survives.
        if lines.len() > MAX_IO_ENTRIES {
            let excess = lines.len() - MAX_IO_ENTRIES;
            lines.drain(..excess);
        }
    }
    let _ = app.emit("agent:io", &entry);
    persist_io(app, &entry);
}

/// Record something this app did to a project, in the same timeline.
///
/// Takes `State` rather than the journal directly so command handlers can call
/// it without threading the `Arc` through every signature.
fn note_gui(app: &AppHandle, state: &AppState, project_id: &str, what: impl Into<String>) {
    note_io(app, &state.io, project_id, "gui", "action", what);
}

/// Write one line to the `agent_io` table, when the project has opted in.
///
/// Fire and forget: a diagnostic that cannot be written is not worth failing a
/// run over, and the line is already in memory and in the log file.
fn persist_io(app: &AppHandle, entry: &AgentIoEntry) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state
        .tables
        .kv_get(&io_persist_key(&entry.project_id))
        .is_none_or(|value| value != "true")
    {
        return;
    }

    let row = crate::db::schema::agent_io::AgentIoRowRow {
        id: entry.id.clone(),
        project_id: entry.project_id.clone(),
        at: entry.at.clone(),
        direction: entry.direction.clone(),
        kind: entry.kind.clone(),
        detail: entry.detail.clone(),
    };
    if let Err(error) = state.tables.agent_io.insert(row) {
        crate::log!(
            crate::log::Level::Warn,
            "io",
            "{}: could not persist an I/O line: {error}",
            entry.project_id
        );
    }
}

/// The raw exchange for one project, oldest first.
///
/// Whatever is in memory for this launch, plus anything recorded to the table by
/// an earlier one. Merged by id so a line that is in both appears once.
#[tauri::command]
pub fn list_agent_io(project_id: String, state: State<'_, AppState>) -> Vec<AgentIoEntry> {
    let live: Vec<AgentIoEntry> = state
        .io
        .lock()
        .map(|io| io.get(&project_id).cloned().unwrap_or_default())
        .unwrap_or_default();

    let stored: Vec<AgentIoEntry> = state
        .tables
        .agent_io
        .select_by_project_id(project_id)
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(|row| AgentIoEntry {
            id: row.id,
            project_id: row.project_id,
            at: row.at,
            direction: row.direction,
            kind: row.kind,
            detail: row.detail,
        })
        .collect();

    let mut seen: std::collections::HashSet<String> = live.iter().map(|e| e.id.clone()).collect();
    let mut merged = stored;
    merged.retain(|entry| seen.insert(entry.id.clone()));
    merged.extend(live);
    merged.sort_by(|a, b| a.at.cmp(&b.at));
    // Newest kept, so a long recorded history does not flood the panel.
    if merged.len() > MAX_IO_ENTRIES {
        merged.drain(..merged.len() - MAX_IO_ENTRIES);
    }
    merged
}

/// Tool calls in flight, by project id.
///
/// In memory rather than in a table, and that is the honest shape: a running
/// task cannot outlive the process running it, so a persisted one would come
/// back after a restart as a spinner for work that can never finish. What is
/// worth keeping is the *finished* row, and that goes to `task_log`.
pub type RunningTasks = std::sync::Mutex<std::collections::HashMap<String, Vec<RunningTaskDto>>>;

/// Decisions on their way to runs blocked on an approval, by project.
///
/// A run in `ask` mode that hits a gated tool call emits `run:approval` and
/// waits. The sender registered here is how `resolve_approval` delivers the
/// user's answer — `(approval id, allow)` — back into that run's event loop.
/// One entry per project: Claude asks one question at a time, because the
/// agent itself is blocked until it hears back.
pub type PendingApprovals =
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::mpsc::Sender<(String, bool)>>>;

/// How long an unanswered approval stands before it is denied.
///
/// The run is blocked while the question is open, so an abandoned window must
/// become a denial rather than a run that hangs until the agent's own timeout.
const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// What is running in this project right now.
#[tauri::command]
pub fn list_running_tasks(project_id: String, state: State<'_, AppState>) -> Vec<RunningTaskDto> {
    state
        .running
        .lock()
        .map(|running| running.get(&project_id).cloned().unwrap_or_default())
        .unwrap_or_default()
}

/// A page of the task log, plus the total the page came out of.
///
/// Two numbers rather than one because the panel's badge counts everything the
/// project has ever run while the list holds a page: "91" over six rows is the
/// point, and a bare array cannot say that.
#[derive(Serialize)]
pub struct TaskLogPage {
    pub entries: Vec<TaskLogEntryDto>,
    pub total: usize,
}

/// Newest first, `limit` at a time, optionally older than `before`.
///
/// `before` is a `finishedAt` cursor rather than an offset: rows arrive while
/// the panel is open, and an offset would skip or repeat one every time a tool
/// finished between two pages.
#[tauri::command]
pub fn list_task_log(
    project_id: String,
    limit: usize,
    before: Option<String>,
    state: State<'_, AppState>,
) -> TaskLogPage {
    let rows: Vec<TaskLogEntryDto> = state
        .tables
        .task_log
        .select_by_project_id(project_id)
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(TaskLogEntryDto::from)
        .collect();

    page_task_log(rows, limit, before.as_deref())
}

/// Sort, cut at the cursor, take a page — kept apart from the table read so the
/// part with the off-by-ones in it can be tested without a database.
fn page_task_log(
    mut rows: Vec<TaskLogEntryDto>,
    limit: usize,
    before: Option<&str>,
) -> TaskLogPage {
    // Newest first, which is the order the panel renders and the direction the
    // cursor pages in.
    rows.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));

    // Counted before the page is cut, because the badge reports the whole
    // history while the list holds one page of it.
    let total = rows.len();

    if let Some(before) = before.filter(|cursor| !cursor.is_empty()) {
        // Strictly older, so the row the cursor names is not served twice.
        rows.retain(|row| row.finished_at.as_str() < before);
    }
    rows.truncate(limit);

    TaskLogPage {
        entries: rows,
        total,
    }
}

/// The live project and task lists, for the task manager's eyes.
///
/// Bounded: a store with hundreds of tasks must not turn every prompt into a
/// novel, so the block is cut at a ceiling with an honest marker. The cut is
/// per line, never mid-line — a half task reads as a different task.
fn task_manager_snapshot(tables: &crate::db::tables::Tables) -> String {
    const CEILING: usize = 6_000;

    let mut projects: Vec<ProjectRow> = tables.project.select_all().execute().unwrap_or_default();
    projects.sort_by_key(|row| row.position);
    if projects.is_empty() {
        return String::new();
    }

    let mut block = String::from(
        "\n\n---\nCurrent projects and tasks, live from the store. To remove one, \
         emit its line with status \"deleted\"; to add or restate, emit it normally.\n",
    );
    'outer: for project in &projects {
        let header = format!("# {}\n", project.name);
        if block.len() + header.len() > CEILING {
            block.push_str("… (list truncated)\n");
            break;
        }
        block.push_str(&header);

        let mut items: Vec<ProjectItemRow> = tables
            .project_item
            .select_by_project_id(project.id.clone())
            .execute()
            .unwrap_or_default();
        items.sort_by_key(|row| row.position);
        for item in &items {
            let line = format!("- [{}] {}\n", item.status, item.title);
            if block.len() + line.len() > CEILING {
                block.push_str("… (list truncated)\n");
                break 'outer;
            }
            block.push_str(&line);
        }
    }
    block
}

/// Spend over the ranges Settings displays, summed from the usage ledger.
///
/// Dollars, derived once from the exact micro-dollar sums. `turns` counts the
/// ledger rows behind `total`, so "how many priced turns is this" is
/// answerable next to the figure.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSummaryDto {
    pub today_usd: f64,
    pub week_usd: f64,
    pub month_usd: f64,
    pub total_usd: f64,
    pub turns: usize,
}

/// Sum the usage ledger for Settings' cost readout.
///
/// UTC buckets, string-compared: `day` is `YYYY-MM-DD`, which sorts
/// lexicographically, so "this week" is `day >= today - 6` and "this month"
/// is a prefix match. The week is the trailing seven days rather than a
/// calendar week — a Monday reset makes Sunday's spend vanish from view.
///
/// # Errors
/// Infallible today; `Result` for signature stability.
#[tauri::command]
pub async fn get_cost_summary(state: State<'_, AppState>) -> Result<CostSummaryDto, String> {
    let now = chrono::Utc::now();
    let today = now.format("%Y-%m-%d").to_string();
    let week_start = (now - chrono::Duration::days(6)).format("%Y-%m-%d").to_string();
    let month = now.format("%Y-%m").to_string();

    let rows = state
        .tables
        .usage_ledger
        .select_all()
        .execute()
        .unwrap_or_default();

    let mut today_micro = 0i64;
    let mut week_micro = 0i64;
    let mut month_micro = 0i64;
    let mut total_micro = 0i64;
    for row in &rows {
        total_micro += row.cost_micro;
        if row.day == today {
            today_micro += row.cost_micro;
        }
        if row.day.as_str() >= week_start.as_str() {
            week_micro += row.cost_micro;
        }
        if row.day.starts_with(&month) {
            month_micro += row.cost_micro;
        }
    }

    #[expect(clippy::cast_precision_loss, reason = "display figures in dollars")]
    let usd = |micro: i64| micro as f64 / 1_000_000.0;
    Ok(CostSummaryDto {
        today_usd: usd(today_micro),
        week_usd: usd(week_micro),
        month_usd: usd(month_micro),
        total_usd: usd(total_micro),
        turns: rows.len(),
    })
}

/// What the Home task-manager screen needs that no other surface carries.
///
/// The task manager is a reserved project with **no project row** — it never
/// appears in `list_projects`, so the session id the ordinary path hangs off
/// `ProjectDto` has nowhere to travel. This is that one field's own ride.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskManagerDto {
    /// The agent's native session id, once a prompt has produced one.
    pub session_id: Option<String>,
}

/// Where the Home task manager's conversation stands.
///
/// # Errors
/// Infallible today; `Result` so adding a fallible source later is not a
/// breaking change to the command's signature.
#[tauri::command]
pub async fn get_task_manager(state: State<'_, AppState>) -> Result<TaskManagerDto, String> {
    let session = state
        .tables
        .kv_get(&session_key(crate::tasks::TASK_MANAGER_ID))
        .filter(|id| !id.is_empty());
    Ok(TaskManagerDto {
        session_id: session,
    })
}

/// Answer the approval question a run is blocked on.
///
/// The id must be the one from `run:approval`: the agent ignores an answer
/// carrying any other id, and this passes it straight through. A false `allow`
/// denies with the stock reason; the turn continues either way — the model is
/// told no and works around it, so a denial is not a failed run.
///
/// # Errors
/// Returns a message when no run in this project is waiting, or when the run
/// finished before the decision arrived.
#[tauri::command]
pub async fn resolve_approval(
    project_id: String,
    approval_id: String,
    allow: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sender = state
        .approvals
        .lock()
        .ok()
        .and_then(|waiting| waiting.get(&project_id).cloned())
        .ok_or_else(|| format!("no run in {project_id} is waiting on an approval"))?;

    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: approval {approval_id} answered allow={allow}"
    );
    sender
        .send((approval_id, allow))
        .await
        .map_err(|_| "the run finished before the decision arrived".to_string())
}

/// Start the Home task manager's next prompt on a fresh conversation.
///
/// Clears the stored session id, so the next turn does not resume. The
/// transcript and the tasks already collected are left alone: this is "start
/// thinking again", not "throw away what you have".
///
/// # Errors
/// Returns the store's error when the session cannot be cleared.
#[tauri::command]
pub async fn reset_task_manager(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let id = crate::tasks::TASK_MANAGER_ID;
    state
        .tables
        .kv_put(&session_key(id), String::new())
        .await
        .map_err(|error| error.to_string())?;

    crate::log!(crate::log::Level::Info, "tasks", "task manager session reset");
    note_gui(&app, &state, id, "task manager session reset; the next prompt starts fresh");

    if let Some(row) = state.tables.project.select(id.to_string()) {
        let _ = app.emit("project:updated", with_session(ProjectDto::from(row), &state.tables));
    }
    Ok(())
}

/// Rename a project.
///
/// Stage 3 of the naming design in `docs/gui-wiring-plan.md`: whatever the
/// derived stages produce, the name is the user's to change, and a manual
/// rename outranks both. Trimmed, and an empty name is refused rather than
/// written — a nameless tab is unusable and there is no undo here.
///
/// # Errors
/// Returns the store's error when the row cannot be updated, or a message when
/// the name is blank.
#[tauri::command]
pub async fn rename_project(
    app: AppHandle,
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<ProjectDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a project needs a name".into());
    }
    let name = truncate_on_char_boundary(name, 120);

    state
        .tables
        .project
        .update_name_by_id(NameByIdQuery { name: name.clone() }, id.clone())
        .await
        .map_err(|error| {
            crate::log!(
                crate::log::Level::Error,
                "projects",
                "could not rename {id}: {error}"
            );
            error.to_string()
        })?;

    let row = state
        .tables
        .project
        .select(id.clone())
        .ok_or_else(|| format!("no project {id}"))?;
    let project = with_session(ProjectDto::from(row), &state.tables);
    crate::log!(crate::log::Level::Info, "projects", "renamed {id} to {name:?}");
    note_gui(&app, &state, &id, format!("renamed the project to {name:?}"));
    let _ = app.emit("project:updated", &project);
    Ok(project)
}

/// Pin or unpin a project, for Home's Pinned list.
///
/// Not implemented until now, which meant the toggle routed to the fixture
/// backend: the pin moved on screen and was gone on the next launch.
///
/// # Errors
/// Returns the store's error when the row cannot be updated.
#[tauri::command]
pub async fn set_project_pinned(
    app: AppHandle,
    id: String,
    pinned: bool,
    state: State<'_, AppState>,
) -> Result<ProjectDto, String> {
    state
        .tables
        .project
        .update_pinned_by_id(PinnedByIdQuery { pinned }, id.clone())
        .await
        .map_err(|error| {
            crate::log!(
                crate::log::Level::Error,
                "projects",
                "could not set pinned on {id}: {error}"
            );
            error.to_string()
        })?;

    let row = state
        .tables
        .project
        .select(id.clone())
        .ok_or_else(|| format!("no project {id}"))?;
    let project = with_session(ProjectDto::from(row), &state.tables);
    note_gui(
        &app,
        &state,
        &id,
        if pinned { "pinned" } else { "unpinned" }.to_string(),
    );
    let _ = app.emit("project:updated", &project);
    Ok(project)
}

/// Delete a project and everything that belongs to it.
///
/// Every table is cleared before the project row itself, so a failure part-way
/// leaves the project still listed and retryable rather than leaving orphaned
/// messages under an id nothing points at. Ids are uuid-suffixed and never
/// reused, so an orphan would not resurface under a new project — it would just
/// sit there forever, counted by nothing.
///
/// # Errors
/// Returns the store's error when any of the deletes fail.
#[tauri::command]
pub async fn delete_project(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let failed = |what: &str, error: &dyn std::fmt::Display| {
        crate::log!(
            crate::log::Level::Error,
            "projects",
            "could not delete {what} for {id}: {error}"
        );
        format!("could not delete {what}: {error}")
    };

    state
        .tables
        .task_log
        .delete_by_project(id.clone())
        .await
        .map_err(|error| failed("the task log", &error))?;
    state
        .tables
        .message
        .delete_by_project(id.clone())
        .await
        .map_err(|error| failed("the transcript", &error))?;
    state
        .tables
        .project_item
        .delete_by_project(id.clone())
        .await
        .map_err(|error| failed("the items", &error))?;
    state
        .tables
        .project
        .delete(id.clone())
        .await
        .map_err(|error| failed("the project", &error))?;

    // Nothing can be running in a project that no longer exists.
    if let Ok(mut running) = state.running.lock() {
        running.remove(&id);
    }

    crate::log!(crate::log::Level::Info, "projects", "deleted {id}");
    let _ = app.emit("project:deleted", serde_json::json!({ "id": id }));
    Ok(())
}

/// Drop this project's history. The badge goes to zero because the rows are
/// gone, not because the panel stopped counting them.
///
/// # Errors
/// Returns the store's error when the rows cannot be deleted.
#[tauri::command]
pub async fn clear_task_log(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .tables
        .task_log
        .delete_by_project(project_id.clone())
        .await
        .map_err(|error| {
            crate::log!(
                crate::log::Level::Error,
                "tasks",
                "could not clear the log for {project_id}: {error}"
            );
            error.to_string()
        })?;
    Ok(())
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
    state.tables.project.insert(row.clone()).map_err(|error| {
        crate::log!(
            crate::log::Level::Error,
            "projects",
            "could not insert {project_id}: {error}"
        );
        error.to_string()
    })?;

    let project = with_session(ProjectDto::from(row), &state.tables);
    crate::log!(
        crate::log::Level::Info,
        "projects",
        "created {project_id} name={:?}",
        project.name
    );
    note_gui(
        &app,
        &state,
        &project_id,
        format!("created the project, named {:?} from the prompt", project.name),
    );
    let _ = app.emit("project:created", &project);

    send_message(
        app,
        SendMessageInput {
            project_id,
            body: input.first_message,
            item_id: None,
            model: input.model,
            permission: input.permission,
            effort: input.effort,
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
    note_gui(
        &app,
        &state,
        &input.project_id,
        format!("you sent a message ({} chars)", input.body.len()),
    );
    let _ = app.emit("message:appended", &user_message);

    // The working directory: the project's own if it has one, else the
    // workspace root. An agent with no cwd inherits the app's, which for a
    // bundled .app is `/`.
    //
    // The task manager is the special case: it has no project row to carry
    // directories, and the scope matters more than it looks — `read_only`
    // maps to Claude's don't-ask mode, which denies reads *outside* the
    // working tree without prompting. Its directories live in Settings.
    let cwd = if input.project_id == crate::tasks::TASK_MANAGER_ID {
        state
            .tables
            .kv_get(crate::settings::KEY)
            .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
            .unwrap_or_default()
            .task_manager
            .dirs
            .first()
            .cloned()
            .unwrap_or_else(|| crate::workspace_root_path(&app, &state))
    } else {
        state
            .tables
            .project
            .select(input.project_id.clone())
            .and_then(|row| {
                serde_json::from_str::<Vec<String>>(&row.dirs)
                    .ok()
                    .and_then(|dirs| dirs.first().cloned())
            })
            .unwrap_or_else(|| crate::workspace_root_path(&app, &state))
    };

    // The agent's own session id for this project, when a turn has produced
    // one. Without it every turn starts a fresh conversation.
    let resume = state.tables.kv_get(&session_key(&input.project_id));

    let tables = state.tables.clone();
    let running = state.running.clone();
    let io = state.io.clone();
    let approvals = state.approvals.clone();
    let project_id = input.project_id.clone();
    let effort = input.effort.clone();

    tauri::async_runtime::spawn(async move {
        drive_run(
            app, tables, running, io, approvals, project_id, input.body, model, permission,
            effort, cwd, resume,
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
    running: std::sync::Arc<RunningTasks>,
    io: std::sync::Arc<AgentIo>,
    approvals: std::sync::Arc<PendingApprovals>,
    project_id: String,
    prompt: String,
    model: String,
    permission: String,
    effort: Option<String>,
    cwd: String,
    resume: Option<String>,
) {
    /*
     * Home's conversation is the task manager, and its replies have to become
     * rows. The user's own words go out unchanged with the output contract
     * appended, rather than being rewritten into a template — the prompt is
     * theirs, the format is ours.
     */
    let is_task_manager = project_id == crate::tasks::TASK_MANAGER_ID;
    let prompt = if is_task_manager {
        /*
         * The current lists ride along with every prompt. Without them the
         * model only knows what its own conversation remembers, so "delete
         * everything about X" could not name the lines to delete. With them,
         * bulk edits are exact: each deletion is an explicit line against a
         * task the model can actually see.
         */
        format!(
            "{prompt}{}{}",
            task_manager_snapshot(&tables),
            crate::tasks::OUTPUT_CONTRACT
        )
    } else {
        prompt
    };

    // Kept for the I/O panel before the builder consumes them, so the "sent"
    // line shows what actually went out rather than what was asked for.
    let prompt_echo = prompt.clone();
    let effort_echo = effort.clone().filter(|value| !value.is_empty());

    let mut request = Request::new(Agent::Claude, prompt)
        .permission(parse_permission(Some(&permission)))
        .cwd(&cwd);
    // `ask`: every gated call — a write, a command, a read outside the working
    // tree — arrives as an approval question instead of a silent pre-decision.
    let asks = permission == "ask";
    if asks {
        request = request.approvals();
    }
    if !model.is_empty() {
        request = request.model(&model);
    }
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        request = request.effort(effort);
    }

    /*
     * Continue the conversation rather than starting a new one.
     *
     * Without this every turn was a fresh session: the agent had no memory of
     * anything said before, the context never grew past a single exchange, and
     * the session id recorded on the project named a conversation nothing ever
     * went back to. `resume` takes the native id, which is exactly what
     * `Event::Started` gave us and what `kv` has been holding.
     */
    if let Some(session) = resume.as_deref().filter(|id| !id.is_empty()) {
        request = request.resume(session);
    }

    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: starting claude model={} permission={permission} cwd={cwd} resume={}",
        if model.is_empty() { "<default>" } else { &model },
        resume.as_deref().unwrap_or("<new conversation>")
    );

    note_io(
        &app,
        &io,
        &project_id,
        "sent",
        "request",
        format!(
            "claude model={} permission={permission} effort={} cwd={cwd}\n\n{prompt_echo}",
            if model.is_empty() { "<default>" } else { &model },
            effort_echo.as_deref().unwrap_or("<none>"),
        ),
    );

    let mut run = match agent_abstraction::stream(&request) {
        Ok(run) => run,
        Err(error) => {
            // The one failure the window used to swallow entirely: no run, no
            // reply, no error, just a prompt that appeared to do nothing.
            crate::log!(
                crate::log::Level::Error,
                "run",
                "{project_id}: could not start the agent: {error}"
            );
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

    // The channel `resolve_approval` answers on, registered whether or not
    // this run asks: registering is cheap and an entry for a run that never
    // asks is simply never used.
    let (decision_tx, mut decisions) = tokio::sync::mpsc::channel::<(String, bool)>(4);
    if let Ok(mut waiting) = approvals.lock() {
        waiting.insert(project_id.clone(), decision_tx);
    }

    while let Some(event) = run.recv().await {
        match event {
            Event::ApprovalRequest(approval) => {
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "approval",
                    // The input, not just the tool: for Bash the command lives
                    // there, and approving on the name approves an unseen command.
                    format!("{} {}", approval.tool, approval.input),
                );
                let _ = app.emit(
                    "run:approval",
                    serde_json::json!({
                        "projectId": project_id,
                        "approvalId": approval.id,
                        "tool": approval.tool,
                        "input": approval.input,
                    }),
                );

                /*
                 * The agent is blocked until this is answered, so blocking the
                 * loop here loses nothing — no further events arrive while the
                 * question stands. The timeout turns an abandoned question
                 * into a denial rather than a run that hangs until the agent's
                 * own timeout, and a denial is not a failed run: the model is
                 * told no and carries on.
                 */
                let answer = tokio::select! {
                    answer = decisions.recv() => answer,
                    () = tokio::time::sleep(APPROVAL_TIMEOUT) => None,
                };
                let allow = matches!(&answer, Some((id, true)) if *id == approval.id);
                let decision = if allow {
                    Decision::Allow
                } else {
                    Decision::deny()
                };
                if let Err(error) = run.respond(&approval.id, &decision).await {
                    crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not deliver the approval decision: {error}"
                    );
                }
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "sent",
                    "approval",
                    format!(
                        "{} — {}",
                        approval.tool,
                        if allow { "allowed" } else { "denied" }
                    ),
                );
                let _ = app.emit(
                    "run:approval_resolved",
                    serde_json::json!({
                        "projectId": project_id,
                        "approvalId": approval.id,
                        "allow": allow,
                    }),
                );
            }
            Event::Text(delta) => {
                note_io(&app, &io, &project_id, "received", "text", &delta);
                let _ = app.emit(
                    "run:text",
                    serde_json::json!({ "projectId": project_id, "delta": delta }),
                );
            }
            Event::Thinking(text) => {
                note_io(&app, &io, &project_id, "received", "thinking", &text);
                let _ = app.emit(
                    "run:thinking",
                    serde_json::json!({ "projectId": project_id, "text": text }),
                );
            }
            Event::ToolCall { id, name, input } => {
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "tool_call",
                    format!("{name} {input}"),
                );
                let task = RunningTaskDto {
                    tool_call_id: id,
                    project_id: project_id.clone(),
                    item_id: None,
                    label: tool_label(&name, &input),
                    name,
                    started_at: now(),
                    // Always: cancelling drops the Run, which kills the agent
                    // and its whole process group.
                    is_cancelable: true,
                };
                if let Ok(mut running) = running.lock() {
                    running
                        .entry(project_id.clone())
                        .or_default()
                        .push(task.clone());
                }
                let _ = app.emit("task:started", &task);
            }
            Event::ToolResult { id, ok, output, .. } => {
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "tool_result",
                    format!("ok={ok:?} {output}"),
                );
                // Matched on the agent's id, never on the label: two shell
                // commands or two reads of one file share a label, and removing
                // by label would close out the wrong call. With no id there is
                // nothing to match, so nothing is removed — a stale row is
                // recoverable, a wrongly cleared one is not.
                let started = id.as_ref().and_then(|id| {
                    running.lock().ok().and_then(|mut running| {
                        let tasks = running.get_mut(&project_id)?;
                        let at = tasks
                            .iter()
                            .position(|task| task.tool_call_id.as_ref() == Some(id))?;
                        Some(tasks.remove(at))
                    })
                });

                let finished_at = now();
                let entry = TaskLogEntryDto {
                    id: crate::projects::id("log"),
                    tool_call_id: id,
                    project_id: project_id.clone(),
                    item_id: None,
                    // The call's label, so history reads the same as the row it
                    // replaces. Only the ToolCall carried the arguments.
                    label: started
                        .as_ref()
                        .map_or_else(String::new, |task| task.label.clone()),
                    tool: started
                        .as_ref()
                        .map_or_else(String::new, |task| task.name.clone()),
                    ok,
                    output,
                    duration_ms: started
                        .as_ref()
                        .and_then(|task| elapsed_ms(&task.started_at, &finished_at)),
                    // The crate reports no per-tool exit code, only whether the
                    // call succeeded. Left absent rather than guessed from `ok`.
                    exit_code: None,
                    finished_at,
                };

                if let Err(error) = tables.task_log.insert(TaskLogRow::from(&entry)) {
                    crate::log!(
                        crate::log::Level::Error,
                        "tasks",
                        "{project_id}: could not persist a task log row: {error}"
                    );
                }
                let _ = app.emit("task:finished", &entry);
            }
            Event::RateLimit(limit) => {
                /*
                 * Spelled out rather than dumped as `{limit:?}`. Most of these
                 * say `allowed`, which means the provider is reporting where you
                 * stand and refusing nothing — a debug struct in a panel gives
                 * no way to tell that from a real refusal.
                 */
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "rate_limit",
                    if limit.is_blocking() {
                        format!("REFUSED: {}", limit.status)
                    } else {
                        format!(
                            "not limited (the provider reports status {:?}; nothing was refused)",
                            limit.status
                        )
                    },
                );
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
                /*
                 * `allowed` is a heartbeat, not a limit — the crate's own
                 * `is_blocking()` says so, and its docs are explicit that
                 * nothing is refused. Sending it through unqualified is what put
                 * an orange "allowed (five_hour)" warning in the header for a
                 * run that was never restricted, and turned the tab dot amber
                 * for it.
                 */
                let _ = app.emit(
                    "run:rate_limit",
                    serde_json::json!({
                        "projectId": project_id,
                        "message": message,
                        "resetsAt": resets_at,
                        "isBlocking": limit.is_blocking(),
                    }),
                );
            }
            Event::Started { session, model } => {
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "started",
                    format!(
                        "session={session} model={}",
                        model.as_deref().unwrap_or("<unnamed>")
                    ),
                );
                crate::log!(
                    crate::log::Level::Info,
                    "run",
                    "{project_id}: session {session} on {}",
                    model.as_deref().unwrap_or("<unnamed model>")
                );
                // Persisted on the project rather than the message: it is the
                // handle a later turn resumes with, so it outlives any one turn.
                // Written every time rather than only when empty, because an
                // agent is free to hand back a new id and the stale one would
                // resume the wrong conversation.
                if let Err(error) = tables.kv_put(&session_key(&project_id), session.clone()).await
                {
                    crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not record the session id: {error}"
                    );
                } else if let Some(row) = tables.project.select(project_id.clone()) {
                    let _ = app.emit("project:updated", with_session(ProjectDto::from(row), &tables));
                }
            }
            _ => {}
        }
    }

    // Whatever the outcome, nothing in this project is running any more. A tool
    // call whose result never arrived would otherwise spin forever, and the
    // frontend's `run:stopped` handler clears its own copy on the same event.
    if let Ok(mut running) = running.lock() {
        running.remove(&project_id);
    }
    // And nothing is waiting on a decision: a `resolve_approval` arriving now
    // should say "the run finished" rather than feed a dead channel.
    if let Ok(mut waiting) = approvals.lock() {
        waiting.remove(&project_id);
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
                // Empty means the agent reported nothing, which the transcript
                // renders as an em dash. Zeroes would read as a free turn.
                usage: if outcome.usage.is_empty() {
                    String::new()
                } else {
                    serde_json::to_string(&UsageDto::from(&outcome.usage)).unwrap_or_default()
                },
                stop: stop.clone(),
                exit_code: i64::from(outcome.exit_code),
                body: outcome.text.clone(),
                created_at: now(),
            };
            crate::log!(
                crate::log::Level::Info,
                "run",
                "{project_id}: finished stop={stop} exit={} chars={}",
                outcome.exit_code,
                outcome.text.len()
            );
            note_io(
                &app,
                &io,
                &project_id,
                "received",
                "stop",
                {
                    /*
                     * The usage figures belong here, not only in the totals.
                     * "where did $0.06 come from" has to be answerable from
                     * this panel, and the answer is that the agent priced its
                     * own turn — nothing here computes a cost.
                     */
                    let u = &outcome.usage;
                    let context = match (u.context_tokens, u.context_window) {
                        (Some(used), Some(window)) => {
                            format!(" context={used}/{window}")
                        }
                        (Some(used), None) => format!(" context={used}"),
                        _ => String::new(),
                    };
                    format!(
                        "stop={stop} exit={} chars={} unparsed={}\n\
                         usage: in={:?} out={:?} cacheRead={:?} cost_usd={:?} (priced by the agent){context}",
                        outcome.exit_code,
                        outcome.text.len(),
                        outcome.unparsed,
                        u.input_tokens,
                        u.output_tokens,
                        u.cache_read_tokens,
                        u.cost_usd,
                    )
                },
            );
            // Only when there is something to say. An empty stderr line every
            // run would push the interesting ones off the panel.
            if !outcome.stderr.trim().is_empty() {
                note_io(&app, &io, &project_id, "received", "stderr", &outcome.stderr);
            }
            /*
             * A clean exit with no answer and lines we could not read is the
             * shape of a vendor changing its output format. It is not an error
             * the agent reported, so nothing else surfaces it — and "the CLI is
             * healthy, our parser is not" is exactly what someone staring at an
             * empty reply needs told.
             */
            if outcome.looks_like_a_format_change() {
                let sample = outcome.first_unparsed.as_deref().unwrap_or("<none>");
                crate::log!(
                    crate::log::Level::Warn,
                    "run",
                    "{project_id}: clean exit, empty answer, {} unparsed line(s). First: {sample}",
                    outcome.unparsed
                );
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "unparsed",
                    format!(
                        "{} line(s) could not be parsed. First: {sample}",
                        outcome.unparsed
                    ),
                );
            }
            if let Err(error) = tables.message.insert(row.clone()) {
                crate::log!(
                    crate::log::Level::Error,
                    "run",
                    "{project_id}: could not persist the reply: {error}"
                );
            }
            let _ = app.emit("message:appended", MessageDto::from(row));

            /*
             * The durable cost record, one row per turn that priced itself.
             * Separate from the message row because messages die with their
             * project, and "what did this week cost" has to survive that.
             * The figure is the agent's own; absent means the turn reported
             * nothing, and no row is written rather than a zero.
             */
            if let Some(cost) = outcome.usage.cost_usd {
                let at = now();
                let ledger = crate::db::schema::usage_ledger::UsageLedgerRow {
                    id: id("cost"),
                    day: at.chars().take(10).collect(),
                    at,
                    project_id: project_id.clone(),
                    model: model.clone(),
                    #[expect(
                        clippy::cast_possible_truncation,
                        reason = "a turn costing more than 9 trillion dollars is not a rounding concern"
                    )]
                    cost_micro: (cost * 1_000_000.0).round() as i64,
                    input_tokens: outcome
                        .usage
                        .input_tokens
                        .and_then(|tokens| i64::try_from(tokens).ok())
                        .unwrap_or(0),
                    output_tokens: outcome
                        .usage
                        .output_tokens
                        .and_then(|tokens| i64::try_from(tokens).ok())
                        .unwrap_or(0),
                };
                if let Err(error) = tables.usage_ledger.insert(ledger) {
                    crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not record the cost: {error}"
                    );
                }
            }

            if is_task_manager {
                write_tasks_from_reply(&app, &io, &tables, &project_id, &outcome.text).await;
            } else {
                write_items_from_reply(&app, &tables, &project_id, &outcome.text);
            }
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
            crate::log!(
                crate::log::Level::Error,
                "run",
                "{project_id}: the run failed: {error}"
            );
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

    /// The exact mismatch that crashed the transcript: the crate's field names
    /// are not the webview's, so the wire shape is asserted by name here. A
    /// rename on either side has to fail this test rather than the window.
    #[test]
    fn usage_reaches_the_webview_in_the_webviews_own_shape() {
        // Built field by field: `Usage` is `#[non_exhaustive]`, so a struct
        // literal will not compile outside the crate that defines it.
        let mut crate_usage = agent_abstraction::Usage::default();
        crate_usage.input_tokens = Some(1_200);
        crate_usage.output_tokens = Some(300);
        crate_usage.cache_read_tokens = Some(4_096);
        crate_usage.cache_write_tokens = Some(64);
        crate_usage.cost_usd = Some(0.017);

        let encoded =
            serde_json::to_value(UsageDto::from(&crate_usage)).expect("should serialize");

        assert_eq!(encoded["tokens"], 1_500, "input and output are summed");
        assert_eq!(encoded["cacheReads"], 4_096);
        assert_eq!(encoded["costUsd"], 0.017);
        assert!(encoded["premiumRequests"].is_null());
        // The names the frontend actually reads. Present as camelCase, and the
        // crate's own snake_case nowhere in sight.
        assert!(encoded.get("cost_usd").is_none());
        assert!(encoded.get("input_tokens").is_none());
    }

    /// A row has to be told apart from the three identical ones above it, so the
    /// label is the argument a human would have typed rather than the tool name.
    #[test]
    fn a_task_label_shows_the_argument_not_the_tool() {
        assert_eq!(
            tool_label("Bash", &serde_json::json!({ "command": "cargo test -p az-gui" })),
            "cargo test -p az-gui"
        );
        assert_eq!(
            tool_label("Read", &serde_json::json!({ "file_path": "/tmp/notes.md" })),
            "/tmp/notes.md"
        );
        // Nothing recognized: the raw arguments beat a blank row.
        assert_eq!(
            tool_label("mcp__thing", &serde_json::json!({ "unknown": 3 })),
            "{\"unknown\":3}"
        );
        // Newlines would break the single-line row.
        assert!(!tool_label("Bash", &serde_json::json!({ "command": "a\nb" })).contains('\n'));
    }

    /// A tool argument is arbitrary user text. Slicing bytes rather than
    /// characters panics on the first accented path, and a panic in the run
    /// path takes the turn with it.
    #[test]
    fn a_long_label_is_cut_without_splitting_a_character() {
        let wide = "é".repeat(400);
        let cut = truncate_on_char_boundary(&wide, 160);

        assert_eq!(cut.chars().count(), 160, "counted in characters, not bytes");
        assert!(cut.ends_with('…'));
        assert_eq!(truncate_on_char_boundary("short", 160), "short");
    }

    /// Checkboxes are tasks. Bullets and prose are not, and reading items out of
    /// them would write to-dos the agent never proposed.
    #[test]
    fn only_checkboxes_become_items() {
        let reply = "Here is the plan:\n\
             - [ ] Port the model into az-core\n\
             * [x] Decide the store\n\
             1. [ ] Pick the id scheme\n\
             - Just a bullet, not a task\n\
             2. An ordinary numbered line\n\
             Some prose about [x] brackets in a sentence.";

        assert_eq!(
            items_from_reply(reply),
            vec![
                ("Port the model into az-core".into(), "pending".into()),
                ("Decide the store".into(), "finished".into()),
                ("Pick the id scheme".into(), "pending".into()),
            ]
        );
    }

    #[test]
    fn a_reply_with_no_checklist_writes_no_items() {
        assert!(items_from_reply("I read the file and it looks fine.").is_empty());
        assert!(items_from_reply("").is_empty());
        // An empty title is not an item.
        assert!(items_from_reply("- [ ] ").is_empty());
    }

    /// A malformed or enormous reply must not be able to fill the panel.
    #[test]
    fn the_item_count_from_one_reply_is_bounded() {
        let many = (0..100)
            .map(|n| format!("- [ ] item {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(items_from_reply(&many).len(), MAX_ITEMS_PER_REPLY);
    }

    /// `ok` is a tri-state the column cannot hold, and the distinction between
    /// "the agent said it failed" and "the agent did not say" is the whole
    /// reason it is nullable. It has to survive the round trip.
    #[test]
    fn an_unreported_result_stays_distinct_from_a_failed_one() {
        let entry = |ok| TaskLogEntryDto {
            id: "log_1".into(),
            tool_call_id: Some("call_1".into()),
            project_id: "proj_1".into(),
            item_id: None,
            label: "cargo test".into(),
            tool: "Bash".into(),
            ok,
            output: String::new(),
            duration_ms: Some(1_200),
            exit_code: None,
            finished_at: "2026-07-29T12:00:00+00:00".into(),
        };

        for original in [Some(true), Some(false), None] {
            let round_tripped = TaskLogEntryDto::from(TaskLogRow::from(&entry(original)));
            assert_eq!(round_tripped.ok, original, "ok survives as {original:?}");
            assert_eq!(round_tripped.duration_ms, Some(1_200));
            // Absent stays absent rather than becoming the -1 sentinel.
            assert_eq!(round_tripped.exit_code, None);
            assert_eq!(round_tripped.item_id, None);
        }
    }

    fn log_entry(id: &str, finished_at: &str) -> TaskLogEntryDto {
        TaskLogEntryDto {
            id: id.into(),
            tool_call_id: Some(id.into()),
            project_id: "proj_1".into(),
            item_id: None,
            label: "cargo test".into(),
            tool: "Bash".into(),
            ok: Some(true),
            output: String::new(),
            duration_ms: Some(10),
            exit_code: None,
            finished_at: finished_at.into(),
        }
    }

    /// The badge counts the whole history while the list holds one page. A page
    /// that reported its own length would show "2" over a project that has run
    /// a hundred tools.
    #[test]
    fn the_total_counts_everything_not_just_the_page() {
        let rows = vec![
            log_entry("a", "2026-07-29T12:00:00+00:00"),
            log_entry("b", "2026-07-29T12:00:01+00:00"),
            log_entry("c", "2026-07-29T12:00:02+00:00"),
        ];

        let page = page_task_log(rows, 2, None);

        assert_eq!(page.total, 3, "the total is the history, not the page");
        assert_eq!(page.entries.len(), 2);
        // Newest first.
        assert_eq!(page.entries[0].id, "c");
        assert_eq!(page.entries[1].id, "b");
    }

    /// The cursor is a `finishedAt`, not an offset, and it has to be exclusive:
    /// serving the row it names would repeat the last row of the previous page.
    #[test]
    fn paging_older_than_a_cursor_never_repeats_the_row_it_names() {
        let rows = vec![
            log_entry("a", "2026-07-29T12:00:00+00:00"),
            log_entry("b", "2026-07-29T12:00:01+00:00"),
            log_entry("c", "2026-07-29T12:00:02+00:00"),
        ];

        let page = page_task_log(rows, 10, Some("2026-07-29T12:00:01+00:00"));

        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].id, "a", "strictly older than the cursor");
        assert_eq!(page.total, 3, "the total ignores the cursor");
    }

    #[test]
    fn an_empty_cursor_is_the_first_page_rather_than_no_rows() {
        let rows = vec![log_entry("a", "2026-07-29T12:00:00+00:00")];
        assert_eq!(page_task_log(rows, 10, Some("")).entries.len(), 1);
    }

    #[test]
    fn a_duration_needs_two_stamps_it_can_parse() {
        assert_eq!(
            elapsed_ms("2026-07-29T12:00:00+00:00", "2026-07-29T12:00:02+00:00"),
            Some(2_000)
        );
        // Unknown, not zero: zero would render as an instant call.
        assert_eq!(elapsed_ms("not a date", "2026-07-29T12:00:02+00:00"), None);
        // Clocks going backwards clamp rather than report a negative duration.
        assert_eq!(
            elapsed_ms("2026-07-29T12:00:02+00:00", "2026-07-29T12:00:00+00:00"),
            Some(0)
        );
    }

    /// An agent that reported nothing must not look like a free turn.
    #[test]
    fn an_unreported_usage_sums_to_zero_rather_than_inventing_one() {
        let empty = agent_abstraction::Usage::default();
        assert!(empty.is_empty(), "the crate agrees this is nothing");
        assert_eq!(UsageDto::from(&empty), UsageDto::default());
        assert_eq!(UsageDto::default().tokens, 0);
        assert!(UsageDto::default().cost_usd.is_none());
    }
}
