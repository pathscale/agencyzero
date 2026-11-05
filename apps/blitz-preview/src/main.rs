// `Document` provides `inner_mut` and `poll`, which both the capture path
// and the inspection host call. Unconditional: it is used in every
// configuration now.
use blitz_dom::Document;
use blitz_dom::DocumentConfig;
use blitz_script::{DefaultScriptFetcher, FetchError, ScriptFetcher};
use blitz_script_ekojit::{EkojitDocument, NativePageDefect, PageSource, TypedNativeGuest};
#[cfg(all(not(test), feature = "capture"))]
use blitz_traits::shell::{ColorScheme, Viewport};
use brotli::Decompressor;
use izumo::{builder, set_document_factory, set_runtime_trace};
#[cfg(not(test))]
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::sync::Arc;
#[cfg(not(test))]
use std::io::Write;
#[cfg(not(test))]
use std::time::{SystemTime, UNIX_EPOCH};
// `Manager` brings `get_webview_window`, for the offscreen move below.
use tauri::Manager;
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

// Not `capture`-gated: the windowed path loads a dist too, through
// `BLITZ_PREVIEW_DIST`, so this serves both.
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

struct PreviewBlitzDocument {
    document: EkojitDocument,
    poll_hooks: Vec<izumo::DocumentPollHook>,
}

impl PreviewBlitzDocument {
    fn execute_scripts(&mut self) {
        let _ = TypedNativeGuest::execute_scripts(&mut self.document);
    }

    fn eval(&mut self, source: &str) {
        let _ = self.document.eval_source(Arc::new(PageSource {
            text: Arc::from(source),
            url: Arc::from("preview:eval"),
        }));
    }

    fn eval_json(&mut self, source: &str) -> Result<serde_json::Value, String> {
        self.document.with_embedder_host(|host| host.eval_json(source))
    }

    fn external_script_urls(&self) -> Vec<Url> {
        let inner = self.document.inner();
        inner.query_selector_all("script[src]").unwrap_or_default().into_iter()
            .filter_map(|id| inner.get_node(id))
            .filter_map(|node| node.element_data())
            .filter_map(|element| element.attr(blitz_dom::LocalName::from("src")))
            .filter_map(|src| inner.url().join(src).ok())
            .collect()
    }

    fn run_poll_hooks(&mut self, context: Option<&std::task::Context<'_>>) -> bool {
        let mut hooks = std::mem::take(&mut self.poll_hooks);
        let mut work = false;
        for hook in &mut hooks { work |= hook(self, context); }
        hooks.append(&mut self.poll_hooks);
        self.poll_hooks = hooks;
        work
    }
}

impl Document for PreviewBlitzDocument {
    fn inner(&self) -> blitz_dom::DocGuard<'_> { Document::inner(&self.document) }
    fn inner_mut(&mut self) -> blitz_dom::DocGuardMut<'_> { Document::inner_mut(&mut self.document) }
    fn handle_ui_event(&mut self, event: blitz_traits::events::UiEvent) {
        Document::handle_ui_event(&mut self.document, event)
    }
    fn poll(&mut self, context: Option<std::task::Context<'_>>) -> bool {
        let mut work = Document::poll(&mut self.document, context.as_ref().map(|cx| std::task::Context::from_waker(cx.waker())));
        work |= self.run_poll_hooks(context.as_ref()); work
    }
    fn poll_for_settle(&mut self, context: Option<std::task::Context<'_>>, run_timers: bool) -> bool {
        let mut work = Document::poll_for_settle(&mut self.document, context.as_ref().map(|cx| std::task::Context::from_waker(cx.waker())), run_timers);
        work |= self.run_poll_hooks(context.as_ref()); work
    }
    fn prepare_teardown(&mut self) { Document::prepare_teardown(&mut self.document) }
    fn dispose(self: Box<Self>) -> Arc<blitz_dom::release::Teardown> {
        let Self { document, .. } = *self; Box::new(document).dispose()
    }
    fn set_page_visible(&mut self, visible: bool) { Document::set_page_visible(&mut self.document, visible) }
    fn freeze(&mut self) { Document::freeze(&mut self.document) }
    fn finish_restore(&mut self) { Document::finish_restore(&mut self.document) }
    fn resume(&mut self) { Document::resume(&mut self.document) }
}

