use blitz_dom::DocumentConfig;
use blitz_script::{DefaultScriptFetcher, FetchError, ScriptDocument, ScriptFetcher};
use brotli::Decompressor;
#[cfg(not(test))]
use std::fs::{self, OpenOptions};
use std::io::Read;
#[cfg(not(test))]
use std::io::Write;
#[cfg(not(test))]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_runtime_blitz::{builder, set_document_factory, set_runtime_trace};
use url::Url;

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

#[cfg(not(test))]
const TRACE_PATH: &str = "/private/tmp/agencyzero-blitz-preview.log";

#[cfg(not(test))]
fn reset_trace() {
    let _ = fs::write(TRACE_PATH, "");
}

#[cfg(test)]
fn reset_trace() {}

#[cfg(not(test))]
fn trace(message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    eprintln!("agencyzero-blitz-preview [{timestamp}] {message}");
    if let Ok(mut output) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(TRACE_PATH)
    {
        let _ = writeln!(output, "[{timestamp}] {message}");
    }
}

#[cfg(test)]
fn trace(_message: &str) {}

struct EmbeddedScriptFetcher;

impl ScriptFetcher for EmbeddedScriptFetcher {
    fn fetch(&self, url: &Url) -> Result<String, FetchError> {
        if url.as_str() == EMBEDDED_JS_URL {
            trace("JavaScript Brotli decompression started");
            let javascript = decompress_utf8(EMBEDDED_JS_BROTLI, "JavaScript")
                .map_err(FetchError::InvalidData)?;
            trace("JavaScript Brotli decompression completed");
            Ok(javascript)
        } else {
            DefaultScriptFetcher.fetch(url)
        }
    }
}

fn decompress_utf8(compressed: &[u8], label: &str) -> Result<String, String> {
    let mut decoder = Decompressor::new(compressed, 4096);
    let mut decoded = String::new();
    decoder
        .read_to_string(&mut decoded)
        .map_err(|error| format!("could not decompress embedded {label}: {error}"))?;
    Ok(decoded)
}

fn create_document(url: &str) -> Result<ScriptDocument, String> {
    trace("document factory entered");
    let css = decompress_utf8(EMBEDDED_CSS_BROTLI, "CSS")?;
    trace("CSS Brotli decompression completed");
    let html = EMBEDDED_SHELL_HTML.replacen(EMBEDDED_CSS_MARKER, &css, 1);
    let config = DocumentConfig {
        base_url: Some(url.into()),
        ..DocumentConfig::default()
    };
    let document = ScriptDocument::from_html(&html, config).with_fetcher(EmbeddedScriptFetcher);
    trace("document parsing completed");
    Ok(document)
}

#[tauri::command]
fn greet(name: String) -> String {
    format!("Hello, {name}!")
}

#[tauri::command]
fn list_capabilities() -> Vec<String> {
    Vec::new()
}

fn main() {
    reset_trace();
    trace("main entered");
    set_runtime_trace(trace);
    trace("runtime trace configured");
    set_document_factory(create_document);
    trace("document factory configured");

    let context = tauri::generate_context!("tauri.conf.json");
    trace("Tauri context generated");
    builder()
        .invoke_handler(tauri::generate_handler![greet, list_capabilities])
        .run(context)
        .expect("AgencyZero Tauri Blitz preview failed");
    trace("Tauri runtime returned");
}

#[cfg(test)]
mod tests {
    use super::*;
    use blitz_dom::Document;
    use std::collections::HashSet;

    #[test]
    fn embedded_assets_are_compressed_and_round_trip() {
        let css = decompress_utf8(EMBEDDED_CSS_BROTLI, "CSS").unwrap();
        let javascript = decompress_utf8(EMBEDDED_JS_BROTLI, "JavaScript").unwrap();

        assert_eq!(css.len(), EMBEDDED_CSS_LEN);
        assert_eq!(javascript.len(), EMBEDDED_JS_LEN);
        assert!(EMBEDDED_CSS_BROTLI.len() < EMBEDDED_CSS_LEN);
        assert!(EMBEDDED_JS_BROTLI.len() < EMBEDDED_JS_LEN);
        assert_eq!(
            EMBEDDED_BROTLI_QUALITY,
            if cfg!(debug_assertions) { 2 } else { 9 }
        );
        assert!(javascript.starts_with("(()=>"));
    }

    #[test]
    fn production_javascript_stays_external_until_first_poll() {
        let document = create_document("tauri://localhost/").unwrap();
        let scripts = document.external_script_urls();

        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].as_str(), EMBEDDED_JS_URL);
    }

    #[test]
    fn production_icon_uses_resolve_to_nonempty_svg_images() {
        std::thread::Builder::new()
            .name("production-icon-test".to_owned())
            .stack_size(16 * 1024 * 1024)
            .spawn(assert_production_icon_uses_resolve)
            .unwrap()
            .join()
            .unwrap();
    }

    fn assert_production_icon_uses_resolve() {
        let mut document = create_document("tauri://localhost/").unwrap();
        document.execute_scripts();
        document.inner_mut().resolve(0.0);

        let doc = document.inner();
        let use_ids = doc.query_selector_all("svg use").unwrap();
        assert!(
            !use_ids.is_empty(),
            "production bundle rendered no SVG uses"
        );

        let mut svg_ids = HashSet::new();
        for use_id in use_ids {
            let mut current = doc.get_node(use_id).and_then(|node| node.parent);
            while let Some(node_id) = current {
                let node = doc.get_node(node_id).unwrap();
                if node
                    .element_data()
                    .is_some_and(|element| element.name.local.as_ref() == "svg")
                {
                    svg_ids.insert(node_id);
                    break;
                }
                current = node.parent;
            }
        }

        assert!(
            !svg_ids.is_empty(),
            "no visible SVG ancestors found for uses"
        );
        for svg_id in svg_ids {
            let tree = doc
                .get_node(svg_id)
                .and_then(|node| node.element_data())
                .and_then(|element| element.svg_data())
                .expect("visible SVG use was not parsed as an image");
            assert!(
                !tree.root().children().is_empty(),
                "visible SVG use parsed to an empty image"
            );
        }
    }
}
