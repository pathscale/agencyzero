//! Every icon in the app puts ink on the canvas, checked against the real
//! rasteriser.
//!
//! # Why this is a Rust test and not a frontend one
//!
//! The icons were blank across the whole window while the frontend suite was
//! green, the semantic tree reported 762 visible icon nodes at `16x16`, and the
//! accent audit came back 760 of 762 on the artwork accent. Every instrument
//! said the icons were fine. Nothing drew them.
//!
//! Inline SVG is not painted from the DOM on this renderer: `blitz-dom`
//! serialises the `<svg>` element and hands the string to **usvg**, which has no
//! stylesheet and no custom properties. Two separate mistakes died in there,
//! silently, because `construct.rs` swallows a parse error unless the `tracing`
//! feature is on:
//!
//! - `stroke="var(--color-az-artwork)"` — usvg does not fall back on an
//!   unreadable paint, it **drops** it. A shape with neither stroke nor fill
//!   draws nothing. That token was also defined nowhere in the app.
//! - `fill="currentColor"` with no `color` on the root — `currentColor` resolves
//!   against the serialised document's own `color`, whose usvg default is
//!   **black**. Seven icons filled black on a dark surface.
//!
//! Neither is visible from jsdom, which never rasterises, nor from the semantic
//! tree, where a blank icon and a drawn one are indistinguishable. usvg is the
//! thing that decides, so usvg is what this asks.
//!
//! Run with `cargo test -p blitz-bench`.

use std::collections::BTreeMap;

/// What `Icon.tsx` puts on the root element, with the theme fallback resolved.
///
/// Kept in step with that file by hand, deliberately: the point is to check the
/// markup the renderer really receives, and deriving it from the source would
/// re-import whatever mistake the source is making.
const ROOT_ATTRS: &str = concat!(
    r##"xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" "##,
    r##"fill="none" stroke="#8fb8e8" color="#8fb8e8" stroke-width="2" "##,
    r##"stroke-linecap="round" stroke-linejoin="round""##
);

/// The artwork for each icon, lifted from `ICON_ART` in `IconSprite.tsx`.
fn icon_artwork() -> BTreeMap<String, String> {
    let source = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/gui/frontend/src/components/IconSprite.tsx"
    ));
    let mut icons = BTreeMap::new();
    let mut rest = source;
    // Entries read `  name: (` or `  "list-checks": (`, then a fragment. The
    // formatter unquotes keys that are valid identifiers, so both forms appear.
    while let Some(at) = rest.find(": (\n") {
        let (before, after) = rest.split_at(at);
        let name = before
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"');
        rest = &after[": (\n".len()..];
        let Some(open) = rest.find("<>") else {
            continue;
        };
        let Some(close) = rest.find("</>") else {
            continue;
        };
        if open > close {
            continue;
        }
        // Digits included: `file-plus-2` and `folder-git-2` are real icon
        // names, and a filter of letters-and-dashes silently skipped both,
        // which is coverage quietly going missing rather than a test failing.
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            icons.insert(name.to_owned(), rest[open + 2..close].trim().to_owned());
        }
        rest = &rest[close + 3..];
    }
    icons
}

/// Every shape usvg kept, as the paints it resolved them to.
fn shapes(node: &usvg::Node, out: &mut Vec<(Option<String>, Option<String>)>) {
    match node {
        usvg::Node::Path(path) => out.push((
            path.stroke().map(|s| format!("{:?}", s.paint())),
            path.fill().map(|f| format!("{:?}", f.paint())),
        )),
        usvg::Node::Group(group) => {
            for child in group.children() {
                shapes(child, out);
            }
        }
        _ => {}
    }
}

#[test]
fn every_icon_draws_something_visible() {
    let icons = icon_artwork();
    /*
     * The count is asserted, not just the contents.
     *
     * An entry the parser fails to recognise is coverage going missing without
     * a failure, which is the same class of quiet hole this whole test exists
     * to close: two icons with digits in their names were skipped by an earlier
     * filter and nothing said so.
     */
    let declared = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/gui/frontend/src/components/IconSprite.tsx"
    ))
    .lines()
    .filter(|line| line.trim_start().starts_with("| \""))
    .count();
    assert_eq!(
        icons.len(),
        declared,
        "parsed {} icons but the IconName union declares {declared}",
        icons.len()
    );

    let mut blank = Vec::new();
    let mut black = Vec::new();

    for (name, art) in &icons {
        let markup = format!("<svg {ROOT_ATTRS}>{art}</svg>");
        let tree = match usvg::Tree::from_data(markup.as_bytes(), &usvg::Options::default()) {
            Ok(tree) => tree,
            Err(error) => {
                blank.push(format!("{name} (parse failed: {error})"));
                continue;
            }
        };

        let mut found = Vec::new();
        shapes(
            &usvg::Node::Group(Box::new(tree.root().clone())),
            &mut found,
        );

        // A shape with neither stroke nor fill is in the tree and on no screen.
        if !found
            .iter()
            .any(|(stroke, fill)| stroke.is_some() || fill.is_some())
        {
            blank.push(name.clone());
        }
        // Pure black is the `currentColor` default, which is invisible here.
        if found.iter().any(|(stroke, fill)| {
            format!("{stroke:?}{fill:?}").contains("red: 0, green: 0, blue: 0")
        }) {
            black.push(name.clone());
        }
    }

    assert!(
        blank.is_empty(),
        "{} of {} icons draw nothing: {blank:?}",
        blank.len(),
        icons.len()
    );
    assert!(
        black.is_empty(),
        "{} of {} icons paint black, which is invisible on the app's surface: {black:?}",
        black.len(),
        icons.len()
    );
}

/// The two paints that silently produce an empty icon.
///
/// Pinned as behaviour rather than assumed, so a usvg upgrade that starts
/// falling back is noticed here rather than by the owner looking at a window.
#[test]
fn usvg_drops_an_unreadable_paint() {
    let with_var = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="var(--color-az-artwork)" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>"##;
    let tree = usvg::Tree::from_data(with_var.as_bytes(), &usvg::Options::default())
        .expect("usvg parses the document even when a paint is unreadable");
    let mut found = Vec::new();
    shapes(
        &usvg::Node::Group(Box::new(tree.root().clone())),
        &mut found,
    );
    assert!(
        found
            .iter()
            .all(|(stroke, fill)| stroke.is_none() && fill.is_none()),
        "usvg now understands var(); the fallback in Icon.tsx can be simplified"
    );

    let no_color = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8fb8e8" stroke-width="2"><circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/></svg>"##;
    let tree = usvg::Tree::from_data(no_color.as_bytes(), &usvg::Options::default()).unwrap();
    let mut found = Vec::new();
    shapes(
        &usvg::Node::Group(Box::new(tree.root().clone())),
        &mut found,
    );
    assert!(
        found
            .iter()
            .any(|(_, fill)| format!("{fill:?}").contains("red: 0, green: 0, blue: 0")),
        "currentColor no longer defaults to black; the `color` attribute may be unnecessary"
    );
}
