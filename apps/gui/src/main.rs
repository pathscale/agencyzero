#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_proxy;
mod agents;
mod angel;
mod chat_import;
mod db;
mod directives;
mod experimental;
mod log;
mod models;
mod notes;
mod per_turn;
mod pricing;
mod projects;
mod prs;
mod qa_profile;
mod questions;
mod quota;
mod retry;
mod settings;
mod store_backup;
mod study;
mod tasks;
mod update;
mod workers;

// Exactly one runtime, chosen explicitly.
//
// Cargo features are additive, so a default runtime could not be turned off by
// naming the other one: `--features blitz-inspector` used to compile the
// webview in as well, which is how a Blitz build ended up declaring a WebKit
// dependency it never called. Neither selected is the more common slip and
// used to surface as a wall of missing-type errors from Tauri.
#[cfg(all(feature = "blitz-runtime", feature = "webview-runtime"))]
compile_error!(
    "pick one runtime: `blitz-runtime` or `webview-runtime`, not both. \
     Both compiles the WebKit webview into a binary that renders with Blitz."
);
#[cfg(not(any(feature = "blitz-runtime", feature = "webview-runtime")))]
compile_error!(
    "pick a runtime: `--features blitz-runtime` for the Blitz renderer, which \
     is what ships, or `--features webview-runtime` for Tauri's WKWebView."
);

use std::ffi::OsString;
#[cfg(feature = "blitz-runtime")]
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use worktable::prelude::SelectQueryExecutor;

#[cfg(feature = "blitz-runtime")]
pub(crate) type AppHandle = tauri::AppHandle<tauri_runtime_blitz::BlitzRuntime>;
#[cfg(not(feature = "blitz-runtime"))]
pub(crate) type AppHandle = tauri::AppHandle<tauri::Wry>;

#[cfg(feature = "blitz-runtime")]
fn blitz_profile_dir(bundle_dir: PathBuf) -> PathBuf {
    if cfg!(feature = "experimental") {
        bundle_dir
    } else {
        bundle_dir
            .parent()
            .map(|parent| parent.join("com.pathscale.agencyzero"))
            .unwrap_or(bundle_dir)
    }
}

enum StoreProbe {
    Acquired(std::fs::File),
    Busy(wt_migrate::StoreLockError),
}

/// Probe the profile before WorkTable opens a single table.
///
/// A live writer is an ordinary duplicate-profile launch, not a damaged app or
/// database. Keep that collision as data so setup can log it and request a
/// clean zero-status exit. Permission and filesystem failures remain errors.
fn probe_store(store: &std::path::Path) -> Result<StoreProbe, wt_migrate::StoreLockError> {
    match wt_migrate::lock_store(store) {
        Ok(lock) => Ok(StoreProbe::Acquired(lock)),
        Err(error) if error.is_busy() => Ok(StoreProbe::Busy(error)),
        Err(error) => Err(error),
    }
}

fn no_persist_requested() -> bool {
    std::env::var_os("AZ_NO_PERSIST").is_some()
        || std::env::args().any(|arg| arg == "--debug-no-persist")
}

/// How many times to ask the main window to show before giving up. `show()` can
/// return `Ok` while the window stays hidden, so the result is checked and the
/// call repeated rather than trusted once.
const SHOW_ATTEMPTS: u32 = 5;

/// Gap between show attempts. Long enough for the compositor to settle, short
/// enough that a window that will appear is not held back noticeably.
const SHOW_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(120);

/// Resolve and claim the Blitz profile before AppKit, a window, or frontend
/// JavaScript exists. This is the soft duplicate-instance probe: a busy return
/// ends `main` normally, while an acquired lock is handed into setup and held
/// by `AppState` for the process lifetime.
#[cfg(feature = "blitz-runtime")]
enum BlitzPreflight {
    Skip,
    Busy,
    Acquired(PathBuf, std::fs::File),
}

#[cfg(feature = "blitz-runtime")]
fn preflight_blitz_profile() -> Result<BlitzPreflight, String> {
    if no_persist_requested() {
        return Ok(BlitzPreflight::Skip);
    }

    let identifier = if cfg!(feature = "experimental") {
        "com.pathscale.agencyzero.experimental"
    } else {
        "com.pathscale.agencyzero"
    };
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "no config directory for the Blitz profile probe".to_string())?
        .join(identifier);
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "no data directory for the Blitz profile probe".to_string())?
        .join(identifier);
    let location = location::resolve(&config_dir, &data_dir);

    match probe_store(&location.path).map_err(|error| error.to_string())? {
        StoreProbe::Acquired(lock) => Ok(BlitzPreflight::Acquired(location.path, lock)),
        StoreProbe::Busy(busy) => {
            log::init(&data_dir.join("logs"));
            crate::log!(
                log::Level::Warn,
                "boot",
                "profile already open; exiting before Tauri or WorkTable starts: {busy}"
            );
            eprintln!(
                "AgencyZero profile is already open; this launch exited without starting Tauri \
                 or touching WorkTable: {busy}"
            );
            Ok(BlitzPreflight::Busy)
        }
    }
}

use crate::db::location::{self, DataLocation};
use crate::db::tables::Tables;
use crate::settings::GlobalSettings;

#[cfg(feature = "blitz-runtime")]
include!(concat!(env!("OUT_DIR"), "/blitz_embedded.rs"));

#[cfg(feature = "blitz-runtime")]
struct EmbeddedBlitzScriptFetcher;

#[cfg(feature = "blitz-runtime")]
impl blitz_script::ScriptFetcher for EmbeddedBlitzScriptFetcher {
    fn fetch(&self, url: &url::Url) -> Result<String, blitz_script::FetchError> {
        if url.as_str() == BLITZ_JS_URL {
            decompress_blitz_asset(BLITZ_JS_BROTLI, BLITZ_JS_LEN, "JavaScript")
                .map_err(blitz_script::FetchError::InvalidData)
        } else {
            blitz_script::DefaultScriptFetcher.fetch(url)
        }
    }
}

#[cfg(feature = "blitz-runtime")]
fn decompress_blitz_asset(
    compressed: &[u8],
    expected_len: usize,
    label: &str,
) -> Result<String, String> {
    let mut decoder = brotli::Decompressor::new(compressed, 4096);
    let mut decoded = String::with_capacity(expected_len);
    decoder
        .read_to_string(&mut decoded)
        .map_err(|error| format!("could not decompress embedded {label}: {error}"))?;
    Ok(decoded)
}

#[cfg(feature = "blitz-runtime")]
fn create_blitz_document(url: &str) -> Result<blitz_script::ScriptDocument, String> {
    let css = decompress_blitz_asset(BLITZ_CSS_BROTLI, BLITZ_CSS_LEN, "CSS")?;
    let html = BLITZ_SHELL_HTML.replacen(BLITZ_CSS_MARKER, &css, 1);
    let config = blitz_dom::DocumentConfig {
        base_url: Some(url.into()),
        ..Default::default()
    };
    Ok(blitz_script::ScriptDocument::from_html(&html, config)
        .with_fetcher(EmbeddedBlitzScriptFetcher))
}

/// Commands this build actually implements.
///
/// The frontend routes each call to Rust or the mock by consulting this, and
/// greys out any control whose command appears in neither. That makes wiring
/// progress visible in the UI by construction, instead of by a hand-kept list
/// that goes stale the first time someone forgets to update it.
///
/// **Add a name here in the same change that implements it**, never ahead of it:
/// a name listed early routes real calls at an unimplemented command and the
/// window fails rather than falling back.
const IMPLEMENTED: &[&str] = &[
    "greet",
    "set_window_chrome",
    "get_data_location",
    "set_data_location",
    "get_store_backup_status",
    "create_store_backup",
    "create_store_snapshot",
    "select_store_backup",
    "restore_store_backup",
    "choose_data_directory",
    "choose_project_directory",
    "choose_agent_proxy_binary",
    "get_agent_proxy_status",
    "restart_agent_proxy",
    "stop_agent_proxy",
    "get_workspace_root",
    "create_workspace_root",
    "list_projects",
    "get_home_snapshot",
    "list_items",
    "create_item",
    "fork_item",
    "set_item_status",
    "update_item",
    "set_item_issue",
    "delete_item",
    "unmark_item_deletion",
    "reorder_items",
    "choose_attachments",
    "list_pull_requests",
    "dismiss_pull_request",
    "refresh_pull_request",
    "discover_pull_requests",
    "review_pull_request",
    "list_questions",
    "answer_question",
    "list_messages",
    "sync_project",
    "list_running_tasks",
    "list_task_log",
    "clear_task_log",
    "delete_project",
    "set_project_pinned",
    "set_project_moderator",
    "reorder_projects",
    "rename_project",
    "add_dir",
    "remove_dir",
    "reset_task_manager",
    "get_task_manager",
    "resolve_approval",
    "list_approval_rules",
    "clear_approval_rules",
    "cancel_run",
    "compact_project",
    "get_checkpoints",
    "set_checkpoints",
    "get_project_concise",
    "set_project_concise",
    "get_project_notes",
    "set_project_notes",
    "get_item_context",
    "set_item_context",
    "get_cost_summary",
    "get_usage_analytics",
    "get_project_verbosity",
    "set_project_verbosity",
    "reset_project_session",
    "list_recoverable_sessions",
    "adopt_session",
    "get_build_info",
    "get_persistence_failure",
    "quit_app",
    "quit_app_and_proxy",
    "relaunch_app",
    "list_agent_io",
    "get_io_persist",
    "set_io_persist",
    "list_quota",
    "list_rate_limits",
    "discover_chat_imports",
    "import_chat_session",
    "create_project",
    "send_message",
    "get_settings",
    "set_settings",
    "get_study_summary",
    "export_study_events",
    "clear_study_events",
    "list_agent_status",
    "list_models",
    "pricing_table",
    "log_frontend",
    "get_log_path",
    "list_table_sizes",
    "open_external",
    "check_for_update",
    "install_update",
];

