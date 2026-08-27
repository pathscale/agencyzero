#[cfg(any(test, feature = "capture"))]
use blitz_dom::Document;
use blitz_dom::DocumentConfig;
use blitz_script::{DefaultScriptFetcher, FetchError, ScriptDocument, ScriptFetcher};
#[cfg(all(not(test), feature = "capture"))]
use blitz_traits::shell::{ColorScheme, Viewport};
use brotli::Decompressor;
#[cfg(not(test))]
use std::fs::{self, OpenOptions};
use std::io::Read;
#[cfg(not(test))]
use std::io::Write;
#[cfg(not(test))]
use std::time::{SystemTime, UNIX_EPOCH};
// `Manager` brings `get_webview_window`, for the offscreen move below.
use tauri::Manager;
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
    Ok(
        ScriptDocument::from_html(&html, config).with_fetcher(CapturedScriptFetcher {
            url: script_url,
            javascript,
        }),
    )
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
     * from one source. The socket itself is `pub(crate)` in
     * `tauri-runtime-blitz` and so cannot be hosted from here, which is why
     * this path writes the tree to a file instead of serving it.
     */
    if let Some(tree_path) = std::env::var_os("AGENCYZERO_BLITZ_TREE") {
        /*
         * Lay out before reading the tree.
         *
         * The dump carries each node's box now, and a box is only meaningful
         * after `resolve`. This used to run before the `resolve` further down
         * and emitted no geometry, so nothing depended on the ordering; a
         * bounds column read from an unresolved tree would be uniformly zero,
         * which is indistinguishable from a component that painted nothing.
         */
        document.inner_mut().resolve(0.0);
        let update = document.inner().build_accessibility_tree();

        /*
         * Fold each element's text onto the element itself.
         *
         * `build_accessibility_node` in blitz-dom sets a `value` only on text
         * nodes, and links the element to it with `push_labelled_by`. So the
         * tree says role `Button` on one node and the text "Save" on a
         * different one, and a check addressed as `button:Save` matches
         * neither. Measured over 71 components: 159 nodes carried a name and
         * every single one had role `TextRun`, so no `role:name` subject could
         * ever match.
         *
         * `labelled_by` is exactly the edge blitz-dom already recorded for this
         * purpose, so walking it reassembles the pairing the accessibility
         * layer intended rather than guessing at one. Fixing it in blitz-dom
         * proper means naming the element at build time; that is the better
         * home for it and is filed, but it is a published crate and this needs
         * to work now.
         */
        /*
         * Keyed by the raw `u64` rather than `accesskit::NodeId`: accesskit is
         * not a direct dependency here, and adding one to name a key risks
         * resolving a different version of the crate than the one blitz-dom
         * built the tree with. `NodeId` is a newtype over `u64`, so `.0` is the
         * same identity without the dependency.
         */
        let text_of: std::collections::HashMap<u64, String> = update
            .nodes
            .iter()
            .filter_map(|(id, node)| node.value().map(|value| (id.0, value.to_owned())))
            .collect();

        /*
         * Absolute boxes, taken from the layout tree rather than from accesskit.
         *
         * blitz-dom never calls `set_bounds` when it builds an accessibility
         * node, so `node.bounds()` is `None` for every node in the tree and a
         * bounds column sourced from it is uniformly empty. The layout tree has
         * the real geometry, and `final_layout()` is public.
         *
         * `final_layout().location` is relative to the parent, so this walks
         * down accumulating the offset. `visit` is a pre-order traversal, which
         * is what makes a single pass sufficient: a node's parent has always
         * been placed before the node is reached.
         */
        let mut boxes: std::collections::HashMap<u64, (f64, f64, f64, f64)> =
            std::collections::HashMap::new();
        /*
         * `aria-label`, which the accessibility tree drops entirely.
         *
         * `build_accessibility_node` names a node from its text and nothing
         * else, so an element whose only name is an `aria-label` reaches the
         * tree anonymous. The QA harness marks its fixture region with
         * `aria-label="fixture"` and could not address it at all; the same is
         * true of every icon-only control in the application, which is the
         * more important case.
         *
         * Read straight off the DOM here rather than waiting on blitz-dom,
         * matching the attribute by string so this does not need `LocalName`
         * and the stylo atom machinery behind it.
         */
        let mut labels: std::collections::HashMap<u64, String> =
            std::collections::HashMap::new();
        {
            let doc = document.inner();
            doc.visit(|node_id, node| {
                if let Some(attrs) = node.attrs() {
                    for attr in attrs {
                        if &*attr.name.local == "aria-label" && !attr.value.is_empty() {
                            labels.insert(node_id.as_u64(), attr.value.to_string());
                        }
                    }
                }
                let parent = node
                    .parent
                    .and_then(|parent| boxes.get(&parent.as_u64()).copied());
                let (parent_x, parent_y) = parent.map(|(x, y, _, _)| (x, y)).unwrap_or((0.0, 0.0));

                /*
                 * `final_layout` panics rather than returning an option on any
                 * node that is not an element, an anonymous block or the
                 * document, and a text node is none of those. Calling it
                 * unguarded aborted the whole run on the first text node, which
                 * every page has.
                 *
                 * A text node takes its parent's box. It has no layout of its
                 * own, it is drawn inside the element that owns it, and that
                 * element's box is the right answer for "where is this text" —
                 * which matters because the text node is what carries the name
                 * a check matches on.
                 */
                // The document node is the one with no parent. Checked that way
                // rather than through `TNode::as_document`, to avoid pulling a
                // stylo trait into scope for a single predicate.
                let box_for_node = if node.is_element() || node.parent.is_none() {
                    let layout = node.final_layout();
                    (
                        parent_x + f64::from(layout.location.x),
                        parent_y + f64::from(layout.location.y),
                        f64::from(layout.size.width),
                        f64::from(layout.size.height),
                    )
                } else {
                    match parent {
                        Some(box_) => box_,
                        None => return,
                    }
                };

                boxes.insert(node_id.as_u64(), box_for_node);
            });
        }

        let mut lines = String::new();
        for (id, node) in &update.nodes {
            /*
             * `aria-label` wins, then accesskit's own label, then the node's
             * own text, then the text of whatever labels it. The last is what
             * names an element, and the first is what names a control that has
             * no text at all.
             */
            let name = labels
                .get(&id.0)
                .cloned()
                .or_else(|| node.label().map(|label| label.to_owned()))
                .or_else(|| node.value().map(|value| value.to_owned()))
                .or_else(|| {
                    node.labelled_by()
                        .iter()
                        .find_map(|target| text_of.get(&target.0).cloned())
                })
                .unwrap_or_default();

            /*
             * Skip the document's own `<style>` text. It reaches the tree as a
             * `TextRun` carrying the whole stylesheet, which buried the handful
             * of nodes a check actually addresses under 70 kB of Tailwind.
             */
            if name.len() > 200 {
                continue;
            }

            /*
             * Geometry, so `Paints` is decidable from the file.
             *
             * `ps-qa`'s judge asks for `visible` and a box with area; without
             * these columns the only expectation a headless run could decide
             * was "some node has this text", which is not what any generated
             * check asserts. Emitted as x,y,w,h with an empty field when the
             * node has no box at all, which is itself the answer to `Paints`.
             */
            let bounds = boxes
                .get(&id.0)
                .map(|(x, y, w, h)| format!("{x},{y},{w},{h}"))
                .unwrap_or_default();

            lines.push_str(&format!(
                "{}\t{:?}\t{}\t{}\t{}\n",
                id.0,
                node.role(),
                name,
                bounds,
                !node.is_hidden(),
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
        let mtm = objc2::MainThreadMarker::new()
            .expect("main() runs on the main thread");
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
        unsafe {
            application.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
        }
        trace("activation policy set to prohibited");
    }
    #[cfg(not(test))]
    {
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
    match std::env::var_os("BLITZ_PREVIEW_DIST") {
        Some(dist) => {
            let dist = std::path::PathBuf::from(dist);
            trace(&format!("preview dist: {}", dist.display()));
            set_document_factory(move |url| create_dist_document(&dist, url));
        }
        None => set_document_factory(create_document),
    }
    trace("document factory configured");

    let context = tauri::generate_context!("tauri.conf.json");
    trace("Tauri context generated");
    let mut app = builder()
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
        tauri_runtime_blitz::apply_runtime_debug_options(
            tauri_runtime_blitz::RuntimeDebugOptions {
                inspection_and_agent_control: true,
                deep_intrusive_profiling: false,
            },
        )
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