impl blitz_control_protocol::ControlScriptBackend for PreviewBlitzDocument {
    fn dispatch_dom_event(&mut self, event: blitz_traits::events::DomEvent) { self.document.handle_dom_event(event); }
    fn handle_pointer_move_to_node(&mut self, event: blitz_traits::events::BlitzPointerEvent, node: blitz_dom::NodeId) {
        self.document.handle_pointer_move_to_node(event, node);
    }
    fn handle_ui_event_to_node(&mut self, event: blitz_traits::events::UiEvent, node: blitz_dom::NodeId) {
        self.document.handle_ui_event_to_node(event, node);
    }
}

struct PreviewDocumentHost;

fn preview_document(document: &dyn Document) -> Option<&PreviewBlitzDocument> {
    (document as &dyn std::any::Any).downcast_ref()
}
fn preview_document_mut(document: &mut dyn Document) -> Option<&mut PreviewBlitzDocument> {
    (document as &mut dyn std::any::Any).downcast_mut()
}

impl izumo::DocumentHost for PreviewDocumentHost {
    fn current_url(&self, document: &dyn Document) -> Option<Url> { Some(preview_document(document)?.inner().url().clone()) }
    fn eval(&self, document: &mut dyn Document, source: &str) {
        if let Some(doc) = preview_document_mut(document) { doc.eval(source); }
    }
    fn eval_json(&self, document: &mut dyn Document, source: &str) -> Result<serde_json::Value, String> {
        preview_document_mut(document).ok_or_else(|| String::from("unsupported preview document"))?.eval_json(source)
    }
    fn set_ipc_handler(&self, document: &mut dyn Document, handler: Box<dyn Fn(String)>) {
        struct IpcHandler(Box<dyn Fn(String)>);
        fn ipc_post_message(
            realm: &mut blitz_script_ekojit::embedder::RealmHost<'_>,
            args: &[blitz_script_ekojit::embedder::HostValue],
        ) -> Result<
            blitz_script_ekojit::embedder::HostValue,
            blitz_script_ekojit::embedder::NativeFailure,
        > {
            if let Some(handler) = realm.state::<IpcHandler>("preview.ipc")
                && let Some(blitz_script_ekojit::embedder::HostValue::Utf16(units)) = args.first()
            {
                (handler.0)(String::from_utf16_lossy(units));
            }
            Ok(blitz_script_ekojit::embedder::HostValue::Undefined)
        }
        if let Some(doc) = preview_document_mut(document) {
            let _ = doc.document.with_realm_host(|realm| {
                realm.set_state("preview.ipc", std::rc::Rc::new(IpcHandler(handler)))?;
                realm.register_intrinsic("__previewIpcPostMessage", 1, ipc_post_message)
            });
            doc.eval("globalThis.ipc = { postMessage: function(msg) { __previewIpcPostMessage(String(msg)); } };");
        }
    }
    fn add_poll_hook(&self, document: &mut dyn Document, hook: izumo::DocumentPollHook) {
        if let Some(doc) = preview_document_mut(document) { doc.poll_hooks.push(hook); }
    }
    fn service_debug_controller(&self, _document: &mut dyn Document, _controller: &mut blitz_script::DebugController, _animation_time: f64) -> bool { false }
    fn agent(&self, document: &mut dyn Document, control: &mut blitz_control_protocol::in_process::DocumentControl, request: blitz_control_protocol::AgentControlRequest) -> blitz_control_protocol::DebugResponse {
        match preview_document_mut(document) {
            Some(doc) => control.agent(doc, request),
            None => blitz_control_protocol::DebugResponse::Error(blitz_control_protocol::DebugError { code: "unsupportedDocument".into(), message: "document is not owned by the preview".into() }),
        }
    }
    fn diagnostics(&self, _document: &mut dyn Document, _control: &mut blitz_control_protocol::in_process::DocumentControl, _request: blitz_control_protocol::DiagnosticsRequest) -> blitz_control_protocol::DebugResponse {
        blitz_control_protocol::DebugResponse::Error(blitz_control_protocol::DebugError { code: "unsupportedRequest".into(), message: "preview diagnostics requests are unsupported".into() })
    }
    fn diagnostic_batch(&self, document: &dyn Document, console_after: u64, errors_after: u64, limit: usize) -> blitz_script::DiagnosticBatch {
        let empty = |next_sequence| blitz_script::DiagnosticStreamBatch { entries: Vec::new(), lost: 0, next_sequence };
        let Some(doc) = preview_document(document) else { return blitz_script::DiagnosticBatch { console: empty(console_after), errors: empty(errors_after) }; };
        let stream = |entries: Vec<blitz_script::DiagnosticEntry>, after| {
            let entries = entries.into_iter().filter(|entry| entry.sequence > after).take(limit.clamp(1, 1000)).collect::<Vec<_>>();
            let next_sequence = entries.last().map_or(after, |entry| entry.sequence);
            blitz_script::DiagnosticStreamBatch { entries, lost: 0, next_sequence }
        };
        blitz_script::DiagnosticBatch { console: stream(doc.document.console_entries(), console_after), errors: stream(doc.document.runtime_errors(), errors_after) }
    }
}

