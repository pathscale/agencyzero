#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod db;
mod log;
mod models;
mod projects;
mod quota;
mod settings;
mod tasks;

use std::sync::Arc;

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::db::location::{self, DataLocation};
use crate::db::tables::Tables;
use crate::settings::GlobalSettings;

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
    "get_data_location",
    "set_data_location",
    "get_workspace_root",
    "create_workspace_root",
    "list_projects",
    "list_items",
    "list_messages",
    "list_running_tasks",
    "list_task_log",
    "clear_task_log",
    "delete_project",
    "set_project_pinned",
    "rename_project",
    "reset_task_manager",
    "get_task_manager",
    "list_agent_io",
    "get_io_persist",
    "set_io_persist",
    "list_quota",
    "list_rate_limits",
    "create_project",
    "send_message",
    "get_settings",
    "set_settings",
    "list_agent_status",
    "list_models",
    "log_frontend",
    "get_log_path",
];

/// What the GUI carries for the life of the process.
pub(crate) struct AppState {
    tables: Arc<Tables>,
    /// Tool calls in flight, by project. Not persisted, on purpose — see
    /// [`projects::RunningTasks`].
    running: Arc<projects::RunningTasks>,
    /// The raw exchange with the agent, by project. In memory for the life of
    /// the process — see [`projects::AgentIo`].
    io: Arc<projects::AgentIo>,
    /// Kept so `set_data_location` can write the pointer beside the settings.
    config_dir: std::path::PathBuf,
    /// Where the tables were opened from this launch. A change takes effect on
    /// the next one, so this is the answer for the whole session.
    location: DataLocation,
}

