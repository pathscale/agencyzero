//! One tab's back/forward stack.

use serde::Serialize;
use url::Url;

use crate::address::display_title;

/// One position in a tab's history.
///
/// The title lives beside the URL rather than in a lookup table keyed by URL,
/// because the same address visited twice can legitimately have two titles and
/// a shared table would show the newer one against the older entry.
#[derive(Clone, Debug)]
pub struct Entry {
    pub url: Url,
    pub title: String,
}

impl Entry {
    fn new(url: Url) -> Self {
        Self {
            url,
            title: String::new(),
        }
    }

    /// What a tab strip shows for this entry.
    pub fn display_title(&self) -> String {
        display_title(&self.title, &self.url)
    }
}

/// A tab's history, and where in it the tab currently sits.
///
/// Never empty. A tab always has a current entry — a new tab's is
/// `about:blank` — which is what lets [`History::current`] return a reference
/// rather than an option and keeps every caller from handling a state that
/// cannot occur.
#[derive(Clone, Debug)]
pub struct History {
    entries: Vec<Entry>,
    current: usize,
}

impl History {
    pub fn new(url: Url) -> Self {
        Self {
            entries: vec![Entry::new(url)],
            current: 0,
        }
    }

    pub fn current(&self) -> &Entry {
        &self.entries[self.current]
    }

    pub fn current_mut(&mut self) -> &mut Entry {
        &mut self.entries[self.current]
    }

    pub fn can_go_back(&self) -> bool {
        self.current > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.current + 1 < self.entries.len()
    }

    /// Visit a new address, discarding anything ahead of the cursor.
    ///
    /// The truncation is the whole of forward-history policy: going back three
    /// pages and then following a link means the three pages you skipped are
    /// no longer reachable, because you are no longer on the path that led to
    /// them. Keeping them would make Forward go somewhere the user never was.
    ///
    /// Re-entering the address already showing is a reload, not a new entry.
    /// Without that check, pressing Return in the address bar without editing
    /// it grows the stack by one every time and Back stops meaning anything.
    pub fn visit(&mut self, url: Url) {
        if self.current().url == url {
            return;
        }
        self.entries.truncate(self.current + 1);
        self.entries.push(Entry::new(url));
        self.current = self.entries.len() - 1;
    }

    /// Step back one entry, returning where the tab now is.
    pub fn back(&mut self) -> Option<&Entry> {
        if !self.can_go_back() {
            return None;
        }
        self.current -= 1;
        Some(self.current())
    }

    /// Step forward one entry, returning where the tab now is.
    pub fn forward(&mut self) -> Option<&Entry> {
        if !self.can_go_forward() {
            return None;
        }
        self.current += 1;
        Some(self.current())
    }

    /// Every entry, oldest first, for a history panel.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn position(&self) -> usize {
        self.current
    }
}

/// One history entry as the chrome sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySnapshot {
    pub url: String,
    pub title: String,
    /// Whether this is the entry the tab is currently showing.
    pub current: bool,
}

impl History {
    pub fn snapshot(&self) -> Vec<EntrySnapshot> {
        self.entries
            .iter()
            .enumerate()
            .map(|(index, entry)| EntrySnapshot {
                url: entry.url.to_string(),
                title: entry.display_title(),
                current: index == self.current,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn history() -> History {
        History::new(url("https://a.example/"))
    }

    #[test]
    fn a_fresh_history_can_go_nowhere() {
        let history = history();
        assert!(!history.can_go_back());
        assert!(!history.can_go_forward());
        assert_eq!(history.current().url.as_str(), "https://a.example/");
    }

    #[test]
    fn back_then_forward_returns_to_where_it_started() {
        let mut history = history();
        history.visit(url("https://b.example/"));
        assert_eq!(history.back().unwrap().url.as_str(), "https://a.example/");
        assert!(history.can_go_forward());
        assert_eq!(
            history.forward().unwrap().url.as_str(),
            "https://b.example/"
        );
        assert!(!history.can_go_forward());
    }

    /// Going back and then somewhere new drops the branch that was skipped.
    /// Keeping it would put a page the user never navigated to behind Forward.
    #[test]
    fn visiting_after_going_back_discards_the_forward_branch() {
        let mut history = history();
        history.visit(url("https://b.example/"));
        history.visit(url("https://c.example/"));
        history.back();
        history.visit(url("https://d.example/"));

        assert!(!history.can_go_forward());
        assert_eq!(history.entries().len(), 3);
        assert_eq!(history.current().url.as_str(), "https://d.example/");
        // b, not c: c was the branch that going back stepped off, and d
        // replaced it.
        assert_eq!(history.back().unwrap().url.as_str(), "https://b.example/");
    }

    /// Pressing Return on the address already showing is a reload. Recording
    /// it would grow the stack by one per keypress and make Back useless.
    #[test]
    fn re_entering_the_current_address_is_not_a_new_entry() {
        let mut history = history();
        history.visit(url("https://a.example/"));
        assert_eq!(history.entries().len(), 1);
        assert!(!history.can_go_back());
    }

    #[test]
    fn an_untitled_entry_shows_its_url() {
        let mut history = history();
        assert_eq!(history.current().display_title(), "https://a.example/");
        history.current_mut().title = "A".into();
        assert_eq!(history.current().display_title(), "A");
    }

    #[test]
    fn the_snapshot_marks_exactly_one_current_entry() {
        let mut history = history();
        history.visit(url("https://b.example/"));
        history.back();
        let snapshot = history.snapshot();
        assert_eq!(snapshot.iter().filter(|entry| entry.current).count(), 1);
        assert!(snapshot[0].current);
    }
}
