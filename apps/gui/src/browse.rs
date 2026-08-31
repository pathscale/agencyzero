//! The browsing surface: pages rendered inside AgencyZero.
//!
//! # Why there is anything to do here at all
//!
//! AgencyZero already renders on Blitz. The engine that draws this window is
//! the same one a browser would use to draw a page, so "embed a browser" is
//! not an engine integration — the engine is present, and `apps/blitz-preview`
//! already proves it can show a document. What was missing is *policy*: which
//! tab is showing what, what Back means, whether the string someone typed is
//! an address, and what to do when half a page arrives.
//!
//! That policy lives in [`ps_browse_core`], deliberately outside this file and
//! outside this application, because chuzz needs the same answers. This module
//! is the half that cannot be shared: the network provider, the document, and
//! the mount inside the chrome that a page is attached to.
//!
//! # The shape
//!
//! ```text
//!   chrome (Solid)  ──command──▶  ps_browse_core::Tabs  ──Load──▶  fetch task
//!         ▲                              ▲                             │
//!         └────── browse:state ──────────┴────── completed queue ◀──────┘
//!                                                        │
//!                                              poll hook on the chrome
//!                                              document attaches the page
//! ```
//!
//! The policy never fetches and the fetch never decides. A load that comes
//! back carries the generation it was issued at, and [`ps_browse_core::Tabs`]
//! drops it if the tab has moved on — which is the only thing standing between
//! a slow page you navigated away from and it reappearing over the one you
//! asked for.
//!
//! # Why the attach happens in a poll hook
//!
//! A page can only be mounted from the UI thread, into the chrome document,
//! and only once the chrome has actually rendered the `<web-view>` element
//! that receives it. A fetch finishing has no access to any of that. So a
//! finished page joins a queue, the chrome document's poll hook drains it, and
//! a bundle whose mount is not in the tree yet is put back rather than
//! dropped: the alternative is a page that loaded correctly and rendered
//! nowhere, which is indistinguishable from a page that failed.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[cfg(feature = "blitz-runtime")]
use blitz_dom::Document as _;
use ps_browse_core::{BrowseSnapshot, DebugEntry, DebugLog, Load, PageOutcome, TabId, Tabs};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::AppHandle;

/// Emitted whenever anything about the browsing surface changes.
///
/// One topic for the whole surface rather than one per field. The chrome
/// re-reads a snapshot; it does not reconstruct state from a stream of deltas,
/// which is the design that makes a dropped event a permanently wrong tab
/// strip.
pub const BROWSE_STATE_EVENT: &str = "browse:state";

/// How a page's bytes came back, on their way to being mounted.
struct PageBundle {
    tab: TabId,
    generation: u64,
    /// Where the response actually came from, after redirects.
    resolved: ps_browse_core::Url,
    html: String,
    title_hint: String,
    outcome: PageOutcome,
}

struct BrowseInner {
    tabs: Mutex<Tabs>,
    log: Mutex<DebugLog>,
    /// Pages fetched but not yet mounted. Drained by the poll hook on the UI
    /// thread; see the module docs for why the attach cannot happen inline.
    completed: Mutex<VecDeque<PageBundle>>,
    app: Mutex<Option<AppHandle>>,
    #[cfg(feature = "blitz-runtime")]
    net: Arc<blitz_net::Provider>,
}

/// The browsing surface, shared between the Tauri commands and the UI thread.
#[derive(Clone)]
pub struct Browse(Arc<BrowseInner>);

impl Browse {
    pub fn new() -> Self {
        Self(Arc::new(BrowseInner {
            tabs: Mutex::new(Tabs::new()),
            log: Mutex::new(DebugLog::default()),
            completed: Mutex::new(VecDeque::new()),
            app: Mutex::new(None),
            #[cfg(feature = "blitz-runtime")]
            // No waker. A page's own subresources wake the window through the
            // document's provider; this one exists to fetch documents, and its
            // completion path is the queue below rather than a redraw.
            net: Arc::new(blitz_net::Provider::new(None)),
        }))
    }

    /// Give the surface a handle to emit state on. Called once from `setup`.
    pub fn attach_app(&self, app: AppHandle) {
        *self.0.app.lock().unwrap() = Some(app);
    }

    fn note(&self, level: &'static str, source: &'static str, message: String) {
        self.0.log.lock().unwrap().push(level, source, message);
    }

    fn snapshot(&self) -> BrowseSnapshot {
        self.0.tabs.lock().unwrap().snapshot()
    }