/// Which commands Rust answers. See [`IMPLEMENTED`].
#[tauri::command]
fn list_capabilities() -> Vec<String> {
    IMPLEMENTED.iter().map(|name| (*name).to_string()).collect()
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
fn resolve_workspace_root(app: &tauri::AppHandle, state: &AppState) -> WorkspaceRoot {
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
pub(crate) fn workspace_root_path(app: &tauri::AppHandle, state: &AppState) -> String {
    resolve_workspace_root(app, state).path
}

#[tauri::command]
fn get_workspace_root(app: tauri::AppHandle, state: State<'_, AppState>) -> WorkspaceRoot {
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<WorkspaceRoot, String> {
    let resolved = resolve_workspace_root(&app, &state);
    std::fs::create_dir_all(&resolved.path).map_err(|error| error.to_string())?;
    Ok(resolve_workspace_root(&app, &state))
}

/// Where the tables were opened from, and whether that is changeable.
#[tauri::command]
fn get_data_location(state: State<'_, AppState>) -> DataLocation {
    state.location.clone()
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

/// The persisted settings record, or the defaults on a first run.
///
/// A record that fails to parse is replaced by the defaults rather than failing
/// the call: the alternative is a window that will not boot until someone
/// hand-edits a file it never told them the path of. The bad record is left on
/// disk rather than overwritten, so it is still there to look at.
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> GlobalSettings {
    state
        .tables
        .kv_get(settings::KEY)
        .and_then(|raw| match serde_json::from_str(&raw) {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                crate::log!(
                    log::Level::Warn,
                    "settings",
                    "record unreadable, using defaults: {error}"
                );
                None
            }
        })
        .unwrap_or_default()
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
    let current = state
        .tables
        .kv_get(settings::KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::to_value(GlobalSettings::default()).unwrap_or_default());

    let mut merged = current;
    settings::merge(&mut merged, &patch);

    // Parse before writing. A patch that produces something unreadable should
    // fail here rather than land on disk and break the next launch.
    let parsed: GlobalSettings =
        serde_json::from_value(merged.clone()).map_err(|error| error.to_string())?;

    state
        .tables
        .kv_put(settings::KEY, merged.to_string())
        .await
        .map_err(|error| error.to_string())?;
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

    let detected = agents::detect_all().await;
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
const SETTINGS: &str = "settings";
const CLOSE_TAB: &str = "close-tab";
const NEXT_TAB: &str = "next-tab";
const PREV_TAB: &str = "prev-tab";
const QUIT: &str = "quit";

/// The application menu.
///
/// Hand-built rather than `Menu::default`, for one reason: the predefined
/// Close Window item owns Cmd+W, and in a tabbed window Cmd+W has to close the
/// tab. Everything else here is the standard macOS menu — and the Edit submenu
/// is not optional, because without it copy and paste stop working in the
/// composer.
///
/// Tab items and Quit carry ids instead of behaviour: they emit to the webview,
/// which owns the tab strip and the close confirmation. A menu accelerator
/// beats a webview keybinding for these because macOS delivers it whatever has
/// focus, and because it puts the shortcut somewhere discoverable.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let quit = MenuItemBuilder::with_id(QUIT, "Quit AgencyZero")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "AgencyZero")
        .about(Some(AboutMetadata::default()))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // The standard "new" shortcut, and the only one that costs nothing: macOS
    // reserves a Ctrl-letter set for text editing (Ctrl+A E B F P N K T), so
    // any Ctrl accelerator takes one of those away from every text field.
    //
    // Ctrl+T is *also* bound to this, in the webview rather than here — see
    // frontend/src/features/tabs/shortcuts.ts. Leaving it out of the menu is
    // what lets the keydown reach the page, which is the only way it can fire
    // while the composer has focus.
    let new_project = MenuItemBuilder::with_id(NEW_PROJECT, "New Project")
        .accelerator("CmdOrCtrl+N")
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
    let prev_tab = MenuItemBuilder::with_id(PREV_TAB, "Select Previous Tab")
        .accelerator("CmdOrCtrl+1")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id(NEXT_TAB, "Select Next Tab")
        .accelerator("CmdOrCtrl+2")
        .build(app)?;

    let tab_menu = SubmenuBuilder::new(app, "Tabs")
        .item(&new_project)
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            list_capabilities,
            get_data_location,
            set_data_location,
            get_workspace_root,
            create_workspace_root,
            projects::list_projects,
            projects::list_items,
            projects::list_messages,
            projects::list_running_tasks,
            projects::list_task_log,
            projects::list_rate_limits,
            projects::clear_task_log,
            projects::delete_project,
            projects::set_project_pinned,
            projects::rename_project,
            projects::reset_task_manager,
            projects::get_task_manager,
            projects::list_agent_io,
            projects::get_io_persist,
            projects::set_io_persist,
            quota::list_quota,
            projects::create_project,
            projects::send_message,
            get_settings,
            set_settings,
            list_agent_status,
            models::list_models,
            log_frontend,
            get_log_path
        ])
        .setup(|app| {
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

            // Before anything that can fail, so whatever happens next is on the
            // record. Opening the tables is the first thing that can, and it is
            // fatal — a fatal error nobody can read is how this app lost an
            // afternoon.
            log::init(&data_dir.join("logs"));

            // Resolved before anything opens, because the settings record that
            // would otherwise carry it lives in the database being located.
            let location = location::resolve(&config_dir, &data_dir);
            crate::log!(
                log::Level::Info,
                "boot",
                "tables at {:?} (source {})",
                location.path,
                location.source
            );
            let tables = tauri::async_runtime::block_on(Tables::open(&location.path)).map_err(
                |error| {
                    let message =
                        format!("could not open the tables in {:?}: {error}", location.path);
                    crate::log!(log::Level::Error, "boot", "{message}");
                    message
                },
            )?;
            crate::log!(log::Level::Info, "boot", "tables open");

            /*
             * A store written by a build with a different schema is not stale,
             * it is unreadable — rkyv reads the old bytes through the new layout
             * and hands back plausible-looking nonsense. So the old directory is
             * moved aside and this launch starts clean, rather than showing
             * projects whose ids are garbage and whose every command fails.
             *
             * Moved, never deleted: it is the only copy of someone's transcripts
             * and the path is logged so they can be recovered by hand.
             */
            let tables = if let db::tables::SchemaState::Mismatch { found } = tables.schema_state()
            {
                let aside = location.path.with_extension(format!(
                    "superseded-{}",
                    chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
                ));
                crate::log!(
                    log::Level::Warn,
                    "boot",
                    "the store was written by a different schema and cannot be read safely. \
                     Moving it to {aside:?} and starting clean. Found: {found}"
                );
                // Close the handles before moving the directory out from under them.
                drop(tables);
                std::fs::rename(&location.path, &aside).map_err(|error| {
                    format!("could not move the superseded store aside: {error}")
                })?;

                /*
                 * Reopened here, in this launch, rather than reported as a
                 * startup error. Returning `Err` from the setup hook does not
                 * show anyone a message — Tauri turns it into a panic, so the
                 * window never appears and the app dies on the launch that was
                 * supposed to recover. Starting clean is the recovery; the log
                 * and the directory left on disk are the record.
                 */
                tauri::async_runtime::block_on(Tables::open(&location.path)).map_err(|error| {
                    let message = format!("could not open a fresh store: {error}");
                    crate::log!(log::Level::Error, "boot", "{message}");
                    message
                })?
            } else {
                tables
            };

            // Stamped after the check, so the next launch can make it.
            if let Err(error) = tauri::async_runtime::block_on(tables.stamp_schema()) {
                crate::log!(
                    log::Level::Warn,
                    "boot",
                    "could not record the schema fingerprint: {error}"
                );
            }

            app.manage(AppState {
                tables: Arc::new(tables),
                running: Arc::default(),
                io: Arc::default(),
                config_dir,
                location,
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let topic = match event.id().as_ref() {
                NEW_PROJECT => "menu:new-project",
                SETTINGS => "menu:settings",
                CLOSE_TAB => "menu:close-tab",
                NEXT_TAB => "menu:next-tab",
                PREV_TAB => "menu:prev-tab",
                // Quit asks rather than exits. The webview owns the confirmation
                // because it is the side that knows what is still running.
                QUIT => "menu:quit",
                _ => return,
            };
            let _ = app.emit(topic, ());
        })
        // `build` then `run`, rather than `run` alone: the exit hook is only
        // reachable on the built app. WorkTable is sensitive to a half-written
        // page, so the tables are drained explicitly instead of being left to
        // process teardown.
        .build(tauri::generate_context!())
        .expect("failed to build AgencyZero GUI")
        .run(|app, event| {
            // `Exit` fires once, after the last window is gone and before the
            // process ends, which is the only point where nothing else can
            // still be writing.
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(state) = app.try_state::<AppState>()
            {
                tauri::async_runtime::block_on(state.tables.shutdown());
            }
        });
}
