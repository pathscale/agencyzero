#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use agent_abstraction::{Agent, Model, Source};
use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Every agent this build can drive. `Agent` is not iterable, so the list is
/// named once here rather than at each call site.
const AGENTS: [Agent; 3] = [Agent::Claude, Agent::Codex, Agent::Copilot];

/// One model, renamed for the webview.
///
/// The crate serializes `is_default` in snake_case and every type the frontend
/// already has is camelCase, so a DTO does the renaming rather than the
/// TypeScript bending to match one field. `kind` needs no help: its own serde
/// attribute already emits `alias` / `pinned`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDto {
    id: String,
    name: String,
    note: String,
    kind: agent_abstraction::Kind,
    efforts: Vec<String>,
    is_default: bool,
}

impl From<Model> for ModelDto {
    fn from(model: Model) -> Self {
        ModelDto {
            id: model.id.into_owned(),
            name: model.name.into_owned(),
            note: model.note.into_owned(),
            kind: model.kind,
            efforts: model.efforts.into_iter().map(|e| e.into_owned()).collect(),
            is_default: model.is_default,
        }
    }
}

/// One agent's catalogue, flattened so the webview does not have to reach
/// through a nested `verified` object to render a single provenance line.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentModelsDto {
    agent: Agent,
    models: Vec<ModelDto>,
    source: Source,
    checked: String,
    against: String,
    discovered: bool,
}

/// Every agent's model catalogue.
///
/// With `discover`, each CLI is asked to enumerate rather than trusting the
/// crate's compiled list. Only Codex can answer that today; Claude and Copilot
/// return `Error::Unsupported` and fall back here.
///
/// A discovery failure is **not** an error for the whole call. It falls back to
/// the compiled list with `discovered: false`, which is the same thing the two
/// agents that cannot be asked report. That is not a silent downgrade: the
/// frontend renders provenance from these fields, so a failed discovery reads as
/// "from vendor documentation, checked <date>" rather than "asked just now", and
/// the difference is visible in Settings. Failing the whole call instead would
/// leave the picker with nothing over one agent's bad output.
#[tauri::command]
async fn list_models(discover: bool) -> Vec<AgentModelsDto> {
    let mut catalogues = Vec::with_capacity(AGENTS.len());
    for agent in AGENTS {
        let verified = agent.models_verified();
        let discovered = if discover {
            agent.discover_models().await.ok()
        } else {
            None
        };
        let has_discovered = discovered.is_some();
        catalogues.push(AgentModelsDto {
            agent,
            models: discovered
                .unwrap_or_else(|| agent.models())
                .into_iter()
                .map(ModelDto::from)
                .collect(),
            source: verified.source,
            checked: verified.checked.to_string(),
            against: verified.against.to_string(),
            discovered: has_discovered,
        });
    }
    catalogues
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
        .invoke_handler(tauri::generate_handler![greet, list_models])
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The webview's `AgentModels` type is camelCase and the crate's `Model` is
    /// not, so the DTO is the only thing keeping the two in step. A rename that
    /// silently reverted would leave every model reading as not-default.
    #[tokio::test]
    async fn catalogues_serialize_in_the_shape_the_webview_expects() {
        let catalogues = list_models(false).await;
        assert_eq!(catalogues.len(), AGENTS.len());

        let json = serde_json::to_value(&catalogues).expect("should serialize");
        let claude = &json[0];
        assert_eq!(claude["agent"], "claude");
        assert!(
            claude["models"].as_array().is_some_and(|m| !m.is_empty()),
            "an empty catalogue would leave the picker with nothing"
        );
        assert!(
            claude["models"][0].get("isDefault").is_some(),
            "is_default must reach the webview as isDefault: {}",
            claude["models"][0]
        );
        assert!(
            claude["models"][0].get("is_default").is_none(),
            "the snake_case field must not also be emitted"
        );
    }

    /// Without `discover` nothing is spawned, so every entry must say so. The
    /// Settings provenance line reads this to decide between "asked just now"
    /// and naming the weaker evidence behind the compiled list.
    #[tokio::test]
    async fn a_compiled_catalogue_never_claims_to_have_been_discovered() {
        for catalogue in list_models(false).await {
            assert!(
                !catalogue.discovered,
                "{:?} claimed discovery without being asked",
                catalogue.agent
            );
        }
    }

    /// Exactly one preselection per agent, or the picker opens on nothing.
    #[tokio::test]
    async fn every_agent_offers_one_default() {
        for catalogue in list_models(false).await {
            let defaults = catalogue.models.iter().filter(|m| m.is_default).count();
            assert_eq!(defaults, 1, "{:?} should mark one default", catalogue.agent);
        }
    }
}