    /// Tell the chrome the surface changed.
    fn emit(&self) {
        let snapshot = self.snapshot();
        if let Some(app) = self.0.app.lock().unwrap().as_ref() {
            let _ = app.emit(BROWSE_STATE_EVENT, snapshot);
        }
    }

    /// Perform a load the policy asked for, then tell the chrome.
    ///
    /// Takes the load by value because it is a one-shot instruction: acting on
    /// the same `Load` twice would issue two fetches at one generation and let
    /// whichever finished second overwrite the first for no reason.
    fn dispatch(&self, load: Option<Load>) {
        if let Some(load) = load {
            self.note("info", "nav", format!("tab {}: {}", load.tab, load.url));
            self.fetch(load);
        }
        self.emit();
    }

    #[cfg(feature = "blitz-runtime")]
    fn fetch(&self, load: Load) {
        let browse = self.clone();
        let net = Arc::clone(&self.0.net);
        // Tauri's runtime, not one of our own. The document a fetch produces is
        // mounted on the UI thread, which is already inside this reactor, and
        // a second runtime would give page loads their own thread pool and
        // their own shutdown for no benefit.
        tauri::async_runtime::spawn(async move {
            let request = blitz_traits::net::Request::get(load.url.clone());
            let bundle = match net.fetch_response_async(request).await {
                Ok(response) => {
                    let status = response.status;
                    let resolved = response.url.clone();
                    let html = decode_body(&response);
                    let outcome = if status.is_success() {
                        PageOutcome::Loaded
                    } else {
                        // The bytes are kept: a 404 page is a page, and every
                        // browser shows the server's own version of it rather
                        // than replacing it with a generic one.
                        PageOutcome::Partial
                    };
                    browse.note(
                        if status.is_success() { "info" } else { "warn" },
                        "net",
                        format!("{} {}", status.as_u16(), resolved),
                    );
                    PageBundle {
                        tab: load.tab,
                        generation: load.generation,
                        resolved,
                        html,
                        title_hint: String::new(),
                        outcome,
                    }
                }
                Err(error) => {
                    browse.note("error", "net", format!("{}: {error}", load.url));
                    PageBundle {
                        tab: load.tab,
                        generation: load.generation,
                        resolved: load.url.clone(),
                        html: error_html(&error.to_string()),
                        title_hint: load.url.to_string(),
                        outcome: PageOutcome::Error,
                    }
                }
            };

            browse.0.completed.lock().unwrap().push_back(bundle);
            // The chrome is told immediately, before the page is mounted. The
            // address bar and the spinner belong to the chrome and should not
            // wait on a mount that happens on the next frame.
            browse.emit();
        });
    }

    /// Without the Blitz runtime there is no engine to render a page in.
    ///
    /// A webview-only build still has the whole surface — tabs, history, the
    /// address bar — and says so on the page rather than appearing to work and
    /// showing nothing. Silently doing nothing here is the failure mode this
    /// avoids: it looks exactly like a page that never loads.
    #[cfg(not(feature = "blitz-runtime"))]
    fn fetch(&self, load: Load) {
        self.note(
            "error",
            "net",
            format!(
                "this build has no renderer for pages; {} not loaded",
                load.url
            ),
        );
        self.0.tabs.lock().unwrap().finish_load(
            load.tab,
            load.generation,
            &load.url.to_string(),
            PageOutcome::Error,
        );
    }
}

impl Default for Browse {
    fn default() -> Self {
        Self::new()
    }
}

/// Turn a response body into text.
///
/// Charset from the `Content-Type` header, UTF-8 otherwise, and lossy rather
/// than fallible: a page with one bad byte in it is still a page, and refusing
/// to show it is a worse answer than a replacement character in one word.
#[cfg(feature = "blitz-runtime")]
fn decode_body(response: &blitz_traits::platform::FetchResponse) -> String {
    let charset = response
        .headers
        .get(blitz_traits::net::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(';')
                .find_map(|part| part.trim().strip_prefix("charset="))
        })
        .map(|charset| charset.trim_matches('"').to_ascii_lowercase())
        .unwrap_or_else(|| "utf-8".to_string());

    match charset.as_str() {
        "utf-8" | "utf8" | "us-ascii" | "ascii" => {
            String::from_utf8_lossy(&response.body).into_owned()
        }
        // Everything else is treated as Latin-1, which is what a byte-for-byte
        // mapping gives and is right for the western pages that still declare
        // `iso-8859-1`. A full charset table is a real dependency and belongs
        // in the engine, not here.
        _ => response.body.iter().map(|byte| *byte as char).collect(),
    }
}

