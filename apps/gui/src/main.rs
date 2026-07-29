#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod models;
mod settings;
mod store;

use std::sync::Arc;

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::settings::GlobalSettings;
use crate::store::Store;

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
    "get_settings",
    "set_settings",
    "list_agent_status",
    "list_models",
];

/// What the GUI carries for the life of the process.
struct AppState {
    store: Arc<Store>,
}

/// Which commands Rust answers. See [`IMPLEMENTED`].
#[tauri::command]
fn list_capabilities() -> Vec<String> {
    IMPLEMENTED.iter().map(|name| (*name).to_string()).collect()
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
        .store
        .get(settings::KEY)
        .and_then(|raw| match serde_json::from_str(&raw) {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                eprintln!("[az-gui] settings record unreadable, using defaults: {error}");
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
        .store
        .get(settings::KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::to_value(GlobalSettings::default()).unwrap_or_default());

    let mut merged = current;
    settings::merge(&mut merged, &patch);

    // Parse before writing. A patch that produces something unreadable should
    // fail here rather than land on disk and break the next launch.
    let parsed: GlobalSettings =
        serde_json::from_value(merged.clone()).map_err(|error| error.to_string())?;

    state
        .store
        .put(settings::KEY, merged.to_string())
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
            .store
            .get(agents::KEY)
            .and_then(|raw| serde_json::from_str::<Vec<agents::AgentStatusDto>>(&raw).ok())
    {
        return Ok(cached);
    }

    let detected = agents::detect_all().await;
    // A cache that cannot be written is not worth failing the call over: the
    // answer in hand is still correct, it just will not survive a restart.
    if let Ok(encoded) = serde_json::to_string(&detected)
        && let Err(error) = state.store.put(agents::KEY, encoded).await
    {
        eprintln!("[az-gui] could not cache the agent probe: {error}");
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
            get_settings,
            set_settings,
            list_agent_status,
            models::list_models
        ])
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;

            // The store is opened before the window is usable, and a failure is
            // fatal on purpose. Running with no persistence would let every
            // setting appear to save and then vanish on the next launch, which
            // is a worse failure than refusing to start.
            let dir = app
                .path()
                .app_config_dir()
                .map_err(|error| format!("no config directory: {error}"))?;
            let store = tauri::async_runtime::block_on(Store::open(&dir))
                .map_err(|error| format!("could not open the store in {dir:?}: {error}"))?;
            app.manage(AppState {
                store: Arc::new(store),
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let topic = match event.id().as_ref() {
                NEW_PROJECT => "menu:new-project",
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
        .run(tauri::generate_context!())
        .expect("failed to run AgencyZero GUI");
}