fn create_document(url: &str) -> Result<PreviewBlitzDocument, String> {
    trace("document factory entered");
    let css = decompress_utf8(EMBEDDED_CSS_BROTLI, "CSS")?;
    trace("CSS Brotli decompression completed");
    let html = EMBEDDED_SHELL_HTML.replacen(EMBEDDED_CSS_MARKER, &css, 1);
    let config = DocumentConfig { base_url: Some(url.into()), ..DocumentConfig::default() };
    let mut document = EkojitDocument::from_html(Arc::from(html), config, NativePageDefect::None).map_err(|error| error.to_string())?;
    let _ = document.set_initial_script_budget(std::time::Duration::from_secs(60));
    let prelude = r#"
        globalThis.setInterval = globalThis.setInterval || ((callback, delay, ...args) => {
          const run = () => { callback(...args); timer = setTimeout(run, delay); };
          let timer = setTimeout(run, delay); return timer;
        });
        globalThis.clearInterval = globalThis.clearInterval || globalThis.clearTimeout;
        globalThis.requestIdleCallback = globalThis.requestIdleCallback || (callback => setTimeout(() => callback({didTimeout:false,timeRemaining:()=>0}), 1));
        globalThis.cancelIdleCallback = globalThis.cancelIdleCallback || globalThis.clearTimeout;
        globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
        globalThis.IntersectionObserver = globalThis.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
        globalThis.PerformanceObserver = globalThis.PerformanceObserver || class { observe() {} disconnect() {} takeRecords() { return []; } };
        globalThis.performance = globalThis.performance || (() => { const t0 = Date.now(); return { timeOrigin: t0, now: () => Date.now() - t0, mark: () => {}, measure: () => {}, getEntries: () => [], getEntriesByType: () => [], getEntriesByName: () => [], clearMarks: () => {}, clearMeasures: () => {} }; })();
        globalThis.CSS = globalThis.CSS || {}; globalThis.CSS.supports = globalThis.CSS.supports || (() => false);
        globalThis.btoa = globalThis.btoa || (value => globalThis.Buffer ? Buffer.from(value, 'binary').toString('base64') : '');
        globalThis.atob = globalThis.atob || (value => globalThis.Buffer ? Buffer.from(value, 'base64').toString('binary') : '');
        globalThis.encodeURIComponent = globalThis.encodeURIComponent || encodeURI;
        globalThis.decodeURIComponent = globalThis.decodeURIComponent || decodeURI;
        globalThis.encodeURI = globalThis.encodeURI || (value => String(value));
        globalThis.decodeURI = globalThis.decodeURI || (value => String(value));
    "#;
    let _ = document.eval_source(Arc::new(PageSource {
        text: Arc::from(prelude),
        url: Arc::from("preview:compatibility"),
    }));
    document.set_script_fetcher(EmbeddedScriptFetcher);
    trace("document parsing completed");
    Ok(PreviewBlitzDocument { document, poll_hooks: Vec::new() })
}