/// The document shown when a page could not be fetched.
///
/// Explicit colours, and light ones. This document declares none of its own,
/// so it would inherit the engine's defaults — black text on a transparent
/// background — over a viewport the shell paints with the dark theme surface.
/// The error would render, lay out, and be unreadable, which is
/// indistinguishable from not rendering at all.
fn error_html(error: &str) -> String {
    let escaped = escape(error);
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Cannot load</title></head>
<body style="margin:0;background:#fff;color:#1a1a1a;font:14px system-ui,sans-serif">
<div style="padding:2rem;max-width:44rem">
<p style="margin:0 0 .5rem;font-size:1.1rem;font-weight:600">This page could not be loaded</p>
<p style="margin:0;color:#555;font-family:ui-monospace,monospace;word-break:break-word">{escaped}</p>
</div></body></html>"#
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The chrome element a tab's page is mounted into.
///
/// Matched by id first and by `data-tab-id` second, so the chrome can render
/// the mount either way without this having to know which. Nothing else in the
/// document is a `<web-view>`; the element exists for exactly this.
#[cfg(feature = "blitz-runtime")]
fn mount_node(document: &blitz_dom::BaseDocument, tab: TabId) -> Option<blitz_dom::NodeId> {
    if let Some(node) = document.get_element_by_id(&format!("az-browse-page-{tab}")) {
        return Some(node);
    }
    let tab = tab.to_string();
    document
        .query_selector_all("web-view")
        .ok()?
        .into_iter()
        .find(|node| {
            document
                .get_node(*node)
                .and_then(|node| node.element_data())
                .is_some_and(|element| {
                    element
                        .attrs
                        .iter()
                        .any(|attr| attr.name.local.as_ref() == "data-tab-id" && attr.value == tab)
                })
        })
}

#[cfg(feature = "blitz-runtime")]
impl Browse {
    /// Attach the surface to the chrome document.
    ///
    /// The poll hook runs on the UI thread on every frame the document is
    /// polled, which is the only place a sub-document may be mounted.
    pub fn install_document_lifecycle(&self, document: &mut blitz_script::ScriptDocument) {
        let browse = self.clone();
        let mut pending: VecDeque<PageBundle> = VecDeque::new();
        document.add_poll_hook(move |document, _| browse.poll_document(document, &mut pending));
    }

    /// Mount whatever has finished fetching. Returns whether anything changed.
    fn poll_document(
        &self,
        chrome: &mut blitz_script::ScriptDocument,
        pending: &mut VecDeque<PageBundle>,
    ) -> bool {
        pending.extend(self.0.completed.lock().unwrap().drain(..));
        if pending.is_empty() {
            return false;
        }

        let mut retained = VecDeque::new();
        let mut changed = false;

        while let Some(bundle) = pending.pop_front() {
            if !self
                .0
                .tabs
                .lock()
                .unwrap()
                .accepts(bundle.tab, bundle.generation)
            {
                // The tab moved on while this was in flight. Dropped, not
                // mounted: this is the stale-load case the generation exists
                // for.
                continue;
            }

            let Some(target) = mount_node(&chrome.inner(), bundle.tab) else {
                // The chrome has not rendered the mount yet. Held rather than
                // dropped — a page that loaded and rendered nowhere looks
                // exactly like a page that failed.
                retained.push_back(bundle);
                continue;
            };

            let shell_provider = chrome.inner().shell_provider.clone();
            let config = blitz_dom::DocumentConfig {
                base_url: Some(bundle.resolved.to_string()),
                // The page's own provider, so its images, stylesheets and
                // fonts are fetched under the ordinary subresource path rather
                // than through the document fetch above.
                net_provider: Some(
                    Arc::clone(&self.0.net) as Arc<dyn blitz_traits::net::NetProvider>
                ),
                shell_provider: Some(shell_provider),
                ..Default::default()
            };
            let page = blitz_script::ScriptDocument::from_html(&bundle.html, config);
            let title = page
                .inner()
                .find_title_node()
                .map(|node| node.text_content())
                .unwrap_or_default();
            let title = if title.trim().is_empty() {
                bundle.title_hint.clone()
            } else {
                title
            };

            self.note(
                "info",
                "page",
                format!(
                    "attached {} to tab {} as {}",
                    bundle.resolved,
                    bundle.tab,
                    bundle.outcome.name()
                ),
            );

            {
                let mut tabs = self.0.tabs.lock().unwrap();
                tabs.record_redirect(bundle.tab, bundle.generation, bundle.resolved.clone());
                tabs.finish_load(bundle.tab, bundle.generation, &title, bundle.outcome);
            }

            chrome.inner_mut().set_sub_document(target, Box::new(page));
            changed = true;
        }

        *pending = retained;
        if changed {
            self.emit();
        }
        changed
    }
}

/// Everything the chrome needs to draw the surface in one read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseView {
    #[serde(flatten)]
    pub snapshot: BrowseSnapshot,
    /// Whether this build can actually render a page. A surface that cannot
    /// says so up front rather than after a navigation that goes nowhere.
    pub can_render: bool,
}

