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
use crate::db::schema::project::{DirsByIdQuery, NameByIdQuery, PinnedByIdQuery, ProjectRow};
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
    /// Native session ids by provider. Separate keys let a project switch
    /// agents and later resume either conversation without crossing them.
    pub sessions: std::collections::BTreeMap<String, String>,
    pub last_activity_at: String,
}

/// Attach the project's session id, which lives in `kv` rather than on the row.
fn with_session(mut dto: ProjectDto, tables: &crate::db::tables::Tables) -> ProjectDto {
    for agent in [Agent::Claude, Agent::Codex] {
        if let Some(session) = tables
            .kv_get(&agent_session_key(&dto.id, agent))
            .filter(|session| !session.is_empty())
        {
            dto.sessions.insert(agent_wire_name(agent).into(), session);
        }
    }
    // The legacy field is the same Claude key, kept for older frontends.
    dto.session_id = dto.sessions.get("claude").cloned();
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
            sessions: std::collections::BTreeMap::new(),
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
    /// Tokens served from cache during this turn. Additive across turns.
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
    /// An already-rendered user row whose failed live delivery is being
    /// retried in a fresh resumed turn. Reusing it keeps recovery from drawing
    /// the same words twice in the transcript.
    pub retry_message_id: Option<String>,
    pub item_id: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub permission: Option<String>,
    pub effort: Option<String>,
    /// Whether the model may spend reasoning tokens ("Extra Thinking" in the
    /// composer). `Some(false)` disables it, as `Request::thinking(false)`;
    /// `Some(true)` and `None` both leave the agent's default. Only Claude has a
    /// lever; the crate no-ops it for the others.
    pub extra_thinking: Option<bool>,
    /// Content-free facts computed before the composer compiles controls or
    /// appends attachment paths. Absent callers fall back to the sent body.
    pub study: Option<StudyTurnMetadata>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyTurnMetadata {
    pub authored_character_count: usize,
    pub authored_line_count: usize,
    pub attachment_count: usize,
    pub user_authored_ps: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub first_message: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub permission: Option<String>,
    /// Reasoning effort, as `Request::effort`. `None` means the CLI's default.
    pub effort: Option<String>,
    /// See [`SendMessageInput::extra_thinking`].
    pub extra_thinking: Option<bool>,
    pub study: Option<StudyTurnMetadata>,
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

/// Provider-specific session storage. Claude keeps the legacy key so every
/// existing project resumes exactly where it did before this feature.
fn agent_session_key(project_id: &str, agent: Agent) -> String {
    match agent {
        Agent::Claude => session_key(project_id),
        Agent::Codex => format!("session:codex:{project_id}"),
        Agent::Copilot => format!("session:copilot:{project_id}"),
    }
}

fn agent_wire_name(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "claude",
        Agent::Codex => "codex",
        Agent::Copilot => "copilot",
    }
}

/// Whether the next provider text event starts a new visible block.
///
/// Every interactive provider may emit adjacent deltas of one message, so
/// consecutive text events must stay adjacent. A tool, reasoning event, or
/// injected user message establishes a visible block boundary.
fn needs_text_break(streamed_any: bool, last_was_text: bool) -> bool {
    streamed_any && !last_was_text
}

/// Whether this run needs an approval callback as well as its sandbox posture.
///
/// `ask` is explicitly human-gated for every capable provider. Codex `auto`
/// also keeps the callback open so a path outside the declared workspace roots
/// can ask the user for access instead of being silently denied and provoking
/// the model to clone a second copy somewhere writable.
fn should_route_approvals(agent: Agent, permission: &str) -> bool {
    permission == "ask" || (agent == Agent::Codex && permission == "auto")
}

/// The Markdown fence currently making reply content inert.
///
/// Marker and width both matter. A tilde fence cannot close a backtick fence,
/// and a shorter run of backticks inside a longer fence is content, not its
/// end. Treating either as a close would promote an example that is still
/// quoted into a live authoring directive.
#[derive(Debug, Default, PartialEq, Eq)]
struct FenceState(Option<(char, usize)>);

fn fence_marker(line: &str) -> Option<(char, usize, &str)> {
    let marker = line.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let width = line.chars().take_while(|char| *char == marker).count();
    (width >= 3).then(|| {
        let bytes = width * marker.len_utf8();
        (marker, width, &line[bytes..])
    })
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

/// Cut to at most `max_bytes` bytes, never mid-character.
///
/// The page-safety caps count bytes, not characters, because the engine does:
/// a WorkTable page holds 16356 *bytes* and a row must fit one. A char-counted
/// cap of 8000 passes 32K of CJK through untouched, which is the corruption
/// vector wearing a costume. Display caps stay char-counted; anything sized
/// against the page limit goes through here.
fn truncate_to_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes.saturating_sub('…'.len_utf8());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", text[..end].trim_end())
}

/// The most bytes a persisted diagnostic blob may carry.
///
/// WorkTable pages are 16K and a row must fit one: handing the engine a
/// bigger row does not merely fail, it has twice corrupted the table's
/// on-disk state on this machine — `need 18336, but 16356 allowed` in the
/// log, then a store that bus-errors at the next open. Both times the blob
/// was a tool output (`git show` on a large commit, reviewing recent work).
///
/// Bytes, because the engine's limit is bytes: as characters this cap let 32K
/// of CJK through. 8K leaves the rest of the page for the row's other fields
/// with a wide margin. These are diagnostic tails, not records: the full
/// output lived on screen and in the agent's own transcript; what the panel
/// needs is the head of it. The engine-side fix (an oversized insert must be
/// an atomic refusal) belongs upstream and is tracked there.
const MAX_PERSISTED_BLOB: usize = 8_000;

/// The inline head of a message body: the most that fits the row's page.
///
/// A WorkTable row must fit one ~16K page, and a body shares that page with the
/// row's other fields (usage and moderation JSON among them), so 12K is the
/// body's share. A body within that is stored whole. A larger one keeps its
/// first 12K here and spills the rest to `message_chunk` via [`store_overflow`],
/// so the read path can stitch the whole thing back — the tail is no longer
/// truncated, only stored elsewhere.
const MAX_MESSAGE_BODY: usize = 12_000;

/// The largest byte length `<= max` that lands on a char boundary of `text`.
///
/// A clean cut, unlike [`truncate_to_bytes`], which appends an ellipsis and
/// trims — that is right for a diagnostic tail but wrong here, where the head
/// and the chunks must concatenate back to the exact original body. Always
/// makes progress on a non-empty string: the first char alone is `<= max` only
/// if `max` is at least that char's width, but a body over the cap always has a
/// boundary at or below `max`, so this never returns 0 for the inputs it sees.
fn split_boundary(text: &str, max: usize) -> usize {
    let mut end = max.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn body_head(body: &str) -> String {
    if body.len() <= MAX_MESSAGE_BODY {
        return body.to_string();
    }
    body[..split_boundary(body, MAX_MESSAGE_BODY)].to_string()
}

/// Spill a body's overflow to `message_chunk` rows. The head is stored on the
/// message row separately via [`body_head`]; this writes only the tail.
///
/// Call after the message row's id is known; the chunks key off it. A body
/// within the cap writes nothing. Every caller mints a fresh message id, so
/// there are never prior chunks to clear: this is insert-only and synchronous,
/// which keeps the send path off an await it does not need.
fn store_body(tables: &Tables, message_id: &str, project_id: &str, body: &str) {
    if body.len() <= MAX_MESSAGE_BODY {
        return;
    }
    let head = body_head(body);
    let rest = &body[head.len()..];
    for (seq, chunk) in chunk_bytes(rest, MAX_MESSAGE_BODY).into_iter().enumerate() {
        let row = crate::db::schema::message_chunk::MessageChunkRow {
            id: format!("{message_id}#{seq}"),
            message_id: message_id.to_string(),
            project_id: project_id.to_string(),
            seq: u32::try_from(seq).unwrap_or(u32::MAX),
            text: chunk,
        };
        if let Err(error) = tables.message_chunk.insert(row) {
            crate::log!(
                crate::log::Level::Error,
                "message",
                "{message_id}: overflow chunk {seq} failed: {error}"
            );
            break;
        }
    }
}

/// Split `text` into page-safe slices on char boundaries, in order, that
/// concatenate back to `text` exactly.
fn chunk_bytes(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        // A boundary at or below `max`; for a rest whose first char is wider
        // than `max` this would be 0, so take that whole char to guarantee
        // progress. `max` here is 12K, so this branch never fires in practice.
        let cut = split_boundary(rest, max).max(
            rest.char_indices()
                .nth(1)
                .map(|(i, _)| i)
                .unwrap_or(rest.len()),
        );
        out.push(rest[..cut].to_string());
        rest = &rest[cut..];
    }
    out
}

/// The whole body of a message: its inline head followed by its overflow chunks.
///
/// Rows within the cap have no chunks and read as their head alone. This is the
/// inverse of [`store_body`]: the split is invisible above this call.
fn full_body(tables: &Tables, message_id: &str, head: &str) -> String {
    let mut chunks: Vec<crate::db::schema::message_chunk::MessageChunkRow> = tables
        .message_chunk
        .select_by_message_id(message_id.to_string())
        .execute()
        .unwrap_or_default();
    if chunks.is_empty() {
        return head.to_string();
    }
    chunks.sort_by_key(|chunk| chunk.seq);
    let mut body = head.to_string();
    for chunk in chunks {
        body.push_str(&chunk.text);
    }
    body
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

fn parse_agent(raw: Option<&str>) -> Result<Agent, String> {
    match raw.unwrap_or("claude") {
        "claude" => Ok(Agent::Claude),
        "codex" => Ok(Agent::Codex),
        "copilot" => Err("Copilot projects are not available yet".into()),
        other => Err(format!("unknown project agent: {other}")),
    }
}

fn can_inject(running: Agent, requested: Agent) -> bool {
    running == requested && requested.caps().live_follow_up
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
    let started = std::time::Instant::now();
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
    let mut study =
        crate::study::Record::manual(dto.project_id.clone(), "items.add", "item", dto.id.clone());
    study.latency = Some(started.elapsed());
    crate::study::record(&state.tables, study);
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
    let started = std::time::Instant::now();
    /*
     * Every status the ladder can reach, including `questions` and `canceled`.
     *
     * `questions` was missing, and the marker's ladder walks through it, so a
     * click on an `active` row asked for a status this command refused and the
     * row did not move. From the outside that reads as the cycle stopping
     * partway with no way to carry on or to correct a misclick, and nothing
     * said why: the refusal reached the promise and not the panel.
     *
     * The list here and `ITEM_LADDER` in the frontend are the same vocabulary
     * in two places, which is how they drifted. `ProjectStatus` is the source.
     */
    if !matches!(
        status.as_str(),
        "new"
            | "pending"
            | "planning"
            | "active"
            | "questions"
            | "shipped"
            | "finished"
            | "canceled"
    ) {
        crate::log!(
            crate::log::Level::Error,
            "items",
            "refused status {status:?} for {id}: not one this app knows"
        );
        return Err(format!("not an item status: {status}"));
    }
    let delete_completed = status == "finished"
        && state
            .tables
            .kv_get(crate::settings::KEY)
            .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
            .unwrap_or_default()
            .completed_items
            == "delete";
    if delete_completed {
        let mut row = state
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
        let mut study =
            crate::study::Record::manual(row.project_id.clone(), "items.state", "item", id.clone());
        study.latency = Some(started.elapsed());
        crate::study::record(&state.tables, study);
        // Preserve the command's return shape for callers that await it even
        // though the event removes the row from the live store.
        row.status = status;
        return Ok(ProjectItemDto::from(row));
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
    let mut study = crate::study::Record::manual(
        dto.project_id.clone(),
        "items.state",
        "item",
        dto.id.clone(),
    );
    study.latency = Some(started.elapsed());
    crate::study::record(&state.tables, study);
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
    let started = std::time::Instant::now();
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
    let mut study = crate::study::Record::manual(
        dto.project_id.clone(),
        "items.update",
        "item",
        dto.id.clone(),
    );
    study.latency = Some(started.elapsed());
    crate::study::record(&state.tables, study);
    Ok(dto)
}

fn github_issue_url(authored: &str) -> Option<String> {
    const HOST: &str = "https://github.com/";
    let path = authored.trim().strip_prefix(HOST)?.trim_end_matches('/');
    let mut parts = path.split('/');
    let (Some(owner), Some(repo), Some("issues"), Some(number)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if owner.is_empty()
        || repo.is_empty()
        || number.parse::<u32>().is_err()
        || parts.next().is_some()
    {
        return None;
    }
    Some(format!("{HOST}{owner}/{repo}/issues/{number}"))
}

async fn link_item_issue_inner(
    app: &AppHandle,
    tables: &crate::db::tables::Tables,
    id: &str,
    authored_url: &str,
) -> Result<ProjectItemDto, String> {
    let url = github_issue_url(authored_url)
        .ok_or_else(|| "ENTITY_NOT_FOUND: not a GitHub issue URL".to_string())?;
    tables
        .project_item
        .update_reference_by_id(
            ItemReferenceByIdQuery {
                reference: format!("issue:{url}"),
            },
            id.to_string(),
        )
        .await
        .map_err(|error| error.to_string())?;
    let row = tables
        .project_item
        .select(id.to_string())
        .ok_or_else(|| format!("no item {id}"))?;
    let dto = ProjectItemDto::from(row);
    let _ = app.emit("item:updated", dto.clone());
    Ok(dto)
}

/// Associate an item with a validated GitHub issue URL.
///
/// # Errors
/// Returns a validation message, a missing item error, or a store failure.
#[tauri::command]
pub async fn set_item_issue(
    app: AppHandle,
    id: String,
    url: String,
    state: State<'_, AppState>,
) -> Result<ProjectItemDto, String> {
    let started = std::time::Instant::now();
    let dto = link_item_issue_inner(&app, &state.tables, &id, &url).await?;
    let mut study = crate::study::Record::manual(dto.project_id.clone(), "issue.link", "item", id);
    study.latency = Some(started.elapsed());
    crate::study::record(&state.tables, study);
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
    let started = std::time::Instant::now();
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
    let mut study = crate::study::Record::manual(row.project_id, "items.retire", "item", id);
    study.latency = Some(started.elapsed());
    crate::study::record(&state.tables, study);
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
    let started = std::time::Instant::now();
    let moved = ids.len();
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
    let items = list_items(project_id.clone(), state.clone());
    for item in &items {
        let _ = app.emit("item:updated", item.clone());
    }
    let mut study =
        crate::study::Record::manual(project_id.clone(), "items.reorder", "project", project_id);
    study.latency = Some(started.elapsed());
    study.detail = serde_json::json!({ "itemCount": moved });
    crate::study::record(&state.tables, study);
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
        .map(|row| {
            // Stitch any overflow chunks back onto the inline head, so a body
            // that spilled across pages reads as the whole thing again.
            let id = row.id.clone();
            let mut dto = MessageDto::from(row);
            dto.body = full_body(&state.tables, &id, &dto.body);
            dto
        })
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

/// What this project's list looks like right now, for the prompt.
///
/// The agent was being asked to maintain a list it had never been shown. Every
/// reference it made was a guess at a title string, and a guess that missed by
/// one word inserted a duplicate instead of updating the row. Sending the ids
/// is what turns that into pointing at a row.
///
/// Finished rows are left out. They are the bulk of an old list and none of
/// them is a thing the agent can act on, so they are cost without use.
fn state_snapshot(
    tables: &crate::db::tables::Tables,
    project_id: &str,
    focus: Option<&str>,
) -> String {
    let mut items: Vec<ProjectItemRow> = tables
        .project_item
        .select_by_project_id(project_id.to_string())
        .execute()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.status != "finished" && row.status != "canceled")
        .collect();
    items.sort_by_key(|row| row.position);

    let prs: Vec<crate::db::schema::pull_request::PullRequestRow> = crate::prs::canonical_rows(
        tables
            .pull_request
            .select_by_project_id(project_id.to_string())
            .execute()
            .unwrap_or_default(),
    )
    .into_iter()
    .filter(|row| !row.dismissed)
    .collect();

    let mut out = String::new();
    if project_id == crate::tasks::TASK_MANAGER_ID {
        out.push_str("Home Task Manager uses this same authoring surface for every mutation.");
    } else if items.is_empty() {
        out.push_str("This project has no open items.");
    } else {
        out.push_str("Open items in this project. Answer with the id, never the title:\n");
        for row in items.iter().take(40) {
            let reference = if row.reference.is_empty() {
                String::new()
            } else if let Some(url) = row.reference.strip_prefix("issue:") {
                format!(" (issue {url})")
            } else {
                format!(" (#{})", row.reference)
            };
            out.push_str(&format!(
                "  {} · {} · {}{}\n",
                row.id, row.status, row.title, reference
            ));
        }
        if items.len() > 40 {
            out.push_str(&format!(
                "  ... {} more open items omitted\n",
                items.len() - 40
            ));
        }
    }
    if !prs.is_empty() {
        out.push_str("Tracked pull requests. Retire an association by id, never by PR number:\n");
        for pr in prs.iter().take(20) {
            out.push_str(&format!(
                "  {} · {}#{} · {}\n",
                pr.id,
                pr.repo,
                pr.number,
                pr.state.to_lowercase()
            ));
        }
        if prs.len() > 20 {
            out.push_str(&format!(
                "  ... {} more associations omitted\n",
                prs.len() - 20
            ));
        }
    }
    /*
     * The turn's subject, when the prompt came from a row. This is the only
     * case where the app knows what the turn is about, so it is the only case
     * where a missing report is a fact rather than a guess.
     */
    if let Some(item) = focus.filter(|id| !id.is_empty()) {
        out.push_str(&format!(
            "\nThis turn was started from item {item}. Report its state as it changes.\n"
        ));
    }
    /*
     * The declaration, read from the same constant the published capability
     * document is checked against. Written into the prompt rather than
     * described in prose, so the surface the agent is told about and the one
     * the parser enforces cannot drift.
     */
    let declared = format!(
        "\nThis is a declared authoring surface (Prompt Syntax 13.2). Segment: {}. \
         Live verbs, and nothing else: {}. Reserved to the owner: {}. Reach: {}. \
         Published at docs/ps-capability.yaml.\n",
        crate::directives::SURFACE.delimiter,
        crate::directives::SURFACE
            .verbs
            .iter()
            .map(|verb| format!("@{}:{verb}", crate::directives::SURFACE.namespace))
            .collect::<Vec<_>>()
            .join(", "),
        crate::directives::SURFACE.reserved.join(", "),
        crate::directives::SURFACE.bound
    );
    out.push_str(&declared);
    /*
     * The directive templates, next to the live ids they act on. The surface is
     * explained in the per-turn operating instructions (`crate::per_turn`); what
     * belongs here is the shape to copy, beside the actual rows above. Kept even
     * when that injection is toggled off, so a scaffold is always at hand — but
     * not re-explained, which is what duplicated into two layers that drifted.
     */
    out.push_str(
        "\nAuthor these on their own line, as it happens rather than at the end. \
         Statuses you may set: new, planning, active, questions, shipped.\n\
         <ps @agency:items.state(id: \"<id>\", status: \"active\")>\n\
         <ps @agency:items.state(id: \"<id>\", status: \"shipped\", pr: \"https://github.com/owner/repo/pull/66\")>\n\
         <ps @agency:items.add(ref: \"t1\", title: \"<one line>\", status: \"planning\")>\n\
         <ps @agency:items.add(project: \"<project id or exact name>\", ref: \"t2\", title: \"<one line>\")>\n\
         <ps @agency:items.retire(id: \"<id>\")>\n\
         <ps @agency:ask(text: \"<your question>\", urgency: \"blocking\")>\n\
         <ps @agency:pr.link(url: \"https://github.com/owner/repo/pull/66\", item: \"<id>\")>\n\
         <ps @agency:pr.retire(id: \"<pr association id>\")>\n\
         <ps @agency:issue.link(url: \"https://github.com/owner/repo/issues/42\", item: \"<id>\")>",
    );
    out
}

/// Carry out one directive, and say what became of it.
///
/// Every path here ends in an `Outcome`, including the refusals. That is the
/// whole point: a directive that goes nowhere used to go nowhere silently, so
/// the agent could not tell a write that landed from one that was dropped, and
/// neither could the person reading the panel.
async fn apply_directive(
    app: &AppHandle,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    directive: crate::directives::Directive,
) -> crate::directives::Outcome {
    use crate::directives::{Directive, Outcome};

    /*
     * IDs are installation-wide, and the declared surface explicitly reaches
     * any project in this store. Reading the whole id set is what makes the
     * Task Manager able to speak the same state/retire/link verbs as a project
     * tab instead of needing title-based JSONL mutations of its own.
     */
    let rows: Vec<ProjectItemRow> = tables
        .project_item
        .select_all()
        .execute()
        .unwrap_or_default();

    match directive {
        Directive::ItemState { id, status, pr } => {
            if !crate::directives::settable(&status) {
                return Outcome::Refused {
                    what: format!("items.state({id} -> {status})"),
                    // The owner closes an item. Refusing here makes that a
                    // property of the system rather than a rule to remember.
                    code: "STATUS_NOT_YOURS".into(),
                };
            }
            let known: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
            let resolved = match crate::directives::resolve(&known, &id) {
                Ok(found) => found.to_string(),
                Err(code) => {
                    return Outcome::Refused {
                        what: format!("items.state({id})"),
                        code,
                    };
                }
            };
            let target_project = rows
                .iter()
                .find(|row| row.id == resolved)
                .map(|row| row.project_id.as_str())
                .unwrap_or(project_id);
            let pr_number = match pr.as_deref() {
                Some(url) if url.starts_with("https://github.com/") => {
                    match crate::prs::record_url(app, tables, target_project, url) {
                        Ok(number) => Some(number.to_string()),
                        Err(code) => {
                            return Outcome::Refused {
                                what: format!("items.state({resolved}) pull request"),
                                code,
                            };
                        }
                    }
                }
                Some(number) => Some(number.to_string()),
                None => None,
            };
            if let Some(number) = pr_number.as_deref()
                && let Err(error) = tables
                    .project_item
                    .update_reference_by_id(
                        ItemReferenceByIdQuery {
                            reference: number.to_string(),
                        },
                        resolved.clone(),
                    )
                    .await
            {
                return Outcome::Refused {
                    what: format!("items.state({resolved}) reference"),
                    code: format!("WRITE_FAILED: {error}"),
                };
            }
            match tables
                .project_item
                .update_status_by_id(
                    ItemStatusByIdQuery {
                        status: status.clone(),
                    },
                    resolved.clone(),
                )
                .await
            {
                Ok(()) => {
                    if let Some(updated) = tables.project_item.select(resolved.clone()) {
                        let _ = app.emit("item:updated", ProjectItemDto::from(updated));
                    }
                    let said = match pr_number {
                        Some(number) => format!("{resolved} -> {status} (#{number})"),
                        None => format!("{resolved} -> {status}"),
                    };
                    Outcome::Done(said)
                }
                Err(error) => Outcome::Refused {
                    what: format!("items.state({resolved})"),
                    code: format!("WRITE_FAILED: {error}"),
                },
            }
        }
        Directive::ItemAdd {
            handle,
            project,
            title,
            status,
        } => {
            if !crate::directives::settable(&status) {
                return Outcome::Refused {
                    what: format!("items.add({title:?} -> {status})"),
                    code: "STATUS_NOT_YOURS".into(),
                };
            }
            let target_project = match project.as_deref() {
                Some(named) => {
                    let projects: Vec<ProjectRow> =
                        tables.project.select_all().execute().unwrap_or_default();
                    match resolve_project(&projects, named) {
                        Some(found) => found,
                        None => {
                            /*
                             * The explicit `project:` argument is the authority
                             * to create this named row. Prose never reaches this
                             * path, so a missing name cannot silently become a
                             * project unless the agent used the declared
                             * authoring surface to ask for exactly that.
                             */
                            let row = ProjectRow {
                                id: id("proj"),
                                name: truncate_on_char_boundary(named.trim(), 80),
                                status: "active".into(),
                                position: u32::try_from(projects.len()).unwrap_or(0),
                                dirs: "[]".into(),
                                pinned: false,
                                moderator_enabled: false,
                                forked_from: String::new(),
                                last_activity_at: now(),
                            };
                            if let Err(error) = tables.project.insert(row.clone()) {
                                return Outcome::Refused {
                                    what: format!("items.add({title:?}) project"),
                                    code: format!("WRITE_FAILED: {error}"),
                                };
                            }
                            let _ = app.emit(
                                "project:created",
                                with_session(ProjectDto::from(row.clone()), tables),
                            );
                            row.id
                        }
                    }
                }
                None if project_id == crate::tasks::TASK_MANAGER_ID => {
                    return Outcome::Refused {
                        what: format!("items.add({title:?}) project"),
                        code: "ENTITY_NOT_FOUND".into(),
                    };
                }
                None => project_id.to_string(),
            };
            let target_rows: Vec<&ProjectItemRow> = rows
                .iter()
                .filter(|row| row.project_id == target_project)
                .collect();

            // The same title twice is the agent restating itself, not a second
            // item. Resolve only a unique legacy match: old title-based flows
            // could leave duplicates, and choosing one would repeat that bug.
            //
            // A restated add may carry newer state. Home used to acknowledge
            // the existing title without applying that state, so a request to
            // make an existing task active reported success while leaving it
            // new. Reconcile the unique row, then answer with its id so every
            // later reference can use the stable identity.
            let mut matching = target_rows
                .iter()
                .filter(|row| row.title.eq_ignore_ascii_case(title.trim()));
            match (matching.next(), matching.next()) {
                (Some(_), Some(_)) => {
                    return Outcome::Refused {
                        what: format!("items.add({title:?})"),
                        code: "ENTITY_AMBIGUOUS".into(),
                    };
                }
                (Some(existing), None) => {
                    let moved = existing.status != status;
                    if moved
                        && let Err(error) = tables
                            .project_item
                            .update_status_by_id(
                                ItemStatusByIdQuery {
                                    status: status.clone(),
                                },
                                existing.id.clone(),
                            )
                            .await
                    {
                        return Outcome::Refused {
                            what: format!("items.add({title:?})"),
                            code: format!("WRITE_FAILED: {error}"),
                        };
                    }
                    if moved && let Some(updated) = tables.project_item.select(existing.id.clone())
                    {
                        let _ = app.emit("item:updated", ProjectItemDto::from(updated));
                    }
                    let state = moved.then(|| format!("; -> {status}"));
                    return Outcome::Done(match handle {
                        Some(handle) => format!(
                            "{handle} -> {} (already open{})",
                            existing.id,
                            state.unwrap_or_default()
                        ),
                        None => {
                            format!("{} already open{}", existing.id, state.unwrap_or_default())
                        }
                    });
                }
                (None, _) => {}
            }
            let row = ProjectItemRow {
                id: id("item"),
                project_id: target_project,
                title: truncate_on_char_boundary(title.trim(), 120),
                status,
                position: u32::try_from(target_rows.len()).unwrap_or(0),
                reference: String::new(),
            };
            match tables.project_item.insert(row.clone()) {
                Ok(_) => {
                    let said = match handle {
                        Some(handle) => format!("{handle} -> {} {:?}", row.id, row.title),
                        None => format!("{} {:?}", row.id, row.title),
                    };
                    let _ = app.emit("item:created", ProjectItemDto::from(row));
                    Outcome::Done(said)
                }
                Err(error) => Outcome::Refused {
                    what: format!("items.add({title:?})"),
                    code: format!("WRITE_FAILED: {error}"),
                },
            }
        }
        Directive::ItemRetire { id } => {
            let known: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
            let resolved = match crate::directives::resolve(&known, &id) {
                Ok(found) => found.to_string(),
                Err(code) => {
                    return Outcome::Refused {
                        what: format!("items.retire({id})"),
                        code,
                    };
                }
            };
            let title = rows
                .iter()
                .find(|row| row.id == resolved)
                .map(|row| row.title.clone())
                .unwrap_or_default();
            let target_project = rows
                .iter()
                .find(|row| row.id == resolved)
                .map(|row| row.project_id.clone())
                .unwrap_or_else(|| project_id.to_string());
            match tables.project_item.delete(resolved.clone()).await {
                Ok(()) => {
                    let _ = app.emit(
                        "item:deleted",
                        serde_json::json!({ "id": resolved, "projectId": target_project }),
                    );
                    Outcome::Done(format!("{resolved} retired {title:?}"))
                }
                Err(error) => Outcome::Refused {
                    what: format!("items.retire({resolved})"),
                    code: format!("WRITE_FAILED: {error}"),
                },
            }
        }
        Directive::PrRetire { id } => {
            let tracked = crate::prs::canonical_rows(
                tables
                    .pull_request
                    .select_by_project_id(project_id.to_string())
                    .execute()
                    .unwrap_or_default(),
            );
            let known: Vec<&str> = tracked.iter().map(|row| row.id.as_str()).collect();
            let resolved = match crate::directives::resolve(&known, &id) {
                Ok(found) => found.to_string(),
                Err(code) => {
                    return Outcome::Refused {
                        what: format!("pr.retire({id})"),
                        code,
                    };
                }
            };
            let label = tracked
                .iter()
                .find(|row| row.id == resolved)
                .map(|row| format!("{}#{}", row.repo, row.number))
                .unwrap_or_default();
            match crate::prs::dismiss_association(app, tables, &resolved).await {
                Ok((_, ids)) => Outcome::Done(format!(
                    "{resolved} retired {label} ({} association{})",
                    ids.len(),
                    if ids.len() == 1 { "" } else { "s" }
                )),
                Err(code) => Outcome::Refused {
                    what: format!("pr.retire({resolved})"),
                    code,
                },
            }
        }
        Directive::PrLink { url, number, item } => {
            let linked = match item.as_deref() {
                Some(item) => {
                    let known: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
                    let resolved = match crate::directives::resolve(&known, item) {
                        Ok(found) => found.to_string(),
                        Err(code) => {
                            return Outcome::Refused {
                                what: format!("pr.link(item: {item})"),
                                code,
                            };
                        }
                    };
                    let target_project = rows
                        .iter()
                        .find(|row| row.id == resolved)
                        .map(|row| row.project_id.clone())
                        .unwrap_or_else(|| project_id.to_string());
                    Some((resolved, target_project))
                }
                None => None,
            };
            if linked.is_none() && project_id == crate::tasks::TASK_MANAGER_ID {
                return Outcome::Refused {
                    what: "pr.link(url) from Home".into(),
                    code: "ENTITY_NOT_FOUND".into(),
                };
            }
            let target_project = linked
                .as_ref()
                .map(|(_, project)| project.as_str())
                .unwrap_or(project_id);
            let tracked = match url.as_deref() {
                Some(url) => match crate::prs::record_url(app, tables, target_project, url) {
                    Ok(found) => Some(found.to_string()),
                    Err(code) => {
                        return Outcome::Refused {
                            what: "pr.link(url)".into(),
                            code,
                        };
                    }
                },
                None => None,
            };
            let number = tracked.or(number);
            let Some((resolved, _)) = linked else {
                return Outcome::Done(format!(
                    "pull request #{} tracked",
                    number.unwrap_or_else(|| "?".into())
                ));
            };
            let Some(number) = number else {
                return Outcome::Refused {
                    what: format!("pr.link({resolved})"),
                    code: "ENTITY_NOT_FOUND".into(),
                };
            };
            match tables
                .project_item
                .update_reference_by_id(
                    ItemReferenceByIdQuery {
                        reference: number.clone(),
                    },
                    resolved.clone(),
                )
                .await
            {
                Ok(()) => {
                    if let Some(updated) = tables.project_item.select(resolved.clone()) {
                        let _ = app.emit("item:updated", ProjectItemDto::from(updated));
                    }
                    Outcome::Done(format!("{resolved} <- #{number}"))
                }
                Err(error) => Outcome::Refused {
                    what: format!("pr.link({resolved})"),
                    code: format!("WRITE_FAILED: {error}"),
                },
            }
        }
        Directive::IssueLink { url, item } => {
            let known: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
            let resolved = match crate::directives::resolve(&known, &item) {
                Ok(found) => found.to_string(),
                Err(code) => {
                    return Outcome::Refused {
                        what: format!("issue.link(item: {item})"),
                        code,
                    };
                }
            };
            match link_item_issue_inner(app, tables, &resolved, &url).await {
                Ok(dto) => Outcome::Done(format!(
                    "{} <- {}",
                    dto.id,
                    dto.reference
                        .unwrap_or_default()
                        .trim_start_matches("issue:")
                )),
                Err(code) => Outcome::Refused {
                    what: format!("issue.link({resolved})"),
                    code,
                },
            }
        }
        Directive::Ask {
            text,
            urgency,
            reference,
        } => {
            // A bare-id reference must name a real item; a URL reference is an
            // issue and is taken as given. An unknown id is refused like every
            // other reference, rather than recording a question that points
            // nowhere.
            let reference = match reference.as_deref() {
                Some(reference) if !reference.starts_with("https://") => {
                    let known: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
                    match crate::directives::resolve(&known, reference) {
                        Ok(found) => Some(found.to_string()),
                        Err(code) => {
                            return Outcome::Refused {
                                what: format!("ask(reference: {reference})"),
                                code,
                            };
                        }
                    }
                }
                other => other.map(str::to_string),
            };
            match crate::questions::record(
                app,
                tables,
                project_id,
                &text,
                &urgency,
                reference.as_deref(),
            ) {
                Ok(id) => Outcome::Done(format!("{id} asked ({urgency})")),
                Err(code) => Outcome::Refused {
                    what: "ask".to_string(),
                    code,
                },
            }
        }
    }
}

/// Return an authored PS line, preserving fence state across streamed chunks.
///
/// The declared segment has to occupy its line. Markdown blockquotes, indented
/// code, and fenced code are quoted content, so PS-shaped text inside them is
/// inert. Keeping `fenced` outside this function is essential for streaming:
/// an opening fence, its contents, and its closer usually arrive as separate
/// calls.
fn authored_directive_line<'a>(line: &'a str, fenced: &mut FenceState) -> Option<&'a str> {
    let line = line.trim_end_matches(['\r', '\n']);
    let trimmed = line.trim();

    // Four-space and tab-indented blocks are inert, but are not fenced blocks
    // and therefore must not alter fence state for following lines.
    if line.starts_with("    ") || line.starts_with('\t') {
        return None;
    }
    // A fence quoted inside a blockquote is quoted content, not a delimiter in
    // the agent-authored stream.
    if trimmed.starts_with('>') {
        return None;
    }
    if let Some((marker, width, tail)) = fence_marker(trimmed) {
        match fenced.0 {
            None => fenced.0 = Some((marker, width)),
            Some((open, minimum))
                if marker == open && width >= minimum && tail.trim().is_empty() =>
            {
                fenced.0 = None;
            }
            Some(_) => {}
        }
        return None;
    }
    if fenced.0.is_some() {
        return None;
    }
    Some(trimmed)
}

struct StudyTarget {
    kind: &'static str,
    id: String,
    before_add: std::collections::HashSet<String>,
}

/// Resolve an authored prefix to the application id it actually changed.
///
/// The study table must not retain an arbitrary `id:` argument, and a prefix
/// would not join to a later manual correction anyway. Adds have no id until
/// execution, so their prior id set is kept and the one new row is resolved
/// afterwards.
fn study_target_before(
    tables: &crate::db::tables::Tables,
    directive: &crate::directives::Directive,
) -> StudyTarget {
    use crate::directives::Directive;

    let rows: Vec<ProjectItemRow> = tables
        .project_item
        .select_all()
        .execute()
        .unwrap_or_default();
    let known: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    let resolve = |named: &str| {
        crate::directives::resolve(&known, named)
            .map(str::to_string)
            .unwrap_or_default()
    };

    match directive {
        Directive::ItemState { id, .. } | Directive::ItemRetire { id } => StudyTarget {
            kind: "item",
            id: resolve(id),
            before_add: std::collections::HashSet::new(),
        },
        Directive::ItemAdd { .. } => StudyTarget {
            kind: "item",
            id: String::new(),
            before_add: rows.iter().map(|row| row.id.clone()).collect(),
        },
        Directive::PrLink { item, .. } => StudyTarget {
            kind: if item.is_some() {
                "item"
            } else {
                "pull_request"
            },
            id: item.as_deref().map(resolve).unwrap_or_default(),
            before_add: std::collections::HashSet::new(),
        },
        Directive::PrRetire { id } => {
            let prs = crate::prs::canonical_rows(
                tables
                    .pull_request
                    .select_all()
                    .execute()
                    .unwrap_or_default(),
            );
            let known: Vec<&str> = prs.iter().map(|row| row.id.as_str()).collect();
            StudyTarget {
                kind: "pull_request",
                id: crate::directives::resolve(&known, id)
                    .map(str::to_string)
                    .unwrap_or_default(),
                before_add: std::collections::HashSet::new(),
            }
        }
        Directive::IssueLink { item, .. } => StudyTarget {
            kind: "item",
            id: resolve(item),
            before_add: std::collections::HashSet::new(),
        },
        Directive::Ask { .. } => StudyTarget {
            // The question's own id is minted on apply, so there is nothing to
            // point at beforehand — a fresh row, like items.add.
            kind: "question",
            id: String::new(),
            before_add: std::collections::HashSet::new(),
        },
    }
}

fn study_target_after_add(
    tables: &crate::db::tables::Tables,
    target: &mut StudyTarget,
    operation: &str,
    applied: bool,
) {
    if operation != "items.add" || !applied {
        return;
    }
    let added: Vec<String> = tables
        .project_item
        .select_all()
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(|row| row.id)
        .filter(|id| !target.before_add.contains(id))
        .collect();
    if let [id] = added.as_slice() {
        target.id.clone_from(id);
    }
}

/// Read every directive out of a stretch of reply text and carry it out.
async fn apply_directives_with_state(
    app: &AppHandle,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    turn_id: &str,
    agent: &str,
    text: &str,
    fenced: &mut FenceState,
) -> Vec<crate::directives::Outcome> {
    let mut done = Vec::new();
    for line in text.lines() {
        match authored_directive_line(line, fenced).and_then(crate::directives::parse_authored) {
            Some(crate::directives::Authored::Directive(directive)) => {
                let operation = directive.operation();
                let mut target = study_target_before(tables, &directive);
                let interaction_id = id("interaction");
                crate::study::record(
                    tables,
                    crate::study::Record {
                        project_id: project_id.into(),
                        turn_id: turn_id.into(),
                        interaction_id: interaction_id.clone(),
                        agent: agent.into(),
                        pathway: "ps",
                        operation,
                        stage: "parsed",
                        outcome: "observed",
                        code: String::new(),
                        target_kind: target.kind,
                        target_id: target.id.clone(),
                        latency: None,
                        detail: serde_json::json!({}),
                    },
                );
                let started = std::time::Instant::now();
                let outcome = apply_directive(app, tables, project_id, directive).await;
                let (result, code) = outcome.study_result();
                study_target_after_add(tables, &mut target, operation, result == "applied");
                crate::study::record(
                    tables,
                    crate::study::Record {
                        project_id: project_id.into(),
                        turn_id: turn_id.into(),
                        interaction_id,
                        agent: agent.into(),
                        pathway: "ps",
                        operation,
                        stage: "completed",
                        outcome: result,
                        code,
                        target_kind: target.kind,
                        target_id: target.id,
                        latency: Some(started.elapsed()),
                        detail: serde_json::json!({}),
                    },
                );
                done.push(outcome);
            }
            Some(crate::directives::Authored::Refused(outcome)) => {
                let interaction_id = id("interaction");
                crate::study::record(
                    tables,
                    crate::study::Record {
                        project_id: project_id.into(),
                        turn_id: turn_id.into(),
                        interaction_id: interaction_id.clone(),
                        agent: agent.into(),
                        pathway: "ps",
                        operation: "authoring.segment",
                        stage: "parsed",
                        outcome: "observed",
                        code: String::new(),
                        target_kind: "",
                        target_id: String::new(),
                        latency: None,
                        detail: serde_json::json!({}),
                    },
                );
                let (result, code) = outcome.study_result();
                crate::study::record(
                    tables,
                    crate::study::Record {
                        project_id: project_id.into(),
                        turn_id: turn_id.into(),
                        interaction_id,
                        agent: agent.into(),
                        pathway: "ps",
                        operation: "authoring.segment",
                        stage: "completed",
                        outcome: result,
                        code,
                        target_kind: "",
                        target_id: String::new(),
                        latency: Some(std::time::Duration::ZERO),
                        detail: serde_json::json!({}),
                    },
                );
                done.push(outcome);
            }
            None => {}
        }
    }
    done
}

async fn apply_directives(
    app: &AppHandle,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    turn_id: &str,
    agent: &str,
    text: &str,
) -> Vec<crate::directives::Outcome> {
    apply_directives_with_state(
        app,
        tables,
        project_id,
        turn_id,
        agent,
        text,
        &mut FenceState::default(),
    )
    .await
}

/// Whether a submitted turn itself contains a live AgencyZero authoring line.
///
/// This records one boolean, never the line. The same quote, indentation and
/// fence rules as the reverse-channel parser keep an example in prose from
/// being counted as direct syntax use.
fn user_authored_ps(text: &str) -> bool {
    let mut fenced = FenceState::default();
    text.lines().any(|line| {
        authored_directive_line(line, &mut fenced)
            .and_then(crate::directives::parse_authored)
            .is_some()
    })
}

fn record_study_turn(
    tables: &crate::db::tables::Tables,
    project_id: &str,
    turn_id: &str,
    agent: &str,
    body: &str,
    authored: Option<&StudyTurnMetadata>,
    followup: bool,
) {
    let fallback = StudyTurnMetadata {
        authored_character_count: body.chars().count(),
        authored_line_count: body.lines().count(),
        attachment_count: 0,
        user_authored_ps: user_authored_ps(body),
    };
    let authored = authored.unwrap_or(&fallback);
    crate::study::record(
        tables,
        crate::study::Record {
            project_id: project_id.into(),
            turn_id: turn_id.into(),
            interaction_id: String::new(),
            agent: agent.into(),
            pathway: "study",
            operation: "turn.submit",
            stage: "submitted",
            outcome: "observed",
            code: String::new(),
            target_kind: "",
            target_id: String::new(),
            latency: None,
            detail: serde_json::json!({
                "characterCount": authored.authored_character_count,
                "lineCount": authored.authored_line_count,
                "attachmentCount": authored.attachment_count,
                "followup": followup,
                "userAuthoredPs": authored.user_authored_ps,
            }),
        },
    );
}

/// Find the project a line named, by id or by name, case-insensitively.
///
/// Never creates one. Creation belongs to the caller after it has established
/// that an explicit `project:` argument was authored; keeping lookup pure makes
/// the exact-name rule independently testable.
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

/// Provider identity travels with a streamed-reply checkpoint.
///
/// Versioned because older builds stored the body as a bare string. Recovery
/// treats those legacy values as Claude, which was the only possible writer at
/// the time, while every new checkpoint preserves the provider that wrote it.
#[derive(serde::Deserialize, serde::Serialize)]
struct PartialReply {
    version: u8,
    body: String,
    agent: String,
    model: String,
    permission: String,
}

fn encode_partial_reply(body: &str, agent: Agent, model: &str, permission: &str) -> String {
    let suffix = "\n\n[checkpoint truncated; the reply continued]";
    let mut body_limit = body.len().min(MAX_PERSISTED_BLOB);
    loop {
        let clipped = if body_limit < body.len() {
            truncate_to_bytes(body, body_limit) + suffix
        } else {
            body.to_string()
        };
        let encoded = serde_json::to_string(&PartialReply {
            version: 1,
            body: clipped,
            agent: agent_wire_name(agent).into(),
            model: model.into(),
            permission: permission.into(),
        })
        .unwrap_or_default();
        if encoded.len() <= MAX_PERSISTED_BLOB || body_limit == 0 {
            return encoded;
        }
        body_limit = body_limit.saturating_sub(encoded.len() - MAX_PERSISTED_BLOB + 1);
    }
}

fn decode_partial_reply(raw: String) -> PartialReply {
    serde_json::from_str::<PartialReply>(&raw)
        .ok()
        .filter(|checkpoint| checkpoint.version == 1)
        .unwrap_or(PartialReply {
            version: 0,
            body: raw,
            agent: "claude".into(),
            model: String::new(),
            permission: String::new(),
        })
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
/// failure takes the same road, with its own reason in the I/O panel. `false`
/// tells the run owner to reap the transport: a queued retry cannot start while
/// the stale run still owns the project's only slot.
async fn deliver_injection(
    app: &AppHandle,
    io: &std::sync::Arc<AgentIo>,
    control: &agent_abstraction::RunControl,
    project_id: &str,
    message_id: &str,
    body: String,
) -> bool {
    match control.send(&body).await {
        Ok(()) => {
            note_io(
                app,
                io,
                project_id,
                "sent",
                "message",
                "(into the running turn)",
            );
            true
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
                serde_json::json!({
                    "projectId": project_id,
                    "messageId": message_id,
                    "body": body,
                }),
            );
            false
        }
    }
}

/// Persist a new user message, or recover the exact row whose live steer was
/// rejected after it had already been rendered.
///
/// The retry id is deliberately checked against both project and body. It is
/// an IPC input, not authority to make an unrelated transcript row stand in
/// for new words. A successful retry returns the existing row without another
/// study event, GUI note, or `message:appended` echo.
fn user_message_for_send(
    app: &AppHandle,
    state: &AppState,
    input: &SendMessageInput,
    agent: &str,
    model: &str,
    permission: &str,
    followup: bool,
) -> Result<MessageDto, String> {
    if let Some(message) = retry_user_message(&state.tables, input)? {
        return Ok(message);
    }

    let row = MessageRow {
        id: id("msg"),
        project_id: input.project_id.clone(),
        item_id: input.item_id.clone().unwrap_or_default(),
        author: "user".into(),
        agent: agent.into(),
        moderation: String::new(),
        model: model.into(),
        permission: permission.into(),
        usage: String::new(),
        stop: "completed".into(),
        exit_code: -1,
        body: body_head(&input.body),
        created_at: now(),
    };
    state
        .tables
        .message
        .insert(row.clone())
        .map_err(|error| error.to_string())?;
    store_body(&state.tables, &row.id, &input.project_id, &input.body);

    // The emitted DTO carries the whole body, not just the stored head: the
    // caller has it in hand and the reader would otherwise have to round-trip
    // the chunks it just wrote.
    let mut message = MessageDto::from(row);
    message.body = input.body.clone();
    record_study_turn(
        &state.tables,
        &input.project_id,
        &message.id,
        agent,
        &input.body,
        input.study.as_ref(),
        followup,
    );
    note_gui(
        app,
        state,
        &input.project_id,
        if followup {
            format!(
                "you sent a message into the running turn ({} chars)",
                input.body.len()
            )
        } else {
            format!("you sent a message ({} chars)", input.body.len())
        },
    );
    let _ = app.emit("message:appended", &message);
    Ok(message)
}

/// Resolve a retry without changing the transcript. Kept independent of the
/// Tauri handle so the identity and validation rule have direct regression
/// coverage against a real persisted message table.
fn retry_user_message(
    tables: &crate::db::tables::Tables,
    input: &SendMessageInput,
) -> Result<Option<MessageDto>, String> {
    let Some(message_id) = input.retry_message_id.as_deref() else {
        return Ok(None);
    };
    let row = tables
        .message
        .select(message_id.to_string())
        .ok_or_else(|| "the queued user message no longer exists".to_string())?;
    if row.project_id != input.project_id
        || row.author != "user"
        || row.body != body_head(&input.body)
    {
        return Err("the queued user message does not match this retry".into());
    }
    let id = row.id.clone();
    let mut dto = MessageDto::from(row);
    dto.body = full_body(tables, &id, &dto.body);
    Ok(Some(dto))
}

fn emit_run_stopped(
    app: &AppHandle,
    project_id: &str,
    agent: Agent,
    model: &str,
    permission: &str,
    stop: impl Into<String>,
    exit_code: Option<i64>,
) {
    let _ = app.emit(
        "run:stopped",
        serde_json::json!({
            "projectId": project_id,
            "agent": agent_wire_name(agent),
            "model": model,
            "permission": permission,
            "stop": stop.into(),
            "exitCode": exit_code,
        }),
    );
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
        let checkpoint = decode_partial_reply(row.value);
        let message_id = id("msg");
        let checkpoint_body = checkpoint.body.clone();
        let message = MessageRow {
            id: message_id.clone(),
            project_id: project_id.clone(),
            item_id: String::new(),
            author: "agent".into(),
            agent: checkpoint.agent,
            moderation: String::new(),
            model: checkpoint.model,
            permission: checkpoint.permission,
            usage: String::new(),
            stop: "interrupted".into(),
            exit_code: 0,
            body: body_head(&checkpoint_body),
            created_at: now(),
        };
        let insert_result = tables.message.insert(message);
        store_body(tables, &message_id, &project_id, &checkpoint_body);
        if let Err(error) = insert_result {
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
        // Byte-counted: this row persists, so it is sized against the page.
        detail: truncate_to_bytes(&detail.into(), 4_000),
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
/// The provider's last word on usage, per project.
///
/// In memory and not persisted, deliberately: it is a fact about an account
/// right now, and a figure restored from disk after a day would be read as
/// current when it is not. Kept for the life of the process so the window can
/// hydrate on boot and so a prompt can carry it, both of which need an answer
/// before the next run reports one.
pub type RateLimits = std::sync::Mutex<std::collections::HashMap<(String, Agent), RateLimitReport>>;

/// One usage report, as the provider worded it.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitReport {
    pub project_id: String,
    /// The account whose window this describes.
    pub agent: Agent,
    /// `<status> (<window>)`, the provider's own vocabulary.
    pub message: String,
    /// ISO 8601, or absent when the provider did not say.
    pub resets_at: Option<String>,
    /// Something was actually refused.
    pub is_blocking: bool,
    /// Nothing was refused, but the provider is flagging the window. This is
    /// the state that had nowhere to go: it was emitted, dropped by the window
    /// for not being blocking, and never reached the agent at all, so neither
    /// the person nor the thing spending the quota could see it coming.
    pub is_warning: bool,
    /// When this arrived, so a stale report can be recognised as one.
    pub at: String,
}

impl RateLimitReport {
    /// One line for a prompt: what the provider said, and when it resets.
    #[must_use]
    pub fn sentence(&self) -> String {
        match &self.resets_at {
            Some(at) => format!("{} (resets {at})", self.message),
            None => self.message.clone(),
        }
    }
}
/// What became of the last turn's directives, per project.
///
/// Quoted back to the agent on the next turn, which is the half that makes the
/// contract a loop rather than a hope: a write that was refused says so, by
/// code, to the only party that can reissue it. In memory, because it describes
/// the turn that just happened and is worthless a day later.
pub type Receipts = std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>;

fn queue_directive_receipts(
    receipts: &Receipts,
    tables: &crate::db::tables::Tables,
    project_id: &str,
    turn_id: &str,
    agent: &str,
    outcomes: &[crate::directives::Outcome],
) {
    let (outcome, code) = match receipts.lock() {
        Ok(mut kept) => {
            kept.entry(project_id.to_string())
                .or_default()
                .extend(outcomes.iter().map(crate::directives::Outcome::line));
            ("applied", String::new())
        }
        Err(_) => ("failed", "RECEIPT_LOCK_FAILED".into()),
    };
    crate::study::record(
        tables,
        crate::study::Record {
            project_id: project_id.into(),
            turn_id: turn_id.into(),
            interaction_id: String::new(),
            agent: agent.into(),
            pathway: "ps",
            operation: "receipt.queue",
            stage: "queued",
            outcome,
            code,
            target_kind: "",
            target_id: String::new(),
            latency: None,
            detail: serde_json::json!({ "outcomeCount": outcomes.len() }),
        },
    );
}

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
/// host. Codex permission requests carry their roots in a nested permission
/// object; those collapse to the sorted, exact write-root set so remembering
/// one directory can never silently approve another. Anything else is the tool
/// name alone.
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

    if tool.eq_ignore_ascii_case("permissions") {
        let mut roots: Vec<&str> = input
            .pointer("/permissions/fileSystem/write")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .filter(|root| !root.is_empty())
            .collect();
        roots.sort_unstable();
        roots.dedup();
        if !roots.is_empty() {
            return format!("Permissions: write {}", roots.join(", "));
        }
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

/// How long a live run may emit *nothing* before it is treated as wedged.
///
/// A run that is working streams constantly — reasoning deltas, text, tool
/// events — so true silence means the turn is stuck, almost always on a shell
/// command that never returns (a soak test, a `while` loop, a network call with
/// no timeout). Codex faithfully waits on such a command forever and nothing
/// upstream bounds it, so a wedged turn used to sit until the owner hit Stop.
///
/// This is an *idle* deadline, not a duration cap: it resets on every event, so
/// a legitimately long turn that keeps streaming is never touched. Five minutes
/// is long enough to clear a slow-but-progressing tool that briefly goes quiet
/// (a big `cargo build` prints nothing for a while) and short enough that a
/// genuinely dead turn does not cost the owner twenty minutes. A trip is a
/// recoverable stall, not a failed run: the session resumes.
const RUN_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

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
/// delivered *into* the provider's interactive control channel (`Run::send`),
/// and the model takes it at its next step boundary. That is what makes a
/// mid-run correction an interruption rather than a queued afterthought.
pub struct ActiveRun {
    pub cancel: tokio::sync::watch::Sender<bool>,
    /// Provider owning the live session. A tab may switch providers while it
    /// runs, but its next message must not be injected into the old provider.
    pub agent: Agent,
    /// Exact roots fixed into the live Codex app-server turn.
    ///
    /// A directory added in Settings cannot widen that already-open sandbox.
    /// `send_message` compares this snapshot with the durable project row and
    /// queues the next message for a fresh resumed invocation when they differ.
    pub workspace_roots: Vec<String>,
    /// `None` when the run has no conversation to interrupt.
    ///
    /// A command turn — `/compact` — rewrites the session instead of answering
    /// it, and its stream is drained for the command's own events. Words
    /// delivered into that turn would be read by nobody and would disappear
    /// with it, so the send is refused and the frontend holds them for the
    /// session that comes out the other side.
    pub inject: Option<tokio::sync::mpsc::UnboundedSender<InjectedMessage>>,
}

/// A live follow-up and the persisted user-message row that owns it.
pub struct InjectedMessage {
    body: String,
    turn_id: String,
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

/// The live project and item ids, for the task manager's eyes.
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
        "\n\n---\nCurrent projects and open items, live from the store. Address an \
         existing row by its item id, never by retyping its title.\n",
    );
    'outer: for project in &projects {
        let header = format!("# {} · {}\n", project.id, project.name);
        if block.len() + header.len() > CEILING {
            block.push_str("… (list truncated)\n");
            break;
        }
        block.push_str(&header);

        let mut items: Vec<ProjectItemRow> = tables
            .project_item
            .select_by_project_id(project.id.clone())
            .execute()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.status != "finished" && item.status != "canceled")
            .collect();
        items.sort_by_key(|row| row.position);
        for item in &items {
            let line = format!("  {} · {} · {}\n", item.id, item.status, item.title);
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

/// One day's usage, decomposed the way the analytics view charts it.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayDto {
    pub day: String,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub turns: usize,
}

/// One model's totals, for the per-model breakdown.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelDto {
    pub model: String,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub turns: usize,
}

/// Everything the analytics view needs, in one call.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAnalyticsDto {
    /// Per-day series, oldest first, for the time-series panels.
    pub days: Vec<UsageDayDto>,
    /// Per-model totals, most expensive first.
    pub models: Vec<UsageModelDto>,
    pub total_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_write_tokens: i64,
    pub turns: usize,
}

/// Aggregate the usage ledger and the cache table for the analytics view.
///
/// The two tables share `day`, `project_id` and `model`; the ledger carries the
/// cost, input and output figures, the cache table the read/write split. Joined
/// here by turn: they are written together, so a ledger row and its cache row
/// line up one to one and the cache read/write folds onto the ledger totals for
/// the same day and model.
///
/// # Errors
/// Infallible today; `Result` for signature stability.
#[tauri::command]
pub async fn get_usage_analytics(state: State<'_, AppState>) -> Result<UsageAnalyticsDto, String> {
    let ledger = state
        .tables
        .usage_ledger
        .select_all()
        .execute()
        .unwrap_or_default();
    let cache = state
        .tables
        .usage_cache
        .select_all()
        .execute()
        .unwrap_or_default();

    // Cache read/write summed by day and by model, so the ledger loop can fold
    // them in without a nested scan.
    let mut cache_by_day: std::collections::HashMap<String, (i64, i64)> =
        std::collections::HashMap::new();
    let mut cache_by_model: std::collections::HashMap<String, (i64, i64)> =
        std::collections::HashMap::new();
    for row in &cache {
        let day = cache_by_day.entry(row.day.clone()).or_default();
        day.0 += row.cache_read_tokens;
        day.1 += row.cache_write_tokens;
        let model = cache_by_model.entry(row.model.clone()).or_default();
        model.0 += row.cache_read_tokens;
        model.1 += row.cache_write_tokens;
    }

    let mut by_day: std::collections::BTreeMap<String, UsageDayDto> =
        std::collections::BTreeMap::new();
    let mut by_model: std::collections::HashMap<String, UsageModelDto> =
        std::collections::HashMap::new();
    let mut total_micro = 0i64;
    let mut total_input = 0i64;
    let mut total_output = 0i64;

    for row in &ledger {
        total_micro += row.cost_micro;
        total_input += row.input_tokens;
        total_output += row.output_tokens;

        let day = by_day
            .entry(row.day.clone())
            .or_insert_with(|| UsageDayDto {
                day: row.day.clone(),
                ..Default::default()
            });
        day.cost_usd += row.cost_micro as f64 / 1_000_000.0;
        day.input_tokens += row.input_tokens;
        day.output_tokens += row.output_tokens;
        day.turns += 1;

        let model = by_model
            .entry(row.model.clone())
            .or_insert_with(|| UsageModelDto {
                model: row.model.clone(),
                ..Default::default()
            });
        model.cost_usd += row.cost_micro as f64 / 1_000_000.0;
        model.input_tokens += row.input_tokens;
        model.output_tokens += row.output_tokens;
        model.turns += 1;
    }

    // Fold the cache split onto the per-day and per-model rows.
    let mut total_read = 0i64;
    let mut total_write = 0i64;
    for (day_key, day) in &mut by_day {
        if let Some((read, write)) = cache_by_day.get(day_key) {
            day.cache_read_tokens = *read;
            day.cache_write_tokens = *write;
        }
    }
    for (model_key, model) in &mut by_model {
        if let Some((read, write)) = cache_by_model.get(model_key) {
            model.cache_read_tokens = *read;
            model.cache_write_tokens = *write;
        }
    }
    for (read, write) in cache_by_day.values() {
        total_read += read;
        total_write += write;
    }

    let mut models: Vec<UsageModelDto> = by_model.into_values().collect();
    models.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));

    Ok(UsageAnalyticsDto {
        days: by_day.into_values().collect(),
        models,
        total_usd: total_micro as f64 / 1_000_000.0,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read_tokens: total_read,
        total_cache_write_tokens: total_write,
        turns: ledger.len(),
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
    /// The provider whose session is selected in Settings.
    pub agent: Agent,
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
    let settings = state
        .tables
        .kv_get(crate::settings::KEY)
        .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
        .unwrap_or_default();
    let agent = parse_agent(Some(&settings.task_manager.agent))?;
    let session = state
        .tables
        .kv_get(&agent_session_key(crate::tasks::TASK_MANAGER_ID, agent))
        .filter(|id| !id.is_empty());
    Ok(TaskManagerDto {
        agent,
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
    agent: Agent,
    cwd: &str,
    session: Option<&str>,
) -> Option<String> {
    let existing = state
        .tables
        .kv_get(&crate::notes::notes_key(project_id))
        .unwrap_or_default();

    let mut request =
        agent_abstraction::Request::new(agent, crate::notes::merge_prompt(&existing)).cwd(cwd);
    if let Some(session) = session {
        request = request.resume(session);
    }

    note_io(
        app,
        io,
        project_id,
        "sent",
        "request",
        format!(
            "{} <pre-compaction notes> cwd={cwd}",
            agent_wire_name(agent)
        ),
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
    agent: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let agent = parse_agent(agent.as_deref())?;
    if !agent.caps().commands {
        return Err(format!(
            "{} does not expose a command vocabulary, so this conversation cannot be compacted from AgencyZero",
            agent_wire_name(agent)
        ));
    }
    let session = state
        .tables
        .kv_get(&agent_session_key(&project_id, agent))
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
                agent,
                workspace_roots: Vec::new(),
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
        .kv_put(
            &crate::notes::checkpoint_mark_key(&project_id, agent_wire_name(agent)),
            "0".into(),
        )
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
                "agent": agent,
                "driver": "command",
                "phase": "learning",
            }),
        );
        learn_before_compacting(
            &app,
            &io,
            &state,
            &project_id,
            agent,
            &cwd,
            session.as_deref(),
        )
        .await
    } else {
        None
    };

    let mut request = agent_abstraction::Request::command(
        agent,
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
        format!(
            "{} /compact cwd={cwd} resume={resumed}",
            agent_wire_name(agent)
        ),
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
            "agent": agent,
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
                    .kv_put(&agent_session_key(&project_id, agent), started.clone())
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
        agent: agent_wire_name(agent).into(),
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
            "agent": agent,
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
    let settings = state
        .tables
        .kv_get(crate::settings::KEY)
        .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
        .unwrap_or_default();
    let agent = parse_agent(Some(&settings.task_manager.agent))?;
    state
        .tables
        .kv_put(&agent_session_key(id, agent), String::new())
        .await
        .map_err(|error| error.to_string())?;

    crate::log!(
        crate::log::Level::Info,
        "tasks",
        "{} task manager session reset",
        agent_wire_name(agent)
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

/// Store one project's complete ordered directory list and return the durable row.
///
/// `Project.dirs` is already a persisted JSON column. Keeping the mutation here
/// means the project panel, a restarted app, and the next agent invocation all
/// read the same value instead of the live UI quietly falling back to fixtures.
async fn write_project_dirs(
    tables: &Tables,
    id: &str,
    dirs: Vec<String>,
) -> Result<ProjectDto, String> {
    let encoded = serde_json::to_string(&dirs).map_err(|error| error.to_string())?;
    tables
        .project
        .update_dirs_by_id(DirsByIdQuery { dirs: encoded }, id.to_string())
        .await
        .map_err(|error| error.to_string())?;
    let row = tables
        .project
        .select(id.to_string())
        .ok_or_else(|| format!("no project {id}"))?;
    Ok(with_session(ProjectDto::from(row), tables))
}

/// Attach an exact working directory to a project.
///
/// Paths are trimmed but otherwise preserved. In particular, AgencyZero does
/// not replace the selected root with a parent directory or a broad home/code
/// grant. Duplicate selections are idempotent.
///
/// # Errors
/// Returns a message for an empty path, missing project, or store failure.
#[tauri::command]
pub async fn add_dir(
    app: AppHandle,
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectDto, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("a working directory needs a path".into());
    }
    let row = state
        .tables
        .project
        .select(project_id.clone())
        .ok_or_else(|| format!("no project {project_id}"))?;
    let mut dirs = serde_json::from_str::<Vec<String>>(&row.dirs).unwrap_or_default();
    let project = if dirs.iter().any(|dir| dir == &path) {
        with_session(ProjectDto::from(row), &state.tables)
    } else {
        dirs.push(path.clone());
        write_project_dirs(&state.tables, &project_id, dirs).await?
    };
    note_gui(
        &app,
        &state,
        &project_id,
        format!("attached working directory {path}"),
    );
    let _ = app.emit("project:updated", &project);
    Ok(project)
}

/// Remove one exact attached directory from a project.
///
/// # Errors
/// Returns a message for a missing project or store failure.
#[tauri::command]
pub async fn remove_dir(
    app: AppHandle,
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectDto, String> {
    let row = state
        .tables
        .project
        .select(project_id.clone())
        .ok_or_else(|| format!("no project {project_id}"))?;
    let mut dirs = serde_json::from_str::<Vec<String>>(&row.dirs).unwrap_or_default();
    dirs.retain(|dir| dir != &path);
    let project = write_project_dirs(&state.tables, &project_id, dirs).await?;
    note_gui(
        &app,
        &state,
        &project_id,
        format!("removed working directory {path}"),
    );
    let _ = app.emit("project:updated", &project);
    Ok(project)
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
    // Message-body overflow follows the project out, so a purge cannot leave a
    // reply's tail behind with no message to hang it off.
    state
        .tables
        .message_chunk
        .delete_by_project(id.clone())
        .await
        .map_err(|error| failed("the message overflow rows", &error))?;
    let mut keys = [Agent::Claude, Agent::Codex, Agent::Copilot]
        .map(|agent| agent_session_key(&id, agent))
        .to_vec();
    keys.extend([
        io_persist_key(&id),
        partial_reply_key(&id),
        crate::notes::checkpoints_key(&id),
        crate::notes::checkpoint_mark_key(&id, "claude"),
        crate::notes::checkpoint_mark_key(&id, "codex"),
        crate::notes::checkpoint_mark_key(&id, "copilot"),
        // The notes kept across compactions. Ids are not recycled, so this is
        // only an orphan — but it is an orphan that would be fed to an agent as
        // standing instructions if one ever were.
        crate::notes::notes_key(&id),
    ]);
    for key in keys {
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
pub fn list_rate_limits(state: State<'_, AppState>) -> Vec<RateLimitReport> {
    /*
     * Hydration, which this stub never did. A limit only ever arrived as an
     * event during a run, so a window opened after one was reported showed
     * nothing at all and the account looked healthy until the next run said
     * otherwise.
     */
    state
        .limits
        .lock()
        .map(|kept| kept.values().cloned().collect())
        .unwrap_or_default()
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
            retry_message_id: None,
            item_id: None,
            agent: input.agent,
            model: input.model,
            permission: input.permission,
            effort: input.effort,
            extra_thinking: input.extra_thinking,
            study: input.study,
        },
        state,
    )
    .await?;

    Ok(CreatedProject {
        project,
        items: Vec::new(),
    })
}

/// Filesystem scope resolved afresh for one provider invocation.
///
/// The stored session id is intentionally beside the roots: resuming changes
/// conversation history, not the sandbox declaration. Rebuilding this value on
/// every send is what lets a directory attached after session creation take
/// effect on the very next invocation.
#[derive(Clone, Debug, PartialEq, Eq)]
struct InvocationScope {
    cwd: String,
    extra_dirs: Vec<String>,
    resume: Option<String>,
    memory_dir: std::path::PathBuf,
}

impl InvocationScope {
    fn workspace_roots(&self) -> Vec<String> {
        let mut roots = vec![self.cwd.clone()];
        for dir in &self.extra_dirs {
            if !roots.contains(dir) {
                roots.push(dir.clone());
            }
        }
        roots
    }
}

/// Resolve the current project row into one invocation's exact filesystem scope.
///
/// Claude keeps the established first-directory-as-cwd behavior. Codex keeps
/// the AgencyZero-managed project directory as cwd and receives every attached
/// directory plus only this project's durable-memory directory as typed
/// additional roots. The provider adapter maps those roots to `--add-dir` or
/// the app-server workspace-write request as appropriate.
fn invocation_scope(
    tables: &Tables,
    project_id: &str,
    agent: Agent,
    managed_cwd: String,
    data_dir: &std::path::Path,
) -> InvocationScope {
    let mut dirs = if project_id == crate::tasks::TASK_MANAGER_ID {
        tables
            .kv_get(crate::settings::KEY)
            .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
            .unwrap_or_default()
            .task_manager
            .dirs
    } else {
        tables
            .project
            .select(project_id.to_string())
            .and_then(|row| serde_json::from_str::<Vec<String>>(&row.dirs).ok())
            .unwrap_or_default()
    };
    dirs = dirs
        .into_iter()
        .map(|dir| dir.trim().to_string())
        .filter(|dir| !dir.is_empty())
        .fold(Vec::new(), |mut exact, dir| {
            if !exact.contains(&dir) {
                exact.push(dir);
            }
            exact
        });

    let memory_dir = data_dir.join("memory").join(project_id);
    let (cwd, mut extra_dirs) =
        if agent == Agent::Codex && project_id != crate::tasks::TASK_MANAGER_ID {
            // Attached repositories never replace the managed project directory.
            // They widen Codex's scoped workspace instead.
            (managed_cwd, dirs)
        } else if dirs.is_empty() {
            (managed_cwd, Vec::new())
        } else {
            let cwd = dirs.remove(0);
            (cwd, dirs)
        };

    if agent == Agent::Codex {
        let memory = memory_dir.to_string_lossy().into_owned();
        if memory != cwd && !extra_dirs.contains(&memory) {
            extra_dirs.push(memory);
        }
    }

    InvocationScope {
        cwd,
        extra_dirs,
        resume: tables.kv_get(&agent_session_key(project_id, agent)),
        memory_dir,
    }
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
    let agent = parse_agent(input.agent.as_deref())?;
    let agent_name = agent_wire_name(agent);
    let model = input.model.clone().unwrap_or_default();
    let permission = input
        .permission
        .clone()
        .unwrap_or_else(|| "read_only".into());
    if permission == "ask" && !agent.caps().approvals {
        return Err(format!(
            "{} cannot ask for approval during a run; choose read only, edit, auto, or bypass",
            agent_name
        ));
    }

    // Read the durable row before deciding whether this message can ride an
    // already-open Codex turn. A turn's app-server sandbox cannot be widened in
    // place: if Settings changed its roots, the frontend queues this message
    // until the current run settles, then a fresh invocation resumes the same
    // session with the new scope.
    let scope = invocation_scope(
        &state.tables,
        &input.project_id,
        agent,
        crate::workspace_root_path(&app, &state),
        &state.location.path,
    );
    let workspace_roots = scope.workspace_roots();

    /*
     * One run per project, enforced here rather than in the composer. A second
     * concurrent run would resume the same session and share one approval
     * route, so it corrupts rather than parallelizes. The slot is claimed
     * before the message row is written: a refused send leaves no user message
     * dangling with no reply, and the frontend keeps the draft to retry.
     *
     * A message during a live run is not a second run: it is delivered *into*
     * the provider's interactive control channel, and the model takes it at
     * its next step boundary. The interruption the owner asked for.
     */
    let (reservation, cancel, inject_rx) = {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "the run registry is unavailable".to_string())?;
        if let Some(running) = active.get(&input.project_id) {
            if !can_inject(running.agent, agent) {
                drop(active);
                return Err(BUSY_WITH_RUN.into());
            }
            if agent == Agent::Codex && running.workspace_roots != workspace_roots {
                drop(active);
                return Err(BUSY_WITH_RUN.into());
            }
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

            let user_message =
                user_message_for_send(&app, &state, &input, agent_name, &model, &permission, true)?;

            if inject
                .send(InjectedMessage {
                    body: input.body.clone(),
                    turn_id: user_message.id.clone(),
                })
                .is_err()
            {
                // The run tore down after the row became visible. Hand that
                // same row to the retry queue and report this send as accepted;
                // returning the busy error as well would enqueue it twice.
                let _ = app.emit(
                    "run:inject_failed",
                    serde_json::json!({
                        "projectId": input.project_id,
                        "messageId": user_message.id,
                        "body": input.body,
                    }),
                );
            }
            return Ok(user_message);
        }
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (inject_tx, inject_rx) = tokio::sync::mpsc::unbounded_channel();
        active.insert(
            input.project_id.clone(),
            ActiveRun {
                cancel: cancel_tx,
                agent,
                workspace_roots,
                // Kept for the receiver's lifetime. The capability check above
                // exposes live injection only when the active provider allows it.
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

    let user_message =
        user_message_for_send(&app, &state, &input, agent_name, &model, &permission, false)?;
    // The run exists from this moment: the slot is claimed and the spawn below
    // cannot be refused. This is what starts the transcript's status line —
    // event-driven rather than assumed by the sender, so a backend that fakes
    // no run (the mock) shows no run.
    let _ = app.emit(
        "run:accepted",
        serde_json::json!({
            "projectId": input.project_id,
            "agent": agent_name,
            "model": model,
            "permission": permission,
        }),
    );

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
    let tables = state.tables.clone();
    let running = state.running.clone();
    let io = state.io.clone();
    let approvals = state.approvals.clone();
    let limits = state.limits.clone();
    let receipts = state.receipts.clone();
    let item_id = input.item_id.clone();

    /*
     * A run starting on an item is that item becoming active, and the app
     * watched it happen. Derived rather than asked for: this is the one
     * transition an agent misses most, because it happens before it has said
     * anything, and nothing about it needs the agent's cooperation.
     *
     * Only from a state that is not already it. A row that is `shipped` and
     * gets worked on again is genuinely active again, but re-announcing
     * `active` on every follow-up in the same conversation would be noise.
     */
    if let Some(item) = item_id.as_deref()
        && let Some(row) = state.tables.project_item.select(item.to_string())
        && row.status != "active"
    {
        match state
            .tables
            .project_item
            .update_status_by_id(
                ItemStatusByIdQuery {
                    status: "active".into(),
                },
                item.to_string(),
            )
            .await
        {
            Ok(()) => {
                if let Some(updated) = state.tables.project_item.select(item.to_string()) {
                    let _ = app.emit("item:updated", ProjectItemDto::from(updated));
                }
            }
            Err(error) => crate::log!(
                crate::log::Level::Error,
                "items",
                "could not start {item}: {error}"
            ),
        }
    }
    let project_id = input.project_id.clone();
    let turn_id = user_message.id.clone();
    let effort = input.effort.clone();
    let extra_thinking = input.extra_thinking;

    tauri::async_runtime::spawn(async move {
        drive_run(
            app,
            tables,
            running,
            io,
            approvals,
            limits,
            receipts,
            item_id,
            reservation,
            cancel,
            inject_rx,
            project_id,
            turn_id,
            input.body,
            agent,
            model,
            permission,
            effort,
            extra_thinking,
            scope,
            checkpoint_dir,
        )
        .await;
    });

    Ok(user_message)
}

/// Review a pull request with the chosen agent, inline and read-only.
///
/// A side-channel: the agent runs headlessly on the PR in the project's cwd, and
/// the result lands as a `review`-authored message in the transcript, with a
/// copy button, but is never part of the conversation sent to the Home agent.
/// The owner reads it and pastes it on if they want. Model and prompt come from
/// Settings' review config, both with a default when blank.
///
/// # Errors
/// When the agent is unknown, or the headless run fails.
#[tauri::command]
pub async fn review_pull_request(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    url: String,
    agent: String,
) -> Result<(), String> {
    let agent = parse_agent(Some(&agent))?;
    let settings = state
        .tables
        .kv_get(crate::settings::KEY)
        .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
        .unwrap_or_default();
    let instruction = if settings.review.prompt.trim().is_empty() {
        crate::settings::DEFAULT_REVIEW_PROMPT.to_string()
    } else {
        settings.review.prompt.clone()
    };
    let model = settings
        .review
        .models
        .get(agent_wire_name(agent))
        .cloned()
        .unwrap_or_default();

    let scope = invocation_scope(
        &state.tables,
        &project_id,
        agent,
        crate::workspace_root_path(&app, &state),
        &state.location.path,
    );

    let prompt = format!("{instruction}\n\nThe pull request: {url}");
    let mut request = agent_abstraction::Request::new(agent, prompt).cwd(&scope.cwd);
    for dir in &scope.extra_dirs {
        request = request.add_dir(dir);
    }
    if !model.is_empty() {
        request = request.model(&model);
    }
    let request = crate::experimental::apply(request, agent, &model).map_err(|e| e.to_string())?;

    let outcome = agent_abstraction::run(request.request())
        .await
        .map_err(|error| format!("the review run failed: {error}"))?;

    let body = if outcome.text.trim().is_empty() {
        "The reviewer returned nothing.".to_string()
    } else {
        outcome.text
    };
    let message_id = id("msg");
    let row = MessageRow {
        id: message_id.clone(),
        project_id: project_id.clone(),
        item_id: String::new(),
        author: "review".into(),
        agent: agent_wire_name(agent).into(),
        moderation: String::new(),
        model,
        permission: String::new(),
        usage: String::new(),
        // The PR it reviewed, so the transcript row can say what it is about.
        stop: url,
        exit_code: 0,
        body: body_head(&body),
        created_at: now(),
    };
    state
        .tables
        .message
        .insert(row.clone())
        .map_err(|error| error.to_string())?;
    store_body(&state.tables, &message_id, &project_id, &body);
    let mut appended = MessageDto::from(row);
    appended.body = body;
    let _ = app.emit("message:appended", appended);
    Ok(())
}

/// Build the provider request whose filesystem and resume policy were resolved
/// for this invocation.
///
/// This function is deliberately provider-neutral. AgencyZero supplies typed
/// roots on every call; agent-abstraction owns whether those become CLI flags
/// or Codex app-server workspace-write fields.
fn build_turn_request(
    agent: Agent,
    prompt: String,
    permission: &str,
    model: &str,
    effort: Option<&str>,
    extra_thinking: Option<bool>,
    scope: &InvocationScope,
) -> Request {
    let mut request = Request::new(agent, prompt)
        .permission(parse_permission(Some(permission)))
        .cwd(&scope.cwd);
    for dir in &scope.extra_dirs {
        request = request.add_dir(dir);
    }
    let asks = should_route_approvals(agent, permission);
    if asks && agent.caps().approvals {
        request = request.approvals();
    }
    if agent.caps().live_follow_up {
        request = request.interactive();
    }
    /*
     * Ask for the one-hour prompt cache, not the five-minute default.
     *
     * The whole conversation is re-sent every turn; a cache read is a tenth of
     * the input price, so keeping the prefix warm across replies is where the
     * saving is. On a subscription the CLI already requests 1h and this is a
     * no-op; on an API key it defaults to 5m, and in a long conversation with
     * minutes between turns the 5m cache dies between turns and every turn pays
     * full price for the entire history. The CLI exposes no per-request TTL
     * flag — this env var is the only lever, and it is Claude's. Cache reads
     * refresh the window for free, so an active session rarely pays the higher
     * 1h write more than once.
     */
    if agent == Agent::Claude {
        request = request.env("ENABLE_PROMPT_CACHING_1H", "1");
    }
    if !model.is_empty() {
        request = request.model(model);
    }
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        request = request.effort(effort);
    }
    if extra_thinking == Some(false) {
        request = request.thinking(false);
    }
    if let Some(session) = scope.resume.as_deref().filter(|id| !id.is_empty()) {
        request = request.resume(session);
    }
    request
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
    // The provider's last word on usage, updated as the run reports it and
    // read by the next run's prompt. See `RateLimits`.
    limits: std::sync::Arc<RateLimits>,
    // What became of the last turn's directives, written at the end of this
    // run and read by the next one's prompt. See `Receipts`.
    receipts: std::sync::Arc<Receipts>,
    // The item this turn was started from, when it was started from one. The
    // only case where the app knows what the turn is about.
    item_id: Option<String>,
    // Held for the whole run and dropped on any exit path, so the project's
    // run slot frees exactly when no agent can still be alive.
    _reservation: RunReservation,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    // Messages typed while this run is live, to deliver into the open turn.
    mut inject_rx: tokio::sync::mpsc::UnboundedReceiver<InjectedMessage>,
    project_id: String,
    // The user message that opened this run. PS outcomes emitted by the agent
    // link back to it without retaining the message body in the study table.
    turn_id: String,
    prompt: String,
    agent: Agent,
    model: String,
    permission: String,
    effort: Option<String>,
    // Whether the model may spend reasoning tokens. `Some(false)` disables it;
    // see `SendMessageInput::extra_thinking`.
    extra_thinking: Option<bool>,
    scope: InvocationScope,
    // Where to write knowledge checkpoints, or `None` when this project does
    // not take them. See `checkpoint_if_due`.
    checkpoint_dir: Option<std::path::PathBuf>,
) {
    let cwd = scope.cwd.clone();
    let extra_dirs = scope.extra_dirs.clone();
    let resume = scope.resume.clone();
    let memory_dir = scope.memory_dir.clone();
    let mut directive_turn_id = turn_id;
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
        /*
         * The item/PR list and the last turn's directive receipts ride the user
         * turn, not the system prompt.
         *
         * They change every turn, and a system prompt that changes every turn
         * never caches: on a long conversation Claude then re-bills the whole
         * history at full input price instead of the cache read it should be,
         * which the "cache miss?" chip has been flagging. Regenerated fresh from
         * the store each turn, this needs no compaction survival — so it belongs
         * where changing content is cheap, leaving the system prompt stable and
         * cacheable.
         */
        let snapshot = state_snapshot(&tables, &project_id, item_id.as_deref());
        let receipts_line = receipts
            .lock()
            .ok()
            .and_then(|kept| kept.get(&project_id).cloned())
            .filter(|lines| !lines.is_empty())
            .map(|said| format!("\n\nYour last turn's directives:\n  {}", said.join("\n  ")))
            .unwrap_or_default();
        // The account-usage warning, which climbs every turn: also a per-turn
        // fact, so it rides here rather than in the cached system prompt.
        let usage_line = limits
            .lock()
            .ok()
            .and_then(|kept| kept.get(&(project_id.clone(), agent)).cloned())
            .map(|usage| {
                format!(
                    "\n\nAccount usage, as the provider last reported it: {}. This is not a \
                     refusal; it is a warning that the window is filling. Prefer fewer and \
                     cheaper turns, and say so if you are about to do something expensive.",
                    usage.sentence()
                )
            })
            .unwrap_or_default();
        format!("{prompt}\n\n{snapshot}{receipts_line}{usage_line}")
    };

    // Kept for the I/O panel before the builder consumes them, so the "sent"
    // line shows what actually went out rather than what was asked for.
    let prompt_echo = prompt.clone();
    let effort_echo = effort.clone().filter(|value| !value.is_empty());

    let mut request = build_turn_request(
        agent,
        prompt,
        &permission,
        &model,
        effort.as_deref(),
        extra_thinking,
        &scope,
    );

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

    /*
     * The app's own per-turn operating instructions: how to use the Prompt
     * Syntax surface and the obligations that come with it. Unlike `AgencyZero.md`
     * above, which is read from the run's cwd and so is present only for a
     * project whose checkout ships one, these reach every project — the surface
     * is the app's, and an agent told nothing about it cannot author it. Carried
     * here, in the system prompt, so a compaction cannot lose them.
     *
     * On by default, and a user file overrides the built-in text without a
     * rebuild; the toggle is the deliberate off. See `crate::per_turn`.
     */
    let inject_per_turn = tables
        .kv_get(crate::settings::KEY)
        .and_then(|raw| serde_json::from_str::<crate::settings::GlobalSettings>(&raw).ok())
        .unwrap_or_default()
        .per_turn_injection;
    if inject_per_turn {
        let config_dir = app.state::<crate::AppState>().config_dir.clone();
        let instructions = crate::per_turn::instructions(&config_dir);
        if !instructions.trim().is_empty() {
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(instructions.trim());
        }
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

    /*
     * What the provider last said about usage, told to the agent.
     *
     * It knew nothing about this. A warning was emitted, dropped by the window
     * for not being a refusal, and never reached the thing actually spending
     * the quota, so an agent would happily open a fan-out of subagents on an
     * account already flagged at seventy-five per cent. Read from memory here
     * rather than persisted: it is a fact about an account right now, and one
     * restored from disk a day later would be read as current.
     */
    /*
     * The account-usage sentence also changes every turn (the figures climb),
     * so it too rides the user turn now (built above with `prompt`) rather than
     * busting the system-prompt cache here.
     *
     * The item/PR list and last turn's receipts used to be appended here, but
     * they change every turn and a system prompt that changes every turn never
     * caches. They now ride the user turn (built above with `prompt`), leaving
     * this system prompt static across a conversation and so cacheable: the
     * history is then read from cache rather than re-billed in full each turn.
     */
    if !system.is_empty() {
        request = request.system(system);
    }

    let request = match crate::experimental::apply(request, agent, &model) {
        Ok(request) => request,
        Err(error) => {
            crate::log!(crate::log::Level::Error, "run", "{project_id}: {error}");
            emit_run_stopped(&app, &project_id, agent, &model, &permission, error, None);
            return;
        }
    };

    crate::log!(
        crate::log::Level::Info,
        "run",
        "{project_id}: starting {} model={} permission={permission} cwd={cwd} resume={}",
        agent_wire_name(agent),
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
            "{} model={} permission={permission} effort={}{} cwd={cwd}{}\n\n{prompt_echo}",
            agent_wire_name(agent),
            if model.is_empty() {
                "<default>"
            } else {
                &model
            },
            effort_echo.as_deref().unwrap_or("<none>"),
            // Only when turned off: the default leaves the agent's own thinking
            // in place and does not belong on every request line.
            if extra_thinking == Some(false) {
                " thinking=off"
            } else {
                ""
            },
            if extra_dirs.is_empty() {
                String::new()
            } else {
                format!(" add-dir={}", extra_dirs.join(","))
            },
        ),
    );

    // The previous receipt has now been included in this request. Start a new
    // one before streamed directives arrive so this turn cannot inherit old
    // outcomes and so a live add keeps its newly assigned id in the receipt.
    if let Ok(mut kept) = receipts.lock() {
        kept.remove(&project_id);
    }

    let mut run = match agent_abstraction::stream(request.request()) {
        Ok(run) => run,
        Err(error) => {
            // The one failure the window used to swallow entirely: no run, no
            // reply, no error, just a prompt that appeared to do nothing.
            crate::log!(
                crate::log::Level::Error,
                "run",
                "{project_id}: could not start the agent: {error}"
            );
            emit_run_stopped(
                &app,
                &project_id,
                agent,
                &model,
                &permission,
                format!("could not start the agent: {error}"),
                None,
            );
            return;
        }
    };

    /*
     * Delivery receipts must never share the task that drains agent events.
     *
     * Codex can acknowledge `turn/steer` only after emitting a burst of
     * events. The abstraction's event channel is deliberately bounded, so
     * awaiting that acknowledgement here would stop `run.recv`, fill the
     * channel, and leave both sides waiting forever. A cloneable control handle
     * lets this ordered worker wait for receipts while the loop below keeps
     * making room for every event.
     */
    let (injection_delivery_tx, mut injection_delivery_rx) =
        tokio::sync::mpsc::unbounded_channel::<InjectedMessage>();
    let (injection_failure_tx, mut injection_failure_rx) =
        tokio::sync::mpsc::unbounded_channel::<()>();
    let injection_app = app.clone();
    let injection_io = io.clone();
    let injection_project_id = project_id.clone();
    let injection_control = run.control();
    let injection_delivery = tokio::spawn(async move {
        while let Some(injected) = injection_delivery_rx.recv().await {
            let delivered = deliver_injection(
                &injection_app,
                &injection_io,
                &injection_control,
                &injection_project_id,
                &injected.turn_id,
                injected.body,
            )
            .await;
            if !delivered {
                let _ = injection_failure_tx.send(());
            }
        }
    });

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
     * `Outcome::text` is the provider's settled answer, which can be only the
     * final text block, so persisting it clobbered the narration between tool
     * calls ("I'll check whether that exists.") the moment the run finished.
     * The transcript keeps what the user watched; the terminal text is the
     * fallback for a run that never streamed.
     */
    let mut streamed_text = String::new();
    /*
     * How much of `streamed_text` has been scanned for PS directive lines.
     *
     * Items used to be written only from the finished reply, which made it
     * impossible to open one and then work on it in the same turn: the row did
     * not exist until the turn that proposed it had already ended. So a session
     * asked to follow the procedure could not follow it, and the list only ever
     * described work that was already over.
     */
    let mut directives_scanned_to = 0usize;
    let mut directives_fenced = FenceState::default();

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
    let mut stalled_injection = false;
    // Set when the idle deadline trips: a run that went silent long enough to be
    // treated as wedged. Recovered like a stall rather than reported as a crash.
    let mut idle_stalled = false;

    /// What woke the loop: an agent event, or a message to queue for the
    /// independent delivery worker. Keeping receipt waits off this task is
    /// what guarantees the event stream continues to drain.
    enum Wake {
        Event(Event),
        Inject(InjectedMessage),
    }

    // The idle deadline, as an absolute instant like the approval deadline
    // below. Pushed forward past every event, so it measures silence since the
    // last one rather than total run time; a streaming turn never reaches it,
    // only one emitting nothing at all does.
    let mut idle_deadline = tokio::time::Instant::now() + RUN_IDLE_TIMEOUT;
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
            Some(()) = injection_failure_rx.recv() => {
                // The visible message is already queued for retry. Free the
                // one-run-per-project slot so that retry can resume the same
                // session instead of waiting behind a dead app-server forever.
                cancelled = true;
                stalled_injection = true;
                break;
            }
            () = tokio::time::sleep_until(idle_deadline) => {
                // No event for RUN_IDLE_TIMEOUT: the turn is wedged, almost
                // always on a shell command that never returns. Tear the run
                // down so the slot frees and the session can resume, rather than
                // sit here until the owner notices and hits Stop.
                crate::log!(
                    crate::log::Level::Warn,
                    "run",
                    "{project_id}: no output for {}s — treating the run as wedged and stopping it",
                    RUN_IDLE_TIMEOUT.as_secs()
                );
                cancelled = true;
                idle_stalled = true;
                break;
            }
            injected = inject_rx.recv() => match injected {
                Some(body) => Wake::Inject(body),
                // The sender lives in the registry this run owns a slot in;
                // it closing early is a teardown already in progress.
                None => continue,
            },
        };
        // The run is alive: push the idle deadline past this event so only
        // silence *after* it, not total run time, can trip the timeout.
        idle_deadline = tokio::time::Instant::now() + RUN_IDLE_TIMEOUT;
        let event = match wake {
            Wake::Event(event) => event,
            Wake::Inject(injected) => {
                // A correction typed mid-turn. The user row was persisted and
                // broadcast by `send_message`. Queue it without waiting for
                // Codex's receipt so this task can immediately drain events.
                directive_turn_id.clone_from(&injected.turn_id);
                let _ = injection_delivery_tx.send(injected);
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

                // Log every question that reaches a human, not just the ones a
                // remembered rule answers. A Codex escalation
                // (`require_escalated`) that surfaced but was never seen used to
                // sit on the full APPROVAL_TIMEOUT with nothing in the log to
                // say a decision was even being waited on: the run read as
                // hung when it was in fact blocked on the owner.
                crate::log!(
                    crate::log::Level::Info,
                    "run",
                    "{project_id}: waiting for the owner to answer [{signature}]"
                );

                let _ = app.emit(
                    "run:approval",
                    serde_json::json!({
                        "projectId": project_id,
                        "agent": agent,
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
                 * and do X instead". Delivery is queued to the independent
                 * worker; the deadline is absolute so servicing a message
                 * cannot extend the timeout.
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
                        Some(()) = injection_failure_rx.recv() => {
                            cancelled = true;
                            stalled_injection = true;
                            break None;
                        }
                        injected = inject_rx.recv() => {
                            if let Some(injected) = injected {
                                directive_turn_id.clone_from(&injected.turn_id);
                                let _ = injection_delivery_tx.send(injected);
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
                /*
                 * Interactive providers may emit one visible message as many
                 * adjacent Text deltas. Preserve that adjacency. A tool,
                 * reasoning event, or injected user message clears
                 * `last_was_text`, which gives the next visible message its
                 * own block without inserting whitespace between tokens.
                 */
                let delta = if needs_text_break(streamed_any, last_was_text) {
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
                 * Directives take effect as their complete line arrives.
                 *
                 * Only whole lines: the scan stops at the last newline seen, so
                 * a directive still being streamed is never read as a shorter
                 * one.
                 *
                 * The end-of-turn pass handles only the unscanned tail, as a
                 * backstop for a final line with no newline after it.
                 */
                while let Some(at) = streamed_text[directives_scanned_to..].find('\n') {
                    let end = directives_scanned_to + at + 1;
                    let line = streamed_text[directives_scanned_to..end].to_string();
                    directives_scanned_to = end;
                    /*
                     * Never gate PS parsing on another grammar. The old code
                     * called `apply_directives` only after a checkbox matched,
                     * so a standalone `items.state` line was guaranteed to be
                     * skipped until the turn ended.
                     */
                    let done = apply_directives_with_state(
                        &app,
                        &tables,
                        &project_id,
                        &directive_turn_id,
                        agent_wire_name(agent),
                        &line,
                        &mut directives_fenced,
                    )
                    .await;
                    if !done.is_empty() {
                        note_io(
                            &app,
                            &io,
                            &project_id,
                            "received",
                            "directive",
                            done.iter()
                                .map(crate::directives::Outcome::line)
                                .collect::<Vec<_>>()
                                .join("; "),
                        );
                        queue_directive_receipts(
                            &receipts,
                            &tables,
                            &project_id,
                            &directive_turn_id,
                            agent_wire_name(agent),
                            &done,
                        );
                    }
                }

                if partial_flushed_at.elapsed() >= PARTIAL_FLUSH_EVERY {
                    partial_flushed_at = std::time::Instant::now();
                    /*
                     * Capped like every persisted blob: an oversized row has
                     * corrupted a table twice on this machine, and this one
                     * shares a table with the schema fingerprint. A truncated
                     * checkpoint recovers the head of an interrupted reply,
                     * which beats both a corrupted kv and no checkpoint; the
                     * finished reply is unaffected — it lands as a message
                     * row, not here.
                     */
                    let checkpoint =
                        encode_partial_reply(&streamed_text, agent, &model, &permission);
                    match tables
                        .kv_put(&partial_reply_key(&project_id), checkpoint)
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
                    // Capped: an oversized row corrupts the table it was
                    // refused from. See MAX_PERSISTED_BLOB.
                    output: truncate_to_bytes(&output, MAX_PERSISTED_BLOB),
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
                /*
                 * A warning is not a heartbeat and not a refusal, and it used
                 * to have nowhere to go: emitted, dropped by the window for
                 * not being blocking, and never reaching the agent at all. So
                 * neither the person nor the thing spending the quota could
                 * see it coming. The status word carries it, so it is read
                 * once here rather than sniffed for in three places.
                 */
                let is_warning =
                    !limit.is_blocking() && limit.status.to_ascii_lowercase().contains("warning");
                let report = RateLimitReport {
                    project_id: project_id.clone(),
                    agent,
                    message: message.clone(),
                    resets_at: resets_at.clone(),
                    is_blocking: limit.is_blocking(),
                    is_warning,
                    at: now(),
                };
                if let Ok(mut kept) = limits.lock() {
                    // Plain `allowed` is a heartbeat: it replaces nothing and
                    // is not worth keeping, so a warning stays visible until
                    // the provider says something else that matters.
                    if report.is_blocking || report.is_warning {
                        kept.insert((project_id.clone(), agent), report.clone());
                    } else {
                        kept.remove(&(project_id.clone(), agent));
                    }
                }
                let _ = app.emit("run:rate_limit", &report);
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
                        "agent": agent,
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
                        "agent": agent,
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
                    .kv_put(&agent_session_key(&project_id, agent), session.clone())
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

    /*
     * Close both input stages before teardown or persistence. The run slot is
     * still held, so a new `send_message` can otherwise enqueue into a receiver
     * this function no longer polls and report success even though the words
     * are lost. Once the receiver is gone, the caller takes the existing
     * `run:inject_failed` recovery path and starts a fresh resumed turn.
     */
    drop(inject_rx);
    drop(injection_delivery_tx);

    // One write, now that there is something final to write.
    let result = if cancelled {
        note_io(
            &app,
            &io,
            &project_id,
            "sent",
            "cancel",
            if idle_stalled {
                "the run went idle with no output for too long, likely wedged on a command that never returns; stopped so the session can resume"
            } else if stalled_injection {
                "interactive delivery stalled — restarting the run so the queued message can resume the session"
            } else {
                "stop requested — tearing the agent down and waiting for it to exit"
            },
        );
        // Cooperative and awaited: when this returns, the process group is
        // actually gone, not merely asked to leave.
        run.cancel().await
    } else {
        run.finish().await
    };

    // Finishing or cancelling the run closes every outstanding receipt. Let
    // the ordered worker report any rejected messages before the run slot is
    // released and a resumed turn begins.
    if let Err(error) = injection_delivery.await {
        crate::log!(
            crate::log::Level::Error,
            "run",
            "{project_id}: injection delivery worker failed: {error}"
        );
    }

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
        emit_run_stopped(
            &app,
            &project_id,
            agent,
            &model,
            &permission,
            "canceled",
            None,
        );
        return;
    }

    match result {
        Ok(outcome) => {
            /*
             * The body is what the user watched stream, block breaks and all.
             * `outcome.text` is the provider's settled answer, which can be
             * only the final block, and persisting it was how the narration between
             * tool calls vanished the moment a run finished. The terminal
             * text remains the fallback for a run that never streamed.
             */
            let used_streamed_body = !streamed_text.trim().is_empty();
            let body = if used_streamed_body {
                streamed_text
            } else {
                outcome.text.clone()
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
                agent: agent_wire_name(agent).into(),
                moderation: String::new(),
                model: model.clone(),
                permission: permission.clone(),
                // Empty means the agent reported nothing, which the transcript
                // renders as an em dash. Zeroes would read as a free turn.
                usage: if outcome.usage.is_empty() {
                    String::new()
                } else {
                    serde_json::to_string(&UsageDto::from(&outcome.usage)).unwrap_or_default()
                },
                stop: stop.clone(),
                exit_code: i64::from(outcome.exit_code),
                body: body_head(&body),
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
                emit_run_stopped(
                    &app,
                    &project_id,
                    agent,
                    &model,
                    &permission,
                    format!("the reply could not be persisted: {error}"),
                    None,
                );
                return;
            }
            store_body(&tables, &row.id, &project_id, &body);
            // Emit the whole reply, not just the stored head: the reader would
            // otherwise round-trip the chunks this just wrote.
            let mut appended = MessageDto::from(row);
            appended.body = body.clone();
            let _ = app.emit("message:appended", appended);
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
                let ledger_at = ledger.at.clone();
                let ledger_day = ledger.day.clone();
                if let Err(error) = tables.usage_ledger.insert(ledger) {
                    crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not record the cost: {error}"
                    );
                }
                // The cache split for this turn, in its own table so the
                // analytics view can show read-vs-write over time. A turn that
                // read or wrote no cache still records zeros, so the series has
                // a point per priced turn.
                let cache_row = crate::db::schema::usage_cache::UsageCacheRow {
                    id: id("cache"),
                    day: ledger_day,
                    project_id: project_id.clone(),
                    model: model.clone(),
                    cache_read_tokens: outcome
                        .usage
                        .cache_read_tokens
                        .and_then(|tokens| i64::try_from(tokens).ok())
                        .unwrap_or(0),
                    cache_write_tokens: outcome
                        .usage
                        .cache_write_tokens
                        .and_then(|tokens| i64::try_from(tokens).ok())
                        .unwrap_or(0),
                    input_tokens: outcome
                        .usage
                        .input_tokens
                        .and_then(|tokens| i64::try_from(tokens).ok())
                        .unwrap_or(0),
                    at: ledger_at,
                };
                if let Err(error) = tables.usage_cache.insert(cache_row) {
                    crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not record the cache split: {error}"
                    );
                }
            }

            /*
             * One reverse-channel parser for Home and project tabs. The
             * mid-stream path has already applied every complete line.
             * Only the unscanned tail is handled here, which catches a final
             * directive without a newline while preserving the exact receipt
             * from a live add instead of replaying it as "already open".
             */
            let tail_at = if used_streamed_body {
                directives_scanned_to.min(body.len())
            } else {
                0
            };
            let done = if used_streamed_body {
                apply_directives_with_state(
                    &app,
                    &tables,
                    &project_id,
                    &directive_turn_id,
                    agent_wire_name(agent),
                    &body[tail_at..],
                    &mut directives_fenced,
                )
                .await
            } else {
                apply_directives(
                    &app,
                    &tables,
                    &project_id,
                    &directive_turn_id,
                    agent_wire_name(agent),
                    &body,
                )
                .await
            };
            if !done.is_empty() {
                note_io(
                    &app,
                    &io,
                    &project_id,
                    "received",
                    "directive",
                    done.iter()
                        .map(crate::directives::Outcome::line)
                        .collect::<Vec<_>>()
                        .join("; "),
                );
                queue_directive_receipts(
                    &receipts,
                    &tables,
                    &project_id,
                    &directive_turn_id,
                    agent_wire_name(agent),
                    &done,
                );
            }
            emit_run_stopped(
                &app,
                &project_id,
                agent,
                &model,
                &permission,
                stop,
                Some(i64::from(outcome.exit_code)),
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
                let canceled_body = streamed_text.clone();
                let row = MessageRow {
                    id: id("msg"),
                    project_id: project_id.clone(),
                    item_id: String::new(),
                    author: "agent".into(),
                    agent: agent_wire_name(agent).into(),
                    moderation: String::new(),
                    model: model.clone(),
                    permission: permission.clone(),
                    usage: String::new(),
                    stop: "canceled".into(),
                    exit_code: -1,
                    body: body_head(&canceled_body),
                    created_at: now(),
                };
                match tables.message.insert(row.clone()) {
                    Ok(_) => {
                        store_body(&tables, &row.id, &project_id, &canceled_body);
                        let mut appended = MessageDto::from(row);
                        appended.body = canceled_body.clone();
                        let _ = app.emit("message:appended", appended);
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
            emit_run_stopped(
                &app,
                &project_id,
                agent,
                &model,
                &permission,
                "canceled",
                None,
            );
        }
        Err(error) => {
            crate::log!(
                crate::log::Level::Error,
                "run",
                "{project_id}: the run failed: {error}"
            );
            /*
             * A failure after the agent spoke does not unsay the words.
             *
             * This branch used to report the error and drop `streamed_text`,
             * so a turn the user had just watched arrive vanished and was
             * replaced by a banner. That is the visible half of every
             * misclassification: on 2026-08-01 an account crossing 75% of its
             * weekly window made the crate read `allowed_warning` as a
             * refusal, and every finished answer was erased by a rate-limit
             * notice quoting one of its own sentences back.
             *
             * The crate-side fixes are in 0.4.3, and this is the half that
             * does not depend on them being right. Whatever the classifier
             * decides, an answer that reached the screen reaches the
             * transcript, and the error is reported alongside it rather than
             * instead of it. The cancelled branch above has always worked
             * this way; a failure is the same situation with a different
             * label.
             *
             * No usage row and no harvest, exactly as with a cancellation: a
             * turn that ended badly reported no cost, and its words are not a
             * finished answer to mine for tasks.
             */
            if !streamed_text.trim().is_empty() {
                let row = MessageRow {
                    id: id("msg"),
                    project_id: project_id.clone(),
                    item_id: String::new(),
                    author: "agent".into(),
                    agent: agent_wire_name(agent).into(),
                    moderation: String::new(),
                    model: model.clone(),
                    permission: permission.clone(),
                    usage: String::new(),
                    // The reason, kept with the words it interrupted, so the
                    // transcript can explain itself later.
                    stop: error.to_string(),
                    exit_code: -1,
                    body: body_head(&streamed_text),
                    created_at: now(),
                };
                let failed_body = streamed_text.clone();
                match tables.message.insert(row.clone()) {
                    Ok(_) => {
                        store_body(&tables, &row.id, &project_id, &failed_body);
                        let mut appended = MessageDto::from(row);
                        appended.body = failed_body.clone();
                        let _ = app.emit("message:appended", appended);
                        clear_partial_reply(&tables, &project_id).await;
                    }
                    // Left in place deliberately: the checkpoint is what the
                    // next boot recovers these words from.
                    Err(error) => crate::log!(
                        crate::log::Level::Error,
                        "run",
                        "{project_id}: could not persist the failed turn: {error}"
                    ),
                }
            }
            emit_run_stopped(
                &app,
                &project_id,
                agent,
                &model,
                &permission,
                error.to_string(),
                None,
            );
        }
    }

    checkpoint_if_due(
        &app,
        &tables,
        &project_id,
        agent,
        &model,
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
#[expect(
    clippy::too_many_arguments,
    reason = "the checkpoint turn borrows one value from each run concern without owning them"
)]
async fn checkpoint_if_due(
    app: &AppHandle,
    tables: &std::sync::Arc<crate::db::tables::Tables>,
    project_id: &str,
    agent: Agent,
    model: &str,
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
            .filter(|row| row.agent == agent_wire_name(agent))
            .filter_map(|row| serde_json::from_str::<UsageDto>(&row.usage).ok())
            .filter_map(|dto| dto.context_window)
            .next_back()
    });
    let mark = tables
        .kv_get(&crate::notes::checkpoint_mark_key(
            project_id,
            agent_wire_name(agent),
        ))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let Some(threshold) = crate::notes::due(context_tokens, mark) else {
        return;
    };
    // Nothing to resume means nothing to sample; the crossing cannot have
    // happened without a session.
    let Some(session) = tables
        .kv_get(&agent_session_key(project_id, agent))
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
            "agent": agent,
            "phase": "started",
            "threshold": threshold,
        }),
    );

    let existing = tables
        .kv_get(&crate::notes::notes_key(project_id))
        .unwrap_or_default();
    let request = agent_abstraction::Request::new(agent, crate::notes::merge_prompt(&existing))
        .cwd(cwd)
        .resume(&session);
    let request = match crate::experimental::apply(request, agent, model) {
        Ok(request) => request,
        Err(error) => {
            crate::log!(
                crate::log::Level::Warn,
                "run",
                "{project_id}: the {threshold} checkpoint could not prepare: {error}"
            );
            return;
        }
    };

    let taken = match agent_abstraction::run(request.request()).await {
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
            &crate::notes::checkpoint_mark_key(project_id, agent_wire_name(agent)),
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
            .join(agent_wire_name(agent))
            .join(crate::notes::sample_name(threshold, &stamp));
        let document = crate::notes::sample_document(
            threshold,
            context_tokens,
            context_window,
            &stamp,
            agent_wire_name(agent),
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
                    agent: agent_wire_name(agent).into(),
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
            "agent": agent,
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
    fn github_issues_are_canonical_and_pull_requests_are_refused() {
        assert_eq!(
            github_issue_url("https://github.com/pathscale/agencyzero/issues/42/"),
            Some("https://github.com/pathscale/agencyzero/issues/42".into())
        );
        assert_eq!(
            github_issue_url("https://github.com/pathscale/agencyzero/pull/42"),
            None
        );
    }

    #[test]
    fn partial_reply_checkpoints_keep_provider_identity_within_the_blob_limit() {
        let raw = encode_partial_reply(
            &"reply ".repeat(MAX_PERSISTED_BLOB),
            Agent::Codex,
            "gpt-5.6-sol",
            "edit",
        );
        assert!(raw.len() <= MAX_PERSISTED_BLOB);

        let recovered = decode_partial_reply(raw);
        assert_eq!(recovered.version, 1);
        assert_eq!(recovered.agent, "codex");
        assert_eq!(recovered.model, "gpt-5.6-sol");
        assert_eq!(recovered.permission, "edit");
        assert!(recovered.body.contains("checkpoint truncated"));
    }

    #[test]
    fn legacy_partial_replies_recover_as_the_only_provider_that_could_write_them() {
        let recovered = decode_partial_reply("unfinished words".into());
        assert_eq!(recovered.version, 0);
        assert_eq!(recovered.agent, "claude");
        assert_eq!(recovered.body, "unfinished words");
    }

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

    #[test]
    fn codex_permission_rules_name_the_exact_write_roots() {
        let input = serde_json::json!({
            "permissions": {"fileSystem": {"write": ["/repo-b", "/repo-a", "/repo-a"]}}
        });
        assert_eq!(
            approval_signature("Permissions", &input),
            "Permissions: write /repo-a, /repo-b"
        );
        assert_ne!(
            approval_signature("Permissions", &input),
            approval_signature(
                "Permissions",
                &serde_json::json!({
                    "permissions": {"fileSystem": {"write": ["/somewhere-else"]}}
                })
            )
        );
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

    #[test]
    fn project_agents_are_explicit_and_copilot_stays_out() {
        assert_eq!(parse_agent(None), Ok(Agent::Claude));
        assert_eq!(parse_agent(Some("claude")), Ok(Agent::Claude));
        assert_eq!(parse_agent(Some("codex")), Ok(Agent::Codex));
        assert!(parse_agent(Some("copilot")).is_err());
        assert!(parse_agent(Some("unknown")).is_err());
    }

    #[test]
    fn provider_sessions_cannot_cross() {
        assert_eq!(agent_session_key("proj-1", Agent::Claude), "session:proj-1");
        assert_eq!(
            agent_session_key("proj-1", Agent::Codex),
            "session:codex:proj-1"
        );
        assert_ne!(
            agent_session_key("proj-1", Agent::Claude),
            agent_session_key("proj-1", Agent::Codex)
        );
    }

    #[tokio::test]
    async fn codex_request_contains_primary_attached_and_project_memory_roots() {
        let store = std::env::temp_dir().join(format!(
            "az-codex-roots-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let tables = Tables::open(&store).await.expect("scope store opens");
        let mut row = project_row("proj-roots", "Roots");
        row.dirs = serde_json::to_string(&vec!["/repo-a", "/repo-b"]).unwrap();
        tables.project.insert(row).expect("project inserts");

        let scope = invocation_scope(
            &tables,
            "proj-roots",
            Agent::Codex,
            "/managed/project".into(),
            &store,
        );
        let memory = store
            .join("memory/proj-roots")
            .to_string_lossy()
            .into_owned();
        assert_eq!(scope.cwd, "/managed/project");
        assert_eq!(scope.extra_dirs, vec!["/repo-a", "/repo-b", &memory]);
        assert_eq!(
            scope.workspace_roots(),
            vec!["/managed/project", "/repo-a", "/repo-b", &memory]
        );
        assert!(
            !scope
                .workspace_roots()
                .contains(&store.to_string_lossy().into_owned()),
            "the database parent is not a root"
        );
        assert!(
            !scope
                .workspace_roots()
                .contains(&"/Users/revenge/code".into())
        );
        assert!(!scope.workspace_roots().contains(&"/Users/revenge".into()));

        let request = build_turn_request(
            Agent::Codex,
            "probe".into(),
            "auto",
            "gpt-5.6-sol",
            Some("high"),
            None,
            &scope,
        );
        let described = format!("{request:?}");
        for root in ["/managed/project", "/repo-a", "/repo-b", &memory] {
            assert!(
                described.contains(root),
                "request omitted {root}: {described}"
            );
        }

        tables.shutdown().await.expect("tables drain");
        let _ = std::fs::remove_dir_all(&store);
    }

    /// Exact regression for 0.1.62: the session id already exists, then the
    /// project gains another directory. The following request must resume that
    /// same Codex thread with the newly persisted root.
    #[tokio::test]
    async fn resumed_codex_session_applies_directory_added_after_session_creation() {
        let store = std::env::temp_dir().join(format!(
            "az-codex-resume-roots-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let tables = Tables::open(&store).await.expect("scope store opens");
        let mut row = project_row("proj-resume", "Resume roots");
        row.dirs = serde_json::to_string(&vec!["/repo-a"]).unwrap();
        tables.project.insert(row).expect("project inserts");
        tables
            .kv_put(
                &agent_session_key("proj-resume", Agent::Codex),
                "thread-existing".into(),
            )
            .await
            .expect("session persists");

        let before = invocation_scope(
            &tables,
            "proj-resume",
            Agent::Codex,
            "/managed/project".into(),
            &store,
        );
        assert!(!before.workspace_roots().contains(&"/repo-b".into()));

        write_project_dirs(
            &tables,
            "proj-resume",
            vec!["/repo-a".into(), "/repo-b".into()],
        )
        .await
        .expect("new root persists");
        tables.shutdown().await.expect("tables drain");

        let reopened = Tables::open(&store)
            .await
            .expect("persisted project reopens");
        let after = invocation_scope(
            &reopened,
            "proj-resume",
            Agent::Codex,
            "/managed/project".into(),
            &store,
        );
        assert_eq!(after.resume.as_deref(), Some("thread-existing"));
        assert!(after.workspace_roots().contains(&"/repo-a".into()));
        assert!(after.workspace_roots().contains(&"/repo-b".into()));

        let request = build_turn_request(
            Agent::Codex,
            "continue".into(),
            "auto",
            "gpt-5.6-sol",
            None,
            None,
            &after,
        );
        let described = format!("{request:?}");
        assert!(described.contains("Resume(\"thread-existing\")"));
        assert!(described.contains("/repo-b"));

        reopened.shutdown().await.expect("tables drain");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[tokio::test]
    async fn claude_directory_scope_is_unchanged_and_excludes_agency_memory() {
        let store = std::env::temp_dir().join(format!(
            "az-claude-roots-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let tables = Tables::open(&store).await.expect("scope store opens");
        let mut row = project_row("proj-claude", "Claude roots");
        row.dirs = serde_json::to_string(&vec!["/repo-a", "/repo-b"]).unwrap();
        tables.project.insert(row).expect("project inserts");

        let scope = invocation_scope(
            &tables,
            "proj-claude",
            Agent::Claude,
            "/managed/project".into(),
            &store,
        );
        assert_eq!(scope.cwd, "/repo-a");
        assert_eq!(scope.extra_dirs, vec!["/repo-b"]);
        assert!(
            !scope
                .workspace_roots()
                .contains(&scope.memory_dir.to_string_lossy().into_owned())
        );

        let argv = build_turn_request(
            Agent::Claude,
            "continue".into(),
            "edit",
            "sonnet",
            None,
            None,
            &scope,
        )
        .argv()
        .expect("Claude request is valid");
        let add_dirs: Vec<_> = argv
            .windows(2)
            .filter(|pair| pair[0] == "--add-dir")
            .map(|pair| pair[1].as_str())
            .collect();
        assert_eq!(add_dirs, ["/repo-b"]);

        tables.shutdown().await.expect("tables drain");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn live_follow_up_uses_the_providers_capability() {
        assert!(can_inject(Agent::Claude, Agent::Claude));
        assert!(can_inject(Agent::Codex, Agent::Codex));
        assert!(!can_inject(Agent::Claude, Agent::Codex));
        assert!(!can_inject(Agent::Codex, Agent::Claude));
    }

    #[test]
    fn codex_auto_can_ask_for_a_missing_workspace_root() {
        assert!(should_route_approvals(Agent::Codex, "auto"));
        assert!(should_route_approvals(Agent::Codex, "ask"));
        assert!(!should_route_approvals(Agent::Codex, "edit"));
        assert!(!should_route_approvals(Agent::Claude, "auto"));
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

    /// The page-safety caps count bytes, because the engine does. A
    /// char-counted cap waved 32K of CJK through and the store died of it.
    #[test]
    fn a_page_safety_cap_counts_bytes_not_characters() {
        let wide = "字".repeat(4_000);
        assert!(wide.len() > 8_000, "the setup must exceed the cap in bytes");

        let cut = truncate_to_bytes(&wide, 8_000);
        assert!(cut.len() <= 8_000, "cut to bytes, not characters");
        assert!(cut.ends_with('…'));
        let head: String = cut.chars().take(10).collect();
        assert_eq!(head, "字".repeat(10), "no character was split");
        assert_eq!(truncate_to_bytes("short", 8_000), "short");
    }

    #[tokio::test]
    async fn a_rejected_live_steer_retries_the_same_transcript_row() {
        let store = std::env::temp_dir().join(format!(
            "az-codex-steer-retry-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let tables = crate::db::tables::Tables::open(&store)
            .await
            .expect("message store opens");
        let row = MessageRow {
            id: "msg-visible".into(),
            project_id: "proj-steer".into(),
            item_id: String::new(),
            author: "user".into(),
            agent: "codex".into(),
            moderation: String::new(),
            model: "gpt-5.6-sol".into(),
            permission: "auto".into(),
            usage: String::new(),
            stop: "completed".into(),
            exit_code: -1,
            body: "change course".into(),
            created_at: now(),
        };
        tables.message.insert(row).expect("visible row inserts");
        let input = SendMessageInput {
            project_id: "proj-steer".into(),
            body: "change course".into(),
            retry_message_id: Some("msg-visible".into()),
            item_id: None,
            agent: Some("codex".into()),
            model: Some("gpt-5.6-sol".into()),
            permission: Some("auto".into()),
            effort: None,
            extra_thinking: None,
            study: None,
        };

        let retried = retry_user_message(&tables, &input)
            .expect("retry validates")
            .expect("retry resolves");
        assert_eq!(retried.id, "msg-visible");
        assert_eq!(
            tables
                .message
                .select_by_project_id("proj-steer".into())
                .execute()
                .expect("messages read")
                .len(),
            1,
            "recovery must not append the same user words twice"
        );

        let mismatched = SendMessageInput {
            body: "different words".into(),
            ..input
        };
        assert!(retry_user_message(&tables, &mismatched).is_err());

        tables.shutdown().await.expect("tables drain");
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn a_body_over_the_page_survives_whole_across_a_reopen() {
        let store = std::env::temp_dir().join(format!(
            "az-chunk-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let tables = crate::db::tables::Tables::open(&store)
            .await
            .expect("chunk store opens");

        // A body well past the 12K inline cap, with a marker every 1000 bytes so
        // a dropped or reordered chunk is visible rather than hidden by
        // repetition.
        let mut body = String::new();
        for i in 0..40 {
            body.push_str(&format!("[block {i:02}]"));
            body.push_str(&"x".repeat(1000));
        }
        assert!(body.len() > MAX_MESSAGE_BODY);

        let row = MessageRow {
            id: "msg-big".into(),
            project_id: "proj-big".into(),
            item_id: String::new(),
            author: "agent".into(),
            agent: "claude".into(),
            moderation: String::new(),
            model: "opus".into(),
            permission: "auto".into(),
            usage: String::new(),
            stop: "completed".into(),
            exit_code: 0,
            body: body_head(&body),
            created_at: now(),
        };
        tables.message.insert(row).expect("head row inserts");
        store_body(&tables, "msg-big", "proj-big", &body);

        // The inline head alone is capped; the whole body comes back only once
        // the chunks are stitched on.
        let head_only = tables
            .message
            .select("msg-big".to_string())
            .expect("row present")
            .body;
        assert!(
            head_only.len() <= MAX_MESSAGE_BODY,
            "the head must fit a page"
        );
        assert_eq!(full_body(&tables, "msg-big", &head_only), body);

        // And it survives a reopen: the chunks are persisted, not in-memory.
        tables.shutdown().await.expect("tables drain");
        let reopened = crate::db::tables::Tables::open(&store)
            .await
            .expect("chunk store reopens");
        let head = reopened
            .message
            .select("msg-big".to_string())
            .expect("row present after reopen")
            .body;
        assert_eq!(
            full_body(&reopened, "msg-big", &head),
            body,
            "a body that spilled across pages must read back whole after a reopen"
        );

        reopened.shutdown().await.expect("reopen drains");
        let _ = std::fs::remove_dir_all(store);
    }

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

    #[test]
    fn streamed_deltas_stay_together_and_other_events_make_blocks() {
        assert!(!needs_text_break(true, true));
        assert!(needs_text_break(true, false));
        assert!(!needs_text_break(false, false));
    }

    #[test]
    fn streamed_fences_and_markdown_quotes_keep_ps_inert() {
        let directive = r#"<ps @agency:items.add(ref: "t1", title: "Do it")>"#;
        let mut fenced = FenceState::default();

        assert_eq!(authored_directive_line("```text\n", &mut fenced), None);
        assert_eq!(fenced.0, Some(('`', 3)));
        assert_eq!(authored_directive_line(directive, &mut fenced), None);
        assert_eq!(authored_directive_line("```\n", &mut fenced), None);
        assert_eq!(fenced, FenceState::default());

        assert_eq!(
            authored_directive_line(&format!("> {directive}"), &mut fenced),
            None
        );
        assert_eq!(
            authored_directive_line(&format!("    {directive}"), &mut fenced),
            None
        );
        assert_eq!(
            authored_directive_line(directive, &mut fenced),
            Some(directive)
        );
    }

    #[test]
    fn direct_use_flag_obeys_the_same_inert_content_rules() {
        let directive = r#"<ps @agency:items.state(id: "item-a3f9", status: "active")>"#;
        assert!(user_authored_ps(directive));
        assert!(!user_authored_ps(&format!("```text\n{directive}\n```")));
        assert!(!user_authored_ps(&format!("> {directive}")));
    }

    #[tokio::test]
    async fn study_targets_use_resolved_ids_instead_of_authored_prefixes() {
        let dir = std::env::temp_dir().join(format!("az-study-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let tables = crate::db::tables::Tables::open(&dir)
            .await
            .expect("study target store opens");
        tables
            .project_item
            .insert(ProjectItemRow {
                id: "item-a3f9-canonical".into(),
                project_id: "project-private".into(),
                title: "not collected".into(),
                status: "active".into(),
                position: 0,
                reference: String::new(),
            })
            .expect("item inserts");

        let target = study_target_before(
            &tables,
            &crate::directives::Directive::ItemState {
                id: "item-a3f9".into(),
                status: "shipped".into(),
                pr: None,
            },
        );
        assert_eq!(target.id, "item-a3f9-canonical");
        assert_eq!(target.kind, "item");
    }

    #[tokio::test]
    async fn state_snapshot_exposes_one_canonical_pr_association_with_retire_guidance() {
        let dir = std::env::temp_dir().join(format!(
            "az-pr-state-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let tables = crate::db::tables::Tables::open(&dir)
            .await
            .expect("PR state store opens");

        for row in [
            crate::db::schema::pull_request::PullRequestRow {
                id: "pr-stale".into(),
                project_id: "project-private".into(),
                url: "https://github.com/pathscale/WorkTable/pull/46".into(),
                repo: "pathscale/WorkTable".into(),
                number: 46,
                branch: "feature".into(),
                state: "OPEN".into(),
                additions: 1,
                deletions: 0,
                ci: "pending".into(),
                dismissed: false,
                updated_at: "2026-08-03T00:00:00Z".into(),
            },
            crate::db::schema::pull_request::PullRequestRow {
                id: "pr-current".into(),
                project_id: "project-private".into(),
                url: "https://github.com/pathscale/worktable/pull/46/".into(),
                repo: "pathscale/worktable".into(),
                number: 46,
                branch: "feature".into(),
                state: "CLOSED".into(),
                additions: 1,
                deletions: 0,
                ci: "none".into(),
                dismissed: false,
                updated_at: "2026-08-04T00:00:00Z".into(),
            },
        ] {
            tables.pull_request.insert(row).expect("PR row inserts");
        }

        let snapshot = state_snapshot(&tables, "project-private", None);
        assert!(snapshot.contains("pr-current · pathscale/worktable#46 · closed"));
        assert!(!snapshot.contains("pr-stale"));
        assert!(snapshot.contains("@agency:pr.retire(id: \"<pr association id>\")"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_different_or_shorter_fence_cannot_promote_quoted_ps() {
        let directive = r#"<ps @agency:items.retire(id: "item-a3f9")>"#;
        let mut fenced = FenceState::default();

        assert_eq!(authored_directive_line("````rust", &mut fenced), None);
        assert_eq!(fenced.0, Some(('`', 4)));
        assert_eq!(authored_directive_line("~~~", &mut fenced), None);
        assert_eq!(authored_directive_line("```", &mut fenced), None);
        assert_eq!(authored_directive_line(directive, &mut fenced), None);
        assert_eq!(fenced.0, Some(('`', 4)));

        assert_eq!(authored_directive_line("````", &mut fenced), None);
        assert_eq!(fenced, FenceState::default());
        assert_eq!(
            authored_directive_line(directive, &mut fenced),
            Some(directive)
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
