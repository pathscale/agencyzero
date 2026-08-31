//! Address-bar policy: deciding what a typed string means.
//!
//! The browser owns this, not the engine. A string is a URL if it parses as
//! one, a bare hostname if it looks like a domain, and nothing otherwise.
//!
//! Lifted from chuzz's `nav.rs` and cut loose from the engine: chuzz returned
//! a `blitz_traits::net::Request`, which dragged the whole engine into a
//! decision that is pure string handling. A [`Url`] is the same answer without
//! the dependency, and the host wraps it in whatever its fetch layer wants.

use url::Url;

/// Page opened by a new tab: nothing at all.
///
/// A new tab should cost nothing until it is asked for something. Pointing it
/// at a home page instead means every new tab fetches a site, runs its
/// scripts, and decodes its images before the address bar has been touched.
/// The host answers the `about` scheme from a constant, without a request.
pub const NEW_TAB_URL: &str = "about:blank";

/// Turn whatever the user typed into a URL to navigate to.
///
/// Returns `None` for anything that is not a URL or a bare hostname. The
/// toolbar treats that as "do nothing".
pub fn url_from_input(input: &str) -> Option<Url> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }

    if let Ok(url) = Url::parse(input)
        && url.scheme() != "localhost"
    {
        return Some(url);
    }

    if looks_like_hostname(input)
        && let Ok(url) = Url::parse(&format!("https://{input}"))
    {
        return Some(url);
    }

    // No search fallback. Anything that is not a URL and not a hostname is a
    // mistake, and quietly navigating somewhere unrelated hides it: that is how
    // a wrong capture argument once ended up loading a search engine instead of
    // the local file it was given.
    None
}

/// A dotted, space-free token is treated as a host rather than a query.
///
/// `localhost` and `localhost:3000` are special-cased because developers type
/// them constantly and they carry no dot.
fn looks_like_hostname(input: &str) -> bool {
    if input.contains(char::is_whitespace) {
        return false;
    }
    if input == "localhost" || input.starts_with("localhost:") || input.starts_with("localhost/") {
        return true;
    }
    let host = input
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(input)
        .split(':')
        .next()
        .unwrap_or(input);
    // A trailing dot ("foo.") or a leading dot (".foo") is a typo, not a host.
    host.contains('.') && !host.starts_with('.') && !host.ends_with('.')
}

/// Text shown in a tab strip and a window title.
pub fn display_title(title: &str, url: &Url) -> String {
    if title.trim().is_empty() {
        url.as_str().to_string()
    } else {
        title.to_string()
    }
}

/// Whether a URL is one the browser answers itself rather than fetching.
///
/// `about:blank` is the new-tab document and has no server. Asking the network
/// for it is how a new tab ends up with an error page instead of an empty one.
pub fn is_internal(url: &Url) -> bool {
    url.scheme() == "about"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(input: &str) -> String {
        url_from_input(input).unwrap().to_string()
    }

    /// The host answers the `about` scheme from a constant instead of
    /// fetching. A new tab pointed anywhere else costs a request before it has
    /// been asked for anything.
    #[test]
    fn a_new_tab_costs_no_request() {
        let url = Url::parse(NEW_TAB_URL).unwrap();
        assert_eq!(url.scheme(), "about");
        assert!(is_internal(&url));
    }

    #[test]
    fn blank_input_is_not_a_navigation() {
        assert!(url_from_input("").is_none());
        assert!(url_from_input("   \t ").is_none());
    }

    #[test]
    fn an_explicit_scheme_is_preserved() {
        assert_eq!(target("http://example.com/a"), "http://example.com/a");
        assert_eq!(target("https://example.com/a"), "https://example.com/a");
    }

    #[test]
    fn a_bare_hostname_gets_https() {
        assert_eq!(target("example.com"), "https://example.com/");
        assert_eq!(
            target("example.com/path?q=1"),
            "https://example.com/path?q=1"
        );
    }

    #[test]
    fn localhost_is_treated_as_a_host_despite_having_no_dot() {
        assert_eq!(target("localhost:3000"), "https://localhost:3000/");
        assert_eq!(target("localhost"), "https://localhost/");
    }

    #[test]
    fn prose_is_not_a_navigation() {
        assert!(url_from_input("how tall is the eiffel tower").is_none());
    }

    #[test]
    fn a_dotted_phrase_with_spaces_is_not_a_host() {
        assert!(url_from_input("what is rust.lang about").is_none());
    }

    #[test]
    fn a_trailing_dot_is_a_typo_and_goes_nowhere() {
        assert!(url_from_input("example.").is_none());
    }

    #[test]
    fn an_untitled_page_falls_back_to_its_url() {
        let url = Url::parse("https://example.com/a").unwrap();
        assert_eq!(display_title("", &url), "https://example.com/a");
        assert_eq!(display_title("   ", &url), "https://example.com/a");
        assert_eq!(display_title("Example", &url), "Example");
    }
}