/// What the GUI carries for the life of the process.
pub(crate) struct AppState {
    tables: Arc<Tables>,
    /// Persistent provider runtime. The GUI is only a client; live agent
    /// processes survive this application's restart inside AgencyProxy.
    proxy: Arc<agent_proxy::AgencyProxy>,
    /// Tool calls in flight, by project. Not persisted, on purpose, see
    /// [`projects::RunningTasks`].
    running: Arc<projects::RunningTasks>,
    /// The raw exchange with the agent, by project. In memory for the life of
    /// the process, see [`projects::AgentIo`].
    io: Arc<projects::AgentIo>,
    /// Approval questions waiting on the user, by project. The run is blocked
    /// mid-turn until `resolve_approval` answers, see [`projects::PendingApprovals`].
    approvals: Arc<projects::PendingApprovals>,
    /// The provider's last word on usage, by project. In memory rather than
    /// persisted: it is a fact about an account right now, see
    /// [`projects::RateLimits`].
    limits: Arc<projects::RateLimits>,
    /// What became of the last turn's directives, by project. Quoted back to
    /// the agent next turn, see [`projects::Receipts`].
    receipts: Arc<projects::Receipts>,
    /// The live run per project: at most one, and how to stop it, see
    /// [`projects::ActiveRuns`].
    active: Arc<projects::ActiveRuns>,
    /// Which project/agent pairs have produced a provider event since this app
    /// process started. Process-local on purpose: relaunching arms the first
    /// message again, while ordinary resumed turns stay quiet.
    pub(crate) startup_visibility: projects::StartupVisibility,
    /// Serializes `set_settings`. The update is a read-merge-write over one
    /// record, and Tauri runs commands concurrently: two quick patches could
    /// both read the same prior record and the slower write would silently
    /// drop the faster one's field on disk.
    settings_write: tokio::sync::Mutex<()>,
    /// Serializes provider-session ownership checks with project creation.
    /// Without one lock, two Import clicks can both observe "unknown" before
    /// either writes the native session id and create duplicate projects.
    chat_imports: tokio::sync::Mutex<()>,
    /// Native-picker restore selection. The webview receives only its display
    /// name; the absolute path never crosses the trust boundary.
    pending_restore: tokio::sync::Mutex<Option<std::path::PathBuf>>,
    /// Coalesces per-chip polling into one whole-project GitHub refresh.
    pr_refreshes: Arc<prs::ActiveRefreshes>,
    /// Makes every quit, restart, updater, and signal share one drain. The
    /// normal UI path drains asynchronously before asking Tauri to exit; the
    /// native exit callback is only a fallback for exits that bypass IPC.
    exit_drain_started: std::sync::atomic::AtomicBool,
    /// Distinguishes "already drained" from "the one attempted drain failed".
    /// Treating both as success let a second close request exit after the first
    /// one had proved persistence was unsafe.
    exit_drain_succeeded: std::sync::atomic::AtomicBool,
    /// The first terminal WorkTable failure for this process. The event is the
    /// fast path; retaining it closes the startup race before the webview has
    /// registered its listener.
    persistence_failure: Arc<std::sync::RwLock<Option<String>>>,
    /// At most one agent-authored lifecycle request may wait for the current
    /// run to finish. This is process-local on purpose: a crash must not leave
    /// a stale restart command to execute on the next launch.
    agent_restart_scheduled: std::sync::atomic::AtomicBool,
    /// Kept so `set_data_location` can write the pointer beside the settings.
    config_dir: std::path::PathBuf,
    /// Kept so `get_data_location` can re-resolve the pointer against the same
    /// default this launch used, and report where the next one will open.
    data_dir: std::path::PathBuf,
    /// Where the tables were opened from this launch. A change takes effect on
    /// the next one, so this is the answer for the whole session.
    location: DataLocation,
    /// The store's exclusive flock, held for the life of the process — the
    /// single-writer rule made mechanical. See `lock_store`.
    _store_lock: std::fs::File,
}

const RESTART_RESUME_FILE: &str = "restart-resume.json";
const RESTART_RESUME_PROMPT: &str = "AgencyZero self-restart continuation (app-authored; not written by the owner): Resume the work interrupted by the agent-triggered AgencyZero restart. Re-read the current item list, durable project memory, and working tree, then continue until the work is complete or an owner decision is genuinely required.";

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RestartResume {
    /// Empty for an ordinary authored restart: the latest active project is
    /// resolved at boot. A recovery tool may pin the project explicitly.
    project_id: String,
    agent: String,
    model: String,
    permission: String,
    effort: String,
    prompt: String,
}

fn restart_resume_path(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join(RESTART_RESUME_FILE)
}

fn restart_resume_marker(
    settings: &GlobalSettings,
    project_id: &str,
    actor: &str,
) -> RestartResume {
    let agent = if settings.models.contains_key(actor) {
        actor.to_string()
    } else {
        settings.default_agent.clone()
    };
    let model = settings
        .models
        .get(&agent)
        .map(|selection| selection.default.clone())
        .unwrap_or_default();
    RestartResume {
        project_id: project_id.into(),
        agent,
        model,
        permission: settings.default_permission.clone(),
        effort: settings.default_effort.clone(),
        prompt: RESTART_RESUME_PROMPT.into(),
    }
}

fn write_restart_resume(state: &AppState, project_id: &str, actor: &str) -> Result<(), String> {
    let settings = state
        .tables
        .kv_get(settings::KEY)
        .and_then(|raw| serde_json::from_str::<GlobalSettings>(&raw).ok())
        .unwrap_or_default();
    let marker = restart_resume_marker(&settings, project_id, actor);
    std::fs::create_dir_all(&state.config_dir)
        .map_err(|error| format!("could not create restart-resume directory: {error}"))?;
    let path = restart_resume_path(&state.config_dir);
    let staging = path.with_extension("json.staging");
    let encoded = serde_json::to_vec(&marker)
        .map_err(|error| format!("could not encode restart-resume marker: {error}"))?;
    std::fs::write(&staging, encoded)
        .map_err(|error| format!("could not write restart-resume marker: {error}"))?;
    std::fs::rename(&staging, &path)
        .map_err(|error| format!("could not publish restart-resume marker: {error}"))
}

fn take_restart_resume(config_dir: &std::path::Path) -> Option<RestartResume> {
    let path = restart_resume_path(config_dir);
    let consuming = path.with_extension("json.consuming");
    if !path.is_file() {
        return None;
    }
    if let Err(error) = std::fs::rename(&path, &consuming) {
        crate::log!(
            log::Level::Error,
            "boot",
            "could not consume {} exactly once: {error}",
            path.display()
        );
        return None;
    }
    let raw = match std::fs::read(&consuming) {
        Ok(raw) => raw,
        Err(error) => {
            crate::log!(
                log::Level::Warn,
                "boot",
                "could not read consumed restart marker {}: {error}",
                consuming.display()
            );
            let _ = std::fs::remove_file(&consuming);
            return None;
        }
    };
    let _ = std::fs::remove_file(&consuming);
    match serde_json::from_slice(&raw) {
        Ok(marker) => Some(marker),
        Err(error) => {
            crate::log!(
                log::Level::Warn,
                "boot",
                "could not decode {}: {error}",
                consuming.display()
            );
            None
        }
    }
}

async fn resume_after_restart(app: AppHandle, marker: RestartResume) {
    // Let the webview subscribe before the resumed run begins emitting. The
    // user message itself is durable, so a slower window still catches up.
    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
    let state = app.state::<AppState>();
    let project_id = if marker.project_id.is_empty() {
        state
            .tables
            .project
            .select_all()
            .execute()
            .unwrap_or_default()
            .into_iter()
            .filter(|project| !matches!(project.status.as_str(), "finished" | "canceled"))
            .max_by(|left, right| left.last_activity_at.cmp(&right.last_activity_at))
            .map(|project| project.id)
    } else {
        state
            .tables
            .project
            .select(marker.project_id.clone())
            .map(|project| project.id)
    };
    let Some(project_id) = project_id else {
        crate::log!(
            log::Level::Warn,
            "boot",
            "restart-resume marker has no available project"
        );
        return;
    };
    let input = projects::SendMessageInput {
        project_id,
        body: marker.prompt,
        retry_message_id: None,
        reply_question_id: None,
        item_id: None,
        agent: Some(marker.agent),
        model: Some(marker.model),
        permission: Some(marker.permission),
        effort: Some(marker.effort),
        extra_thinking: None,
        stateless: false,
        study: None,
    };
    match projects::send_message(app.clone(), input, state).await {
        Ok(_) => crate::log!(log::Level::Info, "boot", "restart-resume run started"),
        Err(error) => crate::log!(
            log::Level::Error,
            "boot",
            "restart-resume run could not start: {error}"
        ),
    }
}

impl AppState {
    pub(crate) fn live_run_count(&self) -> usize {
        self.active
            .lock()
            .map(|active| active.len())
            .unwrap_or_default()
    }

    async fn drain_tables_once(&self) -> Result<(), String> {
        if self
            .exit_drain_started
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return if self
                .exit_drain_succeeded
                .load(std::sync::atomic::Ordering::Acquire)
            {
                Ok(())
            } else {
                Err("the persistence drain already failed or is still in progress; quit remains blocked to protect the store".into())
            };
        }
        // No new PR refresh can register after `exit_drain_started` became
        // true. Let one already in flight finish before asking WorkTable if it
        // is idle, otherwise that refresh can submit a new operation after the
        // pull-request table has already reported drained.
        let refresh_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if self.pr_refreshes.is_empty()? {
                break;
            }
            if tokio::time::Instant::now() >= refresh_deadline {
                return Err(
                    "a pull-request refresh did not finish before the persistence drain".into(),
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let result = self.tables.shutdown().await;
        if result.is_ok() {
            self.exit_drain_succeeded
                .store(true, std::sync::atomic::Ordering::Release);
        }
        result
    }
}

/// Schedule one owner-authorized lifecycle action after all runs are quiet.
///
/// The directive is applied from inside the run it belongs to, so executing it
/// immediately would tear down the process before that run releases its slot
/// and persists its final events. A short stable-idle window also lets a queued
/// owner message acquire the slot first; in that case the restart waits again.
/// Nothing is persisted and the angel remains unaware of networks, settings,
/// or Prompt Syntax.
pub(crate) fn schedule_agent_restart(
    app: &AppHandle,
    mode: &str,
    project_id: &str,
    actor: &str,
) -> Result<(), String> {
    if !matches!(mode, "disk" | "update") {
        return Err("unsupported restart mode".into());
    }
    let state = app.state::<AppState>();
    state
        .agent_restart_scheduled
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .map_err(|_| "a lifecycle action is already scheduled".to_string())?;

    let handle = app.clone();
    let mode = mode.to_string();
    let project_id = project_id.to_string();
    let actor = actor.to_string();
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
        loop {
            if tokio::time::Instant::now() >= deadline {
                let state = handle.state::<AppState>();
                state
                    .agent_restart_scheduled
                    .store(false, std::sync::atomic::Ordering::Release);
                let message = "agent restart expired while other runs remained active";
                crate::log!(log::Level::Warn, "boot", "{message}");
                let _ = handle.emit("app:restart-failed", message);
                return;
            }
            if handle.state::<AppState>().live_run_count() == 0 {
                // Require a stable quiet interval. The frontend starts queued
                // turns after 250 ms, so 500 ms observes that handoff.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if handle.state::<AppState>().live_run_count() == 0 {
                    break;
                }
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }

        // Arm automatic continuation only when this agent-authored lifecycle
        // action is actually about to execute. Writing the marker when the
        // restart was merely scheduled let a normal manual quit/reopen consume
        // stale intent and fabricate a user turn the owner never sent.
        let state = handle.state::<AppState>();
        if let Err(error) = write_restart_resume(&state, &project_id, &actor) {
            state
                .agent_restart_scheduled
                .store(false, std::sync::atomic::Ordering::Release);
            crate::log!(
                log::Level::Error,
                "boot",
                "could not arm agent restart: {error}"
            );
            let _ = handle.emit("app:restart-failed", error);
            return;
        }

        let result = if mode == "update" {
            crate::update::install_update_now(&handle).await
        } else {
            let state = handle.state::<AppState>();
            restart_after_drain(&handle, &state).await
        };
        if let Err(error) = result {
            let state = handle.state::<AppState>();
            let _ = std::fs::remove_file(restart_resume_path(&state.config_dir));
            state
                .agent_restart_scheduled
                .store(false, std::sync::atomic::Ordering::Release);
            crate::log!(log::Level::Error, "boot", "agent restart failed: {error}");
            let _ = handle.emit("app:restart-failed", error);
        }
    });
    Ok(())
}

#[cfg(test)]
mod restart_resume_tests {
    use super::*;

    #[test]
    fn authored_restart_resumes_the_originating_project_and_provider() {
        let settings = GlobalSettings::default();

        let marker = restart_resume_marker(&settings, "project-origin", "codex");

        assert_eq!(marker.project_id, "project-origin");
        assert_eq!(marker.agent, "codex");
        assert!(
            marker
                .prompt
                .starts_with("AgencyZero self-restart continuation (app-authored")
        );
        assert!(marker.prompt.contains("not written by the owner"));
        assert_eq!(
            marker.model,
            settings.models.get("codex").unwrap().default,
            "the resumed run should use the originating provider's selected default"
        );
    }

