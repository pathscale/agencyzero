use blitz_dom::DocumentConfig;
use blitz_script::ScriptDocument;
use tauri_runtime_blitz::{builder, set_document_factory};

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

#[tauri::command]
fn greet(name: String) -> String {
    format!("Hello, {name}!")
}

#[tauri::command]
fn list_capabilities() -> Vec<String> {
    Vec::new()
}

fn main() {
    set_document_factory(|url| {
        let config = DocumentConfig {
            base_url: Some(url.into()),
            ..DocumentConfig::default()
        };
        Ok(ScriptDocument::from_html(EMBEDDED_HTML, config))
    });

    builder()
        .invoke_handler(tauri::generate_handler![greet, list_capabilities])
        .run(tauri::generate_context!("tauri.conf.json"))
        .expect("AgencyZero Tauri Blitz preview failed");
}