#[cfg(not(test))]
fn create_dist_document(dist: &std::path::Path, url: &str) -> Result<PreviewBlitzDocument, String> {
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

    /*
     * Brotli or plain, decided by the bytes rather than by configuration.
     *
     * The capture path is fed a Brotli dist, and AgencyZero's own `dist` is
     * plain text; a harness dist is whatever its bundler emitted. Requiring one
     * of the two produced `could not decompress embedded external CSS: Invalid
     * Data` on a perfectly good stylesheet, and the page then rendered with no
     * styles at all, which reads as broken components rather than a rejected
     * asset.
     */
    fn read_brotli_asset(dist: &std::path::Path, url: &str, label: &str) -> Result<String, String> {
        let relative = url.split('?').next().unwrap_or(url).trim_start_matches('/');
        let path = dist.join(relative);
        let bytes = fs::read(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        match decompress_utf8(&bytes, label) {
            Ok(text) => Ok(text),
            Err(compressed_error) => String::from_utf8(bytes).map_err(|_| compressed_error),
        }
    }

    trace(&format!("external dist loading: {}", dist.display()));
    let index_path = dist.join("index.html");
    let index = fs::read_to_string(&index_path)
        .map_err(|error| format!("could not read {}: {error}", index_path.display()))?;
    let javascript_url = asset_url(&index, "src")?;
    let stylesheet_url = asset_url(&index, "href")?;
    let css = read_brotli_asset(dist, stylesheet_url, "external CSS")?;
    let javascript = read_brotli_asset(dist, javascript_url, "external JavaScript")?;
    /*
     * `data-theme` rides along from the source document. Every design token in
     * `@pathscale/ui` is defined under a `[data-theme=...]` selector, so a body
     * without one leaves `var(--color-base-100)` and friends unresolved: the
     * page renders, and every component in it is transparent and unconstrained.
     * That reads as broken components rather than a dropped attribute.
     */
    let theme = index
        .find("data-theme=\"")
        .map(|start| start + "data-theme=\"".len())
        .and_then(|start| {
            index[start..]
                .find('"')
                .map(|end| &index[start..start + end])
        })
        .unwrap_or("dark");
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{css}</style></head><body data-theme=\"{theme}\"><div id=\"root\"></div><script src=\"{javascript_url}\"></script></body></html>"
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
    let mut document = EkojitDocument::from_html(Arc::from(html), config, NativePageDefect::None)
        .map_err(|error| error.to_string())?;
    document.set_script_fetcher(CapturedScriptFetcher { url: script_url, javascript });
    Ok(PreviewBlitzDocument { document, poll_hooks: Vec::new() })
}

#[cfg(all(not(test), feature = "capture"))]
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
    if let Ok(scroll_y) = std::env::var("BLITZ_CAPTURE_SCROLL_Y") {
        let scroll_y = scroll_y
            .trim()
            .parse::<f64>()
            .map_err(|error| format!("invalid capture scroll offset: {error}"))?;
        document.inner_mut().resolve(0.0);
        let mut doc = document.inner_mut();
        let selector = std::env::var("BLITZ_CAPTURE_SCROLL_SELECTOR").ok();
        let changed = if let Some(selector) = selector.as_deref() {
            let node_id = doc
                .query_selector(selector)
                .map_err(|error| format!("invalid capture scroll selector: {error:?}"))?
                .ok_or_else(|| format!("capture scroll selector matched no node: {selector}"))?;
            doc.scroll_node_by_has_changed(node_id, 0.0, -scroll_y, |_| {})
        } else {
            doc.scroll_viewport_by_has_changed(0.0, -scroll_y)
        };
        drop(doc);
        trace(&format!(
            "headless capture scrolled to y={scroll_y} with selector={selector:?}; changed={changed}"
        ));
    }
    if let Ok(point) = std::env::var("BLITZ_CAPTURE_HOVER") {
        let (x, y) = point
            .split_once(',')
            .ok_or_else(|| "BLITZ_CAPTURE_HOVER must be formatted as x,y".to_owned())?;
        let x = x
            .trim()
            .parse::<f32>()
            .map_err(|error| format!("invalid hover x coordinate: {error}"))?;
        let y = y
            .trim()
            .parse::<f32>()
            .map_err(|error| format!("invalid hover y coordinate: {error}"))?;
        document.inner_mut().resolve(0.0);
        let changed = document.inner_mut().set_hover_to(x, y);
        trace(&format!(
            "headless capture hover applied at {x},{y}; changed={changed}"
        ));
    }
    document.eval(
        "const status = document.getElementById('native-ipc-status'); if (status && status.parentNode) status.parentNode.removeChild(status);",
    );

    /*
     * `AGENCYZERO_BLITZ_TREE`: write the semantic tree, not a picture.
     *
     * This is what a QA check actually reads. A PNG says a component painted
     * *something*; only the tree says which control a reader can address, what
     * its role is and what its accessible name reads, which is the whole
     * question every check asks.
     *
     * It is the same tree the inspector serves over the control socket
     * (`build_accessibility_tree`), so a headless run and a windowed run answer
     * from one source. The socket used to be `pub(crate)` inside the runtime,
     * which is why this path writes the tree to a file instead of serving it.
     * It is public now, as `blitz-control-protocol`'s `server` module rather
     * than anything in `izumo`, but serving a headless document is
     * `qa-headless-host`'s job, so this path still writes a file.
     */
    if let Some(tree_path) = std::env::var_os("AGENCYZERO_BLITZ_TREE") {
        let update = document.inner().build_accessibility_tree();
        let mut lines = String::new();
        for (id, node) in &update.nodes {
            /*
             * Skip the document's own `<style>` text. It reaches the tree as a
             * `TextRun` carrying the whole stylesheet, which buried the handful
             * of nodes a check actually addresses under 70 kB of Tailwind.
             */
            let name = node.label().or_else(|| node.value()).unwrap_or_default();
            if name.len() > 200 {
                continue;
            }
            lines.push_str(&format!(
                "{}\t{:?}\t{}\n",
                id.0,
                node.role(),
                /*
                 * `label` is only set when a node carries an explicit one, and
                 * almost none do: the first dump had 27 nodes and not a single
                 * name, which is exactly why 30 generated checks could not
                 * address anything. A node's `value` carries its text, which is
                 * what Blitz names a node from and what a check matches on.
                 */
                name,
            ));
        }
        fs::write(std::path::Path::new(&tree_path), lines)
            .map_err(|error| format!("could not write the tree: {error}"))?;
        trace(&format!(
            "headless tree written: {} nodes",
            update.nodes.len()
        ));
    }

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

    /*
     * `--offscreen`: become an accessory process before anything else runs.
     *
     * A QA sweep launches one window per component, and 71 windows appearing
     * over the owner's desktop is not acceptable. Setting the policy later does
     * not work: `App::set_activation_policy` is only reachable once the app is
     * built, and by then macOS has activated the process and taken focus, so
     * the window flashes to the front first. `focus: false` and repositioning
     * are both too late for the same reason.
     *
     * `NSApplicationActivationPolicyAccessory` on the shared application, set
     * here, means the process never activates and never enters the Dock. The
     * renderer still lays out and paints, so every measurement is unchanged.
     */
    #[cfg(target_os = "macos")]
    if std::env::args().any(|argument| argument == "--offscreen") {
        use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
        let mtm = objc2::MainThreadMarker::new().expect("main() runs on the main thread");
        let application = NSApplication::sharedApplication(mtm);
        application.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        /*
         * Also stop the app activating itself when the window is created.
         * `setActivationPolicy` alone is not enough: winit calls
         * `activateIgnoringOtherApps` while creating the window, which pulls a
         * process to the front whatever its policy says. Overriding the
         * activation-policy default here is what makes the accessory policy
         * stick through window creation.
         */
        application.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
        trace("activation policy set to prohibited");
    }
    #[cfg(not(test))]
    {
        /*
         * Headless inspection lives in its own crate, `qa-headless-host`.
         *
         * It was here, because this binary already knew how to build a document
         * from a dist, but nothing in it was specific to AgencyZero and every
         * Blitz project wanting a component sweep needs the same thing. Two
         * copies of "own a document and serve the socket" drift.
         */

        if let Some(output) = std::env::var_os("AGENCYZERO_BLITZ_CAPTURE") {
            #[cfg(feature = "capture")]
            {
                let output = std::path::PathBuf::from(output);
                if let Err(error) = capture_preview(&output) {
                    trace(&format!("headless capture failed: {error}"));
                    std::process::exit(1);
                }
                return;
            }
            #[cfg(not(feature = "capture"))]
            {
                let _ = output;
                trace("headless capture requested, but this build excludes the capture feature");
                std::process::exit(2);
            }
        }
    }
    set_runtime_trace(trace);
    trace("runtime trace configured");

    /*
     * `BLITZ_PREVIEW_DIST` points the window at any built frontend, which is
     * what makes this binary a general harness host rather than a fixture
     * viewer: `@pathscale/ui`'s `qa/` builds a page per component, and pointing
     * this at it is how those components get driven against the real renderer
     * without the consuming application around them.
     *
     * The capture path already reads a dist through `BLITZ_CAPTURE_DIST`. This
     * is the same thing for the windowed path, under its own name so a headless
     * capture and a live window can be aimed at different builds.
     */
    #[cfg(not(test))]
    match std::env::var_os("BLITZ_PREVIEW_DIST") {
        Some(dist) => {
            let dist = std::path::PathBuf::from(dist);
            trace(&format!("preview dist: {}", dist.display()));
            set_document_factory(move |url| create_dist_document(&dist, url).map(|doc| izumo::ApplicationDocument::new(Box::new(doc), Arc::new(PreviewDocumentHost))));
        }
        None => set_document_factory(|url| create_document(url).map(|doc| izumo::ApplicationDocument::new(Box::new(doc), Arc::new(PreviewDocumentHost)))),
    }
    #[cfg(test)]
    set_document_factory(|url| create_document(url).map(|doc| izumo::ApplicationDocument::new(Box::new(doc), Arc::new(PreviewDocumentHost))));
    trace("document factory configured");

    let context = tauri::generate_context!("tauri.conf.json");
    trace("Tauri context generated");
    let app = builder()
        .invoke_handler(tauri::generate_handler![greet, list_capabilities])
        .build(context)
        .expect("AgencyZero Tauri Blitz preview failed to build");

    /*
     * The control socket, on the same `--blitz-control` flag az-gui uses.
     *
     * Applied between `build` and `run` for the reason az-gui's copy documents:
     * the runtime exists after `build`, while Tauri's setup callback does not
     * execute until `run`, so this gap is where ps-qa's discovery descriptor
     * can be published without depending on native app activation.
     */
    if std::env::args().any(|argument| argument == "--blitz-control") {
        izumo::apply_runtime_debug_options(izumo::RuntimeDebugOptions {
            inspection_and_agent_control: true,
            deep_intrusive_profiling: false,
        })
        .expect("could not enable Blitz control for the preview");
        trace("blitz control enabled");
    }

    /*
     * `--offscreen` runs the window as a macOS accessory application.
     *
     * A QA sweep launches one window per component. At 71 components that is 71
     * windows appearing over whatever the owner is doing, and it is not enough
     * to move them: a regular application activates when it launches, so the
     * window flashes and takes focus before any reposition can run. An
     * accessory application never activates and never appears in the Dock.
     *
     * The renderer still lays out and paints exactly as it would on screen, so
     * every measurement a check makes is unchanged. `visible: false` would not
     * do: a hidden window stops painting, and a check would then measure a
     * component that never rendered.
     */
    if std::env::args().any(|argument| argument == "--offscreen") {
        /*
         * No `set_activation_policy` here. It used to set `Accessory`, which
         * silently undid the `Prohibited` set at the top of `main`, and
         * `Accessory` is not enough on its own: winit calls
         * `activateIgnoringOtherApps` during window creation and pulls the
         * process to the front regardless. That one line is why every sweep
         * kept stealing focus after the policy was supposedly fixed.
         */
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_position(tauri::PhysicalPosition::new(-20_000, -20_000));
        }
        trace("running as an accessory application, offscreen");
    }

    app.run(|_app, _event| {});
    trace("Tauri runtime returned");
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn production_icons_resolve_to_nonempty_svg_images() {
        std::thread::Builder::new()
            .name("production-icon-test".to_owned())
            .stack_size(16 * 1024 * 1024)
            .spawn(assert_production_icons_resolve)
            .unwrap()
            .join()
            .unwrap();
    }

    fn assert_production_icons_resolve() {
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
        assert!(
            document.document.runtime_errors().is_empty(),
            "production workspace emitted runtime errors: {:?}",
            document.document.runtime_errors()
        );
        document.inner_mut().resolve(0.0);

        let doc = document.inner();
        let svg_ids = doc.query_selector_all("svg").unwrap();
        assert!(
            !svg_ids.is_empty(),
            "production workspace rendered no SVG icons"
        );
        for svg_id in svg_ids {
            let node = doc.get_node(svg_id).unwrap();
            let tree = node
                .element_data()
                .and_then(|element| element.svg_data())
                .expect("visible SVG was not parsed as an image");
            assert!(
                count_painted_paths(tree.root()) > 0,
                "visible SVG parsed without any paintable paths"
            );
        }
    }
}
