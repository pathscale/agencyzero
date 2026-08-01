//! Projects, their items, their transcripts, and the agent run that fills them.
//!
//! # Streaming, and when a row is written
//!
//! Events reach the UI as they arrive; the database is written once, when the
//! run finishes. A row per token would hammer the table for data that is
//! superseded microseconds later, and `Outcome::text` is the authoritative body
//! anyway: the deltas are for the eye, the outcome is for the record.
//!
//! One exception, learned the hard way: the streaming reply is checkpointed to
//! `kv` every 200ms (`partial_reply_key`), because "close the app,
//! reopen it" lost every word the user had watched stream. A checkpoint found
//! at boot becomes an `interrupted` message row; a run that ends normally
//! clears it before anyone can see it.
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
use crate::db::schema::project_item::{
    PositionByIdQuery as ItemPositionByIdQuery, ProjectItemRow,
    ReferenceByIdQuery as ItemReferenceByIdQuery, StatusByIdQuery as ItemStatusByIdQuery,
    TitleByIdQuery as ItemTitleByIdQuery,
};
use crate::db::schema::task_log::TaskLogRow;
use crate::db::tables::Tables;

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
    /// The pull request or issue this shipped as, without the `#`. `None`
    /// until something has shipped, which is most of a row's life.
    pub reference: Option<String>,
}

