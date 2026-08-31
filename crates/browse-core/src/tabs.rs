//! The tab set, and what a navigation asks the host to do.

use serde::Serialize;
use url::Url;

use crate::address::{NEW_TAB_URL, url_from_input};
use crate::history::{EntrySnapshot, History};
use crate::outcome::PageOutcome;

pub type TabId = u64;

/// What the host must fetch and mount, and for whom.
///
/// The policy never fetches. It answers "this tab, at this generation, now
/// wants this URL", and the host — which owns the network stack and the
/// engine — does the work and reports back through [`Tabs::finish_load`].
/// That split is the reason this crate has no engine dependency, and it is
/// what lets the same policy sit under two different applications.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Load {
    pub tab: TabId,
    /// Bumped on every navigation in the tab.
    ///
    /// A fetch that finishes after the user has navigated somewhere else must
    /// not attach; without this the slower of two loads wins and a page you
    /// left comes back over the one you asked for. The host carries the
    /// generation through its async work and hands it back, and
    /// [`Tabs::finish_load`] drops anything stale.
    pub generation: u64,
    pub url: Url,
}

#[derive(Clone, Debug)]
struct Tab {
    id: TabId,
    history: History,
    title: String,
    loading: bool,
    /// How the last completed load went. `loading` wins over it while a load
    /// is in flight, so the previous page's outcome never shows against the
    /// new one's address.
    outcome: PageOutcome,
    generation: u64,
}

impl Tab {
    fn new(id: TabId, url: Url) -> Self {
        Self {
            id,
            history: History::new(url),
            title: String::new(),
            loading: false,
            outcome: PageOutcome::Empty,
            generation: 0,
        }
    }

    fn snapshot(&self) -> TabSnapshot {
        TabSnapshot {
            id: self.id,
            title: if self.title.trim().is_empty() {
                self.history.current().display_title()
            } else {
                self.title.clone()
            },
            url: self.history.current().url.to_string(),
            status: if self.loading {
                "loading"
            } else {
                self.outcome.name()
            },
            can_go_back: self.history.can_go_back(),
            can_go_forward: self.history.can_go_forward(),
        }
    }
}

/// One tab as the chrome sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    pub id: TabId,
    pub title: String,
    pub url: String,
    /// `loading`, or the name of the last [`PageOutcome`].
    pub status: &'static str,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// The whole browsing surface as the chrome sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseSnapshot {
    pub tabs: Vec<TabSnapshot>,
    pub active: TabId,
    /// The active tab's history, for the history panel. Only the active one:
    /// the panel shows one tab at a time and serialising every tab's stack on
    /// every state emission is a cost paid for nothing.
    pub history: Vec<EntrySnapshot>,
}

/// Tabs, history and navigation, with no engine anywhere in sight.
#[derive(Clone, Debug)]
pub struct Tabs {
    tabs: Vec<Tab>,
    active: TabId,
    next_id: TabId,
}

impl Default for Tabs {
    fn default() -> Self {
        Self::new()
    }
}

impl Tabs {
    /// A browser with one empty tab.
    ///
    /// Never zero tabs. A surface with no tab has no address bar target and no
    /// place to put a page, and every caller would have to handle that state;
    /// closing the last tab blanks it instead. See [`Tabs::close`].
    pub fn new() -> Self {
        let url = Url::parse(NEW_TAB_URL).expect("the new-tab URL is a constant and parses");
        Self {
            tabs: vec![Tab::new(0, url)],
            active: 0,
            next_id: 1,
        }
    }

    pub fn active(&self) -> TabId {
        self.active
    }

    pub fn len(&self) -> usize {
        self.tabs.len()
    }

    pub fn is_empty(&self) -> bool {
        // Never true. Kept because clippy asks for it beside `len`, and a
        // caller reading it as "can this be empty" gets the honest answer.
        self.tabs.is_empty()
    }

    fn tab(&self, id: TabId) -> Option<&Tab> {
        self.tabs.iter().find(|tab| tab.id == id)
    }