#[tauri::command]
pub fn browse_state(state: State<'_, Browse>) -> BrowseView {
    BrowseView {
        snapshot: state.snapshot(),
        can_render: cfg!(feature = "blitz-runtime"),
    }
}

#[tauri::command]
pub fn browse_navigate(tab: TabId, input: String, state: State<'_, Browse>) -> BrowseView {
    let load = state.0.tabs.lock().unwrap().navigate(tab, &input);
    if load.is_none() {
        state.note("warn", "nav", format!("not an address: {input}"));
    }
    state.dispatch(load);
    browse_state(state)
}

#[tauri::command]
pub fn browse_open_tab(input: Option<String>, state: State<'_, Browse>) -> BrowseView {
    let (_, load) = state.0.tabs.lock().unwrap().open(input.as_deref());
    state.dispatch(load);
    browse_state(state)
}

#[tauri::command]
pub fn browse_close_tab(tab: TabId, state: State<'_, Browse>) -> BrowseView {
    state.0.tabs.lock().unwrap().close(tab);
    state.emit();
    browse_state(state)
}

#[tauri::command]
pub fn browse_select_tab(tab: TabId, state: State<'_, Browse>) -> BrowseView {
    state.0.tabs.lock().unwrap().select(tab);
    state.emit();
    browse_state(state)
}

#[tauri::command]
pub fn browse_back(tab: TabId, state: State<'_, Browse>) -> BrowseView {
    let load = state.0.tabs.lock().unwrap().back(tab);
    state.dispatch(load);
    browse_state(state)
}

#[tauri::command]
pub fn browse_forward(tab: TabId, state: State<'_, Browse>) -> BrowseView {
    let load = state.0.tabs.lock().unwrap().forward(tab);
    state.dispatch(load);
    browse_state(state)
}

#[tauri::command]
pub fn browse_reload(tab: TabId, state: State<'_, Browse>) -> BrowseView {
    let load = state.0.tabs.lock().unwrap().reload(tab);
    state.dispatch(load);
    browse_state(state)
}

/// The debugging stream, from where the caller left off.
#[tauri::command]
pub fn browse_debug_log(since: Option<u64>, state: State<'_, Browse>) -> Vec<DebugEntry> {
    state.0.log.lock().unwrap().since(since)
}

/// Wire the surface into the app. One call, so a build that forgets it fails
/// at the missing state rather than at a command that silently returns nothing.
pub fn manage(app: &AppHandle, browse: Browse) {
    browse.attach_app(app.clone());
    app.manage(browse);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a rendering test. The policy is tested in `ps-browse-core`; what is
    /// worth pinning here is that the commands route to it and that a surface
    /// with no window still answers.
    #[test]
    fn a_fresh_surface_has_one_blank_tab() {
        let browse = Browse::new();
        let snapshot = browse.snapshot();
        assert_eq!(snapshot.tabs.len(), 1);
        assert_eq!(snapshot.tabs[0].url, ps_browse_core::NEW_TAB_URL);
    }

    /// Emitting with no app handle attached must not panic. `setup` runs after
    /// the state is managed, so there is a real window in which commands can
    /// arrive before a handle exists.
    #[test]
    fn emitting_before_the_window_exists_is_a_no_op() {
        let browse = Browse::new();
        browse.emit();
    }

    #[test]
    fn the_error_page_escapes_what_the_server_said() {
        let html = error_html("<script>boom</script>");
        assert!(!html.contains("<script>boom"));
        assert!(html.contains("&lt;script&gt;boom"));
    }

    #[test]
    fn a_typed_address_becomes_a_load_and_a_typed_sentence_does_not() {
        let browse = Browse::new();
        let tab = browse.0.tabs.lock().unwrap().active();

        assert!(
            browse
                .0
                .tabs
                .lock()
                .unwrap()
                .navigate(tab, "example.com")
                .is_some()
        );
        assert!(
            browse
                .0
                .tabs
                .lock()
                .unwrap()
                .navigate(tab, "what is a browser")
                .is_none()
        );
    }
}
