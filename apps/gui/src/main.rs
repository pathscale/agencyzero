#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

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
        .invoke_handler(tauri::generate_handler![greet])
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
