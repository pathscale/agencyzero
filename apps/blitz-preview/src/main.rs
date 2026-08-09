use blitz_dom::{Document, DocumentConfig};
use blitz_script::{DefaultScriptFetcher, FetchError, ScriptDocument, ScriptFetcher};
#[cfg(not(test))]
use blitz_traits::shell::{ColorScheme, Viewport};
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

#[cfg(not(test))]
struct CapturedScriptFetcher {
    url: String,
    javascript: String,
}

#[cfg(not(test))]
impl ScriptFetcher for CapturedScriptFetcher {
    fn fetch(&self, url: &Url) -> Result<String, FetchError> {
        if url.as_str() == self.url {
            Ok(self.javascript.clone())
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

#[cfg(not(test))]
fn create_dist_document(dist: &std::path::Path, url: &str) -> Result<ScriptDocument, String> {
    fn asset_url<'a>(html: &'a str, attribute: &str) -> Result<&'a str, String> {
        let marker = format!("{attribute}=\"");
        let start = html
            .find(&marker)
            .map(|index| index + marker.len())
            .ok_or_else(|| format!("index.html has no {attribute} asset"))?;
        let end = html[start..]
            .find('"')
            .map(|index| start + index)
            .ok_or_else(|| format!("index.html has an unterminated {attribute} asset"))?;
        Ok(&html[start..end])
    }

    fn read_brotli_asset(dist: &std::path::Path, url: &str, label: &str) -> Result<String, String> {
        let relative = url.split('?').next().unwrap_or(url).trim_start_matches('/');
        let path = dist.join(relative);
        let compressed = fs::read(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        decompress_utf8(&compressed, label)
    }

    trace(&format!("external dist loading: {}", dist.display()));
    let index_path = dist.join("index.html");
    let index = fs::read_to_string(&index_path)
        .map_err(|error| format!("could not read {}: {error}", index_path.display()))?;
    let javascript_url = asset_url(&index, "src")?;
    let stylesheet_url = asset_url(&index, "href")?;
    let css = read_brotli_asset(dist, stylesheet_url, "external CSS")?;
    let javascript = read_brotli_asset(dist, javascript_url, "external JavaScript")?;
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{css}</style></head><body><div id=\"root\"></div><script src=\"{javascript_url}\"></script></body></html>"
    );
    let base_url = Url::parse(url).map_err(|error| format!("invalid capture URL: {error}"))?;
    let script_url = base_url
        .join(javascript_url)
        .map_err(|error| format!("invalid JavaScript asset URL: {error}"))?
        .to_string();
    let config = DocumentConfig {
        base_url: Some(url.into()),
        ..DocumentConfig::default()
    };
    Ok(
        ScriptDocument::from_html(&html, config).with_fetcher(CapturedScriptFetcher {
            url: script_url,
            javascript,
        }),
    )
}

#[cfg(not(test))]
fn capture_preview(output: &std::path::Path) -> Result<(), String> {
    use anyrender::render_to_buffer;
    use anyrender_vello_cpu::VelloCpuImageRenderer;
    use blitz_paint::paint_scene;

    fn dimension(variable: &str, default: u32) -> Result<u32, String> {
        let Ok(value) = std::env::var(variable) else {
            return Ok(default);
        };
        value
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| format!("{variable} must be a positive integer, got {value:?}"))
    }

    let width = dimension("AGENCYZERO_BLITZ_CAPTURE_WIDTH", 1344)?;
    let height = dimension("AGENCYZERO_BLITZ_CAPTURE_HEIGHT", 900)?;

    trace("headless capture started");
    let mut document = match std::env::var_os("BLITZ_CAPTURE_DIST") {
        Some(dist) => create_dist_document(std::path::Path::new(&dist), "tauri://localhost/")?,
        None => create_document("tauri://localhost/")?,
    };
    document
        .inner_mut()
        .set_viewport(Viewport::new(width, height, 1.0, ColorScheme::Dark));
    document.execute_scripts();

    // The fixture backend deliberately resolves commands after 90 ms. Drive
    // those same timers until the production workspace reaches its ready DOM.
    for _ in 0..8 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        document.eval("void 0");
        document.poll(None);
    }

    if let Ok(script) = std::env::var("BLITZ_CAPTURE_EVAL") {
        for (index, step) in script.split("/* BLITZ_STEP */").enumerate() {
            document.inner_mut().resolve(0.0);
            trace(&format!("headless capture script step {index} started"));
            match document.eval_json(step) {
                Ok(result) => trace(&format!(
                    "headless capture script step {index} result: {result}"
                )),
                Err(error) => trace(&format!(
                    "headless capture script step {index} failed: {error}"
                )),
            }
            for _ in 0..3 {
                std::thread::sleep(std::time::Duration::from_millis(20));
                document.eval("void 0");
                document.poll(None);
            }
            trace(&format!("headless capture script step {index} completed"));
        }
    }
    document.eval(
        "const status = document.getElementById('native-ipc-status'); if (status && status.parentNode) status.parentNode.removeChild(status);",
    );

    let mut doc = document.inner_mut();
    doc.resolve(0.0);
    let buffer = render_to_buffer::<VelloCpuImageRenderer, _>(
        |scene| paint_scene(scene, &mut doc, 1.0, width, height, 0, 0),
        width,
        height,
    );
    drop(doc);

    let file = std::fs::File::create(output)
        .map_err(|error| format!("could not create {}: {error}", output.display()))?;
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| format!("could not start PNG capture: {error}"))?;
    writer
        .write_image_data(&buffer)
        .map_err(|error| format!("could not write PNG capture: {error}"))?;
    writer
        .finish()
        .map_err(|error| format!("could not finish PNG capture: {error}"))?;
    trace(&format!("headless capture completed: {}", output.display()));
    Ok(())
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
    #[cfg(not(test))]
    {
        if let Some(output) = std::env::var_os("AGENCYZERO_BLITZ_CAPTURE") {
            let output = std::path::PathBuf::from(output);
            if let Err(error) = capture_preview(&output) {
                trace(&format!("headless capture failed: {error}"));
                std::process::exit(1);
            }
            return;
        }
    }
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
        fn count_painted_paths(group: &usvg::Group) -> usize {
            group
                .children()
                .iter()
                .map(|node| match node {
                    usvg::Node::Group(group) => count_painted_paths(group),
                    usvg::Node::Path(path)
                        if path.is_visible()
                            && (path.fill().is_some() || path.stroke().is_some()) =>
                    {
                        1
                    }
                    usvg::Node::Path(_) => 0,
                    usvg::Node::Image(_) | usvg::Node::Text(_) => 0,
                })
                .sum()
        }

        let mut document = create_document("tauri://localhost/").unwrap();
        document.execute_scripts();
        for _ in 0..8 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            document.eval("void 0");
            document.poll(None);
        }
        document.inner_mut().resolve(0.0);

        let doc = document.inner();
        let use_ids = doc.query_selector_all("svg use").unwrap();
        assert!(
            use_ids.len() > 20,
            "production workspace did not finish rendering"
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
            let node = doc.get_node(svg_id).unwrap();
            let tree = node
                .element_data()
                .and_then(|element| element.svg_data())
                .expect("visible SVG use was not parsed as an image");
            assert!(
                count_painted_paths(tree.root()) > 0,
                "visible SVG use parsed without any paintable paths"
            );
        }
    }
}