    #[test]
    fn an_unknown_actor_falls_back_without_losing_the_project() {
        let settings = GlobalSettings::default();

        let marker = restart_resume_marker(&settings, "project-origin", "future-agent");

        assert_eq!(marker.project_id, "project-origin");
        assert_eq!(marker.agent, settings.default_agent);
    }

    #[test]
    fn a_restart_marker_is_consumed_once_even_when_resume_cannot_start() {
        let dir = std::env::temp_dir().join(format!(
            "az-restart-marker-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = RestartResume {
            project_id: "project-origin".into(),
            agent: "codex".into(),
            model: "gpt-5.6-sol".into(),
            permission: "auto".into(),
            effort: "high".into(),
            prompt: RESTART_RESUME_PROMPT.into(),
        };
        std::fs::write(
            restart_resume_path(&dir),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();

        assert!(take_restart_resume(&dir).is_some());
        assert!(take_restart_resume(&dir).is_none());
        assert!(!restart_resume_path(&dir).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "blitz-runtime")]
    #[test]
    fn blitz_profile_routing_never_collapses_experimental_into_stable() {
        let experimental = PathBuf::from(
            "/Users/example/Library/Application Support/com.pathscale.agencyzero.experimental",
        );
        let routed = blitz_profile_dir(experimental.clone());

        if cfg!(feature = "experimental") {
            assert_eq!(routed, experimental);
        } else {
            assert_eq!(
                routed,
                PathBuf::from(
                    "/Users/example/Library/Application Support/com.pathscale.agencyzero"
                )
            );
        }
    }

    #[test]
    fn a_live_profile_is_a_soft_probe_result_not_a_startup_error() {
        let dir = std::env::temp_dir().join(format!(
            "az-soft-store-probe-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        let store = dir.join("db");
        let first = wt_migrate::lock_store(&store).expect("the first process owns the profile");

        let probe = probe_store(&store).expect("a live profile is not a fatal startup error");
        assert!(matches!(probe, StoreProbe::Busy(_)));

        drop(first);
        let probe = probe_store(&store).expect("the released profile can be opened");
        assert!(matches!(probe, StoreProbe::Acquired(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_project_mutations_never_route_to_fixture_data() {
        let capabilities = list_capabilities();
        for command in ["set_project_moderator", "reorder_projects"] {
            assert!(
                capabilities.iter().any(|candidate| candidate == command),
                "{command} cannot update a live project through fixture data"
            );
        }
    }
}

/// Which commands Rust answers. See [`IMPLEMENTED`].
#[tauri::command]
fn list_capabilities() -> Vec<String> {
    let mut implemented: Vec<String> = IMPLEMENTED.iter().map(|name| (*name).to_string()).collect();
    if cfg!(all(feature = "experimental", target_os = "macos")) {
        implemented.push("claude_usage".to_string());
    }
    implemented
}

/// Exactly which build this process is.
///
/// The version number names every build for weeks at a time, so it cannot
/// answer "am I running the fix or the stale bundle?", the question behind
/// two wasted debugging rounds. The commit and compile time can. Stamped by
/// `build.rs`; a `*` after the sha means the tree had uncommitted edits.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    version: &'static str,
    runtime: &'static str,
    git_sha: &'static str,
    built_at: &'static str,
}

const BUILD: BuildInfo = BuildInfo {
    version: az_core::VERSION,
    runtime: if cfg!(feature = "blitz-runtime") {
        "blitz"
    } else {
        "wry"
    },
    git_sha: env!("AZ_GIT_SHA"),
    built_at: env!("AZ_BUILT_AT"),
};

#[tauri::command]
fn get_build_info() -> BuildInfo {
    BUILD
}

#[tauri::command]
fn get_persistence_failure(state: State<'_, AppState>) -> Option<String> {
    state
        .persistence_failure
        .read()
        .map(|failure| failure.clone())
        .unwrap_or_else(|_| Some("persistence failure state is poisoned".into()))
}

/// Record a line the webview produced, in the same file as the Rust ones.
///
/// Two logs in two places cannot be read against each other, and the ordering
/// between them is the whole question when a boot stalls: the answer is either
/// "Rust never got the call" or "Rust answered and the webview did nothing with
/// it", and only one interleaved file can tell those apart.
#[tauri::command]
fn log_frontend(level: String, message: String) {
    crate::log!(log::Level::parse(&level), "webview", "{message}");
}

/// One table's footprint on disk, for the Data section.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TableSize {
    name: String,
    bytes: u64,
}

/// How much room each table takes, largest first.
///
/// The store grows silently and unevenly: the task log and the raw agent I/O
/// are written per tool call and per event, so they outgrow the transcript by
/// an order of magnitude while nothing on screen says so. "Some of these logs
/// may get very big" is only checkable if the app can be asked.
///
/// Directory sizes rather than row counts, because the question behind it is
/// about disk. Walks one level: WorkTable keeps a directory per table with its
/// pages inside, and a deep walk would be a stat storm on every Settings open.
#[tauri::command]
fn list_table_sizes(state: State<'_, AppState>) -> Vec<TableSize> {
    let mut sizes: Vec<TableSize> = std::fs::read_dir(&state.location.path)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| {
            let bytes = std::fs::read_dir(entry.path())
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|file| file.metadata().ok())
                .filter(|meta| meta.is_file())
                .map(|meta| meta.len())
                .sum();
            TableSize {
                name: entry.file_name().to_string_lossy().into_owned(),
                bytes,
            }
        })
        .collect();
    // Largest first: the point of the list is which table is eating the disk.
    sizes.sort_by_key(|table| std::cmp::Reverse(table.bytes));
    sizes
}

/// Hand a URL to the browser.
///
/// A PR chip carries the one link you actually want to follow, and a webview
/// with no navigation of its own can only copy it, "click to copy, now go
/// paste it" is two steps for the commonest action on the row.
///
/// `open(1)` rather than a plugin: it is one line of std, and the alternative
/// is a dependency for a subprocess this app can spawn itself. The argument is
/// passed as an argv entry, never through a shell, so there is no quoting to
/// get wrong.
///
/// **Only http and https.** `open` will happily launch a `file://` path or a
/// registered custom scheme, and the URLs reaching this come from an agent's
/// reply, text this app did not author. A scheme allowlist is what keeps
/// "click the link" from being an arbitrary-handler invocation.
///
/// # Errors
/// Returns a message when the scheme is not allowed, or when the browser could
/// not be launched.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        crate::log!(
            log::Level::Warn,
            "shell",
            "refused to open a non-web URL: {url}"
        );
        return Err("only http and https links can be opened".into());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            crate::log!(log::Level::Error, "shell", "could not open {url}: {error}");
            format!("could not open the link: {error}")
        })
}

/// Where the log file is, so Settings can point at it rather than describing it.
#[tauri::command]
fn get_log_path() -> Option<String> {
    log::path().map(|path| path.to_string_lossy().into_owned())
}

/// The directory a new project runs in, and whether it is there yet.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRoot {
    path: String,
    exists: bool,
    /// True when this is the resolved default rather than a stored choice, so
    /// Settings can say "recommended" rather than presenting it as configured.
    is_default: bool,
}

/// Resolve the workspace root: the stored value, else `$HOME/AgencyZero`.
fn resolve_workspace_root(app: &AppHandle, state: &AppState) -> WorkspaceRoot {
    let stored = state
        .tables
        .kv_get(settings::KEY)
        .and_then(|raw| serde_json::from_str::<GlobalSettings>(&raw).ok())
        .map(|settings| settings.workspace_root)
        .unwrap_or_default();

    let (path, is_default) = if stored.trim().is_empty() {
        let home = app.path().home_dir().unwrap_or_else(|_| ".".into());
        (home.join("AgencyZero"), true)
    } else {
        (std::path::PathBuf::from(&stored), false)
    };

    WorkspaceRoot {
        exists: path.is_dir(),
        path: path.to_string_lossy().into_owned(),
        is_default,
    }
}

/// The workspace root as a plain path, for callers that need somewhere to run.
pub(crate) fn workspace_root_path(app: &AppHandle, state: &AppState) -> String {
    resolve_workspace_root(app, state).path
}

#[tauri::command]
fn get_workspace_root(app: AppHandle, state: State<'_, AppState>) -> WorkspaceRoot {
    resolve_workspace_root(&app, &state)
}

/// Create the workspace root if it is not there.
///
/// Explicit rather than created on save: a settings write should not quietly
/// make directories on someone's disk, and the recommended default is a
/// suggestion until it is accepted.
///
/// # Errors
/// Returns the IO error as a string when the directory cannot be created.
#[tauri::command]
fn create_workspace_root(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WorkspaceRoot, String> {
    let resolved = resolve_workspace_root(&app, &state);
    std::fs::create_dir_all(&resolved.path).map_err(|error| error.to_string())?;
    Ok(resolve_workspace_root(&app, &state))
}

/// Where the tables were opened from, whether that is changeable, and where the
/// next launch will open if that has been changed since.
#[tauri::command]
fn get_data_location(state: State<'_, AppState>) -> location::LocationView {
    location::view(&state.config_dir, &state.data_dir, &state.location)
}

/// Ask the OS for a directory, for the Settings "Choose…" row.
///
/// `window.prompt` used to stand in for this and silently did nothing. wry
/// implements only three of `WKUIDelegate`'s methods and the JavaScript text
/// input panel is not among them, so WKWebView completes the request with nil
/// without drawing anything: `prompt()` returns `null` instantly and the click
/// has no visible effect at all. A native picker is both the path that works and
/// the right affordance for a filesystem path.
///
/// `None` means the user cancelled, which is not an error, the caller writes no
/// pointer and the row is left alone.
///
/// # Errors
/// Returns a message when the picker goes away without answering, which would
/// otherwise hang the caller's await forever.
#[tauri::command]
async fn choose_data_directory(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // Open where the tables are now, so the picker starts somewhere meaningful
    // rather than in whatever directory macOS remembers last. The path may not
    // exist yet on a first run, in which case its parent is the next best thing.
    let current = &state.location.path;
    let start = if current.is_dir() {
        Some(current.clone())
    } else {
        current.parent().map(std::path::Path::to_path_buf)
    };

    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose the agencyzero data directory");
    if let Some(start) = start {
        dialog = dialog.set_directory(start);
    }

    /*
     * The callback form, not `blocking_pick_folder`. Tauri runs a synchronous
     * command on the main thread, and the blocking variant asks the main thread
     * to run the panel and then waits for it, from the main thread that is a
     * deadlock, with the window frozen behind a dialog that never appears.
     */
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |picked| {
        // Fails only if this command was already dropped; nobody is left to tell.
        let _ = tx.send(picked);
    });

    let picked = rx
        .await
        .map_err(|_| "the directory picker closed without answering".to_string())?;
    Ok(picked.map(|path| path.to_string()))
}

/// Ask the OS for a working directory, for a project's Settings section.
///
/// Separate from [`choose_data_directory`] because it starts somewhere else:
/// a checkout lives under home, not beside the store. The panel asked for a
/// typed path with a note saying a picker needed the dialog plugin, which has
/// been wired since; a typed path is also how a project ends up pointed at a
/// directory that is not a checkout, which is exactly what stopped pull
/// requests being discovered.
#[tauri::command]
async fn choose_project_directory(app: AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("Choose a working directory");
    if let Some(home) = dirs_home() {
        dialog = dialog.set_directory(home);
    }
    // The callback form, never the blocking one: see `choose_data_directory`.
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx
        .await
        .map_err(|_| "the directory picker closed without answering".to_string())?;
    Ok(picked.map(|path| path.to_string()))
}

/// Choose a custom AgencyProxy executable. The persisted setting is applied on
/// the next proxy restart; canceling the picker changes nothing.
#[tauri::command]
async fn choose_agent_proxy_binary(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose an AgencyProxy executable")
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx
        .await
        .map_err(|_| "the AgencyProxy picker closed without answering".to_string())?;
    Ok(picked.map(|path| path.to_string()))
}

