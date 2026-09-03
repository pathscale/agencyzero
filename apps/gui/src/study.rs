//! Opt-in, content-free instrumentation for the PromptSyntax deployment study.
//!
//! This is not general telemetry. Nothing is uploaded, collection is off by
//! default, and the event shape has no field for prompt text, agent prose,
//! titles, paths, URLs or tool output. It measures the declared control path:
//! a turn, a PS or manual operation, and the operation's explicit outcome.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use worktable::prelude::*;

use crate::db::schema::study_event::StudyEventRow;
use crate::db::tables::Tables;
use crate::settings::{GlobalSettings, StudyAnalytics};
use crate::{AppHandle, AppState};

pub const PROTOCOL_VERSION: &str = "agencyzero-ps-deployment-study/0.1";
pub const PARSER_VERSION: &str = "promptsyntax-rs/0.1.1";
const MAX_DETAIL_BYTES: usize = 2_000;
const DETAIL_KEYS: &[&str] = &[
    "attachmentCount",
    "characterCount",
    "followup",
    "itemCount",
    "lineCount",
    "outcomeCount",
    "userAuthoredPs",
];

/// One operation observed while the study setting is enabled.
///
/// Every field is application-owned metadata. Callers cannot put arbitrary
/// prose into the row: `detail` accepts only objects made from counters,
/// booleans and nulls, and is checked again before persistence.
pub struct Record {
    pub project_id: String,
    pub turn_id: String,
    pub interaction_id: String,
    pub agent: String,
    pub pathway: &'static str,
    pub operation: &'static str,
    pub stage: &'static str,
    pub outcome: &'static str,
    pub code: String,
    pub target_kind: &'static str,
    pub target_id: String,
    pub latency: Option<Duration>,
    pub detail: Value,
}

impl Record {
    #[must_use]
    pub fn manual(
        project_id: impl Into<String>,
        operation: &'static str,
        target_kind: &'static str,
        target_id: impl Into<String>,
    ) -> Self {
        Self {
            project_id: project_id.into(),
            turn_id: String::new(),
            interaction_id: String::new(),
            agent: String::new(),
            pathway: "manual",
            operation,
            stage: "completed",
            outcome: "applied",
            code: String::new(),
            target_kind,
            target_id: target_id.into(),
            latency: None,
            detail: json!({}),
        }
    }
}

/// The only setting transition that creates a boundary event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Boundary {
    Enabled,
    Disabled,
}

/// Keep backend-owned session fields stable and mint a new interval on enable.
///
/// A generic settings patch can carry `studyAnalytics.enabled`, but it cannot
/// choose or rewrite the session id. This is what makes two opt-in intervals
/// distinguishable even if a webview sends a stale whole settings object.
pub fn normalize_setting(previous: &StudyAnalytics, next: &mut StudyAnalytics) -> Option<Boundary> {
    let changed = match (previous.enabled, next.enabled) {
        (false, true) => {
            next.session_id = crate::projects::id("study");
            next.enabled_at = crate::projects::now();
            Some(Boundary::Enabled)
        }
        (true, false) => {
            next.session_id.clone_from(&previous.session_id);
            next.enabled_at.clone_from(&previous.enabled_at);
            Some(Boundary::Disabled)
        }
        _ => None,
    };
    if changed.is_none() {
        next.session_id.clone_from(&previous.session_id);
        next.enabled_at.clone_from(&previous.enabled_at);
    }
    changed
}

fn current_setting(tables: &Tables) -> StudyAnalytics {
    tables
        .kv_get(crate::settings::KEY)
        .and_then(|raw| serde_json::from_str::<GlobalSettings>(&raw).ok())
        .unwrap_or_default()
        .study_analytics
}

fn detail_is_content_free(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::Object(fields) => fields.iter().all(|(key, value)| {
            DETAIL_KEYS.contains(&key.as_str())
                && matches!(value, Value::Null | Value::Bool(_) | Value::Number(_))
        }),
        Value::String(_) | Value::Array(_) => false,
    }
}

/// Reduce runtime errors to a stable category before they reach the table.
///
/// A WorkTable failure can contain paths or engine details after a colon. The
/// full error still goes to the normal log; the study row keeps only the
/// machine-readable category needed for the failure taxonomy.
fn failure_code(value: String) -> String {
    if value.is_empty() {
        return value;
    }
    let category = value.split(':').next().unwrap_or_default().trim();
    if category.len() <= 64
        && !category.is_empty()
        && category
            .chars()
            .all(|character| character.is_ascii_uppercase() || character == '_')
    {
        category.to_string()
    } else {
        "UNCLASSIFIED_FAILURE".into()
    }
}