impl From<ProjectItemRow> for ProjectItemDto {
    fn from(row: ProjectItemRow) -> Self {
        ProjectItemDto {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            status: row.status,
            order: row.position,
            // Absent rather than empty: "no pull request yet" is a different
            // fact from "a pull request named the empty string".
            reference: (!row.reference.is_empty()).then_some(row.reference),
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
    /// Everything this turn processed: input, output and both cache figures.
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

/// Everything the model processed, cache included.
///
/// The app's one definition of "tokens", used for the finished turn and for the
/// figure ticking over while it runs, so the status line cannot drift from the
/// header the way it did.
///
/// Was input + output, which for Claude counts only the *uncached* input: on a
/// long conversation each call reads six figures from cache and writes more,
/// and none of it appeared. That is what put "54.6k tok" next to "$9.409" in
/// the header, two numbers that cannot both describe the same turns. Cache
/// reads are billed, so they are consumption and they belong in the figure
/// sitting beside the price.
///
/// Missing fields count as zero, which is what makes one function serve both
/// callers: mid-turn `Event::Usage` carries no `output_tokens` by design, so a
/// live total is the prompt side and settles onto the full figure when the
/// `Outcome` lands.
fn processed_tokens(usage: &agent_abstraction::Usage) -> u64 {
    usage.input_tokens.unwrap_or(0)
        + usage.output_tokens.unwrap_or(0)
        + usage.cache_read_tokens.unwrap_or(0)
        + usage.cache_write_tokens.unwrap_or(0)
}

impl From<&agent_abstraction::Usage> for UsageDto {
    fn from(usage: &agent_abstraction::Usage) -> Self {
        UsageDto {
            tokens: processed_tokens(usage),
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

pub(crate) fn now() -> String {
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

pub(crate) fn id(prefix: &str) -> String {
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
/// **Markdown checkboxes only**: `- [ ] title` and `- [x] title`. Deliberately
/// not bullets, numbered lists or headings: a checkbox is unambiguously a task,
/// whereas a bulleted list is just as often prose. Reading structure into
/// ordinary paragraphs would write items the agent never proposed, and an
/// invented to-do in someone's workspace is worse than an empty panel.
///
/// Returns `(title, status)` in the order they appear, with `[x]` mapping onto
/// the `finished` status the panel already renders struck through.
/// One checkbox line, read.
#[derive(Debug, PartialEq, Eq)]
struct Checked {
    /// The match key, and never carries the reference. See the `reference`
    /// column on `ProjectItem` for why the two are kept apart.
    title: String,
    status: String,
    /// A pull request or issue the line pointed at, without the `#`.
    reference: Option<String>,
    /// The project the line named, when it named one other than the session's.
    /// A name as a person would write it, or a raw `proj-` id.
    project: Option<String>,
}

/// Split a trailing `(#35)` off a checkbox line.
///
/// Written as a suffix because that is how a person writes it, and because the
/// alternative is a second field in a format whose whole appeal is that it is
/// one line of markdown. Only a trailing group of digits counts: a title that
/// happens to contain `(#3)` mid-sentence keeps it.
fn split_reference(line: &str) -> (&str, Option<&str>) {
    let Some(open) = line.rfind("(#") else {
        return (line, None);
    };
    let rest = &line[open + 2..];
    let Some(digits) = rest.strip_suffix(')') else {
        return (line, None);
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return (line, None);
    }
    (line[..open].trim_end(), Some(digits))
}

/// Split a trailing `(@somewhere)` off a checkbox line.
///
/// The same shape as the reference suffix because it is the same kind of fact:
/// a small piece of routing that does not belong in the title, which is the
/// match key. Both may appear, in either order.
///
/// Anything non-empty counts, since project names are prose. A title that ends
/// in an email address keeps it: `(@` has to open the group.
fn split_project(line: &str) -> (&str, Option<&str>) {
    let Some(open) = line.rfind("(@") else {
        return (line, None);
    };
    let Some(named) = line[open + 2..].strip_suffix(')') else {
        return (line, None);
    };
    let named = named.trim();
    if named.is_empty() || named.contains(')') {
        return (line, None);
    }
    (line[..open].trim_end(), Some(named))
}

fn items_from_reply(reply: &str) -> Vec<Checked> {
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
                        .then(|| {
                            digits
                                .strip_prefix(". ")
                                .or_else(|| digits.strip_prefix(") "))
                        })
                        .flatten()
                })?
                .trim_start();

            /*
             * `[ ]` proposes, `[~]` plans, `[/]` starts, `[>]` ships, `[x]`
             * closes, `[-]` removes.
             *
             * `[ ]` opens a row as `new`: proposed, and nobody has decided
             * anything about it yet. `[~]` is the phase before work, where the
             * shape of the thing is still being argued about, which a list that
             * jumped from proposed to in-progress could not show at all.
             *
             * The last two are this contract's own. Markdown has no "strike
             * this row" checkbox, and a project session needs one: an obsolete
             * item is not a *finished* item, and before `[-]` existed an agent
             * working a backlog could add rows but never retire one, so the
             * list only grew. `[-]` never creates, since removing something
             * that does not exist is already true.
             *
             * `[>]` is the answer to a fix that was reported as done and was
             * not. An agent can say it shipped something; it cannot say the
             * thing works, because it is not the one looking at the screen.
             * So it moves a row to `shipped` naming the pull request, and the
             * row waits there for the owner. A copy bug was called fixed three
             * times in one evening, and under the old vocabulary the row would
             * have been deleted after the first.
             */
            let (marker, title) = [
                ("new", "[ ] "),
                ("planning", "[~] "),
                ("active", "[/] "),
                ("shipped", "[>] "),
                ("deleted", "[-] "),
                ("finished", "[x] "),
                ("finished", "[X] "),
            ]
            .into_iter()
            .find_map(|(marker, checkbox)| {
                rest.strip_prefix(checkbox).map(|title| (marker, title))
            })?;

            /*
             * Both suffixes come off before the title is read, in whichever
             * order they were written, because a person writing one of each
             * has no reason to think the order matters.
             */
            let mut title = title.trim();
            let (mut reference, mut project) = (None, None);
            loop {
                if reference.is_none()
                    && let (rest, found @ Some(_)) = split_reference(title)
                {
                    (title, reference) = (rest, found);
                    continue;
                }
                if project.is_none()
                    && let (rest, found @ Some(_)) = split_project(title)
                {
                    (title, project) = (rest, found);
                    continue;
                }
                break;
            }
            (!title.is_empty()).then(|| Checked {
                title: truncate_on_char_boundary(title, 120),
                status: marker.to_string(),
                reference: reference.map(str::to_string),
                project: project.map(str::to_string),
            })
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

/// Add one item at the end of a project's list.
///
/// These four item commands land together: the panel's controls existed for
/// weeks served by the frontend mock, which meant a created or reordered item
/// looked real and evaporated on restart — the same dishonesty the Stop
/// button had, in miniature.
///
/// # Errors
/// Returns a message for an empty title or a store failure.
#[tauri::command]
pub fn create_item(
    app: AppHandle,
    project_id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<ProjectItemDto, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("an item needs a title".into());
    }
    let count = state
        .tables
        .project_item
        .select_by_project_id(project_id.clone())
        .execute()
        .unwrap_or_default()
        .len();
    let row = ProjectItemRow {
        id: id("item"),
        project_id,
        title,
        status: "pending".into(),
        position: u32::try_from(count).unwrap_or(u32::MAX),
        // Nothing has shipped for a row that was only just proposed.
        reference: String::new(),
    };
    state
        .tables
        .project_item
        .insert(row.clone())
        .map_err(|error| error.to_string())?;
    let dto = ProjectItemDto::from(row);
    let _ = app.emit("item:created", dto.clone());
    Ok(dto)
}

/// Move one item through pending → active → finished.
///
/// # Errors
/// Returns a message for an unknown status word, a missing item, or a store
/// failure.
#[tauri::command]
pub async fn set_item_status(
    app: AppHandle,
    id: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<ProjectItemDto, String> {
    if !matches!(
        status.as_str(),
        "new" | "pending" | "planning" | "active" | "shipped" | "finished"
    ) {
        return Err(format!("not an item status: {status}"));
    }
    state
        .tables
        .project_item
        .update_status_by_id(ItemStatusByIdQuery { status }, id.clone())
        .await
        .map_err(|error| error.to_string())?;
    let row = state
        .tables
        .project_item
        .select(id.clone())
        .ok_or_else(|| format!("no item {id}"))?;
    let dto = ProjectItemDto::from(row);
    let _ = app.emit("item:updated", dto.clone());
    Ok(dto)
}

/// Rewrite one item's title, for the panel's inline edit.
///
/// # Errors
/// Returns a message for an empty title, a missing item, or a store failure.
#[tauri::command]
pub async fn update_item(
    app: AppHandle,
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<ProjectItemDto, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("an item needs a title".into());
    }
    state
        .tables
        .project_item
        .update_title_by_id(ItemTitleByIdQuery { title }, id.clone())
        .await
        .map_err(|error| error.to_string())?;
    let row = state
        .tables
        .project_item
        .select(id.clone())
        .ok_or_else(|| format!("no item {id}"))?;
    let dto = ProjectItemDto::from(row);
    let _ = app.emit("item:updated", dto.clone());
    Ok(dto)
}

/// Remove one item.
///
/// # Errors
/// Returns a message when the item does not exist or the delete fails.
#[tauri::command]
pub async fn delete_item(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let row = state
        .tables
        .project_item
        .select(id.clone())
        .ok_or_else(|| format!("no item {id}"))?;
    state
        .tables
        .project_item
        .delete(id.clone())
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit(
        "item:deleted",
        serde_json::json!({ "id": id, "projectId": row.project_id }),
    );
    Ok(())
}

/// Persist a new order for a project's items.
///
/// `ids` is the list as the user arranged it; position becomes the index.
/// Items the list does not name keep their old positions — the sort is
/// stable enough for the desktop-sized lists this handles, and refusing a
/// partial list would make every caller re-fetch before every move.
///
/// # Errors
/// Returns the first store failure; positions written before it stand, which
/// the returned (re-read) list makes visible rather than papering over.
#[tauri::command]
pub async fn reorder_items(
    app: AppHandle,
    project_id: String,
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ProjectItemDto>, String> {
    for (index, item_id) in ids.iter().enumerate() {
        state
            .tables
            .project_item
            .update_position_by_id(
                ItemPositionByIdQuery {
                    position: u32::try_from(index).unwrap_or(u32::MAX),
                },
                item_id.clone(),
            )
            .await
            .map_err(|error| error.to_string())?;
    }
    let items = list_items(project_id, state);
    for item in &items {
        let _ = app.emit("item:updated", item.clone());
    }
    Ok(items)
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
            reference: String::new(),
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
///
/// A line lands on the session's own project unless it names another with
/// `(@somewhere)`. Every session can write anywhere for the same reason the
/// task manager always could: the app owns the store, so which project a row
/// belongs to is a fact the line states, not a consequence of where it was
/// typed. Work spills across projects constantly, and the alternative is
/// telling the user to go and re-type it in the right window.
async fn write_items_from_reply(
    app: &AppHandle,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    reply: &str,
) {
    let proposed = items_from_reply(reply);
    if proposed.is_empty() {
        return;
    }

    /*
     * A line may say where it goes. Grouped rather than written one at a time
     * so that each project is read once and its positions stay contiguous,
     * and kept in the order the reply wrote them.
     */
    let mut targets: Vec<(String, Vec<Checked>)> = Vec::new();
    let mut projects: Option<Vec<ProjectRow>> = None;
    for item in proposed {
        let target = match item.project.as_deref() {
            None => project_id.to_string(),
            Some(named) => {
                let rows = projects.get_or_insert_with(|| {
                    tables.project.select_all().execute().unwrap_or_default()
                });
                match resolve_project(rows, named) {
                    Some(found) => found,
                    None => {
                        crate::log!(
                            crate::log::Level::Error,
                            "items",
                            "{project_id}: no project matches {named:?}, so {:?} was not written",
                            item.title
                        );
                        continue;
                    }
                }
            }
        };
        match targets.iter_mut().find(|(id, _)| *id == target) {
            Some((_, group)) => group.push(item),
            None => targets.push((target, vec![item])),
        }
    }

    for (target, group) in targets {
        write_items_into(app, tables, &target, group).await;
    }
}

/// Find the project a line named, by id or by name, case-insensitively.
///
/// Never creates one. The task manager creates a project it cannot find,
/// because organising is the entire job there. An ordinary session that names
/// something missing has far more likely mistyped it, and a silently created
/// near-duplicate project is much harder to notice than an item that never
/// appeared.
fn resolve_project(rows: &[ProjectRow], named: &str) -> Option<String> {
    let named = named.trim();
    // Folded the same way the task manager folds its names, so the two ways
    // into the same table cannot disagree about which project was meant.
    let folded = named.to_lowercase();
    rows.iter()
        .find(|row| row.id == named)
        .or_else(|| {
            rows.iter()
                .find(|row| row.name.trim().to_lowercase() == folded)
        })
        .map(|row| row.id.clone())
}

/// Write one project's worth of checkbox lines.
async fn write_items_into(
    app: &AppHandle,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    proposed: Vec<Checked>,
) {
    let existing: Vec<ProjectItemRow> = tables
        .project_item
        .select_by_project_id(project_id.to_string())
        .execute()
        .unwrap_or_default();
    let by_title: std::collections::HashMap<String, &ProjectItemRow> = existing
        .iter()
        .map(|row| (row.title.to_lowercase(), row))
        .collect();
    let mut next = u32::try_from(existing.len()).unwrap_or(0);

    // Settings decide what "done" does to an existing row; read once per reply.
    let delete_completed = tables
        .kv_get(crate::settings::KEY)
        .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
        .unwrap_or_default()
        .completed_items
        == "delete";

    for Checked {
        title,
        status,
        reference,
        // Already spent: grouping the reply is what chose `project_id`.
        project: _,
    } in proposed
    {
        /*
         * A checkbox line naming an item that already exists is a status
         * report, not a proposal: `- [x] Fix the picker` from the session
         * that just fixed it marks the row finished (or deletes it, per
         * Settings). This is how a run closes out the item it was started
         * from without any special verb.
         */
        if let Some(row) = by_title.get(&title.to_lowercase()) {
            if row.status == status {
                continue;
            }
            /*
             * A proposal never moves a row that already exists.
             *
             * `- [ ]` means "this should be done", which is already true of
             * every row on the list, so re-listing the backlog in a reply must
             * not knock a row being worked on back to the start. The contract
             * has always said a proposal leaves an existing title alone; the
             * code updated it anyway, which was survivable while `[ ]` meant
             * `pending` and is not now that it means `new`.
             */
            if status == "new" {
                continue;
            }
            /*
             * `[-]` removes outright, whatever Settings says about completed
             * items: an obsolete row is not a finished one, and the setting
             * governs what "done" means, not what "gone" means. `[x]` defers
             * to the setting as before.
             */
            if status == "deleted" || (status == "finished" && delete_completed) {
                let (row_id, row_project) = (row.id.clone(), row.project_id.clone());
                match tables.project_item.delete(row_id.clone()).await {
                    Ok(()) => {
                        let _ = app.emit(
                            "item:deleted",
                            serde_json::json!({ "id": row_id, "projectId": row_project }),
                        );
                    }
                    Err(error) => crate::log!(
                        crate::log::Level::Error,
                        "items",
                        "{project_id}: could not delete the item: {error}"
                    ),
                }
                continue;
            }
            let row_id = row.id.clone();
            /*
             * The reference is recorded before the status, so a row that
             * reaches `shipped` always names where it went. A shipped row with
             * no pull request on it is the state this whole verb exists to
             * make impossible: it reads exactly like the "done" that was not.
             */
            if let Some(number) = reference.as_deref()
                && row.reference != number
                && let Err(error) = tables
                    .project_item
                    .update_reference_by_id(
                        ItemReferenceByIdQuery {
                            reference: number.to_string(),
                        },
                        row_id.clone(),
                    )
                    .await
            {
                crate::log!(
                    crate::log::Level::Error,
                    "items",
                    "{project_id}: could not record the item's reference: {error}"
                );
            }
            match tables
                .project_item
                .update_status_by_id(ItemStatusByIdQuery { status }, row_id.clone())
                .await
            {
                Ok(()) => {
                    if let Some(updated) = tables.project_item.select(row_id) {
                        let _ = app.emit("item:updated", ProjectItemDto::from(updated));
                    }
                }
                Err(error) => crate::log!(
                    crate::log::Level::Error,
                    "items",
                    "{project_id}: could not update the item's status: {error}"
                ),
            }
            continue;
        }
        // `[-]` for a title that does not exist is already true — removing
        // nothing must not create something.
        if status == "deleted" {
            continue;
        }
        let row = ProjectItemRow {
            id: id("item"),
            project_id: project_id.to_string(),
            title,
            status,
            position: next,
            reference: reference.unwrap_or_default(),
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

/// Where a run's partially streamed reply lives in `kv` while it streams.
///
/// Written every few seconds during a run and cleared the moment the reply
/// lands as a real message row. Anything found here at boot is a reply the
/// app was closed on top of — `recover_partial_replies` turns it into an
/// `interrupted` message so the words the user watched stream are not lost.
pub(crate) fn partial_reply_key(project_id: &str) -> String {
    format!("partial-reply:{project_id}")
}

/// How stale the persisted copy of a streaming reply may get.
///
/// Every text delta re-arms this; the write happens on the first delta after
/// the interval passes. 200ms by owner request (down from 2s): killing the
/// app should lose a breath of prose, not a paragraph. Still throttled at
/// all, because a delta can be a single token and one kv upsert per token
/// is a continuous write load on the store everything else depends on —
/// at ~5 writes/second the cost is noise and the loss window is invisible.
const PARTIAL_FLUSH_EVERY: std::time::Duration = std::time::Duration::from_millis(200);

/// Deliver a mid-turn message into the open turn, per 0.3.6's contract.
///
/// The user row is already in the transcript — rendering happened on send and
/// no echo is coming, deliberately. Here the words just have to reach the
/// agent, which takes them at its next step boundary ("sent", never
/// "stopped"). A turn that settled first (`is_cancelled`) hands them back via
/// `run:inject_failed`, and the frontend queues them for a fresh run resuming
/// the session — the crate notes' prescribed recovery, automated. Any other
/// failure takes the same road, with its own reason in the I/O panel.
async fn deliver_injection(
    app: &AppHandle,
    io: &std::sync::Arc<AgentIo>,
    run: &agent_abstraction::Run,
    project_id: &str,
    body: String,
) {
    match run.send(&body).await {
        Ok(()) => {
            note_io(
                app,
                io,
                project_id,
                "sent",
                "message",
                "(into the running turn)",
            );
        }
        Err(error) => {
            let why = if error.is_cancelled() {
                "the turn settled before the message arrived — queued for a fresh turn resuming the session".to_string()
            } else {
                format!("the mid-run message could not be delivered: {error}")
            };
            note_io(app, io, project_id, "received", "error", why);
            let _ = app.emit(
                "run:inject_failed",
                serde_json::json!({ "projectId": project_id, "body": body }),
            );
        }
    }
}

/// Drop a run's reply checkpoint, once a real row owns the words.
async fn clear_partial_reply(tables: &Tables, project_id: &str) {
    if let Err(error) = tables
        .kv_put(&partial_reply_key(project_id), String::new())
        .await
    {
        crate::log!(
            crate::log::Level::Warn,
            "run",
            "{project_id}: could not clear the reply checkpoint: {error}"
        );
    }
}

/// Turn any partially streamed replies from a previous launch into rows.
///
/// Called once at boot, before the window asks for messages. A non-empty
/// `partial-reply:` key means a run was streaming when the process died — the
/// reply row was never written, but the prose the user watched was flushed
/// here. It becomes a message with `stop: "interrupted"`, so the transcript
/// says honestly that the turn did not finish.
pub async fn recover_partial_replies(tables: &Tables) {
    let rows = tables.kv.select_all().execute().unwrap_or_default();
    for row in rows {
        let Some(project_id) = row.key.strip_prefix("partial-reply:") else {
            continue;
        };
        let project_id = project_id.to_string();
        if row.value.is_empty() {
            continue;
        }
        // The task manager has no project row; every real project must still
        // exist — a partial for a deleted project is just cleared.
        if project_id != crate::tasks::TASK_MANAGER_ID
            && tables.project.select(project_id.clone()).is_none()
        {
            let _ = tables.kv_put(&row.key, String::new()).await;
            continue;
        }
        let message = MessageRow {
            id: id("msg"),
            project_id: project_id.clone(),
            item_id: String::new(),
            author: "agent".into(),
            agent: "claude".into(),
            moderation: String::new(),
            model: String::new(),
            permission: String::new(),
            usage: String::new(),
            stop: "interrupted".into(),
            exit_code: 0,
            body: row.value,
            created_at: now(),
        };
        if let Err(error) = tables.message.insert(message) {
            crate::log!(
                crate::log::Level::Error,
                "run",
                "{project_id}: could not recover the interrupted reply: {error}"
            );
            continue;
        }
        crate::log!(
            crate::log::Level::Info,
            "run",
            "{project_id}: recovered a reply the last launch was closed on top of"
        );
        let _ = tables.kv_put(&row.key, String::new()).await;
    }
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

/// One question a run is blocked on: the way to answer it, and what
/// remembering the answer would mean.
pub struct PendingAsk {
    sender: tokio::sync::oneshot::Sender<bool>,
    /// The [`approval_signature`] of the gated call, carried here so
    /// "always allow similar" can persist a rule without the frontend ever
    /// defining what similar means.
    signature: String,
}

/// Decisions on their way to runs blocked on an approval, keyed by the exact
/// `(project id, approval id)` pair.
///
/// A run in `ask` mode that hits a gated tool call emits `run:approval`,
/// registers a one-shot sender here, and waits. `resolve_approval` consumes
/// exactly that sender, so an answer can only ever reach the question it
/// names. The previous shape — a shared per-project queue — let a late answer
/// to a timed-out question sit in the queue and instantly deny the *next*
/// question; one-shot-per-id makes that stale answer an error instead.
pub type PendingApprovals =
    std::sync::Mutex<std::collections::HashMap<(String, String), PendingAsk>>;

/// What "similar" means when an approval is remembered.
///
/// Bash commands collapse to program plus subcommand — `cargo test`,
/// `git push` — specific enough that allowing `cargo test` says nothing
/// about `rm`, general enough that the next test run does not ask again.
/// The second word only counts when it is shaped like a subcommand: flags
/// and paths vary per call and would make every rule single-use.
///
/// File tools collapse to the file's parent directory, so allowing one edit
/// in a crate allows that directory, not the disk. URL tools collapse to the
/// host. Anything else is the tool name alone.
fn approval_signature(tool: &str, input: &serde_json::Value) -> String {
    let text = |key: &str| {
        input
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or("")
    };

    if tool.eq_ignore_ascii_case("bash") {
        let mut words = text("command").split_whitespace();
        let program = words.next().unwrap_or("");
        let subcommand = words
            .next()
            .filter(|word| {
                !word.starts_with('-')
                    && word
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            })
            .unwrap_or("");
        return if subcommand.is_empty() {
            format!("{tool}: {program}")
        } else {
            format!("{tool}: {program} {subcommand}")
        };
    }

    for key in ["file_path", "path", "notebook_path"] {
        let value = text(key);
        if !value.is_empty() {
            let dir = std::path::Path::new(value)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map_or_else(|| value.to_string(), |p| p.to_string_lossy().into_owned());
            return format!("{tool}: {dir}");
        }
    }

    let url = text("url");
    if !url.is_empty() {
        let host = url
            .split("://")
            .nth(1)
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or(url);
        return format!("{tool}: {host}");
    }

    tool.to_string()
}

/// The remembered approval signatures for one project, from the
/// `approval_rule` table — rows, not a kv blob, so `wt-tools` can audit
/// grants and a later per-rule delete is a `delete`, not a rewrite.
fn load_rules(tables: &crate::db::tables::Tables, project_id: &str) -> Vec<String> {
    tables
        .approval_rule
        .select_by_project_id(project_id.to_string())
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(|row| row.signature)
        .collect()
}

/// How long an unanswered approval stands before it is denied.
///
/// The run is blocked while the question is open, so an abandoned window must
/// become a denial rather than a run that hangs until the agent's own timeout.
const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// The live run in each project: a reservation that there is at most one, and
/// the signal that stops it.
///
/// `send_message` claims a project's slot before spawning anything and a
/// second *run* is refused while the slot is held, which is what makes "one
/// run per project" true in the backend rather than merely drawn in the UI —
/// two concurrent runs would resume the same session and share one approval
/// route. `cancel_run` and `delete_project` signal `cancel`; the run's event
/// loop watches the receiver and tears the agent down cooperatively.
///
/// `inject` is the other direction: a message typed while the run is live is
/// delivered *into* the turn over the agent's open stdin (`Run::send`, 0.3.6),
/// and the model takes it at its next step boundary. That is what makes a
/// mid-run correction an interruption rather than a queued afterthought.
pub struct ActiveRun {
    pub cancel: tokio::sync::watch::Sender<bool>,
    /// `None` when the run has no conversation to interrupt.
    ///
    /// A command turn — `/compact` — rewrites the session instead of answering
    /// it, and its stream is drained for the command's own events. Words
    /// delivered into that turn would be read by nobody and would disappear
    /// with it, so the send is refused and the frontend holds them for the
    /// session that comes out the other side.
    pub inject: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

pub type ActiveRuns = std::sync::Mutex<std::collections::HashMap<String, ActiveRun>>;

/*
 * The two refusals that mean "hold this, do not hand it back".
 *
 * A Tauri command's error crosses to the window as a bare string, so
 * `queueReason` in `stores/workspace.tsx` reads these by their wording — there
 * is nothing else on the wire to key on. Reworded here without being reworded
 * there, a prompt that should have waited in the queue turns into red text
 * under the composer instead. Named, and asserted in `queue_markers`, so the
 * coupling is at least visible from this end.
 */
const BUSY_WITH_COMMAND: &str =
    "a command is running in this project — the message will be sent when it finishes";
const BUSY_WITH_RUN: &str = "a run is already active in this project — stop it or let it finish";
const BUSY_WITH_RUN_ALREADY: &str = "a run is already active in this project — let it finish first";

/// Releases a project's run slot when the run is over, however it ends.
///
/// Owned by `drive_run` for its whole body, so a spawn failure or a panic
/// unwinding frees the slot the same way a finished run does. A leaked slot
/// would refuse every later send for the project.
pub struct RunReservation {
    active: std::sync::Arc<ActiveRuns>,
    project_id: String,
}

impl Drop for RunReservation {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&self.project_id);
        }
    }
}

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
    let week_start = (now - chrono::Duration::days(6))
        .format("%Y-%m-%d")
        .to_string();
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
    remember: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    /*
     * Removed, not read: consuming the sender is what makes a duplicate click
     * or a late answer to a timed-out question an error here, instead of a
     * stray decision waiting to be misread as the answer to the *next*
     * question.
     */
    let ask = state
        .approvals
        .lock()
        .ok()
        .and_then(|mut waiting| waiting.remove(&(project_id.clone(), approval_id.clone())))
        .ok_or_else(|| {
            format!(
                "approval {approval_id} is not waiting in {project_id} — \
                 already answered, timed out, or the run has moved on"
            )
        })?;

    /*
     * "Always allow similar": persist the rule before answering, so a run
     * that finishes the instant it hears yes still leaves the rule behind.
     * Only an *allow* is ever remembered — a remembered denial would turn
     * one misclick into a run that can never do its job again, silently.
     */
    if allow && remember == Some(true) {
        let rules = load_rules(&state.tables, &project_id);
        // Uniqueness is the writer's job; the single writer makes that safe.
        if !rules.iter().any(|rule| rule == &ask.signature) {
            let row = crate::db::schema::approval_rule::ApprovalRuleRow {
                id: id("rule"),
                project_id: project_id.clone(),
                signature: ask.signature.clone(),
                created_at: now(),
            };
            state
                .tables
                .approval_rule
                .insert(row)
                .map_err(|error| error.to_string())?;
            crate::log!(
                crate::log::Level::Info,
                "run",
                "{project_id}: remembered [{}]",
                ask.signature
            );
        }
    }

    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: approval {approval_id} answered allow={allow}"
    );
    ask.sender
        .send(allow)
        .map_err(|_| "the run finished before the decision arrived".to_string())
}

/// The remembered approval rules for one project, for display.
#[tauri::command]
pub fn list_approval_rules(project_id: String, state: State<'_, AppState>) -> Vec<String> {
    load_rules(&state.tables, &project_id)
}

/// Forget every remembered approval for one project.
///
/// All of them rather than one at a time, on purpose for now: the list is
/// short, the rules are cheap to re-teach, and "which single rule caused
/// that" is answered by the I/O panel's auto-allow notes.
///
/// # Errors
/// Returns the store's error when the record cannot be cleared.
#[tauri::command]
pub async fn clear_approval_rules(
    app: AppHandle,
    project_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .tables
        .approval_rule
        .delete_by_project(project_id.clone())
        .await
        .map_err(|error| error.to_string())?;
    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: remembered approvals cleared"
    );
    note_gui(&app, &state, &project_id, "remembered approvals cleared");
    Ok(())
}

/// Stop the run in this project, if one is live.
///
/// The signal reaches the run's own event loop, which asks the crate to tear
/// the agent's process group down cooperatively and waits until it is really
/// gone — the `run:stopped` that follows comes from the backend after the
/// processes have exited, not from optimism. Before this existed, Stop was
/// served by the frontend mock: the UI showed "canceled" while the real agent
/// kept executing tools.
///
/// # Errors
/// Returns a message when nothing is running in the project.
#[tauri::command]
pub async fn cancel_run(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let signalled = state
        .active
        .lock()
        .map(|active| {
            active
                .get(&project_id)
                .map(|run| {
                    let _ = run.cancel.send(true);
                })
                .is_some()
        })
        .unwrap_or(false);

    if signalled {
        crate::log!(
            crate::log::Level::Info,
            "run",
            "{project_id}: stop requested"
        );
        Ok(())
    } else {
        Err(format!("nothing is running in {project_id}"))
    }
}

/// Ask the conversation what it must not forget, and keep the answer.
///
/// Runs against the session about to be summarised, because that is the only
/// place the knowledge still exists. The reply is stored verbatim (clamped) and
/// becomes this project's standing instructions — see [`crate::notes`] for why
/// it lives outside the conversation rather than being told to the agent.
///
/// # Failure is not fatal
///
/// Returns `None` and leaves the existing notes untouched if anything goes
/// wrong. A compaction the user asked for must still happen: refusing to
/// compact because the note-taking failed would hold a full context window
/// hostage to an optional feature, and the agent is already struggling — that
/// is why they reached for `/compact`.
///
/// No tools, no approvals, and the crate's default read-only posture: this turn
/// writes prose, and a run that could touch the repository while the user
/// believes it is taking notes would be a surprise nobody asked for.
async fn learn_before_compacting(
    app: &AppHandle,
    io: &AgentIo,
    state: &State<'_, AppState>,
    project_id: &str,
    cwd: &str,
    session: Option<&str>,
) -> Option<String> {
    let existing = state
        .tables
        .kv_get(&crate::notes::notes_key(project_id))
        .unwrap_or_default();

    let mut request = agent_abstraction::Request::new(
        agent_abstraction::Agent::Claude,
        crate::notes::merge_prompt(&existing),
    )
    .cwd(cwd);
    if let Some(session) = session {
        request = request.resume(session);
    }

    note_io(
        app,
        io,
        project_id,
        "sent",
        "request",
        format!("claude <pre-compaction notes> cwd={cwd}"),
    );

    let outcome = match agent_abstraction::run(&request).await {
        Ok(outcome) => outcome,
        Err(error) => {
            crate::log!(
                crate::log::Level::Warn,
                "run",
                "{project_id}: could not take notes before compacting: {error}"
            );
            return None;
        }
    };

    let learned = crate::notes::clamp(&outcome.text);
    if learned.is_empty() {
        // Nothing said is not the same as "forget everything you knew": an
        // empty reply leaves the previous set standing.
        crate::log!(
            crate::log::Level::Warn,
            "run",
            "{project_id}: the pre-compaction pass returned nothing to keep"
        );
        return None;
    }

    if let Err(error) = state
        .tables
        .kv_put(&crate::notes::notes_key(project_id), learned.clone())
        .await
    {
        crate::log!(
            crate::log::Level::Error,
            "run",
            "{project_id}: could not store what was learned: {error}"
        );
        return None;
    }

    note_io(
        app,
        io,
        project_id,
        "received",
        "notes",
        format!("kept {} characters for after the compaction", learned.len()),
    );
    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: kept {} characters of notes before compacting",
        learned.len()
    );
    Some(learned)
}

/// Who gets to say whether a compaction happened, and why it did not.
///
/// Four sources, deliberately ranked, because they disagree. `reported` is the
/// agent's own compaction record and outranks everything: a refusal is a
/// *completed* run carrying a reason, and reading the clean exit instead would
/// report a compaction that did not happen. `spoken` is the last resort and the
/// one that matters in practice — an agent with nothing to compact says
/// `Error: No messages to compact` as plain assistant text and emits no
/// compaction record at all, so without it the honest-but-useless "ended
/// without reporting a compaction" was all the user ever saw.
///
/// Silence is never success. A run that finished cleanly having said nothing
/// about compacting has not compacted, and saying otherwise is precisely the
/// lie the typed command exists to prevent.
fn compaction_verdict(
    cancelled: bool,
    reported: Option<(bool, Option<String>)>,
    exit: Option<String>,
    spoken: &str,
) -> (bool, Option<String>) {
    if cancelled {
        // Asked for, so reported as itself rather than as whatever error the
        // torn-down agent happened to exit with.
        return (false, Some("you stopped the compaction".into()));
    }
    if let Some((ok, error)) = reported {
        return (ok, error);
    }
    if let Some(error) = exit {
        return (false, Some(error));
    }
    (
        false,
        Some(match spoken.trim() {
            "" => "the agent ended without reporting a compaction".into(),
            said => said.to_string(),
        }),
    )
}

/// Summarise the conversation so far and continue from the summary.
///
/// The answer to a session that has filled its context window: past about
/// four-fifths of it the model is measurably worse at what it was doing, and
/// there is nothing a user can do about it from the composer.
///
/// Runs `agent-abstraction`'s `Command::Compact` rather than sending the text
/// `/compact`, which is the whole point of the crate's typed surface: the
/// literal would reach an agent without a command vocabulary as prose and come
/// back as an essay about compaction, indistinguishable from success.
///
/// # Its own turn, and its own slot
///
/// A compaction is a turn: it resumes the session, rewrites it, and settles.
/// So it claims the same one-run-per-project slot a message does — really
/// claims it, by holding a [`RunReservation`] for its whole body. Checking the
/// registry without inserting into it was the bug behind "why is my message not
/// queued": nothing knew a compaction was running, so a send during one started
/// a second run against the same session.
///
/// It writes no assistant reply — a compaction produces no answer — so the
/// transcript gets a system note instead, which is the only durable record that
/// the conversation the user is reading was rewritten underneath them.
///
/// # Without a session
///
/// Runs on a fresh one and records the id the agent hands back. A command that
/// demanded an existing session made `/compact` fail on an untouched project
/// until the user sent a throwaway message to bring a session into being, which
/// is the opposite of what a command is for. Compacting an empty conversation
/// is the agent's own question to answer, and it answers it.
///
/// # Errors
/// When a run is already active, or when the agent refuses. A conversation too
/// short to summarise is the agent's own refusal and comes back as its message,
/// not as a crash.
#[tauri::command]
pub async fn compact_project(
    app: AppHandle,
    project_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = state
        .tables
        .kv_get(&session_key(&project_id))
        .filter(|id| !id.is_empty());

    // Held for the rest of the body: the slot is released when this drops,
    // however the compaction ends.
    let (_reservation, mut cancel) = {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "the run registry is unavailable".to_string())?;
        if active.contains_key(&project_id) {
            return Err(BUSY_WITH_RUN_ALREADY.into());
        }
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        active.insert(
            project_id.clone(),
            ActiveRun {
                cancel: cancel_tx,
                // Nothing to say into: see `ActiveRun::inject`.
                inject: None,
            },
        );
        (
            RunReservation {
                active: state.active.clone(),
                project_id: project_id.clone(),
            },
            cancel_rx,
        )
    };

    let mut dirs = state
        .tables
        .project
        .select(project_id.clone())
        .and_then(|row| serde_json::from_str::<Vec<String>>(&row.dirs).ok())
        .unwrap_or_default();
    dirs.retain(|dir| !dir.trim().is_empty());
    let cwd = if dirs.is_empty() {
        crate::workspace_root_path(&app, &state)
    } else {
        dirs.remove(0)
    };

    let io = state.io.clone();

    /*
     * Learn before forgetting.
     *
     * A compaction is the only operation in the app that destroys something on
     * purpose, and what it destroys is not evenly valuable: the narrative
     * compresses well and the operating rules do not survive at all. So the
     * command is caught here and wrapped — one turn to write down what must
     * outlive the summary, then the summary.
     *
     * Only ever on a session that exists. On a fresh one there is nothing to
     * learn from, and asking would bill a turn to be told so.
     */
    /*
     * A compaction shrinks the conversation, so the thresholds re-arm: the next
     * fill is a fresh set of samples, and comparing across fills is the point.
     * Cleared before the compaction rather than after, so a failure part-way
     * leaves the marks armed rather than stuck at 900k on a conversation that
     * has since been cut to 30k.
     */
    if let Err(error) = state
        .tables
        .kv_put(&crate::notes::checkpoint_mark_key(&project_id), "0".into())
        .await
    {
        crate::log!(
            crate::log::Level::Warn,
            "run",
            "{project_id}: could not re-arm the checkpoint marks: {error}"
        );
    }

    let learned = if session.is_some() {
        let _ = app.emit(
            "run:compaction",
            serde_json::json!({
                "projectId": project_id,
                "driver": "command",
                "phase": "learning",
            }),
        );
        learn_before_compacting(&app, &io, &state, &project_id, &cwd, session.as_deref()).await
    } else {
        None
    };

    let mut request = agent_abstraction::Request::command(
        agent_abstraction::Agent::Claude,
        &agent_abstraction::Command::Compact { instructions: None },
    )
    .cwd(&cwd);
    if let Some(session) = &session {
        request = request.resume(session);
    }

    let resumed = session.as_deref().unwrap_or("<new session>");
    note_io(
        &app,
        &io,
        &project_id,
        "sent",
        "request",
        format!("claude /compact cwd={cwd} resume={resumed}"),
    );
    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: compacting session {resumed}"
    );

    let mut run = agent_abstraction::stream(&request)
        .map_err(|error| format!("could not start the compaction: {error}"))?;

    let _ = app.emit(
        "run:compaction",
        serde_json::json!({
            "projectId": project_id,
            "driver": "command",
            "phase": "started",
        }),
    );

    /*
     * Three events matter, and the third is the one an empty conversation
     * answers with. A compaction reports no usage worth recording and its
     * `result` is empty by design — but an agent that will not compact at all
     * says so as ordinary assistant text and emits no compaction record
     * whatsoever. Checked against the CLI on a fresh session: the entire reply
     * is `Error: No messages to compact`, the run exits `success`, and nothing
     * else is said. Dropping that text left the user reading "the agent ended
     * without reporting a compaction" while the agent had explained itself
     * perfectly well.
     */
    let mut outcome_note = None;
    let mut spoken = String::new();
    let mut cancelled = false;
    loop {
        let event = tokio::select! {
            _ = cancel.changed() => {
                cancelled = true;
                break;
            }
            event = run.recv() => match event {
                Some(event) => event,
                None => break,
            },
        };
        match event {
            agent_abstraction::Event::Compaction(agent_abstraction::Compaction::Finished {
                ok,
                error,
            }) => outcome_note = Some((ok, error)),
            // Kept only as a fallback reason. A compaction that works says
            // nothing here, so text almost always means it did not.
            agent_abstraction::Event::Text(text) => spoken.push_str(&text),
            // The session this command is running on, which is news only when
            // there was none to resume — the command has just brought one into
            // being and the next message has to resume *it*.
            agent_abstraction::Event::Started {
                session: started, ..
            } => {
                if let Err(error) = state
                    .tables
                    .kv_put(&session_key(&project_id), started.clone())
                    .await
                {
                    crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not record the session id: {error}"
                    );
                } else if let Some(row) = state.tables.project.select(project_id.clone()) {
                    let _ = app.emit(
                        "project:updated",
                        with_session(ProjectDto::from(row), &state.tables),
                    );
                }
            }
            _ => {}
        }
    }
    let finished = if cancelled {
        run.cancel().await
    } else {
        run.finish().await
    };

    let (ok, why) = compaction_verdict(
        cancelled,
        outcome_note,
        finished.as_ref().err().map(ToString::to_string),
        &spoken,
    );

    let body = if ok {
        /*
         * The note says what was kept, not just that something was thrown
         * away. A compaction is destructive and silent, and "kept 14 rules"
         * is the only evidence the user has that the destruction was survivable
         * — it is also the prompt to go and check them if the agent starts
         * behaving oddly afterwards.
         */
        match learned.as_deref() {
            Some(notes) => format!(
                "Compacted the conversation, keeping {} rule(s) learned so far. \
                 What came before is now a summary, but those rules ride every \
                 turn from here and no later compaction can lose them.",
                notes.lines().filter(|line| !line.trim().is_empty()).count()
            ),
            None => "Compacted the conversation. What came before is now a summary, so the agent remembers the gist rather than the words.".to_string(),
        }
    } else {
        format!(
            "Could not compact: {}",
            why.as_deref().unwrap_or("no reason given")
        )
    };
    note_io(
        &app,
        &io,
        &project_id,
        "received",
        if ok { "compacted" } else { "error" },
        body.clone(),
    );

    let row = MessageRow {
        id: id("msg"),
        project_id: project_id.clone(),
        item_id: String::new(),
        // The app's own voice, not the moderator's. Written as a moderator note
        // this rendered as an empty amber card reading "Moderator supervising ·"
        // — the transcript builds that card out of the `moderation` verdict,
        // which a compaction does not have and should not fake.
        author: "system".into(),
        agent: "claude".into(),
        moderation: String::new(),
        model: String::new(),
        permission: String::new(),
        usage: String::new(),
        stop: if ok { "completed" } else { "error" }.into(),
        exit_code: 0,
        body,
        created_at: now(),
    };
    state
        .tables
        .message
        .insert(row.clone())
        .map_err(|error| error.to_string())?;
    let _ = app.emit("message:appended", &MessageDto::from(row));
    let _ = app.emit(
        "run:compaction",
        serde_json::json!({
            "projectId": project_id,
            "driver": "command",
            "phase": "finished",
            "ok": ok,
            "error": why,
        }),
    );

    if ok {
        Ok(())
    } else {
        Err(why.unwrap_or_else(|| "the compaction did not complete".into()))
    }
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

    crate::log!(
        crate::log::Level::Info,
        "tasks",
        "task manager session reset"
    );
    note_gui(
        &app,
        &state,
        id,
        "task manager session reset; the next prompt starts fresh",
    );

    if let Some(row) = state.tables.project.select(id.to_string()) {
        let _ = app.emit(
            "project:updated",
            with_session(ProjectDto::from(row), &state.tables),
        );
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
    crate::log!(
        crate::log::Level::Info,
        "projects",
        "renamed {id} to {name:?}"
    );
    note_gui(
        &app,
        &state,
        &id,
        format!("renamed the project to {name:?}"),
    );
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

    /*
     * Stop the live run first, and wait until it has actually stopped.
     * Deleting rows out from under a running agent does not stop it — the
     * detached run holds its own table handles and would keep executing
     * tools, then write its reply and cost under an id that no longer
     * exists. Deletion doubles as the emergency brake, so it must brake.
     *
     * The wait watches the run registry: the run frees its slot only after
     * `Run::cancel()` has confirmed the process group is gone.
     */
    let was_running = state
        .active
        .lock()
        .map(|active| {
            active
                .get(&id)
                .map(|run| {
                    let _ = run.cancel.send(true);
                })
                .is_some()
        })
        .unwrap_or(false);
    if was_running {
        crate::log!(
            crate::log::Level::Info,
            "projects",
            "{id}: stopping the live run before deleting"
        );
        // Teardown is normally near-instant; the bound only exists so a hung
        // agent cannot hold the delete hostage. The tombstone check in
        // `drive_run` catches anything that outlives it.
        for _ in 0..100 {
            let released = state
                .active
                .lock()
                .map(|active| !active.contains_key(&id))
                .unwrap_or(true);
            if released {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

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

    /*
     * The project's satellites go with it: the remembered approval rows —
     * standing permission grants — plus the resume session and the I/O
     * recording flag in kv. Ids are never recycled so these were only
     * orphans, but an allow-rule is not the kind of orphan to leave around.
     */
    state
        .tables
        .approval_rule
        .delete_by_project(id.clone())
        .await
        .map_err(|error| failed("the approval rules", &error))?;
    /*
     * The raw exchange and the PR chips, which were being left behind.
     *
     * Both tables have carried a `ByProject` delete since they were added and
     * neither was ever called here, so every deleted project left its I/O rows
     * and its pull-request rows in the store — invisible, because nothing reads
     * them without a project to hang them off, and unbounded, because the I/O
     * table is the largest thing this app writes.
     *
     * The usage ledger is deliberately *not* cleared and has no such verb: the
     * money was spent whether or not the project still exists, and a cost
     * summary that shrinks when you tidy up is a cost summary nobody can
     * reconcile. It carries the project id for grouping, not for ownership.
     */
    state
        .tables
        .agent_io
        .delete_by_project(id.clone())
        .await
        .map_err(|error| failed("the agent I/O rows", &error))?;
    state
        .tables
        .pull_request
        .delete_by_project(id.clone())
        .await
        .map_err(|error| failed("the pull request rows", &error))?;
    for key in [
        session_key(&id),
        io_persist_key(&id),
        partial_reply_key(&id),
        // The notes kept across compactions. Ids are not recycled, so this is
        // only an orphan — but it is an orphan that would be fed to an agent as
        // standing instructions if one ever were.
        crate::notes::notes_key(&id),
    ] {
        if let Err(error) = state.tables.kv_put(&key, String::new()).await {
            crate::log!(
                crate::log::Level::Warn,
                "projects",
                "could not clear {key} for deleted {id}: {error}"
            );
        }
    }

    // The display metadata follows the run it described.
    if let Ok(mut running) = state.running.lock() {
        running.remove(&id);
    }

    crate::log!(crate::log::Level::Info, "projects", "deleted {id}");
    let _ = app.emit("project:deleted", serde_json::json!({ "id": id }));
    Ok(())
}

/// Whether this project samples its knowledge as the context fills.
#[tauri::command]
pub fn get_checkpoints(project_id: String, state: State<'_, AppState>) -> bool {
    state
        .tables
        .kv_get(&crate::notes::checkpoints_key(&project_id))
        .is_some_and(|value| value == "true")
}

/// Turn knowledge checkpoints on or off for one project.
///
/// Off by default, and it should stay off for anything but a project being
/// measured: each sample is a whole extra turn against a large conversation, so
/// three of them per fill is a real cost paid for evidence rather than for the
/// agent's benefit — nothing ever reads the samples back to it.
///
/// # Errors
/// Returns the store's error when the flag cannot be written.
#[tauri::command]
pub async fn set_checkpoints(
    project_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .tables
        .kv_put(
            &crate::notes::checkpoints_key(&project_id),
            enabled.to_string(),
        )
        .await
        .map_err(|error| error.to_string())?;
    crate::log!(
        crate::log::Level::Info,
        "projects",
        "{project_id}: knowledge checkpoints {}",
        if enabled { "on" } else { "off" }
    );
    Ok(enabled)
}

/// What this project's agent has been told to remember across compactions.
///
/// Empty until a compaction has taken some, which is the honest default: a
/// conversation that has never been summarised has lost nothing yet.
#[tauri::command]
pub fn get_project_notes(project_id: String, state: State<'_, AppState>) -> String {
    state
        .tables
        .kv_get(&crate::notes::notes_key(&project_id))
        .unwrap_or_default()
}

/// Correct, extend or delete what the agent kept.
///
/// # Why this is not read-only
///
/// These notes are standing instructions: they ride every turn and the model
/// treats them as true. An agent that wrote down a wrong rule — misread a
/// correction, generalised from one incident — would otherwise carry it for the
/// life of the project, and the user's only clue would be behaviour they cannot
/// account for. Invisible durable memory is a liability; editable memory is a
/// feature. This is the edit.
///
/// Clamped on the way in for the same reason it is clamped on the way out:
/// [`crate::notes::BUDGET`] is what keeps the notes from becoming the context
/// problem they exist to solve, and a hand-pasted essay would defeat it just as
/// well as a verbose agent.
///
/// # Errors
/// Returns the store's error when the row cannot be written.
#[tauri::command]
pub async fn set_project_notes(
    project_id: String,
    notes: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let kept = crate::notes::clamp(&notes);
    state
        .tables
        .kv_put(&crate::notes::notes_key(&project_id), kept.clone())
        .await
        .map_err(|error| {
            crate::log!(
                crate::log::Level::Error,
                "projects",
                "{project_id}: could not write the notes: {error}"
            );
            error.to_string()
        })?;
    crate::log!(
        crate::log::Level::Info,
        "projects",
        "{project_id}: notes set by hand, {} characters",
        kept.len()
    );
    // The clamped text, so the editor shows what was actually stored rather
    // than what was typed.
    Ok(kept)
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
        format!(
            "created the project, named {:?} from the prompt",
            project.name
        ),
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

    /*
     * One run per project, enforced here rather than in the composer. A second
     * concurrent run would resume the same session and share one approval
     * route, so it corrupts rather than parallelizes. The slot is claimed
     * before the message row is written: a refused send leaves no user message
     * dangling with no reply, and the frontend keeps the draft to retry.
     *
     * A message during a live run is not a second run: it is delivered *into*
     * the turn over the agent's open stdin, and the model takes it at its next
     * step boundary. The interruption the owner asked for.
     */
    let (reservation, cancel, inject_rx) = {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "the run registry is unavailable".to_string())?;
        if let Some(running) = active.get(&input.project_id) {
            /*
             * A command turn takes no passengers. Refused *before* the row is
             * written, unlike the injection below: the words were not said to
             * anyone, so leaving a user message in the transcript with nothing
             * answering it would be the lie. The frontend queues them and sends
             * them for real once the command lands.
             */
            let Some(inject) = running.inject.clone() else {
                drop(active);
                return Err(BUSY_WITH_COMMAND.into());
            };
            drop(active);

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
                format!(
                    "you sent a message into the running turn ({} chars)",
                    input.body.len()
                ),
            );
            // The 0.3.6 rendering rule: append immediately, never wait for an
            // echo — the crate deliberately requests none.
            let _ = app.emit("message:appended", &user_message);

            if inject.send(input.body.clone()).is_err() {
                // The run tore down in the race window. The row stands (the
                // words were said); the refusal tells the frontend to queue
                // the body for a fresh turn so the agent actually hears it.
                return Err(BUSY_WITH_RUN.into());
            }
            return Ok(user_message);
        }
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (inject_tx, inject_rx) = tokio::sync::mpsc::unbounded_channel();
        active.insert(
            input.project_id.clone(),
            ActiveRun {
                cancel: cancel_tx,
                inject: Some(inject_tx),
            },
        );
        (
            RunReservation {
                active: state.active.clone(),
                project_id: input.project_id.clone(),
            },
            cancel_rx,
            inject_rx,
        )
    };

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
    // The run exists from this moment: the slot is claimed and the spawn below
    // cannot be refused. This is what starts the transcript's status line —
    // event-driven rather than assumed by the sender, so a backend that fakes
    // no run (the mock) shows no run.
    let _ = app.emit(
        "run:accepted",
        serde_json::json!({ "projectId": input.project_id }),
    );

    // The working directories: the project's own if it has any, else the
    // workspace root. An agent with no cwd inherits the app's, which for a
    // bundled .app is `/`.
    //
    // The task manager is the special case: it has no project row to carry
    // directories, and the scope matters more than it looks — `read_only`
    // maps to Claude's don't-ask mode, which denies reads *outside* the
    // working tree without prompting. Its directories live in Settings.
    //
    // The first directory becomes the cwd; every further one rides along as
    // `--add-dir`, so a project spanning two repos is in scope for both
    // instead of generating an approval question per out-of-tree read.
    let mut dirs = if input.project_id == crate::tasks::TASK_MANAGER_ID {
        state
            .tables
            .kv_get(crate::settings::KEY)
            .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
            .unwrap_or_default()
            .task_manager
            .dirs
    } else {
        state
            .tables
            .project
            .select(input.project_id.clone())
            .and_then(|row| serde_json::from_str::<Vec<String>>(&row.dirs).ok())
            .unwrap_or_default()
    };
    dirs.retain(|dir| !dir.trim().is_empty());
    let cwd = if dirs.is_empty() {
        crate::workspace_root_path(&app, &state)
    } else {
        dirs.remove(0)
    };
    let extra_dirs = dirs;

    // The agent's own session id for this project, when a turn has produced
    // one. Without it every turn starts a fresh conversation.
    let resume = state.tables.kv_get(&session_key(&input.project_id));

    /*
     * Where this project's knowledge checkpoints go, or `None` for the projects
     * that do not take them — which is all of them until someone asks.
     *
     * Resolved here rather than inside the run so the switch is read once, at
     * the moment of sending, and so the destination follows a moved data
     * directory rather than the platform default. `None` is the whole feature
     * turned off, in one value: an off project cannot accidentally sample.
     */
    let checkpoint_dir = state
        .tables
        .kv_get(&crate::notes::checkpoints_key(&input.project_id))
        .is_some_and(|value| value == "true")
        .then(|| state.location.path.join("checkpoints"));

    /*
     * Where this project's durable memory lives, keyed by project id.
     *
     * Not by session: AgencyZero rewrites the stored session id whenever the agent
     * hands back a new one, so memory keyed to it would be orphaned by the first
     * fresh conversation. Not by working directory either, which is how the CLI
     * keys its own memory folder: two projects sharing a checkout would share
     * memory, and the same project opened from a different path would lose it.
     * The project id is the only key that survives a re-clone, a moved checkout
     * and a new session.
     */
    let memory_dir = state.location.path.join("memory").join(&input.project_id);

    let tables = state.tables.clone();
    let running = state.running.clone();
    let io = state.io.clone();
    let approvals = state.approvals.clone();
    let project_id = input.project_id.clone();
    let effort = input.effort.clone();

    tauri::async_runtime::spawn(async move {
        drive_run(
            app,
            tables,
            running,
            io,
            approvals,
            reservation,
            cancel,
            inject_rx,
            project_id,
            input.body,
            model,
            permission,
            effort,
            cwd,
            extra_dirs,
            resume,
            checkpoint_dir,
            memory_dir,
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
    // Held for the whole run and dropped on any exit path, so the project's
    // run slot frees exactly when no agent can still be alive.
    _reservation: RunReservation,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    // Messages typed while this run is live, to deliver into the open turn.
    mut inject_rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    project_id: String,
    prompt: String,
    model: String,
    permission: String,
    effort: Option<String>,
    cwd: String,
    extra_dirs: Vec<String>,
    resume: Option<String>,
    // Where to write knowledge checkpoints, or `None` when this project does
    // not take them. See `checkpoint_if_due`.
    checkpoint_dir: Option<std::path::PathBuf>,
    // This project's durable memory, keyed by project id rather than by session
    // or working directory. Told to the agent every turn; see below.
    memory_dir: std::path::PathBuf,
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
    /*
     * Every directory after the first widens the working tree via Claude's
     * `--add-dir`. Passed through `unchecked_args` — the crate has no unified
     * spelling for this yet — which is safe here because the values are the
     * user's own configured directories, not model output.
     */
    for dir in &extra_dirs {
        request = request.unchecked_args(["--add-dir", dir]);
    }
    // `ask`: every gated call — a write, a command, a read outside the working
    // tree — arrives as an approval question instead of a silent pre-decision.
    let asks = permission == "ask";
    if asks {
        request = request.approvals();
    }
    // Always, not only under `ask` (approvals implies it anyway): the open
    // stdin is what lets a message typed mid-turn reach the model at its next
    // step boundary instead of waiting out the whole turn.
    request = request.interactive();
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

    /*
     * What the last compaction taught, carried on every turn since.
     *
     * This is the half of the compaction the crate cannot do for us. A summary
     * loses the operating rules, and re-teaching them in a message would only
     * put them back inside the conversation for the next compaction to lose
     * again. The system prompt is the one channel a compaction cannot touch, so
     * the notes ride here — re-sent every turn, read from cache, and immune.
     *
     * Empty until a compaction has happened, which is the honest default: a
     * conversation that has never been summarised has lost nothing yet.
     */
    let notes = tables
        .kv_get(&crate::notes::notes_key(&project_id))
        .unwrap_or_default();
    let mut system = String::new();

    /*
     * The repository's own rules file, first and whole.
     *
     * `AGENTS.md` is loaded as project context, which sits *below* the agent's own
     * system prompt. A rule there that contradicts a built-in default loses
     * silently: the no-attribution rule was in this repository's `AGENTS.md` for
     * the whole evening an agent put the forbidden trailer on five commits.
     * Re-reading the file would not have helped, because the file was never
     * missing. Copying the rules up to this layer is the only thing that changes
     * which rule wins.
     *
     * A whole file rather than a section of one, so there is no parse to get
     * wrong and no heading whose rename would switch this off in silence.
     */
    if let Some(rules) =
        std::fs::read_to_string(std::path::Path::new(&cwd).join(crate::notes::RULES_FILE))
            .ok()
            .filter(|text| !text.trim().is_empty())
    {
        system.push_str(
            "The repository you are working in states these rules, and they take \
             precedence over your own defaults wherever the two disagree:\n\n",
        );
        system.push_str(rules.trim());
    }

    if !notes.trim().is_empty() {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(
            "What you learned earlier in this project, kept across a compaction \
             that would otherwise have lost it. Treat it as standing \
             instruction:\n\n",
        );
        system.push_str(&notes);
    }
    /*
     * Where the checkpoints are, told to the agent rather than only logged.
     *
     * The transcript is this app's record, not the agent's conversation — none
     * of it is sent — so a note saying "written to /…/600k-….md" tells the user
     * and leaves the agent unable to answer "show me my checkpoints". One line
     * in the system prompt is what makes that question answerable, and it costs
     * a cache read.
     */
    if let Some(dir) = checkpoint_dir.as_deref() {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(&format!(
            "Knowledge checkpoints for this project are written to {}. Each is a \
             markdown file named for the context size it was taken at, with the \
             pressure it was taken under in its front matter. Read them from \
             there if you are asked about them.",
            dir.join(&project_id).display()
        ));
    }

    /*
     * The memory location, told rather than guessed at.
     *
     * An agent's own memory folder is keyed by the directory it was started in,
     * which is the wrong key here: two projects sharing a checkout would share a
     * memory, and the same project opened from a moved checkout would lose it.
     * AgencyZero knows which project this is, so it says so, and the memory
     * follows the project instead of the path.
     */
    if let Err(error) = std::fs::create_dir_all(&memory_dir) {
        crate::log!(
            crate::log::Level::Warn,
            "run",
            "{project_id}: could not create the memory directory: {error}"
        );
    }
    if !system.is_empty() {
        system.push_str("\n\n");
    }
    system.push_str(&format!(
        "This project's durable memory is {}. It belongs to this project and follows \
         it across sessions, compactions and re-clones. Keep operating knowledge \
         there rather than in a memory keyed to the working directory.",
        memory_dir.display()
    ));

    if !system.is_empty() {
        request = request.system(system);
    }

    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: starting claude model={} permission={permission} cwd={cwd} resume={}",
        if model.is_empty() {
            "<default>"
        } else {
            &model
        },
        resume.as_deref().unwrap_or("<new conversation>")
    );

    note_io(
        &app,
        &io,
        &project_id,
        "sent",
        "request",
        format!(
            "claude model={} permission={permission} effort={} cwd={cwd}{}\n\n{prompt_echo}",
            if model.is_empty() {
                "<default>"
            } else {
                &model
            },
            effort_echo.as_deref().unwrap_or("<none>"),
            if extra_dirs.is_empty() {
                String::new()
            } else {
                format!(" add-dir={}", extra_dirs.join(","))
            },
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

    /*
     * Paragraph breaks between text blocks, keyed on structure rather than
     * timing. "I'll check whether that exists." → tool call → "Yes — it's
     * there." streams as two blocks, and appending the second delta straight
     * after the first glued the sentences together on screen. Any non-text
     * event between deltas marks a block boundary; a pause detector would
     * fire on network hiccups mid-sentence and miss fast tool calls.
     */
    let mut last_was_text = false;
    let mut streamed_any = false;
    /*
     * Everything the model said, exactly as it streamed. The crate's
     * `Outcome::text` is Claude's terminal `result` field — the *final* text
     * block only — so persisting it clobbered the narration between tool
     * calls ("I'll check whether that exists.") the moment the run finished.
     * The transcript keeps what the user watched; the terminal text is the
     * fallback for a run that never streamed.
     */
    let mut streamed_text = String::new();
    /*
     * How much of `streamed_text` has been scanned for checkbox lines.
     *
     * Items used to be written only from the finished reply, which made it
     * impossible to open one and then work on it in the same turn: the row did
     * not exist until the turn that proposed it had already ended. So a session
     * asked to follow the procedure could not follow it, and the list only ever
     * described work that was already over.
     */
    let mut items_scanned_to = 0usize;

    /*
     * The checkpoint clock. The reply is flushed to `kv` on the first delta
     * after each interval, so killing the process mid-run loses at most a
     * breath of prose instead of the whole turn. Each flush emits
     * `run:persisted`, which is what the window's saved/unsaved dot reads.
     */
    let mut partial_flushed_at = std::time::Instant::now();

    /*
     * The live token counter's ledger. Each `Event::Usage` carries one API
     * request's figures; `accumulate` sums the tokens, cache included, and
     * keeps the context latest, exactly as the terminal total will. For the
     * eye only — `Outcome::usage` remains the record.
     */
    let mut turn_usage = agent_abstraction::Usage::default();

    // Set by the cancel signal, wherever the loop happens to be waiting when
    // it lands. The loop exits, and the tail below tears the agent down.
    let mut cancelled = false;

    /// What woke the loop: an agent event, or a message to deliver into the
    /// turn. Two variants rather than handling inject inside the select arm,
    /// because `recv` borrows the run mutably for the whole select and
    /// `run.send` cannot be called until that future is dropped.
    enum Wake {
        Event(Event),
        Inject(String),
    }

    loop {
        let wake = tokio::select! {
            event = run.recv() => match event {
                Some(event) => Wake::Event(event),
                None => break,
            },
            /*
             * `Ok` is the signal; `Err` means the sender vanished from the
             * registry, which only teardown paths do — both read as "stop".
             */
            _ = cancel.changed() => {
                cancelled = true;
                break;
            }
            injected = inject_rx.recv() => match injected {
                Some(body) => Wake::Inject(body),
                // The sender lives in the registry this run owns a slot in;
                // it closing early is a teardown already in progress.
                None => continue,
            },
        };
        let event = match wake {
            Wake::Event(event) => event,
            Wake::Inject(body) => {
                // A correction typed mid-turn. The user row was persisted and
                // broadcast by `send_message`; delivery and its failure modes
                // live in the helper, shared with the approval-wait arm.
                deliver_injection(&app, &io, &run, &project_id, body).await;
                // A user message is a block boundary: the next streamed text
                // starts a new paragraph rather than gluing to the old one.
                last_was_text = false;
                continue;
            }
        };
        let is_text = matches!(&event, Event::Text(_));
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

                /*
                 * The remembered answer, before the question ever reaches a
                 * human. "Always allow similar" stored this signature; the
                 * agent may keep asking, but the click marathon is answered
                 * here — audited in the I/O panel, never silently.
                 */
                let signature = approval_signature(&approval.tool, &approval.input);
                if load_rules(&tables, &project_id)
                    .iter()
                    .any(|rule| rule == &signature)
                {
                    crate::log!(
                        crate::log::Level::Info,
                        "run",
                        "{project_id}: auto-allowed by remembered rule [{signature}]"
                    );
                    if let Err(error) = run.respond(&approval.id, &Decision::Allow).await {
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
                            "{} — allowed by remembered rule [{signature}]",
                            approval.tool
                        ),
                    );
                    last_was_text = is_text;
                    continue;
                }

                let _ = app.emit(
                    "run:approval",
                    serde_json::json!({
                        "projectId": project_id,
                        "approvalId": approval.id,
                        "tool": approval.tool,
                        "input": approval.input,
                    }),
                );

                // One sender per question, registered when the question is
                // asked and consumed by exactly one answer. See
                // [`PendingApprovals`] for why this is not a shared queue.
                let (answer_tx, answer_rx) = tokio::sync::oneshot::channel::<bool>();
                if let Ok(mut waiting) = approvals.lock() {
                    waiting.insert(
                        (project_id.clone(), approval.id.clone()),
                        PendingAsk {
                            sender: answer_tx,
                            signature,
                        },
                    );
                }

                /*
                 * The agent is blocked until this is answered, so blocking the
                 * loop here loses nothing — no further events arrive while the
                 * question stands. The timeout turns an abandoned question
                 * into a denial rather than a run that hangs until the agent's
                 * own timeout, and a denial is not a failed run: the model is
                 * told no and carries on.
                 */
                /*
                 * A loop, not a single select: a message typed while the
                 * question stands must be delivered *now* — "the moment the
                 * user hits enter" is the 0.3.6 contract, and an approval
                 * dialog on screen is exactly when someone types "deny that
                 * and do X instead". `run.send` takes `&self`, so delivering
                 * here needs no truce with the event loop; the deadline is
                 * absolute so servicing a message cannot extend the timeout.
                 */
                let deadline = tokio::time::Instant::now() + APPROVAL_TIMEOUT;
                let mut answer_rx = answer_rx;
                let answer = loop {
                    tokio::select! {
                        answer = &mut answer_rx => break answer.ok(),
                        () = tokio::time::sleep_until(deadline) => break None,
                        // Stop can arrive while the question stands; the pending
                        // tool call is denied and the loop tail tears down.
                        _ = cancel.changed() => {
                            cancelled = true;
                            break None;
                        }
                        injected = inject_rx.recv() => {
                            if let Some(body) = injected {
                                deliver_injection(&app, &io, &run, &project_id, body).await;
                            }
                        }
                    }
                };
                // The question is closed however it ended. A timed-out entry
                // left registered would let a late click "answer" a question
                // that is no longer being asked.
                if let Ok(mut waiting) = approvals.lock() {
                    waiting.remove(&(project_id.clone(), approval.id.clone()));
                }
                let allow = answer == Some(true);
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
                let delta = if streamed_any && !last_was_text {
                    format!("\n\n{delta}")
                } else {
                    delta
                };
                streamed_any = true;
                streamed_text.push_str(&delta);
                note_io(&app, &io, &project_id, "received", "text", &delta);
                let _ = app.emit(
                    "run:text",
                    serde_json::json!({ "projectId": project_id, "delta": delta }),
                );
                /*
                 * Checkbox lines take effect as they are written.
                 *
                 * Only whole lines: the scan stops at the last newline seen, so
                 * a title still being streamed is never read as a shorter one.
                 * Without that, "Fix the copy bug" would land as "Fix the" and
                 * the real title would arrive later as a second row.
                 *
                 * The end-of-turn pass still runs and is the backstop for a
                 * final line with no newline after it. It cannot double-apply:
                 * a row already at the status the line asks for is skipped.
                 */
                if !is_task_manager {
                    while let Some(at) = streamed_text[items_scanned_to..].find('\n') {
                        let end = items_scanned_to + at + 1;
                        let line = streamed_text[items_scanned_to..end].to_string();
                        items_scanned_to = end;
                        if !items_from_reply(&line).is_empty() {
                            write_items_from_reply(&app, &tables, &project_id, &line).await;
                        }
                    }
                }

                if partial_flushed_at.elapsed() >= PARTIAL_FLUSH_EVERY {
                    partial_flushed_at = std::time::Instant::now();
                    match tables
                        .kv_put(&partial_reply_key(&project_id), streamed_text.clone())
                        .await
                    {
                        Ok(()) => {
                            // The saved/unsaved dot: how much of what streamed
                            // is already safe in the store.
                            let _ = app.emit(
                                "run:persisted",
                                serde_json::json!({
                                    "projectId": project_id,
                                    "chars": streamed_text.len(),
                                }),
                            );
                        }
                        Err(error) => crate::log!(
                            crate::log::Level::Warn,
                            "run",
                            "{project_id}: could not checkpoint the reply: {error}"
                        ),
                    }
                }
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
            /*
             * What this install's agent can actually do, from its own init
             * record rather than a list compiled in here. Plugins, skills and
             * user commands make the set per-machine, so a hardcoded one would
             * describe the developer's laptop.
             *
             * Relayed and not stored: it arrives with every run, and a
             * catalogue held across restarts would go stale the moment someone
             * installed a skill. The composer falls back to what it knows on
             * its own until the first run of a session reports one.
             */
            Event::Commands(commands) => {
                let _ = app.emit(
                    "run:commands",
                    serde_json::json!({
                        "projectId": project_id,
                        "all": commands.all,
                        "skills": commands.skills,
                    }),
                );
            }
            Event::Compaction(phase) => {
                // The compaction a `/compact` run drives reports through
                // `compact_project`, which owns that run. This arm exists for
                // the other way a compaction happens: the CLI compacts on its
                // own when the window fills, mid-turn, and the conversation is
                // rewritten underneath an answer being written.
                let (done, ok, why) = match &phase {
                    agent_abstraction::Compaction::Finished { ok, error } => {
                        (true, *ok, error.clone())
                    }
                    _ => (false, false, None),
                };
                let _ = app.emit(
                    "run:compaction",
                    serde_json::json!({
                        "projectId": project_id,
                        // Whose turn this is happening inside. The window holds
                        // the composer for a compaction it asked for; this one
                        // is weather during someone else's run, and clearing
                        // that run's status line would be a lie about it.
                        "driver": "agent",
                        "phase": if done { "finished" } else { "started" },
                        "ok": ok,
                        "error": why,
                    }),
                );
            }
            Event::Usage(usage) => {
                /*
                 * One API request's figures, folded into the turn's running
                 * total. `accumulate` sums the cache fields as of 0.4, so the
                 * running usage is the turn's own consumption and the live
                 * figure is just the same `processed_tokens` the finished turn
                 * gets. One definition, one accumulator, nothing to drift.
                 *
                 * `output_tokens` is absent from `Event::Usage` by design and
                 * is not guessed at. It arrives with the `Outcome`, where the
                 * ledger adds it, so this figure steps up to the final one
                 * rather than jumping past it. Cache dominates it by orders of
                 * magnitude, so the live number is close throughout.
                 *
                 * No note_io -- a tool-heavy turn would bury the panel in
                 * bookkeeping.
                 */
                turn_usage.accumulate(&usage);
                let _ = app.emit(
                    "run:usage",
                    serde_json::json!({
                        "projectId": project_id,
                        "tokens": processed_tokens(&turn_usage),
                        /*
                         * How full the window is *now*, which is the one figure
                         * here that is exact mid-turn — the crate says so, and
                         * `Event::Usage` exists to carry it.
                         *
                         * The header used to learn this only from a finished
                         * turn's stored row, so it froze for the whole length of
                         * a run and moved in one jump at the end. During a long
                         * turn, and in the minutes after a compaction, that is
                         * exactly when someone is watching it: a conversation
                         * just cut from 942k to 31k looks like it is not
                         * recovering when the number simply is not being
                         * redrawn. Latest wins, so `accumulate`'s per-field
                         * rules give the current standing rather than a sum.
                         */
                        "contextTokens": turn_usage.context_tokens,
                        "contextWindow": turn_usage.context_window,
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
                if let Err(error) = tables
                    .kv_put(&session_key(&project_id), session.clone())
                    .await
                {
                    crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not record the session id: {error}"
                    );
                } else if let Some(row) = tables.project.select(project_id.clone()) {
                    let _ = app.emit(
                        "project:updated",
                        with_session(ProjectDto::from(row), &tables),
                    );
                }
            }
            _ => {}
        }
        last_was_text = is_text;
        // The approval arm can learn about a stop mid-question; honour it
        // here rather than waiting for the next event that may never come.
        if cancelled {
            break;
        }
    }

    // Whatever the outcome, nothing in this project is running any more. A tool
    // call whose result never arrived would otherwise spin forever, and the
    // frontend's `run:stopped` handler clears its own copy on the same event.
    if let Ok(mut running) = running.lock() {
        running.remove(&project_id);
    }
    // And nothing is waiting on a decision: a `resolve_approval` arriving now
    // should say "not waiting" rather than feed a dead channel.
    if let Ok(mut waiting) = approvals.lock() {
        waiting.retain(|(project, _), _| project != &project_id);
    }

    // One write, now that there is something final to write.
    let result = if cancelled {
        note_io(
            &app,
            &io,
            &project_id,
            "sent",
            "cancel",
            "stop requested — tearing the agent down and waiting for it to exit",
        );
        // Cooperative and awaited: when this returns, the process group is
        // actually gone, not merely asked to leave.
        run.cancel().await
    } else {
        run.finish().await
    };

    /*
     * The tombstone check. `delete_project` cancels the run and waits for
     * this function to exit, so normally the rows are still here — but that
     * wait is bounded, and a hung agent can outlive it. Checked after
     * teardown: any delete that got this far has already removed the row,
     * and a run whose project is gone must not write its reply, cost or
     * harvest back into existence under a dead id.
     */
    let project_gone = !is_task_manager && tables.project.select(project_id.clone()).is_none();
    if project_gone {
        crate::log!(
            crate::log::Level::Warn,
            "run",
            "{project_id}: the project was deleted mid-run; discarding the outcome"
        );
        // Including its checkpoint: recovery must not resurrect a deleted
        // project's half-written reply at the next boot.
        clear_partial_reply(&tables, &project_id).await;
        let _ = app.emit(
            "run:stopped",
            serde_json::json!({
                "projectId": project_id,
                "stop": "canceled",
                "exitCode": null,
            }),
        );
        return;
    }

    match result {
        Ok(outcome) => {
            /*
             * The body is what the user watched stream, block breaks and all.
             * `outcome.text` is Claude's terminal `result` field — the final
             * block only — and persisting it was how the narration between
             * tool calls vanished the moment a run finished. The terminal
             * text remains the fallback for a run that never streamed.
             */
            let body = if streamed_text.trim().is_empty() {
                outcome.text.clone()
            } else {
                streamed_text
            };
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
                body: body.clone(),
                created_at: now(),
            };
            crate::log!(
                crate::log::Level::Info,
                "run",
                "{project_id}: finished stop={stop} exit={} chars={}",
                outcome.exit_code,
                body.len()
            );
            note_io(&app, &io, &project_id, "received", "stop", {
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
            });
            // Only when there is something to say. An empty stderr line every
            // run would push the interesting ones off the panel.
            if !outcome.stderr.trim().is_empty() {
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "stderr",
                    &outcome.stderr,
                );
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
            /*
             * The reply row is the canonical record; everything below derives
             * from it. If it cannot be written, emitting `message:appended`
             * would show a reply that vanishes on restart, the ledger would
             * price a turn the transcript cannot account for, and the harvest
             * would mutate tasks from a reply that no longer exists to audit.
             * So a failed insert ends the run visibly, with nothing derived.
             */
            if let Err(error) = tables.message.insert(row.clone()) {
                crate::log!(
                    crate::log::Level::Error,
                    "run",
                    "{project_id}: could not persist the reply: {error}"
                );
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "error",
                    format!("the reply could not be persisted: {error}"),
                );
                let _ = app.emit(
                    "run:stopped",
                    serde_json::json!({
                        "projectId": project_id,
                        "stop": format!("the reply could not be persisted: {error}"),
                        "exitCode": null,
                    }),
                );
                return;
            }
            let _ = app.emit("message:appended", MessageDto::from(row));
            // The reply row now owns these words; the checkpoint is done.
            clear_partial_reply(&tables, &project_id).await;

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
                // Parsed from the same body the transcript stores, so what the
                // harvester saw and what the user reads can never disagree.
                write_tasks_from_reply(&app, &io, &tables, &project_id, &body).await;
            } else {
                write_items_from_reply(&app, &tables, &project_id, &body).await;
            }
            // Any PR the reply mentions becomes a chip; `gh` fills it in
            // off-path moments later.
            crate::prs::harvest_prs(&app, &tables, &project_id, &body);
            let _ = app.emit(
                "run:stopped",
                serde_json::json!({
                    "projectId": project_id,
                    "stop": stop,
                    "exitCode": outcome.exit_code,
                }),
            );
        }
        // The normal shape of a stop: `cancel()` reports `Cancelled` unless
        // the run happened to finish first (then it is the `Ok` arm above).
        Err(error) if cancelled => {
            crate::log!(
                crate::log::Level::Info,
                "run",
                "{project_id}: run cancelled ({error})"
            );
            /*
             * The partial transcript is what the user watched stream; a
             * cancelled run that said something must not read afterwards as
             * if it never spoke. No usage row and no harvest: an interrupted
             * turn reported no cost and its output is not a finished answer.
             */
            if !streamed_text.trim().is_empty() {
                let row = MessageRow {
                    id: id("msg"),
                    project_id: project_id.clone(),
                    item_id: String::new(),
                    author: "agent".into(),
                    agent: "claude".into(),
                    moderation: String::new(),
                    model: model.clone(),
                    permission,
                    usage: String::new(),
                    stop: "canceled".into(),
                    exit_code: -1,
                    body: streamed_text,
                    created_at: now(),
                };
                match tables.message.insert(row.clone()) {
                    Ok(_) => {
                        let _ = app.emit("message:appended", MessageDto::from(row));
                        clear_partial_reply(&tables, &project_id).await;
                    }
                    // The insert failing is the one case the checkpoint is
                    // for: left in place, the next boot recovers the words.
                    Err(error) => crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not persist the cancelled turn: {error}"
                    ),
                }
            }
            let _ = app.emit(
                "run:stopped",
                serde_json::json!({
                    "projectId": project_id,
                    "stop": "canceled",
                    "exitCode": null,
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

    /*
     * Closed before the checkpoint, and this is load-bearing rather than tidy.
     *
     * The run slot is still held here — the reservation lives until this
     * function returns — so a message sent now is delivered into `inject`. The
     * turn that was reading it has ended, so with the receiver still alive the
     * words would go into a channel nobody drains and be lost without a trace.
     * Dropping it makes the send fail instead, which is the case
     * `run:inject_failed` already exists for: the message is queued and goes out
     * for real once the slot frees.
     *
     * A checkpoint is a whole extra turn, so it widens that window from
     * milliseconds to a minute. The race was survivable by accident before; it
     * would not be now.
     */
    drop(inject_rx);
    checkpoint_if_due(
        &app,
        &tables,
        &project_id,
        &cwd,
        &turn_usage,
        checkpoint_dir.as_deref(),
    )
    .await;
}

/// Take a knowledge sample if this turn pushed the conversation past a mark.
///
/// # What this is for
///
/// Not for the agent's benefit — the samples are never read back to it. It is a
/// measurement, and the question it answers is whether the pre-compaction
/// extraction gets *worse* as the conversation it summarises gets bigger. If it
/// does, the right moment to compact is earlier than the moment the window
/// forces, and nothing but evidence can say where.
///
/// So the samples are taken with exactly the prompt a real compaction would use,
/// against exactly the notes it would be handed. A cheaper or shorter probe
/// would measure the probe.
///
/// # Why it does not touch the live notes
///
/// Writing each sample into the project's notes would feed the 300k sample into
/// the 600k one, and the comparison would be between an extraction and an
/// extraction-of-an-extraction. These are observations; they are written to
/// files and left alone.
///
/// # Why after the turn rather than during it
///
/// A sample is a turn of its own and a session runs one at a time. The crossing
/// is noticed from the finished turn's usage and sampled immediately after,
/// while the run slot is still held so nothing else can start in between.
async fn checkpoint_if_due(
    app: &AppHandle,
    tables: &std::sync::Arc<crate::db::tables::Tables>,
    project_id: &str,
    cwd: &str,
    usage: &agent_abstraction::Usage,
    dir: Option<&std::path::Path>,
) {
    let Some(dir) = dir else { return };
    let Some(context_tokens) = usage.context_tokens else {
        return;
    };
    /*
     * The window comes from the finished turn's row, not from `usage`.
     *
     * `Event::Usage` never carries it — the crate's mid-turn parser sets
     * `context_window: None` outright, and only the terminal `result` record
     * reads it from the model. So every sample recorded `context_used: unknown`,
     * losing the one axis that makes 390k on a million-token window comparable
     * to 390k on a two-hundred-thousand one.
     */
    let context_window = usage.context_window.or_else(|| {
        tables
            .message
            .select_by_project_id(project_id.to_string())
            .execute()
            .ok()?
            .into_iter()
            .filter_map(|row| serde_json::from_str::<UsageDto>(&row.usage).ok())
            .filter_map(|dto| dto.context_window)
            .next_back()
    });
    let mark = tables
        .kv_get(&crate::notes::checkpoint_mark_key(project_id))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let Some(threshold) = crate::notes::due(context_tokens, mark) else {
        return;
    };
    // Nothing to resume means nothing to sample; the crossing cannot have
    // happened without a session.
    let Some(session) = tables
        .kv_get(&session_key(project_id))
        .filter(|id| !id.is_empty())
    else {
        return;
    };

    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: knowledge checkpoint at {threshold} (context {context_tokens})"
    );
    let _ = app.emit(
        "run:checkpoint",
        serde_json::json!({
            "projectId": project_id,
            "phase": "started",
            "threshold": threshold,
        }),
    );

    let existing = tables
        .kv_get(&crate::notes::notes_key(project_id))
        .unwrap_or_default();
    let request = agent_abstraction::Request::new(
        agent_abstraction::Agent::Claude,
        crate::notes::merge_prompt(&existing),
    )
    .cwd(cwd)
    .resume(&session);

    let taken = match agent_abstraction::run(&request).await {
        Ok(outcome) => crate::notes::clamp(&outcome.text),
        Err(error) => {
            crate::log!(
                crate::log::Level::Warn,
                "run",
                "{project_id}: the {threshold} checkpoint failed: {error}"
            );
            String::new()
        }
    };

    /*
     * The mark advances even when the sample failed or came back empty.
     *
     * A conversation only passes 600k once, and retrying on the next turn would
     * sample a bigger conversation while filing it under the smaller threshold —
     * which is worse than a missing sample, because a missing one is visibly
     * missing and a mislabelled one is not.
     */
    if let Err(error) = tables
        .kv_put(
            &crate::notes::checkpoint_mark_key(project_id),
            threshold.to_string(),
        )
        .await
    {
        crate::log!(
            crate::log::Level::Error,
            "run",
            "{project_id}: could not record the checkpoint mark: {error}"
        );
    }

    let mut written = None;
    if !taken.is_empty() {
        let stamp = now();
        let path = dir
            .join(project_id)
            .join(crate::notes::sample_name(threshold, &stamp));
        let document = crate::notes::sample_document(
            threshold,
            context_tokens,
            context_window,
            &stamp,
            &session,
            &taken,
        );
        match std::fs::create_dir_all(path.parent().unwrap_or(dir))
            .and_then(|()| std::fs::write(&path, document))
        {
            Ok(()) => {
                crate::log!(
                    crate::log::Level::Info,
                    "run",
                    "{project_id}: checkpoint written to {}",
                    path.display()
                );
                written = Some(path.display().to_string());

                /*
                 * Said in the transcript, with the path, because these files
                 * exist to be read by a person and a sample nobody can find is
                 * not evidence. The log has it too, but the log is not where
                 * anyone is looking while the work is happening.
                 */
                let row = MessageRow {
                    id: id("msg"),
                    project_id: project_id.to_string(),
                    item_id: String::new(),
                    author: "system".into(),
                    agent: "claude".into(),
                    moderation: String::new(),
                    model: String::new(),
                    permission: String::new(),
                    usage: String::new(),
                    stop: "completed".into(),
                    exit_code: 0,
                    body: format!(
                        "Knowledge checkpoint at {}k tokens ({} rule(s)) — {}",
                        threshold / 1_000,
                        taken.lines().filter(|line| !line.trim().is_empty()).count(),
                        path.display()
                    ),
                    created_at: now(),
                };
                match tables.message.insert(row.clone()) {
                    Ok(_) => {
                        let _ = app.emit("message:appended", &MessageDto::from(row));
                    }
                    Err(error) => crate::log!(
                        crate::log::Level::Warn,
                        "run",
                        "{project_id}: could not note the checkpoint: {error}"
                    ),
                }
            }
            Err(error) => crate::log!(
                crate::log::Level::Error,
                "run",
                "{project_id}: could not write the checkpoint: {error}"
            ),
        }
    }

    let _ = app.emit(
        "run:checkpoint",
        serde_json::json!({
            "projectId": project_id,
            "phase": "finished",
            "threshold": threshold,
            "path": written,
            "chars": taken.len(),
        }),
    );
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

    /// The rule granularity: allowing `cargo test` must say nothing about
    /// `cargo publish`, and a flag or a path must not become part of the rule
    /// or every rule would match exactly one command ever.
    #[test]
    fn bash_signatures_are_program_plus_subcommand() {
        let sig =
            |command: &str| approval_signature("Bash", &serde_json::json!({ "command": command }));
        assert_eq!(sig("cargo test -p az-gui"), "Bash: cargo test");
        assert_eq!(sig("git push origin master"), "Bash: git push");
        // A flag is not a subcommand; the rule stops at the program.
        assert_eq!(sig("rm -rf /tmp/x"), "Bash: rm");
        // Nor is a path.
        assert_eq!(sig("ls /etc"), "Bash: ls");
        assert_ne!(sig("cargo test"), sig("cargo publish"));
    }

    /// A file rule covers the directory, not the disk.
    #[test]
    fn file_signatures_are_the_parent_directory() {
        let sig = approval_signature(
            "Edit",
            &serde_json::json!({ "file_path": "/repo/apps/gui/src/main.rs" }),
        );
        assert_eq!(sig, "Edit: /repo/apps/gui/src");
    }

    /// A URL rule covers the host: one docs page allows the site, not the web.
    #[test]
    fn url_signatures_are_the_host() {
        let sig = approval_signature(
            "WebFetch",
            &serde_json::json!({ "url": "https://docs.rs/tokio/latest/tokio/" }),
        );
        assert_eq!(sig, "WebFetch: docs.rs");
    }

    /// A tool with no recognized shape falls back to the tool name alone —
    /// still a rule, just a coarse one, and visibly so in the UI.
    #[test]
    fn unknown_tools_sign_as_themselves() {
        assert_eq!(approval_signature("Fancy", &serde_json::json!({})), "Fancy");
    }

    #[test]
    fn permissions_map_onto_the_crates_own_enum() {
        assert_eq!(parse_permission(Some("bypass")), Permission::Bypass);
        assert_eq!(parse_permission(Some("plan")), Permission::Plan);
        // Anything unrecognized is the safest posture, never the widest.
        assert_eq!(parse_permission(Some("nonsense")), Permission::ReadOnly);
        assert_eq!(parse_permission(None), Permission::ReadOnly);
    }

    /// The arithmetic that read "60 tokens" on a ten-minute run.
    ///
    /// Numbers from the crate's own parser fixture: two calls in one turn,
    /// reporting 4 and 6 uncached input tokens against cache reads of 100000
    /// and 102000. Counting input alone is what produced dozens; counting what
    /// the model processed produces the figure the cost can be read against.
    #[test]
    fn tokens_count_the_cache_the_model_actually_read() {
        let mut first = agent_abstraction::Usage::default();
        first.input_tokens = Some(4);
        first.cache_read_tokens = Some(100_000);
        first.cache_write_tokens = Some(2_000);

        let mut second = agent_abstraction::Usage::default();
        second.input_tokens = Some(6);
        second.cache_read_tokens = Some(102_000);
        second.cache_write_tokens = Some(500);

        // Mid-turn there is no output: `Event::Usage` withholds it, and the
        // absent field counting as zero is what lets one definition serve the
        // live counter and the finished turn alike.
        assert_eq!(processed_tokens(&first), 102_004);
        assert_eq!(processed_tokens(&second), 102_506);

        /*
         * Folded the way the run loop folds them. This is the seam with the
         * crate: before 0.4 `accumulate` kept the cache fields latest-wins, so
         * the same two calls came out as 102506 rather than 204510 and the app
         * carried its own accumulator to avoid it. The assertion belongs here
         * because a crate that went back to latest-wins would be silent
         * otherwise, and this is the number on screen.
         */
        let mut turn = agent_abstraction::Usage::default();
        turn.accumulate(&first);
        turn.accumulate(&second);

        let live = processed_tokens(&turn);
        assert_eq!(live, 204_510);
        assert_eq!(turn.cache_read_tokens, Some(202_000), "cache reads add up");
        assert_eq!(
            turn.output_tokens, None,
            "mid-turn output is withheld, and absence must read as zero"
        );
        assert!(
            live > 60,
            "the bug this replaces reported 60 for a turn like this"
        );

        // The same turn's terminal record, where the output finally arrives and
        // the cache figures are already summed across both calls.
        let mut terminal = agent_abstraction::Usage::default();
        terminal.input_tokens = Some(10);
        terminal.output_tokens = Some(497);
        terminal.cache_read_tokens = Some(202_000);
        terminal.cache_write_tokens = Some(2_500);
        assert_eq!(
            processed_tokens(&terminal),
            live + 497,
            "the live figure is the terminal one less the output still to come"
        );
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

        let encoded = serde_json::to_value(UsageDto::from(&crate_usage)).expect("should serialize");

        assert_eq!(
            encoded["tokens"], 5_660,
            "everything processed: input, output and both cache figures"
        );
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
            tool_label(
                "Bash",
                &serde_json::json!({ "command": "cargo test -p az-gui" })
            ),
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

        let read = items_from_reply(reply);
        let seen: Vec<(&str, &str)> = read
            .iter()
            .map(|item| (item.title.as_str(), item.status.as_str()))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("Port the model into az-core", "new"),
                ("Decide the store", "finished"),
                ("Pick the id scheme", "new"),
            ]
        );
    }

    /*
     * The state that only exists because "done" was not.
     *
     * An agent can say it shipped something; it cannot say the thing works,
     * because it is not the one looking at the screen. A copy bug was reported
     * fixed three times in one evening, and under the old vocabulary its row
     * would have been deleted after the first.
     */
    #[test]
    fn a_row_can_be_started_and_shipped_without_being_finished() {
        let read = items_from_reply(
            "- [/] Fix copy in the prompt area\n- [>] Add a shipped state (#35)\n",
        );

        assert_eq!(read[0].status, "active");
        assert_eq!(read[0].reference, None);
        assert_eq!(read[1].status, "shipped");
        assert_eq!(read[1].reference.as_deref(), Some("35"));
    }

    /*
     * The ladder a row climbs, and the two rungs that were missing.
     *
     * `new` is proposed and untriaged; `planning` is the phase before work,
     * where the shape is still being argued about. A list that could only say
     * proposed or in-progress had nowhere to put either.
     */
    #[test]
    fn a_row_can_be_new_and_then_planned() {
        let read = items_from_reply("- [ ] Decide the memory key\n- [~] Decide the memory key\n");

        assert_eq!(read[0].status, "new");
        assert_eq!(read[1].status, "planning");
    }

    /// The reference is its own field, so the title stays the match key: a row
    /// shipped as `(#35)` still answers to the line that closes it.
    #[test]
    fn a_reference_never_becomes_part_of_the_title() {
        let read = items_from_reply("- [>] Add a shipped state (#35)\n");
        assert_eq!(read[0].title, "Add a shipped state");

        let closing = items_from_reply("- [x] Add a shipped state\n");
        assert_eq!(closing[0].title, read[0].title, "the same row is meant");
    }

    /// Only a trailing group of digits is a reference. A title that mentions
    /// one mid-sentence keeps every character it was written with.
    #[test]
    fn only_a_trailing_number_reads_as_a_reference() {
        assert_eq!(
            split_reference("Fix the (#3) case in the parser"),
            ("Fix the (#3) case in the parser", None)
        );
        assert_eq!(split_reference("Ship it (#12)"), ("Ship it", Some("12")));
        assert_eq!(split_reference("Not a ref (#)"), ("Not a ref (#)", None));
        assert_eq!(
            split_reference("Not a ref (#abc)"),
            ("Not a ref (#abc)", None)
        );
    }

    /// Only the two fields resolution looks at matter here; the rest is what an
    /// empty project is.
    fn project_row(id: &str, name: &str) -> ProjectRow {
        ProjectRow {
            id: id.into(),
            name: name.into(),
            status: "active".into(),
            position: 0,
            dirs: "[]".into(),
            pinned: false,
            moderator_enabled: false,
            forked_from: String::new(),
            last_activity_at: String::new(),
        }
    }

    /// A line can say which project it belongs to, and the title it is matched
    /// by must not carry that routing any more than it carries the reference.
    #[test]
    fn a_line_can_name_another_project() {
        let read = items_from_reply("- [ ] Audit the token counter (@Other project)\n");
        assert_eq!(read[0].title, "Audit the token counter");
        assert_eq!(read[0].project.as_deref(), Some("Other project"));

        // An id is accepted for the same reason: a session that knows where a
        // row belongs may not know what that project is called.
        let by_id = items_from_reply("- [ ] Audit (@proj-846b5542-fe2d-4d60-a296-7c10e1119562)\n");
        assert_eq!(
            by_id[0].project.as_deref(),
            Some("proj-846b5542-fe2d-4d60-a296-7c10e1119562")
        );

        // No suffix is the overwhelmingly common case and still means "here".
        assert_eq!(items_from_reply("- [/] Plain\n")[0].project, None);
    }

    /// Both suffixes, in either order, because nobody writing one of each has
    /// any reason to believe the order matters.
    #[test]
    fn a_line_carries_a_project_and_a_reference_in_either_order() {
        for line in [
            "- [>] Ship the thing (@Other) (#35)\n",
            "- [>] Ship the thing (#35) (@Other)\n",
        ] {
            let read = items_from_reply(line);
            assert_eq!(read[0].title, "Ship the thing", "{line:?}");
            assert_eq!(read[0].reference.as_deref(), Some("35"), "{line:?}");
            assert_eq!(read[0].project.as_deref(), Some("Other"), "{line:?}");
        }
    }

    /// The suffix has to be a suffix. Prose that happens to contain a handle
    /// keeps every character it was written with.
    #[test]
    fn only_a_trailing_group_reads_as_a_project() {
        assert_eq!(
            split_project("Mention (@someone) mid-sentence here"),
            ("Mention (@someone) mid-sentence here", None)
        );
        assert_eq!(split_project("Empty (@)"), ("Empty (@)", None));
        assert_eq!(split_project("Blank (@   )"), ("Blank (@   )", None));
        assert_eq!(split_project("Write it (@ui)"), ("Write it", Some("ui")));
    }

    /// Resolution never guesses. An unknown name returns nothing, and the
    /// caller reports it, rather than a project appearing out of a typo.
    #[test]
    fn a_project_resolves_by_id_or_by_name_and_never_by_guess() {
        let rows = vec![
            project_row("proj-1", "AgencyZero"),
            project_row("proj-2", "ui"),
        ];

        assert_eq!(resolve_project(&rows, "proj-2"), Some("proj-2".into()));
        assert_eq!(resolve_project(&rows, "agencyzero"), Some("proj-1".into()));
        assert_eq!(resolve_project(&rows, "  UI  "), Some("proj-2".into()));
        assert_eq!(resolve_project(&rows, "Agency"), None);
        assert_eq!(resolve_project(&rows, "proj-3"), None);
        assert_eq!(resolve_project(&[], "AgencyZero"), None);
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

    /// The third box: `[-]` marks a row for removal. It parses like the other
    /// two so an agent can retire an obsolete item from a project session —
    /// the write path deletes on match and refuses to create from it.
    #[test]
    fn a_struck_box_parses_as_deleted() {
        assert_eq!(
            items_from_reply("- [-] Verify release 0.1.4 upgrade path")
                .into_iter()
                .map(|item| (item.title, item.status))
                .collect::<Vec<_>>(),
            vec![(
                "Verify release 0.1.4 upgrade path".to_string(),
                "deleted".to_string()
            )]
        );
        // The box needs its title, same as the others.
        assert!(items_from_reply("- [-] ").is_empty());
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

    /*
     * The window queues a refused prompt by reading these refusals, so the
     * words below are load-bearing across the IPC boundary rather than prose.
     * Reword one without rewording `queueReason` in `stores/workspace.tsx` and
     * the prompt stops waiting for the slot and starts being an error message.
     */
    /*
     * Checked against Claude Code 2.1.212 on an empty session: `/compact`
     * replies `Error: No messages to compact` as assistant text, emits no
     * compaction record, and exits `success`. Read by the old rules that was a
     * clean run with no verdict, so the user was told the agent had "ended
     * without reporting a compaction" — true, unhelpful, and standing in front
     * of the actual answer.
     */
    #[test]
    fn an_agent_with_nothing_to_compact_is_quoted_rather_than_paraphrased() {
        let (ok, why) = compaction_verdict(false, None, None, "Error: No messages to compact");
        assert!(!ok);
        assert_eq!(why.as_deref(), Some("Error: No messages to compact"));
    }

    #[test]
    fn a_silent_run_is_not_a_compaction() {
        let (ok, why) = compaction_verdict(false, None, None, "   ");
        assert!(!ok, "silence is not success");
        assert_eq!(
            why.as_deref(),
            Some("the agent ended without reporting a compaction")
        );
    }

    /// A refusal is a *completed* run carrying a reason, so the agent's own
    /// record outranks both the exit and anything it said on the way.
    #[test]
    fn the_agents_own_verdict_outranks_the_exit() {
        let refused = Some((false, Some("conversation too short".to_string())));
        let (ok, why) = compaction_verdict(false, refused, None, "some chatter");
        assert!(!ok);
        assert_eq!(why.as_deref(), Some("conversation too short"));

        // And a success stays a success even though the run also spoke.
        let (ok, why) = compaction_verdict(false, Some((true, None)), None, "some chatter");
        assert!(ok);
        assert_eq!(why, None);
    }

    #[test]
    fn stopping_it_is_reported_as_stopping_it() {
        let (ok, why) = compaction_verdict(
            true,
            Some((true, None)),
            Some("killed".into()),
            "half a sentence",
        );
        assert!(!ok);
        assert_eq!(why.as_deref(), Some("you stopped the compaction"));
    }

    #[test]
    fn queue_markers() {
        assert!(BUSY_WITH_COMMAND.contains("a command is running"));
        assert!(BUSY_WITH_RUN.contains("already active"));
        assert!(BUSY_WITH_RUN_ALREADY.contains("already active"));
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