#[tauri::command]
async fn get_agent_proxy_status(state: State<'_, AppState>) -> Result<agent_proxy::Status, String> {
    state.proxy.status().await
}

#[tauri::command]
async fn restart_agent_proxy(
    mode: String,
    state: State<'_, AppState>,
) -> Result<agent_proxy::Status, String> {
    let mode = match mode.as_str() {
        "drain" => agency_proxy_protocol::ShutdownMode::Drain,
        "terminate" => agency_proxy_protocol::ShutdownMode::Terminate,
        _ => return Err(format!("unknown AgencyProxy restart mode: {mode}")),
    };
    let configured_proxy = state
        .tables
        .kv_get(settings::KEY)
        .and_then(|raw| serde_json::from_str::<GlobalSettings>(&raw).ok())
        .map(|settings| settings.agent_proxy_binary)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    state.proxy.restart(configured_proxy, mode).await
}

#[tauri::command]
async fn stop_agent_proxy(state: State<'_, AppState>) -> Result<agent_proxy::Status, String> {
    state.proxy.stop().await
}

/// The user's home, or nothing when the platform will not say.
fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

/// Ask the OS for files, for the composer's Attach button.
///
/// The chosen paths land in the prompt as text, the agents take file paths
/// in prose, so "attach" honestly means "put the path where the model will
/// read it", not an upload. An empty list means the user cancelled, which is
/// not an error.
///
/// Same shape as [`choose_data_directory`], and for the same reasons: the
/// callback form because a blocking picker on the main thread deadlocks, and
/// a Rust-side command so the control greys out through the capability probe
/// on a build that lacks it.
///
/// # Errors
/// Returns a message when the picker goes away without answering, which would
/// otherwise hang the caller's await forever.
#[tauri::command]
async fn choose_attachments(app: AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Attach files to the prompt")
        .pick_files(move |picked| {
            // Fails only if this command was already dropped; nobody is left to tell.
            let _ = tx.send(picked);
        });

    let picked = rx
        .await
        .map_err(|_| "the file picker closed without answering".to_string())?;
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string())
        .collect())
}

/// Point future launches at a different directory, or back at the default.
///
/// Takes effect on the next launch and moves nothing. A database cannot be
/// relocated out from under its open handles, and silently copying a transcript
/// to a new disk is not something to do without asking.
///
/// # Errors
/// Returns the IO error as a string when the pointer cannot be written, and
/// refuses outright when the location came from `AZ_DATA_DIR`: writing a pointer
/// the environment will keep overriding would report a change that never happens.
#[tauri::command]
fn set_data_location(path: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    if !state.location.is_editable {
        return Err("the data location is set by AZ_DATA_DIR and cannot be changed here".into());
    }
    location::set_pointer(&state.config_dir, path.as_deref().map(std::path::Path::new))
        .map_err(|error| error.to_string())
}

/// Manual, verified backups still present beside the current store, newest first.
///
/// The last angel operation arrives through the replacement process's
/// environment. It is deliberately process-local: the backup directory is the
/// durable fact, while the message only explains the restart that just happened.
#[tauri::command]
fn get_store_backup_status(
    state: State<'_, AppState>,
) -> Result<store_backup::StoreBackupStatus, String> {
    store_backup::status(&state.location.path)
}

/// Take a snapshot of the store, now, because the owner asked for one.
///
/// This used to happen on every launch, which cost a full copy per boot and
/// left ten copies of a 128MB store in one profile. It also bought less than it
/// looked like: the corruption that actually occurred was copied faithfully
/// into both rolling snapshots, so neither could restore past it.
///
/// No restart, unlike a backup. A backup drains and exits because the angel
/// copies the store from outside the process; here the process holding the only
/// writer lock takes the copy itself, so draining first is enough to make what
/// lands on disk consistent.
///
/// # Errors
/// Refuses an ephemeral session, which has no durable store to copy, and
/// reports a drain that failed rather than snapshotting a store mid-write.
#[tauri::command]
async fn create_store_snapshot(state: State<'_, AppState>) -> Result<String, String> {
    if state.location.source == "ephemeral" {
        return Err("an ephemeral session has no durable store to snapshot".into());
    }
    state.drain_tables_once().await?;
    snapshot_store(&state.location.path);
    Ok(state
        .location
        .path
        .file_name()
        .map(|name| format!("{}.snapshot-1", name.to_string_lossy()))
        .unwrap_or_else(|| "snapshot-1".into()))
}

/// Choose a profile-agnostic package, then let the restart angel archive and
/// byte-verify the closed store.
///
/// # Errors
/// Refuses ephemeral sessions and active agent runs, and leaves the GUI open if
/// the drain or angel spawn fails.
#[tauri::command]
async fn create_store_backup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.location.source == "ephemeral" {
        return Err("an ephemeral session has no durable store to back up".into());
    }
    if state.live_run_count() != 0 {
        return Err("stop active agent runs before backing up the store".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save AgencyZero backup")
        .set_file_name(store_backup::new_backup_file_name())
        .add_filter("AgencyZero backup", &["azbackup"])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|_| "the backup save dialog closed without answering".to_string())?
    else {
        return Ok(());
    };
    let mut backup = picked.into_path().map_err(|error| error.to_string())?;
    if backup.extension().and_then(|extension| extension.to_str()) != Some("azbackup") {
        backup.set_extension("azbackup");
    }
    if !store_backup::is_package_path(&backup) {
        return Err("choose an absolute .azbackup destination".into());
    }
    if backup.exists() {
        return Err("the selected backup file already exists; choose a new name".into());
    }
    let store = std::fs::canonicalize(&state.location.path)
        .map_err(|error| format!("could not resolve the active store: {error}"))?;
    state.drain_tables_once().await?;
    angel::spawn(angel::Action::Backup { store, backup })?;
    app.exit(0);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreBackupSelection {
    file_name: String,
}

/// Choose and validate a profile-agnostic package without exposing its path.
#[tauri::command]
async fn select_store_backup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<StoreBackupSelection>, String> {
    if state.location.source == "ephemeral" {
        return Err("an ephemeral session has no durable store to restore".into());
    }
    *state.pending_restore.lock().await = None;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose an AgencyZero backup to restore")
        .add_filter("AgencyZero backup", &["azbackup"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|_| "the restore file dialog closed without answering".to_string())?
    else {
        return Ok(None);
    };
    let backup = picked.into_path().map_err(|error| error.to_string())?;
    if !store_backup::is_package_path(&backup) {
        return Err("choose an absolute .azbackup package".into());
    }
    if !backup.is_file() {
        return Err("the selected backup no longer exists".into());
    }
    store_backup::check_restore(&backup)?;
    let file_name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "the selected backup has no readable file name".to_string())?
        .to_string();
    *state.pending_restore.lock().await = Some(backup);
    Ok(Some(StoreBackupSelection { file_name }))
}

/// Atomically replace the closed store with the owner-selected package.
///
/// The displaced store is retained under a generated `pre-restore` name. The
/// webview supplies no path: only the preceding native picker can select it.
#[tauri::command]
async fn restore_store_backup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.location.source == "ephemeral" {
        return Err("an ephemeral session has no durable store to restore".into());
    }
    if state.live_run_count() != 0 {
        return Err("stop active agent runs before restoring the store".into());
    }
    let backup = state
        .pending_restore
        .lock()
        .await
        .clone()
        .ok_or_else(|| "select a backup file before restoring".to_string())?;
    if !backup.is_file() {
        return Err("the selected backup no longer exists".into());
    }
    // Checked again inside the angel after the parent exits. This first pass
    // keeps an incompatible package from draining the live app merely to
    // discover that it cannot be restored.
    store_backup::check_restore(&backup)?;
    let store = std::fs::canonicalize(&state.location.path)
        .map_err(|error| format!("could not resolve the active store: {error}"))?;
    state.drain_tables_once().await?;
    angel::spawn(angel::Action::Restore { store, backup })?;
    app.exit(0);
    Ok(())
}

/// Restart into whatever binary sits at this app's own path on disk.
///
/// The self-hosting keystone: after `cargo tauri build` lands a new bundle at
/// the same path, the running instance is the stale copy. Draining the tables
/// first and then handing our path to the restart angel is "restart into the
/// new build", and the clean half of any upgrade. The angel, rather than the
/// process being replaced, owns the relaunch.
///
/// # Errors
/// None reachable, the tail never returns. `Result` for command uniformity.
#[tauri::command]
async fn relaunch_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::log!(
        log::Level::Info,
        "boot",
        "relaunching into the binary on disk"
    );
    restart_after_drain(&app, &state).await
}

/// Drain once, then hand the actual relaunch to a process that survives us.
///
/// Spawning happens only after a successful drain. If the angel cannot start,
/// this process stays alive and reports the error instead of exiting with no
/// replacement. The angel waits for this PID to disappear before executing
/// the binary now present at the same path, so old and new builds never hold
/// the single-writer store at the same time.
pub(crate) async fn restart_after_drain(app: &AppHandle, state: &AppState) -> Result<(), String> {
    state.drain_tables_once().await?;
    angel::spawn(angel::Action::Relaunch)?;
    app.exit(0);
    Ok(())
}

/// Drain off the native event loop, then let Tauri finish the process.
///
/// `RunEvent::Exit` is synchronous. Doing the first and potentially slow drain
/// there makes macOS show the app as unresponsive. The webview routes ordinary
/// close requests here so it stays responsive while each table reports its
/// own completion or failure.
#[tauri::command]
async fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Err(error) = state.drain_tables_once().await {
        crate::log!(
            log::Level::Error,
            "boot",
            "quit drain reported a persistence failure: {error}"
        );
        return Err(format!(
            "AgencyZero stayed open because its persistence worker failed: {error}. Copy anything important from the current turn, then use Force Quit only if necessary."
        ));
    }
    app.exit(0);
    Ok(())
}

/// Terminate AgencyProxy, let its run handlers settle, drain WorkTable, then
/// exit the GUI. Ordinary Quit deliberately leaves the proxy alive.
#[tauri::command]
async fn quit_app_and_proxy(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.proxy.terminate().await?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while state.live_run_count() != 0 {
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "AgencyProxy stopped, but AgencyZero is still settling terminated runs; try Quit Both again in a moment"
                    .into(),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    state.drain_tables_once().await?;
    app.exit(0);
    Ok(())
}

/// The persisted settings record, or the defaults on a first run.
///
/// A record that fails to parse is replaced by the defaults rather than failing
/// the call: the alternative is a window that will not boot until someone
/// hand-edits a file it never told them the path of. The bad record is left on
/// disk rather than overwritten, so it is still there to look at.
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> GlobalSettings {
    let has_projects = state
        .tables
        .project
        .select_all()
        .execute()
        .is_ok_and(|projects| !projects.is_empty());
    let mut settings = match state.tables.kv_get(settings::KEY) {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|error| {
            crate::log!(
                log::Level::Warn,
                "settings",
                "record unreadable, using established-store defaults: {error}"
            );
            settings::defaults_for_store(has_projects)
        }),
        None => settings::defaults_for_store(has_projects),
    };
    settings::normalize_for_store(&mut settings, has_projects);
    settings
}