fn detail_json(detail: Value) -> String {
    if !detail_is_content_free(&detail) {
        crate::log!(
            crate::log::Level::Warn,
            "study",
            "refused a study detail outside the fixed metadata allowlist"
        );
        return "{}".into();
    }
    let encoded = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".into());
    if encoded.len() > MAX_DETAIL_BYTES {
        crate::log!(
            crate::log::Level::Warn,
            "study",
            "refused an oversized study detail"
        );
        "{}".into()
    } else {
        encoded
    }
}

/// Keep only application-style opaque ids. A malformed directive may put any
/// prose in an `id:` argument; recording that value would create a content
/// channel in a table whose contract explicitly has none.
fn opaque_id(value: String) -> String {
    if value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        value
    } else {
        String::new()
    }
}

fn row(setting: &StudyAnalytics, record: Record) -> StudyEventRow {
    StudyEventRow {
        id: crate::projects::id("study-event"),
        study_id: setting.session_id.clone(),
        at: crate::projects::now(),
        project_id: record.project_id,
        turn_id: record.turn_id,
        interaction_id: opaque_id(record.interaction_id),
        agent: record.agent,
        pathway: record.pathway.into(),
        operation: record.operation.into(),
        stage: record.stage.into(),
        outcome: record.outcome.into(),
        code: failure_code(record.code),
        target_kind: record.target_kind.into(),
        target_id: opaque_id(record.target_id),
        latency_ms: record
            .latency
            .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
            .unwrap_or(-1),
        detail: detail_json(record.detail),
        app_version: az_core::VERSION.into(),
        parser_version: PARSER_VERSION.into(),
        protocol_version: PROTOCOL_VERSION.into(),
    }
}

/// Record an event if, and only if, the persisted opt-in setting is active.
///
/// Instrumentation never changes the product operation's result. A failed
/// study write is logged loudly and the requested task or PR mutation still
/// stands, because research collection must not become application authority.
pub async fn record(tables: &Tables, record: Record) {
    let setting = current_setting(tables);
    if !setting.enabled || setting.session_id.is_empty() {
        return;
    }
    if let Err(error) = tables.study_event.insert(row(&setting, record)).await {
        crate::log!(
            crate::log::Level::Error,
            "study",
            "could not record an enabled study event: {error}"
        );
    }
}