    fn tab_mut(&mut self, id: TabId) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }

    /// The address the given tab is showing.
    pub fn url(&self, id: TabId) -> Option<&Url> {
        self.tab(id).map(|tab| &tab.history.current().url)
    }

    /// Open a tab, optionally at an address, and make it active.
    ///
    /// Returns the load to perform, which is `None` for a blank tab: an empty
    /// tab that fetches something has already failed at the one thing it is
    /// for.
    pub fn open(&mut self, input: Option<&str>) -> (TabId, Option<Load>) {
        let url = input
            .and_then(url_from_input)
            .unwrap_or_else(|| Url::parse(NEW_TAB_URL).expect("constant"));
        let id = self.next_id;
        self.next_id += 1;
        let internal = crate::address::is_internal(&url);
        self.tabs.push(Tab::new(id, url));
        self.active = id;
        if internal {
            return (id, None);
        }
        (id, self.begin(id))
    }

    /// Close a tab.
    ///
    /// Closing the last one resets it to blank rather than leaving the surface
    /// with nothing in it. Returns whether anything changed.
    pub fn close(&mut self, id: TabId) -> bool {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else {
            return false;
        };

        if self.tabs.len() == 1 {
            let url = Url::parse(NEW_TAB_URL).expect("constant");
            let generation = self.tabs[0].generation + 1;
            self.tabs[0] = Tab::new(id, url);
            // Carried across the reset. A load already in flight for the old
            // page must not attach to the blank tab that replaced it, and a
            // generation restarting at zero would let exactly that through.
            self.tabs[0].generation = generation;
            return true;
        }

        self.tabs.remove(index);
        if self.active == id {
            // The neighbour to the right, or the new last tab. Falling back to
            // the first tab instead sends focus across the strip for a close
            // in the middle, which is where every browser that does it feels
            // broken.
            let next = index.min(self.tabs.len() - 1);
            self.active = self.tabs[next].id;
        }
        true
    }

    /// Make a tab active. Returns whether the tab exists.
    pub fn select(&mut self, id: TabId) -> bool {
        if self.tab(id).is_none() {
            return false;
        }
        self.active = id;
        true
    }

    /// Navigate a tab to whatever the user typed.
    ///
    /// `None` means the input was not an address and nothing should happen —
    /// see [`crate::address::url_from_input`], which deliberately has no
    /// search fallback.
    pub fn navigate(&mut self, id: TabId, input: &str) -> Option<Load> {
        let url = url_from_input(input)?;
        let tab = self.tab_mut(id)?;
        tab.history.visit(url);
        tab.title = String::new();
        self.begin(id)
    }

    /// Re-fetch the address the tab is already showing.
    pub fn reload(&mut self, id: TabId) -> Option<Load> {
        let tab = self.tab(id)?;
        if crate::address::is_internal(&tab.history.current().url) {
            return None;
        }
        self.begin(id)
    }

    pub fn back(&mut self, id: TabId) -> Option<Load> {
        let tab = self.tab_mut(id)?;
        tab.history.back()?;
        tab.title = String::new();
        self.begin(id)
    }

    pub fn forward(&mut self, id: TabId) -> Option<Load> {
        let tab = self.tab_mut(id)?;
        tab.history.forward()?;
        tab.title = String::new();
        self.begin(id)
    }

    /// Mark a tab as loading and produce the instruction for the host.
    fn begin(&mut self, id: TabId) -> Option<Load> {
        let tab = self.tab_mut(id)?;
        tab.generation += 1;
        tab.loading = true;
        Some(Load {
            tab: id,
            generation: tab.generation,
            url: tab.history.current().url.clone(),
        })
    }

    /// Whether a load that has come back is still the one the tab wants.
    pub fn accepts(&self, id: TabId, generation: u64) -> bool {
        self.tab(id).is_some_and(|tab| tab.generation == generation)
    }

    /// Record a finished load. Returns whether it was accepted.
    ///
    /// A stale generation is dropped rather than applied, which is the only
    /// thing standing between a slow page you navigated away from and it
    /// reappearing over the page you asked for.
    pub fn finish_load(
        &mut self,
        id: TabId,
        generation: u64,
        title: &str,
        outcome: PageOutcome,
    ) -> bool {
        if !self.accepts(id, generation) {
            return false;
        }
        let Some(tab) = self.tab_mut(id) else {
            return false;
        };
        tab.loading = false;
        tab.outcome = outcome;
        tab.title = title.trim().to_string();
        tab.history.current_mut().title = tab.title.clone();
        true
    }

    /// A load that redirected. The tab's current entry moves to where it
    /// actually arrived, so Back returns to the page that linked here rather
    /// than to the address that redirected away from itself.
    pub fn record_redirect(&mut self, id: TabId, generation: u64, url: Url) -> bool {
        if !self.accepts(id, generation) {
            return false;
        }
        let Some(tab) = self.tab_mut(id) else {
            return false;
        };
        tab.history.current_mut().url = url;
        true
    }

    pub fn snapshot(&self) -> BrowseSnapshot {
        BrowseSnapshot {
            tabs: self.tabs.iter().map(Tab::snapshot).collect(),
            active: self.active,
            history: self
                .tab(self.active)
                .map(|tab| tab.history.snapshot())
                .unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_browser_has_one_blank_tab_and_asks_for_nothing() {
        let tabs = Tabs::new();
        assert_eq!(tabs.len(), 1);
        let snapshot = tabs.snapshot();
        assert_eq!(snapshot.tabs[0].url, NEW_TAB_URL);
        assert_eq!(snapshot.tabs[0].status, "empty");
    }

    #[test]
    fn opening_a_blank_tab_issues_no_load() {
        let mut tabs = Tabs::new();
        let (id, load) = tabs.open(None);
        assert!(load.is_none());
        assert_eq!(tabs.active(), id);
    }

    #[test]
    fn opening_at_an_address_issues_a_load_for_that_tab() {
        let mut tabs = Tabs::new();
        let (id, load) = tabs.open(Some("example.com"));
        let load = load.expect("an address should produce a load");
        assert_eq!(load.tab, id);
        assert_eq!(load.url.as_str(), "https://example.com/");
    }

    #[test]
    fn prose_in_the_address_bar_does_nothing() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        assert!(
            tabs.navigate(active, "how tall is the eiffel tower")
                .is_none()
        );
        assert_eq!(tabs.snapshot().tabs[0].url, NEW_TAB_URL);
    }

    /// The generation check, which is the whole reason it exists: a load that
    /// comes back after the user has gone somewhere else must not attach.
    #[test]
    fn a_stale_load_is_dropped() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        let first = tabs.navigate(active, "a.example").unwrap();
        let second = tabs.navigate(active, "b.example").unwrap();

        assert!(!tabs.finish_load(active, first.generation, "A", PageOutcome::Loaded));
        assert!(tabs.finish_load(active, second.generation, "B", PageOutcome::Loaded));
        assert_eq!(tabs.snapshot().tabs[0].title, "B");
    }

    #[test]
    fn a_finished_load_clears_loading_and_shows_its_outcome() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        let load = tabs.navigate(active, "a.example").unwrap();
        assert_eq!(tabs.snapshot().tabs[0].status, "loading");
        tabs.finish_load(active, load.generation, "A", PageOutcome::Partial);
        assert_eq!(tabs.snapshot().tabs[0].status, "partial");
    }

    /// While a load is in flight the tab shows "loading", not the outcome of
    /// the page it is leaving. The old status against the new address is the
    /// specific thing this prevents.
    #[test]
    fn the_previous_outcome_does_not_show_against_a_new_address() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        let first = tabs.navigate(active, "a.example").unwrap();
        tabs.finish_load(active, first.generation, "A", PageOutcome::Error);
        tabs.navigate(active, "b.example").unwrap();
        let snapshot = tabs.snapshot();
        assert_eq!(snapshot.tabs[0].status, "loading");
        assert_eq!(snapshot.tabs[0].url, "https://b.example/");
    }

    #[test]
    fn back_and_forward_reissue_loads_for_the_addresses_they_land_on() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        tabs.navigate(active, "a.example");
        tabs.navigate(active, "b.example");

        let back = tabs.back(active).expect("back should load");
        assert_eq!(back.url.as_str(), "https://a.example/");
        let forward = tabs.forward(active).expect("forward should load");
        assert_eq!(forward.url.as_str(), "https://b.example/");
        assert!(tabs.forward(active).is_none());
    }

    #[test]
    fn closing_the_last_tab_blanks_it_instead_of_emptying_the_surface() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        tabs.navigate(active, "a.example");
        assert!(tabs.close(active));
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs.snapshot().tabs[0].url, NEW_TAB_URL);
    }

    /// A load in flight when the last tab was closed must not attach to the
    /// blank tab that replaced it.
    #[test]
    fn closing_the_last_tab_invalidates_its_load() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        let load = tabs.navigate(active, "a.example").unwrap();
        tabs.close(active);
        assert!(!tabs.finish_load(active, load.generation, "A", PageOutcome::Loaded));
    }

    #[test]
    fn closing_the_active_tab_activates_its_right_neighbour() {
        let mut tabs = Tabs::new();
        let first = tabs.active();
        let (second, _) = tabs.open(Some("b.example"));
        let (third, _) = tabs.open(Some("c.example"));
        tabs.select(second);

        tabs.close(second);
        assert_eq!(tabs.active(), third);
        tabs.close(third);
        assert_eq!(tabs.active(), first);
    }

    #[test]
    fn a_redirect_moves_the_entry_so_back_skips_the_redirector() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        tabs.navigate(active, "a.example");
        let load = tabs.navigate(active, "b.example").unwrap();
        assert!(tabs.record_redirect(
            active,
            load.generation,
            Url::parse("https://c.example/").unwrap()
        ));
        tabs.finish_load(active, load.generation, "C", PageOutcome::Loaded);

        assert_eq!(tabs.snapshot().tabs[0].url, "https://c.example/");
        let back = tabs.back(active).unwrap();
        assert_eq!(back.url.as_str(), "https://a.example/");
    }

    #[test]
    fn an_untitled_page_shows_its_address_in_the_strip() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        let load = tabs.navigate(active, "a.example").unwrap();
        tabs.finish_load(active, load.generation, "   ", PageOutcome::Loaded);
        assert_eq!(tabs.snapshot().tabs[0].title, "https://a.example/");
    }

    #[test]
    fn reloading_a_blank_tab_asks_for_nothing() {
        let mut tabs = Tabs::new();
        let active = tabs.active();
        assert!(tabs.reload(active).is_none());
    }

    #[test]
    fn operations_on_an_unknown_tab_are_refused_rather_than_panicking() {
        let mut tabs = Tabs::new();
        assert!(tabs.navigate(999, "a.example").is_none());
        assert!(tabs.back(999).is_none());
        assert!(tabs.forward(999).is_none());
        assert!(tabs.reload(999).is_none());
        assert!(!tabs.select(999));
        assert!(!tabs.close(999));
    }
}