/// Merge a partial patch into the stored record and return the whole thing.
///
/// Returns the merged record because the frontend replaces its copy with the
/// response: two quick changes racing would otherwise let the slower one revert
/// the other.
///
/// # Errors
/// Returns the store's error as a string when the write fails, so a setting that
/// did not persist reports rather than appearing to have saved.
#[tauri::command]
async fn set_settings(
    patch: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<GlobalSettings, String> {
    apply_settings_patch(patch, &state).await
}

/// Apply one settings merge through the shared serialized write path.
///
/// The Settings UI and owner-authorized Prompt Syntax both call this function,
/// so neither can race a stale read over the other's update.
pub(crate) async fn apply_settings_patch(
    patch: serde_json::Value,
    state: &AppState,
) -> Result<GlobalSettings, String> {
    // Held across the whole read-merge-write. The frontend's response
    // ticketing protects its in-memory copy from stale responses; only this
    // protects the record on disk from a stale write.
    let _guard = state.settings_write.lock().await;

    /*
     * Scanned only when the defaults are actually reached, which is once.
     *
     * `has_projects` decides a single field on a *default* record, so the moment
     * a settings row exists its value is computed and discarded. Eager, that put
     * a full `select_all()` over the project table inside the write lock on
     * every settings write, and the Settings UI writes once per interaction:
     * picking colours quickly queued one table scan per pick behind the same
     * mutex.
     *
     * Measured from the frame log during rapid picks: intervals of 83 and 88ms
     * where `resolve` was 0.60ms, `paint` 0.06ms and `renderer` 5.69ms, so
     * about 77ms of each stall was spent outside the frame entirely. Painting
     * the pick early (`writeAccentPreview`) makes the colour appear on the next
     * frame but cannot shorten this, because the wait is behind the lock rather
     * than in front of the renderer.
     */
    let scan_for_projects = || {
        state
            .tables
            .project
            .select_all()
            .execute()
            .is_ok_and(|projects| !projects.is_empty())
    };
    let current = state
        .tables
        .kv_get(settings::KEY)
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    // Whether onboarding is already recorded as done, read before the fallback
    // so the scan below can be skipped on the common path.
    let settled = current
        .as_ref()
        .and_then(|value| value.get("onboardingCompleted"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    /*
     * `has_projects` can only ever *set* `onboarding_completed`, never clear it
     * (`settings::normalize_for_store`), so once that flag is true the scan's
     * answer cannot change anything and does not need asking.
     */
    let has_projects = settled || scan_for_projects();
    let current = current.unwrap_or_else(|| {
        serde_json::to_value(settings::defaults_for_store(has_projects)).unwrap_or_default()
    });

    let mut previous: GlobalSettings = serde_json::from_value(current)
        .unwrap_or_else(|_| settings::defaults_for_store(has_projects));
    // Materialize migrations before applying a partial patch. In particular,
    // an old theme stored one colour in `accent`; changing the new independent
    // accent must preserve that old colour as the surface rather than copying
    // the newly selected accent into both roles.
    settings::normalize_for_store(&mut previous, has_projects);

    let mut merged = serde_json::to_value(&previous).map_err(|error| error.to_string())?;
    settings::merge(&mut merged, &patch);

    // Parse before writing. A patch that produces something unreadable should
    // fail here rather than land on disk and break the next launch.
    let mut parsed: GlobalSettings =
        serde_json::from_value(merged.clone()).map_err(|error| error.to_string())?;
    settings::normalize_for_store(&mut parsed, has_projects);
    let boundary = study::normalize_setting(&previous.study_analytics, &mut parsed.study_analytics);
    let merged = serde_json::to_value(&parsed).map_err(|error| error.to_string())?;

    let boundary_id = boundary
        .map(|boundary| study::record_boundary(&state.tables, &parsed.study_analytics, boundary))
        .transpose()?;

    #[cfg(feature = "blitz-runtime")]
    let runtime_debug_changed = previous.blitz_control_enabled != parsed.blitz_control_enabled
        || previous.blitz_deep_profiling_enabled != parsed.blitz_deep_profiling_enabled;
    #[cfg(feature = "blitz-runtime")]
    if runtime_debug_changed {
        tauri_runtime_blitz::apply_runtime_debug_options(
            tauri_runtime_blitz::RuntimeDebugOptions {
                inspection_and_agent_control: parsed.blitz_control_enabled,
                deep_intrusive_profiling: parsed.blitz_deep_profiling_enabled,
            },
        )
        .map_err(|error| format!("could not update local Blitz debugging: {error}"))?;
    }

    if let Err(error) = state.tables.kv_put(settings::KEY, merged.to_string()).await {
        #[cfg(feature = "blitz-runtime")]
        if runtime_debug_changed {
            let _ = tauri_runtime_blitz::apply_runtime_debug_options(
                tauri_runtime_blitz::RuntimeDebugOptions {
                    inspection_and_agent_control: previous.blitz_control_enabled,
                    deep_intrusive_profiling: previous.blitz_deep_profiling_enabled,
                },
            );
        }
        if let Some(id) = boundary_id
            && let Err(cleanup) = state.tables.study_event.delete(id).await
        {
            crate::log!(
                log::Level::Error,
                "study",
                "settings failed and its boundary event could not be removed: {cleanup}"
            );
        }
        return Err(error.to_string());
    }
    Ok(parsed)
}

/// The installed agents, probed through the crate.
///
/// Without `recheck` a cached answer is served when there is one, because
/// probing spawns two processes per agent and that is too slow to sit in front
/// of the first paint. The cache carries its own `checkedAt`, which Settings
/// renders, so a stale answer is visibly stale rather than silently so.
#[tauri::command]
async fn list_agent_status(
    recheck: bool,
    state: State<'_, AppState>,
) -> Result<Vec<agents::AgentStatusDto>, String> {
    if !recheck
        && let Some(cached) = state
            .tables
            .kv_get(agents::KEY)
            .and_then(|raw| serde_json::from_str::<Vec<agents::AgentStatusDto>>(&raw).ok())
    {
        return Ok(cached);
    }

    let detected = agents::detect_all(&state.proxy).await?;
    // A cache that cannot be written is not worth failing the call over: the
    // answer in hand is still correct, it just will not survive a restart.
    if let Ok(encoded) = serde_json::to_string(&detected)
        && let Err(error) = state.tables.kv_put(agents::KEY, encoded).await
    {
        crate::log!(
            log::Level::Warn,
            "agents",
            "could not cache the agent probe: {error}"
        );
    }
    Ok(detected)
}

/// Hello-world IPC round trip: the frontend calls this over Tauri's invoke
/// bridge and renders the reply, proving webview <-> Rust wiring works.
#[tauri::command]
fn greet(name: &str) -> String {
    format!(
        "Hello, {name}! Greetings from az-gui {} (Rust side).",
        az_core::VERSION
    )
}

/// Menu ids the frontend answers for. Each becomes a `menu:<id>` event.
const NEW_PROJECT: &str = "new-project";
const NEW_PROJECT_TYPING: &str = "new-project-typing";
const SETTINGS: &str = "settings";
const CLOSE_TAB: &str = "close-tab";
const NEXT_TAB: &str = "next-tab";
const PREV_TAB: &str = "prev-tab";
const QUIT: &str = "quit";
const QUIT_ALL: &str = "quit-all";
const RESTART: &str = "restart";

/// The application menu.
///
/// Hand-built rather than `Menu::default`, for one reason: the predefined
/// Close Window item owns Cmd+W, and in a tabbed window Cmd+W has to close the
/// tab. Everything else here is the standard macOS menu, and the Edit submenu
/// is not optional, because without it copy and paste stop working in the
/// composer.
///
/// Tab items and Quit carry ids instead of behaviour: they emit to the webview,
/// which owns the tab strip and the close confirmation. A menu accelerator
/// beats a webview keybinding for these because macOS delivers it whatever has
/// focus, and because it puts the shortcut somewhere discoverable.
fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let quit = MenuItemBuilder::with_id(QUIT, "Quit AgencyZero")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let quit_all =
        MenuItemBuilder::with_id(QUIT_ALL, "Quit AgencyZero & AgencyProxy…").build(app)?;
    // No accelerator: restarting is deliberate, not something to fat-finger.
    let restart = MenuItemBuilder::with_id(RESTART, "Restart into Build on Disk").build(app)?;

    // The About box carries the full stamp, so "which build is this?" has an
    // answer reachable without opening Settings. macOS renders it as
    // "Version {short_version} ({version})" and shows nothing else
    // `comments` in particular is Linux-only, so the stamp has to ride in
    // `version` to appear at all.
    let stamp = format!("{} · built {}", BUILD.git_sha, BUILD.built_at);
    let about = AboutMetadata {
        short_version: Some(BUILD.version.into()),
        version: Some(stamp.clone()),
        comments: Some(stamp),
        ..Default::default()
    };

    let app_menu = SubmenuBuilder::new(app, "AgencyZero")
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&restart)
        .item(&quit_all)
        .item(&quit)
        .build()?;

    // AppKit's predefined edit items consume Cmd+X/C/V/A before the custom
    // runtime receives a key event, but Blitz's text editor is the component
    // that actually owns selection and clipboard state. Keep the standard
    // native menu for WebKit; leave its Blitz counterpart accelerator-free so
    // the renderer can handle the shortcuts instead of silently dropping them.
    #[cfg(feature = "blitz-runtime")]
    let edit_menu = SubmenuBuilder::new(app, "Edit").build()?;
    #[cfg(not(feature = "blitz-runtime"))]
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // Cmd+N is the standard new-project shortcut. Ctrl+T is the established
    // typing shortcut; it is deliberately claimed below even though macOS
    // normally reserves it for transpose-characters.
    let new_project = MenuItemBuilder::with_id(NEW_PROJECT, "New Project")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    // Keep the established typing shortcut in the native menu as well. WebKit
    // delivered Ctrl+T to the page, but AppKit can interpret it as the standard
    // `transpose:` text command before the Blitz document sees a keydown.
    let new_project_typing =
        MenuItemBuilder::with_id(NEW_PROJECT_TYPING, "New Project with Ctrl+T")
            .accelerator("Ctrl+T")
            .build(app)?;
    // Cmd+S is free here: nothing in a tabbed agent window saves a document.
    //
    // Home has deliberately *not* been given Cmd+H. macOS reserves it for Hide
    // Application, which the app submenu above owns, and taking it would make
    // this the one Mac app where Cmd+H does something else.
    let settings = MenuItemBuilder::with_id(SETTINGS, "Settings")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id(CLOSE_TAB, "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    // macOS consumes a native menu accelerator before Blitz receives the key,
    // while the custom runtime does not yet deliver that menu callback. Leave
    // these two unclaimed in Blitz so its DOM keydown fallback can cycle tabs.
    // WebKit keeps the native accelerators and their right-aligned menu labels.
    #[cfg(feature = "blitz-runtime")]
    let prev_tab = MenuItemBuilder::with_id(PREV_TAB, "Select Previous Tab (⌘1)").build(app)?;
    #[cfg(not(feature = "blitz-runtime"))]
    let prev_tab = MenuItemBuilder::with_id(PREV_TAB, "Select Previous Tab")
        .accelerator("CmdOrCtrl+1")
        .build(app)?;
    #[cfg(feature = "blitz-runtime")]
    let next_tab = MenuItemBuilder::with_id(NEXT_TAB, "Select Next Tab (⌘2)").build(app)?;
    #[cfg(not(feature = "blitz-runtime"))]
    let next_tab = MenuItemBuilder::with_id(NEXT_TAB, "Select Next Tab")
        .accelerator("CmdOrCtrl+2")
        .build(app)?;

    let tab_menu = SubmenuBuilder::new(app, "Tabs")
        .item(&new_project)
        .item(&new_project_typing)
        .item(&settings)
        .separator()
        .item(&close_tab)
        .separator()
        .item(&prev_tab)
        .item(&next_tab)
        .build()?;

    // No Close Window item: its accelerator is Cmd+W and cannot be changed, so
    // it would shadow Close Tab. The traffic light still closes the window, and
    // that path is confirmed the same way Quit is.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &tab_menu, &window_menu])
        .build()
}

/// Take the user's real `PATH` from their login shell.
///
/// An app launched from Finder inherits launchd's minimal `PATH`
/// (`/usr/bin:/bin:...`), not the terminal's, so every agent probe spawned
/// `claude` by name, found nothing, and Settings reported three installed
/// CLIs as "not installed" while dev runs (launched from a terminal) worked.
/// Asking the login shell is the same trick every GUI editor uses.
fn adopt_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let shell_path = std::process::Command::new(&shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .filter(|path| !path.trim().is_empty())
        .map(OsString::from)
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path = agents::with_user_local_bin(&shell_path, home.as_deref());
    // Safe: called before the async runtime or any thread exists.
    unsafe { std::env::set_var("PATH", path) };
}

/// A scratch store for a session that must not touch the real one.
///
/// Per-pid, under the OS temp dir: two instances get two scratches, and the
/// OS reclaims them. Nothing written here is meant to survive the session,
/// and Settings says so by rendering the source as `ephemeral`.
fn ephemeral_location() -> location::DataLocation {
    location::DataLocation {
        path: std::env::temp_dir().join(format!("agencyzero-ephemeral-{}", std::process::id())),
        source: "ephemeral".into(),
        is_editable: false,
    }
}

/// Carry the window chrome's colours from the stylesheet to AppKit.
///
/// The theme is CSS and changes at runtime; the glass view behind the window is
/// an AppKit object created once at launch. Without this the two drift: the page
/// restyles and the frame around it keeps whatever it was born with.
///
/// The webview reads its own computed values and sends them, so there is no
/// second copy of the palette in Rust to fall out of date.
#[cfg(all(feature = "blitz-runtime", target_os = "macos"))]
#[tauri::command]
fn set_window_chrome(tint: Option<[u8; 4]>, radius: Option<f64>, enabled: bool) {
    tauri_runtime_blitz::set_window_glass(tint.map(|[r, g, b, a]| (r, g, b, a)), radius, enabled);
}

/// Not macOS, or not the Blitz runtime: nothing to carry across.
#[cfg(not(all(feature = "blitz-runtime", target_os = "macos")))]
#[tauri::command]
fn set_window_chrome(_tint: Option<[u8; 4]>, _radius: Option<f64>, _enabled: bool) {}

/// Refresh the rolling pre-open snapshot of the store: `db.snapshot-1` is
/// the last boot's state, `db.snapshot-2` the boot before that.
///
/// Taken while the exclusive lock is held and before any table opens, so the
/// copy is of a store nothing is writing. Copied into a staging directory
/// first and renamed into place after, so a crash mid-copy can never leave a
/// half snapshot wearing the name a recovery would trust. Failure is a
/// warning, not an error: the snapshot protects the next session, and
/// refusing to start this one over it would protect nothing.
fn snapshot_store(store: &std::path::Path) {
    if !store.is_dir() {
        return; // First launch: nothing to keep yet.
    }
    let named = |suffix: &str| {
        let mut name = store.file_name().unwrap_or_default().to_os_string();
        name.push(suffix);
        store.with_file_name(name)
    };
    let newest = named(".snapshot-1");
    let older = named(".snapshot-2");
    let staging = named(".snapshot-staging");

    let started = std::time::Instant::now();
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(error) = copy_dir_all(store, &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        crate::log!(
            log::Level::Warn,
            "boot",
            "could not snapshot the store before opening it: {error}; booting without one"
        );
        return;
    }
    let _ = std::fs::remove_dir_all(&older);
    if newest.is_dir() && std::fs::rename(&newest, &older).is_err() {
        // An unrotatable old snapshot is stale, not sacred: the fresh copy
        // in staging is strictly newer, so it takes the name.
        let _ = std::fs::remove_dir_all(&newest);
    }
    match std::fs::rename(&staging, &newest) {
        Ok(()) => crate::log!(
            log::Level::Info,
            "boot",
            "store snapshot written to {newest:?} in {}ms",
            started.elapsed().as_millis()
        ),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            crate::log!(
                log::Level::Warn,
                "boot",
                "could not move the store snapshot into place: {error}; booting without one"
            );
        }
    }
}

/// `std::fs::copy`, recursively. Symlinks are not followed because the store
/// never contains one.
fn copy_dir_all(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Carry a mismatched store forward without ever putting it at risk.
///
/// The order is the whole design, learned from doing it the other way:
///
/// 1. Migrate `db` into `db.next-<stamp>`. The live store is only read.
/// 2. Only on success: `db` becomes `db.pre-migration-<stamp>` (kept, whole),
///    and `next` becomes `db`. Two renames on one filesystem.
/// 3. On any failure: delete the partial `next`, leave `db` byte-for-byte
///    untouched, and boot on a scratch store so the app still opens. The old
///    build can still read the old store; nothing is stranded and nothing is
///    lost.
///
/// The previous flow renamed the store aside *first* and built the target at
/// the live path, so a failed migration left its partial output as "the
/// store" and the app booted into debris believing it clean.
///
/// # Errors
/// Only when even the scratch store cannot open, which is a disk problem no
/// flow survives.
fn migrate_forward(location: &mut location::DataLocation, found: &str) -> Result<Tables, String> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let next = location.path.with_extension(format!("next-{stamp}"));
    crate::log!(
        log::Level::Warn,
        "boot",
        "the store was written by a different schema ({found}); migrating {:?} into {next:?} \
         without touching the source",
        location.path
    );

    let carried = tauri::async_runtime::block_on(wt_migrate::carry_forward(
        &location.path,
        &next,
        found,
        wt_migrate::CURRENT_FINGERPRINT,
    ));

    match carried {
        Ok(report) => {
            let keep = location
                .path
                .with_extension(format!("pre-migration-{stamp}"));
            /*
             * Two renames, and they fail differently.
             *
             * They used to be chained, and both failures were reported with
             * one message: "the store is untouched". That is true only of the
             * first. If the *second* fails, the store has already been moved
             * to `keep`, and the old handling then deleted the migrated copy
             * and said nothing about where the original went, leaving an empty
             * data directory, a timestamped one nobody was told about, and a
             * next launch that finds no store at all and starts clean.
             */
            if let Err(error) = std::fs::rename(&location.path, &keep) {
                let _ = std::fs::remove_dir_all(&next);
                crate::log!(
                    log::Level::Error,
                    "boot",
                    "could not move the store aside: {error}. The store at {:?} is untouched; \
                     booting on a scratch store instead.",
                    location.path
                );
                *location = ephemeral_location();
                return tauri::async_runtime::block_on(Tables::open(&location.path))
                    .map_err(|error| format!("could not open a scratch store: {error}"));
            }
            if let Err(error) = std::fs::rename(&next, &location.path) {
                // Put the original back, so the next launch finds its store
                // where it expects rather than starting empty.
                match std::fs::rename(&keep, &location.path) {
                    Ok(()) => {
                        let _ = std::fs::remove_dir_all(&next);
                        crate::log!(
                            log::Level::Error,
                            "boot",
                            "could not move the migrated store into place: {error}. The original \
                             is back at {:?} and is unchanged; booting on a scratch store.",
                            location.path
                        );
                    }
                    Err(back) => {
                        /*
                         * Nothing is deleted here. Both copies are real data
                         * and the only thing wrong is their names, so the log
                         * says exactly where each one is and what to do.
                         */
                        crate::log!(
                            log::Level::Error,
                            "boot",
                            "could not move the migrated store into place ({error}), and could \
                             not put the original back ({back}). Nothing is lost and nothing was \
                             deleted: your original store is at {keep:?} and the migrated copy \
                             is at {next:?}. Rename one of them to {:?} to carry on. Booting on \
                             a scratch store meanwhile.",
                            location.path
                        );
                    }
                }
                *location = ephemeral_location();
                return tauri::async_runtime::block_on(Tables::open(&location.path))
                    .map_err(|error| format!("could not open a scratch store: {error}"));
            }
            crate::log!(
                log::Level::Info,
                "boot",
                "carried the store forward: migrated [{}], copied [{}], reset [{}]. The \
                 pre-migration store is kept whole at {keep:?}",
                report.migrated.join(", "),
                report.copied.join(", "),
                report.reset.join(", ")
            );
            for (table, reason) in &report.failed {
                crate::log!(
                    log::Level::Warn,
                    "boot",
                    "{table} could not be carried forward and starts empty: {reason}"
                );
            }
            for (table, count) in &report.dropped {
                crate::log!(
                    log::Level::Warn,
                    "boot",
                    "{table}: dropped {count} row(s) that failed the sanity check during migration"
                );
            }
            tauri::async_runtime::block_on(Tables::open(&location.path)).map_err(|error| {
                let message = format!("could not open the migrated store: {error}");
                crate::log!(log::Level::Error, "boot", "{message}");
                message
            })
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&next);
            crate::log!(
                log::Level::Error,
                "boot",
                "migration failed: {error}. The store at {:?} is byte-for-byte untouched. \
                 Booting on a scratch store so the app still opens; relaunch with \
                 AZ_NO_DB_MIGRATION=1 to keep doing this, or downgrade to the build that \
                 wrote the store to use it as it is.",
                location.path
            );
            *location = ephemeral_location();
            tauri::async_runtime::block_on(Tables::open(&location.path))
                .map_err(|error| format!("could not open a scratch store: {error}"))
        }
    }
}