/// Insert the enable or disable marker before the matching settings write.
///
/// The caller removes this row if the settings write fails, giving the two
/// WorkTable writes transaction-like cleanup without claiming cross-table
/// transactions the engine does not provide.
pub async fn record_boundary(
    tables: &Tables,
    setting: &StudyAnalytics,
    boundary: Boundary,
) -> Result<String, String> {
    let record = Record {
        project_id: String::new(),
        turn_id: String::new(),
        interaction_id: String::new(),
        agent: String::new(),
        pathway: "study",
        operation: "study.session",
        stage: "boundary",
        outcome: match boundary {
            Boundary::Enabled => "enabled",
            Boundary::Disabled => "disabled",
        },
        code: String::new(),
        target_kind: "",
        target_id: String::new(),
        latency: None,
        detail: json!({}),
    };
    let row = row(setting, record);
    let id = row.id.clone();
    tables
        .study_event
        .insert(row)
        .await
        .map_err(|error| error.to_string())?;
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudySummary {
    enabled: bool,
    study_id: Option<String>,
    enabled_at: Option<String>,
    event_count: usize,
    first_at: Option<String>,
    last_at: Option<String>,
}

fn rows(tables: &Tables) -> Vec<StudyEventRow> {
    let mut rows = tables
        .study_event
        .select_all()
        .execute()
        .unwrap_or_default();
    rows.sort_by(|left, right| left.at.cmp(&right.at).then(left.id.cmp(&right.id)));
    rows
}

#[tauri::command]
pub fn get_study_summary(state: State<'_, AppState>) -> StudySummary {
    let setting = current_setting(&state.tables);
    let rows = rows(&state.tables);
    StudySummary {
        enabled: setting.enabled,
        study_id: (!setting.session_id.is_empty()).then_some(setting.session_id),
        enabled_at: (!setting.enabled_at.is_empty()).then_some(setting.enabled_at),
        event_count: rows.len(),
        first_at: rows.first().map(|row| row.at.clone()),
        last_at: rows.last().map(|row| row.at.clone()),
    }
}

#[derive(Default)]
struct Pseudonyms {
    events: BTreeMap<String, String>,
    studies: BTreeMap<String, String>,
    projects: BTreeMap<String, String>,
    turns: BTreeMap<String, String>,
    interactions: BTreeMap<String, String>,
    targets: BTreeMap<String, String>,
}

fn pseudonym(map: &mut BTreeMap<String, String>, prefix: &str, value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let next = map.len() + 1;
    map.entry(value.to_string())
        .or_insert_with(|| format!("{prefix}-{next:03}"))
        .clone()
}

fn render_export(rows: &[StudyEventRow], exported_at: &str) -> Result<String, String> {
    let mut out = String::new();
    let meta = json!({
        "record": "metadata",
        "protocolVersion": PROTOCOL_VERSION,
        "exportedAt": exported_at,
        "appVersion": az_core::VERSION,
        "parserVersion": PARSER_VERSION,
        "eventCount": rows.len(),
        "deidentified": true,
        "containsPromptOrToolContent": false,
    });
    out.push_str(&serde_json::to_string(&meta).map_err(|error| error.to_string())?);
    out.push('\n');

    let mut names = Pseudonyms::default();
    for row in rows {
        let detail: Value = serde_json::from_str(&row.detail).unwrap_or_else(|_| json!({}));
        let event = json!({
            "record": "event",
            "id": pseudonym(&mut names.events, "event", &row.id),
            "studyId": pseudonym(&mut names.studies, "study", &row.study_id),
            "at": row.at,
            "projectId": pseudonym(&mut names.projects, "project", &row.project_id),
            "turnId": pseudonym(&mut names.turns, "turn", &row.turn_id),
            "interactionId": pseudonym(&mut names.interactions, "interaction", &row.interaction_id),
            "agent": row.agent,
            "pathway": row.pathway,
            "operation": row.operation,
            "stage": row.stage,
            "outcome": row.outcome,
            "code": row.code,
            "targetKind": row.target_kind,
            "targetId": pseudonym(&mut names.targets, "target", &row.target_id),
            "latencyMs": row.latency_ms,
            "detail": detail,
            "appVersion": row.app_version,
            "parserVersion": row.parser_version,
            "protocolVersion": row.protocol_version,
        });
        out.push_str(&serde_json::to_string(&event).map_err(|error| error.to_string())?);
        out.push('\n');
    }
    Ok(out)
}

/// Save a de-identified JSONL copy through the native picker.
///
/// `None` is a cancelled picker. No upload or background destination exists.
#[tauri::command]
pub async fn export_study_events(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let export = render_export(&rows(&state.tables), &crate::projects::now())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export de-identified PS deployment study data")
        .set_file_name("agencyzero-ps-study.jsonl")
        .add_filter("JSON Lines", &["jsonl"])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|_| "the save dialog closed without answering".to_string())?
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    std::fs::write(&path, export).map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Delete every locally stored study event. This does not change the toggle.
async fn clear_rows(tables: &Tables) -> Result<(), String> {
    for row in rows(tables) {
        tables
            .study_event
            .delete(row.id)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn clear_study_events(state: State<'_, AppState>) -> Result<(), String> {
    if current_setting(&state.tables).enabled {
        return Err("stop study collection before deleting its stored events".into());
    }
    clear_rows(&state.tables).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn tables(label: &str) -> Tables {
        let dir = std::env::temp_dir().join(format!("az-study-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Tables::open(&dir).await.expect("study test store opens")
    }

    fn sample() -> Record {
        Record {
            project_id: "private-project".into(),
            turn_id: "private-turn".into(),
            interaction_id: "private-interaction".into(),
            agent: "codex".into(),
            pathway: "ps",
            operation: "items.state",
            stage: "completed",
            outcome: "applied",
            code: String::new(),
            target_kind: "item",
            target_id: "private-item".into(),
            latency: Some(Duration::from_millis(12)),
            detail: json!({"userAuthoredPs": false, "lineCount": 2}),
        }
    }

    #[test]
    fn enabling_mints_a_new_backend_owned_session() {
        let previous = StudyAnalytics::default();
        let mut next = StudyAnalytics {
            enabled: true,
            session_id: "caller-chosen".into(),
            enabled_at: "caller-chosen".into(),
        };
        assert_eq!(
            normalize_setting(&previous, &mut next),
            Some(Boundary::Enabled)
        );
        assert!(next.session_id.starts_with("study-"));
        assert_ne!(next.enabled_at, "caller-chosen");
    }

    #[test]
    fn an_enabled_client_cannot_rewrite_backend_session_fields() {
        let previous = StudyAnalytics {
            enabled: true,
            session_id: "study-kept".into(),
            enabled_at: "2026-08-03T00:00:00Z".into(),
        };
        let mut next = StudyAnalytics {
            enabled: true,
            session_id: "caller-rewrite".into(),
            enabled_at: "caller-rewrite".into(),
        };

        assert_eq!(normalize_setting(&previous, &mut next), None);
        assert_eq!(next.session_id, "study-kept");
        assert_eq!(next.enabled_at, "2026-08-03T00:00:00Z");
    }

    #[tokio::test]
    async fn disabled_collection_writes_nothing() {
        let tables = tables("off").await;
        record(&tables, sample()).await;
        assert!(rows(&tables).is_empty());
    }

    #[tokio::test]
    async fn enabled_collection_keeps_metadata_without_content() {
        let tables = tables("on").await;
        let settings = GlobalSettings {
            study_analytics: StudyAnalytics {
                enabled: true,
                session_id: "study-local".into(),
                enabled_at: "2026-08-03T00:00:00Z".into(),
            },
            ..GlobalSettings::default()
        };
        tables
            .kv_put(
                crate::settings::KEY,
                serde_json::to_string(&settings).expect("settings serialize"),
            )
            .await
            .expect("settings persist");

        record(&tables, sample()).await;
        let kept = rows(&tables);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].operation, "items.state");
        assert!(!kept[0].detail.contains("private"));
    }

    #[tokio::test]
    async fn boundaries_survive_the_disabled_side_of_a_transition() {
        let tables = tables("boundaries").await;
        let enabled = StudyAnalytics {
            enabled: true,
            session_id: "study-boundary".into(),
            enabled_at: "2026-08-03T00:00:00Z".into(),
        };
        let disabled = StudyAnalytics {
            enabled: false,
            ..enabled.clone()
        };

        record_boundary(&tables, &enabled, Boundary::Enabled)
            .await
            .expect("enable boundary inserts");
        record_boundary(&tables, &disabled, Boundary::Disabled)
            .await
            .expect("disable boundary inserts");

        let kept = rows(&tables);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].outcome, "enabled");
        assert_eq!(kept[1].outcome, "disabled");
        assert!(kept.iter().all(|row| row.study_id == "study-boundary"));
    }

    #[tokio::test]
    async fn clearing_removes_every_stored_row() {
        let tables = tables("clear").await;
        let setting = StudyAnalytics {
            enabled: false,
            session_id: "study-clear".into(),
            enabled_at: "2026-08-03T00:00:00Z".into(),
        };
        tables
            .study_event
            .insert(row(&setting, sample()))
            .await
            .expect("sample inserts");

        clear_rows(&tables).await.expect("rows clear");
        assert!(rows(&tables).is_empty());
    }

    #[test]
    fn detail_refuses_arbitrary_text() {
        assert_eq!(detail_json(json!({"prompt": "do the private thing"})), "{}");
        assert_eq!(detail_json(json!({"private words as a key": 1})), "{}");
        assert_eq!(detail_json(json!({"lineCount": {"covert": 2}})), "{}");
        assert_eq!(detail_json(json!({"chars": 42, "followup": true})), "{}");
        assert_eq!(
            detail_json(json!({"characterCount": 42, "followup": true})),
            r#"{"characterCount":42,"followup":true}"#
        );
    }

    #[test]
    fn failure_codes_cannot_carry_runtime_content() {
        assert_eq!(
            failure_code("WRITE_FAILED: /private/path in engine".into()),
            "WRITE_FAILED"
        );
        assert_eq!(failure_code("ENTITY_NOT_FOUND".into()), "ENTITY_NOT_FOUND");
        assert_eq!(
            failure_code("customer-specific failure".into()),
            "UNCLASSIFIED_FAILURE"
        );
    }

    #[test]
    fn target_ids_cannot_become_a_content_channel() {
        assert_eq!(opaque_id("item-a3f9".into()), "item-a3f9");
        assert_eq!(opaque_id("the customer's private title".into()), "");
        assert_eq!(opaque_id("x".repeat(161)), "");
    }

    #[test]
    fn export_replaces_every_linkable_local_id() {
        let setting = StudyAnalytics {
            enabled: true,
            session_id: "private-study".into(),
            enabled_at: "2026-08-03T00:00:00Z".into(),
        };
        let mut kept = row(&setting, sample());
        kept.id = "private-event".into();
        let export = render_export(&[kept], "2026-08-10T00:00:00Z").expect("export renders");
        assert!(export.contains("study-001"));
        assert!(export.contains("project-001"));
        assert!(export.contains("turn-001"));
        assert!(export.contains("interaction-001"));
        assert!(export.contains("target-001"));
        assert!(export.contains("event-001"));
        assert!(!export.contains("private-event"));
        assert!(!export.contains("private-study"));
        assert!(!export.contains("private-project"));
        assert!(!export.contains("private-turn"));
        assert!(!export.contains("private-interaction"));
        assert!(!export.contains("private-item"));
        let metadata: Value =
            serde_json::from_str(export.lines().next().expect("export includes metadata"))
                .expect("metadata is valid JSON");
        assert_eq!(metadata["parserVersion"], PARSER_VERSION);
    }
}