fn main() {
    /*
     * Building the QA profile takes over the process, like the restart angel
     * above: it needs this crate's private `db` module and its real schema, and
     * a separate binary cannot reach either without turning the application
     * into a library for one tool's sake.
     */
    if let Ok(spec) = std::env::var(qa_profile::ENV) {
        let Some((source, destination)) = spec.rsplit_once(':') else {
            eprintln!("{}: expected <source-db>:<destination>", qa_profile::ENV);
            std::process::exit(2);
        };
        let source = std::path::PathBuf::from(source);
        let destination = std::path::PathBuf::from(destination);
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("could not start a runtime: {error}");
                std::process::exit(1);
            }
        };
        match runtime.block_on(qa_profile::build(&source, &destination)) {
            Ok(rows) => {
                println!("scrubbed {rows} rows into {}", destination.display());
                return;
            }
            Err(error) => {
                eprintln!("could not build the QA profile: {error}");
                std::process::exit(1);
            }
        }
    }

    if let Some(result) = angel::run_from_env() {
        if let Err(error) = result {
            eprintln!("AgencyZero restart angel failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    adopt_login_shell_path();

    // The runtime narrates window creation through this hook, and nothing was
    // listening, so those lines went nowhere. They are the only account of what
    // the native window actually did — whether a glass backdrop was applied, or
    // refused, and why.
    #[cfg(feature = "blitz-runtime")]
    tauri_runtime_blitz::set_runtime_trace(|message| {
        crate::log!(log::Level::Info, "blitz", "{message}");
    });

    #[cfg(feature = "blitz-runtime")]
    let startup_store_lock = match preflight_blitz_profile() {
        Ok(BlitzPreflight::Busy) => return,
        Ok(BlitzPreflight::Skip) => None,
        Ok(BlitzPreflight::Acquired(path, lock)) => Some((path, lock)),
        Err(error) => {
            eprintln!("AgencyZero could not probe its data profile: {error}");
            std::process::exit(1);
        }
    };
    #[cfg(not(feature = "blitz-runtime"))]
    let startup_store_lock: Option<(PathBuf, std::fs::File)> = None;

    /*
     * Panics must reach the log file. A Finder-launched app's stderr goes
     * nowhere, so before this hook a crash left a DiagnosticReports entry
     * saying only "abort()", the message and location of the panic itself
     * were discarded with the stream.
     */
    /*
     * With the stack, and `force_capture` rather than `capture`: this hook
     * replaces the default one instead of chaining it, so `RUST_BACKTRACE` is
     * read by nobody and setting it does nothing. 0.6.1 aborted two seconds
     * after `boot: ready` inside stylo's `CalcLengthPercentage::resolve`, and
     * the log named the line in a registry crate and not one frame of ours, so
     * there was no way to tell which declaration on which element reached it.
     *
     * Cost is paid once, on the way out of a process that is already dying.
     */
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        crate::log!(log::Level::Error, "panic", "{info}\n{backtrace}");
        eprintln!("{info}\n{backtrace}");
    }));

    #[cfg(feature = "blitz-runtime")]
    tauri_runtime_blitz::set_document_factory(create_blitz_document);

    // The CLI switch is the rescue path for QA when the Settings toggle is
    // off. Read it before the app is built so control can start before the
    // native event loop; setup may never run when macOS rejects activation.
    #[cfg(feature = "blitz-runtime")]
    let cli_blitz_control_enabled = std::env::args().any(|arg| arg == "--blitz-control");
    #[cfg(feature = "blitz-runtime")]
    let cli_blitz_deep_profiling_enabled =
        std::env::args().any(|arg| arg == "--blitz-deep-profiling");

    #[cfg(feature = "blitz-runtime")]
    let builder = tauri_runtime_blitz::builder();
    #[cfg(not(feature = "blitz-runtime"))]
    let builder = tauri::Builder::default();

    let app = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Called from Rust only, so no capability entry: the permissions in
        // `capabilities/default.json` gate the plugin's *JavaScript* commands,
        // and the webview has no business opening a panel of its own.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            update::check_for_update,
            update::install_update,
            list_capabilities,
            get_data_location,
            set_data_location,
            get_store_backup_status,
            create_store_backup,
            create_store_snapshot,
            select_store_backup,
            restore_store_backup,
            choose_data_directory,
            choose_project_directory,
            choose_agent_proxy_binary,
            get_agent_proxy_status,
            restart_agent_proxy,
            stop_agent_proxy,
            get_workspace_root,
            create_workspace_root,
            projects::list_projects,
            projects::get_home_snapshot,
            projects::list_items,
            projects::create_item,
            projects::fork_item,
            projects::set_item_status,
            projects::update_item,
            projects::set_item_issue,
            projects::delete_item,
            projects::unmark_item_deletion,
            projects::reorder_items,
            choose_attachments,
            prs::list_pull_requests,
            prs::dismiss_pull_request,
            prs::refresh_pull_request,
            prs::discover_pull_requests,
            projects::review_pull_request,
            questions::list_questions,
            questions::answer_question,
            projects::list_messages,
            projects::sync_project,
            projects::list_running_tasks,
            projects::list_task_log,
            projects::list_rate_limits,
            projects::discover_chat_imports,
            projects::import_chat_session,
            projects::clear_task_log,
            projects::delete_project,
            projects::set_project_pinned,
            projects::set_project_moderator,
            projects::reorder_projects,
            projects::rename_project,
            projects::add_dir,
            projects::remove_dir,
            projects::reset_task_manager,
            projects::get_task_manager,
            projects::resolve_approval,
            projects::list_approval_rules,
            projects::clear_approval_rules,
            projects::cancel_run,
            projects::compact_project,
            projects::get_checkpoints,
            projects::set_checkpoints,
            projects::get_project_concise,
            projects::set_project_concise,
            projects::get_project_notes,
            projects::set_project_notes,
            projects::get_item_context,
            projects::set_item_context,
            projects::get_cost_summary,
            projects::get_usage_analytics,
            projects::get_project_verbosity,
            projects::set_project_verbosity,
            projects::reset_project_session,
            projects::list_recoverable_sessions,
            projects::adopt_session,
            get_build_info,
            get_persistence_failure,
            projects::list_agent_io,
            projects::get_io_persist,
            projects::set_io_persist,
            quota::list_quota,
            experimental::claude_usage,
            projects::create_project,
            projects::send_message,
            get_settings,
            study::get_study_summary,
            study::export_study_events,
            study::clear_study_events,
            relaunch_app,
            quit_app,
            quit_app_and_proxy,
            set_settings,
            set_window_chrome,
            list_agent_status,
            models::list_models,
            pricing::pricing_table,
            log_frontend,
            get_log_path,
            list_table_sizes,
            open_external
        ])
        .setup(move |app| {
            app.set_menu(build_menu(app.handle())?)?;

            // The store is opened before the window is usable, and a failure is
            // fatal on purpose. Running with no persistence would let every
            // setting appear to save and then vanish on the next launch, which
            // is a worse failure than refusing to start.
            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|error| format!("no config directory: {error}"))?;
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("no data directory: {error}"))?;

            // The separately named standard Blitz test bundle uses the stable
            // profile so side-by-side renderer testing exercises real data.
            // Experimental is deliberately excluded: its bundle-derived path
            // is its profile boundary, and collapsing it into stable makes the
            // owner's entire Experimental project list appear to disappear.
            #[cfg(feature = "blitz-runtime")]
            let config_dir = blitz_profile_dir(config_dir);
            #[cfg(feature = "blitz-runtime")]
            let data_dir = blitz_profile_dir(data_dir);

            // Before anything that can fail, so whatever happens next is on the
            // record. Opening the tables is the first thing that can, and it is
            // fatal, a fatal error nobody can read is how this app lost an
            // afternoon.
            log::init(&data_dir.join("logs"));

            // The first line of every launch names the exact build, so a log
            // can never be read against the wrong binary.
            crate::log!(
                log::Level::Info,
                "boot",
                "az-gui {} · {} · built {}",
                BUILD.version,
                BUILD.git_sha,
                BUILD.built_at,
            );
            crate::log!(
                log::Level::Info,
                "boot",
                "profile={}",
                experimental::profile_name()
            );

            /*
             * The escape hatches, read before anything touches a store. Both
             * exist because of 2026-08-01: a corrupt table made every launch
             * die inside `Tables::open`, before the window existed, and there
             * was no way to start the app at all. Env and argv both work; a
             * Finder launch has an environment, a terminal has arguments.
             *
             * - AZ_NO_PERSIST / --debug-no-persist: never open the real store.
             *   The app runs on a scratch directory that dies with the
             *   session. For diagnosing exactly the above.
             * - AZ_NO_DB_MIGRATION / --no-db-migration: on a schema mismatch,
             *   migrate nothing and touch nothing. The store stays byte-for-
             *   byte as the old build wrote it, so downgrading to that build
             *   is always a way back; this session runs on scratch.
             */
            let no_persist = no_persist_requested();
            let no_migration = std::env::var_os("AZ_NO_DB_MIGRATION").is_some()
                || std::env::args().any(|arg| arg == "--no-db-migration");

            // Resolved before anything opens, because the settings record that
            // would otherwise carry it lives in the database being located.
            let mut location = location::resolve(&config_dir, &data_dir);
            if no_persist {
                let scratch = ephemeral_location();
                crate::log!(
                    log::Level::Warn,
                    "boot",
                    "no-persist mode: the real store at {:?} stays closed and untouched; \
                     this session runs on {:?} and keeps nothing",
                    location.path,
                    scratch.path
                );
                location = scratch;
            }
            crate::log!(
                log::Level::Info,
                "boot",
                "tables at {:?} (source {})",
                location.path,
                location.source
            );

            /*
             * The single-writer rule, enforced across processes. The store was
             * once corrupted by a second process writing table files the
             * running GUI already had open; an advisory flock on a sibling
             * file makes that a refusal instead. Held for the whole session by
             * living in AppState. wt-migrate takes the same lock.
             */
            let store_probe = match startup_store_lock {
                Some((preflight_path, lock)) if preflight_path == location.path => {
                    StoreProbe::Acquired(lock)
                }
                Some((_preflight_path, lock)) => {
                    // A custom Tauri config can route differently from the
                    // compiled Blitz identity. Release the speculative claim
                    // and probe the exact setup path before opening it.
                    drop(lock);
                    probe_store(&location.path).map_err(|error| error.to_string())?
                }
                None => probe_store(&location.path).map_err(|error| error.to_string())?,
            };
            let store_lock = match store_probe {
                StoreProbe::Acquired(lock) => lock,
                StoreProbe::Busy(busy) => {
                    // A second launch of one profile is harmless when it stops
                    // here: no WorkTable page has opened, the hidden window has
                    // never appeared, and the existing owner keeps running.
                    // Returning an error from setup used to turn this expected
                    // collision into a Tauri panic. This fallback is reached
                    // only when an externally supplied config routed somewhere
                    // the early Blitz probe could not know about.
                    crate::log!(
                        log::Level::Warn,
                        "boot",
                        "profile already open; exiting without touching WorkTable: {busy}"
                    );
                    eprintln!(
                        "AgencyZero profile is already open; this launch will exit without \
                         touching WorkTable: {busy}"
                    );
                    std::process::exit(0);
                }
            };

            /*
             * No snapshot here.
             *
             * It used to copy the whole store on every launch, which cost a
             * full duplicate per boot and littered the profile: this machine
             * reached ten copies of a 128MB store. It also bought less than it
             * appeared to — the tear that actually happened was copied
             * faithfully into both rolling snapshots, so neither could restore
             * past it.
             *
             * It is a button in Settings now, beside Backups, taken when the
             * owner asks for one. See `create_store_snapshot`.
             */

            /*
             * The fingerprint is read through the kv table alone, before any
             * other table opens: a full open of a mismatched store loads every
             * row through the wrong layout on the way to saying "mismatched",
             * which is somewhere between garbage and a bus error.
             */
            let peeked = tauri::async_runtime::block_on(Tables::peek_fingerprint(&location.path));
            let tables = match peeked {
                /*
                 * kv is the one table whose shape has never changed, so if it
                 * will not open, the store is damaged rather than old and
                 * there is nothing here a migration can fix. This used to be
                 * indistinguishable from a fresh directory: both answered
                 * `None`, which sends the boot down the `Match` arm, opens all
                 * nine tables through a layout nothing has checked, and then
                 * stamps the current fingerprint over the store, erasing the
                 * evidence that they ever disagreed.
                 *
                 * So: touch nothing, run on scratch, and say where the store
                 * is and what can read it.
                 */
                Err(reason) => {
                    crate::log!(
                        log::Level::Error,
                        "boot",
                        "the store at {:?} could not be read ({reason}), so it is left exactly \
                         as it is and this session runs on scratch, keeping nothing. Inspect it \
                         read-only with `AZ_DATA_DIR={:?} agency-tools list-messages`, or carry what \
                         is readable forward with `wt-migrate <that path> <a new path>`.",
                        location.path,
                        location.path
                    );
                    location = ephemeral_location();
                    tauri::async_runtime::block_on(Tables::open(&location.path))
                        .map_err(|error| format!("could not open a scratch store: {error}"))?
                }
                Ok(stored) => match db::tables::check_schema(stored.as_deref()) {
                db::tables::SchemaState::Match => tauri::async_runtime::block_on(Tables::open(
                    &location.path,
                ))
                .map_err(|error| {
                    let message = format!(
                        "could not open the tables in {:?}: {error}. \
                                 Relaunch with AZ_NO_PERSIST=1 (or --debug-no-persist) to start \
                                 the app without touching the store, then diagnose.",
                        location.path
                    );
                    crate::log!(log::Level::Error, "boot", "{message}");
                    message
                })?,
                db::tables::SchemaState::Mismatch { found } if no_migration => {
                    crate::log!(
                        log::Level::Warn,
                        "boot",
                        "schema mismatch and AZ_NO_DB_MIGRATION is set: the store at {:?} stays \
                         byte-for-byte untouched (its schema: {found}). Downgrade to the build \
                         that wrote it to keep using it, or relaunch without the flag to \
                         migrate. This session runs on scratch and keeps nothing.",
                        location.path
                    );
                    location = ephemeral_location();
                    tauri::async_runtime::block_on(Tables::open(&location.path))
                        .map_err(|error| format!("could not open a scratch store: {error}"))?
                }
                    db::tables::SchemaState::Mismatch { found } => {
                        migrate_forward(&mut location, &found)?
                    }
                },
            };
            crate::log!(log::Level::Info, "boot", "tables open");

            // Stamped after the check, so the next launch can make it.
            if let Err(error) = tauri::async_runtime::block_on(tables.stamp_schema()) {
                crate::log!(
                    log::Level::Warn,
                    "boot",
                    "could not record the schema fingerprint: {error}"
                );
            }

            // Deep profiling is read straight from the row. It used to be
            // rewritten to false here whenever inspection was off, which threw
            // away a preference the owner had set rather than merely leaving it
            // inert, and did it at boot where nothing could report it.
            let persisted_settings = tables
                .kv_get(settings::KEY)
                .and_then(|raw| serde_json::from_str::<GlobalSettings>(&raw).ok());
            let configured_proxy = persisted_settings
                .as_ref()
                .map(|settings| settings.agent_proxy_binary.clone())
                .filter(|path| !path.is_empty())
                .map(PathBuf::from);
            #[cfg(feature = "blitz-runtime")]
            let blitz_control_enabled = cli_blitz_control_enabled
                || persisted_settings
                    .as_ref()
                    .is_some_and(|settings| settings.blitz_control_enabled);
            #[cfg(feature = "blitz-runtime")]
            let blitz_deep_profiling_enabled = cli_blitz_deep_profiling_enabled
                || persisted_settings
                    .as_ref()
                    .is_some_and(|settings| settings.blitz_deep_profiling_enabled);
            #[cfg(feature = "blitz-runtime")]
            tauri_runtime_blitz::apply_runtime_debug_options(
                tauri_runtime_blitz::RuntimeDebugOptions {
                    inspection_and_agent_control: blitz_control_enabled,
                    deep_intrusive_profiling: blitz_deep_profiling_enabled,
                },
            )
            .map_err(|error| format!("could not apply local Blitz debugging: {error}"))?;
            let proxy = Arc::new(agent_proxy::AgencyProxy::new(&config_dir, configured_proxy));
            // A checkpoint backed by a still-live proxy run remains a live
            // draft. Only orphaned checkpoints become `interrupted` rows.
            let live_proxy_runs = tauri::async_runtime::block_on(proxy.list_runs())
                .unwrap_or_default()
                .into_iter()
                .map(|run| run.run_id.0)
                .collect();
            tauri::async_runtime::block_on(projects::recover_partial_replies_excluding(
                &tables,
                &live_proxy_runs,
            ));
            let restart_resume = take_restart_resume(&config_dir);
            app.manage(AppState {
                tables: Arc::new(tables),
                proxy,
                running: Arc::default(),
                io: Arc::default(),
                approvals: Arc::default(),
                active: Arc::default(),
                startup_visibility: projects::StartupVisibility::default(),
                limits: Arc::default(),
                receipts: Arc::default(),
                settings_write: tokio::sync::Mutex::new(()),
                chat_imports: tokio::sync::Mutex::new(()),
                pending_restore: tokio::sync::Mutex::new(None),
                pr_refreshes: Arc::default(),
                exit_drain_started: std::sync::atomic::AtomicBool::new(false),
                exit_drain_succeeded: std::sync::atomic::AtomicBool::new(false),
                persistence_failure: Arc::new(std::sync::RwLock::new(None)),
                agent_restart_scheduled: std::sync::atomic::AtomicBool::new(false),
                config_dir,
                data_dir,
                location,
                _store_lock: store_lock,
            });

            #[cfg(feature = "blitz-runtime")]
            {
                let relaunch_handle = app.handle().clone();
                tauri_runtime_blitz::set_agent_control_handler(move |request| match request {
                    tauri_runtime_blitz::control_protocol::AgentControlRequest::Relaunch => {
                        let handle = relaunch_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = handle.state::<AppState>();
                            if let Err(error) = restart_after_drain(&handle, &state).await {
                                crate::log!(
                                    log::Level::Error,
                                    "boot",
                                    "control-requested relaunch failed before Angel handoff: {error}"
                                );
                            }
                        });
                        tauri_runtime_blitz::control_protocol::DebugResponse::Ack
                    }
                    _ => tauri_runtime_blitz::control_protocol::DebugResponse::Error(
                        tauri_runtime_blitz::control_protocol::DebugError {
                            code: "unsupportedEmbedderAction".into(),
                            message: "AgencyZero delegates only relaunch to its restart Angel"
                                .into(),
                        },
                    ),
                });
            }

            // WorkTable persistence is asynchronous. A worker panic once left
            // the UI accepting writes for twenty minutes and surfaced only
            // when Quit tried to drain the dead table. Keep one event-driven
            // watcher across every table and raise the failure in the window
            // as soon as WorkTable marks a worker terminal.
            let persistence_handle = app.handle().clone();
            let persistence_state = persistence_handle.state::<AppState>();
            let persistence_tables = persistence_state.tables.clone();
            let persistence_failure = persistence_state.persistence_failure.clone();
            tauri::async_runtime::spawn(async move {
                let message = persistence_tables.wait_for_persistence_failure().await;
                crate::log!(log::Level::Error, "persistence", "{message}");
                if let Ok(mut failure) = persistence_failure.write() {
                    *failure = Some(message.clone());
                }
                let _ = persistence_handle.emit(
                    "persistence:failed",
                    serde_json::json!({ "message": message }),
                );
            });

            if let Some(marker) = restart_resume {
                let resume_handle = app.handle().clone();
                tauri::async_runtime::spawn(resume_after_restart(resume_handle, marker));
            }

            /*
             * The cafe standard, ported: SIGTERM, SIGINT and SIGHUP route
             * into the same graceful exit the Quit menu takes, so `kill`,
             * a Ctrl+C on a dev run, or a script recycling the app all
             * drain the tables instead of dying with CDC ops in flight.
             * Persistence here is best-effort by design — the accepted
             * loss window is the instant between in-memory and on-disk —
             * and honoring that design means every exit anyone can catch
             * must drain. Only SIGKILL and a crash remain uncatchable,
             * and the boot snapshot carries those.
             */
            let signal_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::signal::unix::{SignalKind, signal};
                let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
                    signal(SignalKind::terminate()),
                    signal(SignalKind::interrupt()),
                    signal(SignalKind::hangup()),
                ) else {
                    crate::log!(
                        log::Level::Warn,
                        "boot",
                        "could not install signal handlers; kill/Ctrl+C will not drain the store"
                    );
                    return;
                };
                let which = tokio::select! {
                    _ = term.recv() => "SIGTERM",
                    _ = int.recv() => "SIGINT",
                    _ = hup.recv() => "SIGHUP",
                };
                crate::log!(
                    log::Level::Info,
                    "boot",
                    "{which} received; draining the tables and exiting"
                );
                if let Some(state) = signal_handle.try_state::<AppState>()
                    && let Err(error) = state.drain_tables_once().await
                {
                    crate::log!(
                        log::Level::Error,
                        "boot",
                        "{which} drain reported a persistence failure: {error}"
                    );
                }
                signal_handle.exit(0);
            });

            /*
             * Shown here, not by the config, because everything above it can
             * take a while.
             *
             * A store carried forward across a schema change is copied and
             * rewritten table by table, and the window is created before this
             * hook runs. Left visible it sits there empty and unresponsive for
             * the whole migration, which is indistinguishable from a hang and
             * invites the one action that would corrupt the store: force-quit
             * partway through.
             *
             * `visible: false` in `tauri.conf.json` is the other half. If the
             * window fails to show for any reason the app is running with no
             * way to reach it, so that is logged loudly rather than ignored.
             */
            if let Some(window) = app.get_webview_window("main") {
                /*
                 * `show()` returning `Ok` means the request was dispatched, not
                 * that the window came up: the call can succeed while the
                 * window stays hidden, and the app then runs headless with a
                 * fully built UI behind an invisible window. That is
                 * indistinguishable from a blank screen and reports no error,
                 * so ask the window what it actually is and retry rather than
                 * trusting the return value.
                 */
                let mut shown = false;
                for attempt in 1..=SHOW_ATTEMPTS {
                    if let Err(error) = window.show() {
                        crate::log!(
                            log::Level::Error,
                            "boot",
                            "the main window could not be shown (attempt {attempt}): {error}"
                        );
                    }
                    match window.is_visible() {
                        Ok(true) => {
                            shown = true;
                            break;
                        }
                        Ok(false) => {
                            crate::log!(
                                log::Level::Warn,
                                "boot",
                                "the main window is still hidden after show() (attempt {attempt})"
                            );
                        }
                        Err(error) => {
                            crate::log!(
                                log::Level::Warn,
                                "boot",
                                "the main window visibility could not be read (attempt {attempt}): {error}"
                            );
                        }
                    }
                    // No wait after the last look: there is nothing left to
                    // retry, and boot should not pay for a delay it cannot use.
                    if attempt < SHOW_ATTEMPTS {
                        std::thread::sleep(SHOW_RETRY_DELAY);
                    }
                }
                if !shown {
                    crate::log!(
                        log::Level::Error,
                        "boot",
                        "the main window is not visible after {SHOW_ATTEMPTS} attempts; the app \
                         is running with no way to reach it"
                    );
                }
            } else {
                crate::log!(
                    log::Level::Error,
                    "boot",
                    "no window labelled `main` to show after setup"
                );
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let topic = match event.id().as_ref() {
                NEW_PROJECT | NEW_PROJECT_TYPING => "menu:new-project",
                SETTINGS => "menu:settings",
                CLOSE_TAB => "menu:close-tab",
                NEXT_TAB => "menu:next-tab",
                PREV_TAB => "menu:prev-tab",
                // Quit asks rather than exits. The webview owns the confirmation
                // because it is the side that knows what is still running.
                QUIT => "menu:quit",
                QUIT_ALL => "menu:quit-all",
                RESTART => "menu:restart",
                _ => return,
            };
            let _ = app.emit(topic, ());
        })
        // `build` then `run`, rather than `run` alone: the exit hook is only
        // reachable on the built app. WorkTable is sensitive to a half-written
        // page, so the tables are drained explicitly instead of being left to
        // process teardown.
        .build(tauri::generate_context!())
        .expect("failed to build AgencyZero GUI");

    // The runtime exists after `build`, while Tauri's setup callback does not
    // execute until `run`. Start the explicit CLI rescue path in that gap so
    // ps-qa gets a discovery descriptor even if native app activation stalls.
    #[cfg(feature = "blitz-runtime")]
    if cli_blitz_control_enabled || cli_blitz_deep_profiling_enabled {
        tauri_runtime_blitz::apply_runtime_debug_options(
            tauri_runtime_blitz::RuntimeDebugOptions {
                inspection_and_agent_control: cli_blitz_control_enabled,
                deep_intrusive_profiling: cli_blitz_deep_profiling_enabled,
            },
        )
        .expect("could not apply CLI Blitz debugging");
    }

    app.run(|app, event| {
        // Ordinary GUI close, restart, update, and Unix signals drain
        // asynchronously before reaching this callback. Keep a fallback
        // for an exit path that bypasses all of them, but `Tables` bounds
        // its concurrent per-table drains and names any table that fails.
        if matches!(event, tauri::RunEvent::Exit)
            && let Some(state) = app.try_state::<AppState>()
            && let Err(error) = tauri::async_runtime::block_on(state.drain_tables_once())
        {
            crate::log!(
                log::Level::Error,
                "boot",
                "the fallback exit drain failed: {error}"
            );
        }
    });
}
