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

/// Stroke and fill every path in a usvg tree into a real bitmap.
///
/// Written out here rather than pulled from `resvg`, which the app does not
/// depend on. It is the same arithmetic the renderer does: walk the tree,
/// apply the accumulated transform, and paint each shape with the paint usvg
/// resolved. What matters is that the output is pixels, not a tree.
fn rasterise(tree: &usvg::Tree, size: u32) -> tiny_skia::Pixmap {
    let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("a pixmap to draw into");
    let scale = size as f32 / tree.size().width().max(1.0);
    paint_node(
        &usvg::Node::Group(Box::new(tree.root().clone())),
        &mut pixmap,
        tiny_skia::Transform::from_scale(scale, scale),
    );
    pixmap
}

fn paint_node(node: &usvg::Node, pixmap: &mut tiny_skia::Pixmap, transform: tiny_skia::Transform) {
    match node {
        usvg::Node::Group(group) => {
            let inner = transform.pre_concat(to_skia_transform(group.transform()));
            for child in group.children() {
                paint_node(child, pixmap, inner);
            }
        }
        usvg::Node::Path(path) => {
            let Some(skia_path) = to_skia_path(path.data()) else {
                return;
            };
            if let Some(fill) = path.fill() {
                let mut paint = tiny_skia::Paint::default();
                paint.set_color(to_skia_color(fill.paint()));
                paint.anti_alias = true;
                pixmap.fill_path(
                    &skia_path,
                    &paint,
                    tiny_skia::FillRule::Winding,
                    transform,
                    None,
                );
            }
            if let Some(stroke) = path.stroke() {
                let mut paint = tiny_skia::Paint::default();
                paint.set_color(to_skia_color(stroke.paint()));
                paint.anti_alias = true;
                /*
                 * Linecap and linejoin carried over, not defaulted.
                 *
                 * `M12 18h.01` is the Lucide idiom for a dot: a hairline
                 * segment that is only visible because a round cap draws a
                 * disc at each end. With a butt cap it rasterises to nothing,
                 * and the test reported a perfectly good icon as blank.
                 */
                let skia_stroke = tiny_skia::Stroke {
                    width: stroke.width().get(),
                    line_cap: match stroke.linecap() {
                        usvg::LineCap::Butt => tiny_skia::LineCap::Butt,
                        usvg::LineCap::Round => tiny_skia::LineCap::Round,
                        usvg::LineCap::Square => tiny_skia::LineCap::Square,
                    },
                    line_join: match stroke.linejoin() {
                        usvg::LineJoin::Round => tiny_skia::LineJoin::Round,
                        usvg::LineJoin::Bevel => tiny_skia::LineJoin::Bevel,
                        _ => tiny_skia::LineJoin::Miter,
                    },
                    ..tiny_skia::Stroke::default()
                };
                pixmap.stroke_path(&skia_path, &paint, &skia_stroke, transform, None);
            }
        }
        _ => {}
    }
}

fn to_skia_transform(transform: usvg::Transform) -> tiny_skia::Transform {
    tiny_skia::Transform::from_row(
        transform.sx,
        transform.ky,
        transform.kx,
        transform.sy,
        transform.tx,
        transform.ty,
    )
}

fn to_skia_color(paint: &usvg::Paint) -> tiny_skia::Color {
    match paint {
        usvg::Paint::Color(color) => {
            tiny_skia::Color::from_rgba8(color.red, color.green, color.blue, 255)
        }
        // A gradient or pattern still puts ink down; the colour is not what this
        // asserts, so any opaque stand-in is honest here.
        _ => tiny_skia::Color::from_rgba8(255, 255, 255, 255),
    }
}

fn to_skia_path(path: &usvg::tiny_skia_path::Path) -> Option<tiny_skia::Path> {
    let mut builder = tiny_skia::PathBuilder::new();
    for segment in path.segments() {
        match segment {
            usvg::tiny_skia_path::PathSegment::MoveTo(p) => builder.move_to(p.x, p.y),
            usvg::tiny_skia_path::PathSegment::LineTo(p) => builder.line_to(p.x, p.y),
            usvg::tiny_skia_path::PathSegment::QuadTo(a, b) => builder.quad_to(a.x, a.y, b.x, b.y),
            usvg::tiny_skia_path::PathSegment::CubicTo(a, b, c) => {
                builder.cubic_to(a.x, a.y, b.x, b.y, c.x, c.y)
            }
            usvg::tiny_skia_path::PathSegment::Close => builder.close(),
        }
    }
    builder.finish()
}

/// One parsed tree per drawable element in the icon.
///
/// Built by re-parsing the icon with a single child kept each time, which is
/// simpler and more honest than trying to isolate a subtree after the fact:
/// each result is exactly what usvg would make of that shape in context.
fn single_shape_trees(markup: &str) -> Vec<usvg::Tree> {
    let open = markup.find('>').map(|at| at + 1).unwrap_or(0);
    let close = markup.rfind("</svg>").unwrap_or(markup.len());
    let (head, body) = (&markup[..open], &markup[open..close]);

    let mut trees = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find('<') {
        // Elements here are either self-closing or a simple open/close pair;
        // the artwork carries no nesting.
        let after = &rest[start..];
        let end = match after.find("/>") {
            Some(at) => at + 2,
            None => match after.find('>') {
                Some(at) => {
                    let tag_end = after[1..]
                        .find(|c: char| !c.is_ascii_alphanumeric())
                        .unwrap_or(0)
                        + 1;
                    let closing = format!("</{}>", &after[1..tag_end]);
                    after
                        .find(&closing)
                        .map(|at| at + closing.len())
                        .unwrap_or(at + 1)
                }
                None => break,
            },
        };
        let element = &after[..end];
        let one = format!("{head}{element}</svg>");
        if let Ok(tree) = usvg::Tree::from_data(one.as_bytes(), &usvg::Options::default()) {
            trees.push(tree);
        }
        rest = &after[end..];
    }
    trees
}

/// The app's darkest surface, which icons are drawn on top of.
///
/// Taken from the panel background rather than pure black: the point is that
/// artwork has to be distinguishable from the thing behind it, and black-on-
/// near-black is the failure this measures.
const SURFACE: (u8, u8, u8) = (30, 33, 36);

/// Whether a painted pixel would actually be seen against the app's surface.
///
/// Relative luminance, not channel distance. Distance alone called black ink
/// on a near-black surface "visible", because `#000000` is 99 away from
/// `#1e2124` in Manhattan terms while being the one case this exists to catch:
/// five icons filled pure black and the owner saw empty squares. What separates
/// ink from background here is brightness, and the surface is dark, so ink has
/// to be *lighter* than it by a margin a person would notice.
fn contrasts_with_surface(pixel: &tiny_skia::PremultipliedColorU8) -> bool {
    let demultiply = |value: u8| -> f32 {
        let alpha = pixel.alpha() as f32;
        if alpha == 0.0 {
            0.0
        } else {
            (value as f32) * 255.0 / alpha
        }
    };
    // Rec. 601 weights: cheap, and matched to perceived brightness rather than
    // raw channel values.
    let luminance = |r: f32, g: f32, b: f32| 0.299 * r + 0.587 * g + 0.114 * b;
    let ink = luminance(
        demultiply(pixel.red()),
        demultiply(pixel.green()),
        demultiply(pixel.blue()),
    );
    let background = luminance(SURFACE.0 as f32, SURFACE.1 as f32, SURFACE.2 as f32);
    (ink - background) > 40.0
}

/// Every icon puts real, visible pixels on a real bitmap.
///
/// This is the assertion the rest of the suite cannot make. Parsing proves the
/// geometry survived usvg; it does not prove anything was drawn, and both icon
/// outages lived in that gap. Here the icon is rendered at 64px and the lit
/// pixels are counted, so "the icon works" means the same thing it means to
/// someone looking at the window.
///
/// The floor is deliberately low. A comma-sized mark like the ellipsis dot is a
/// few dozen pixels at this scale, and the failure being guarded against is
/// *zero*, not "fewer than it should be".
#[test]
fn every_icon_rasterises_to_visible_pixels() {
    const SIZE: u32 = 64;
    const FLOOR: usize = 12;

    let icons = icon_artwork();
    let mut failures = Vec::new();

    for (name, art) in &icons {
        let markup = format!("<svg {ROOT_ATTRS}>{art}</svg>");
        let tree = usvg::Tree::from_data(markup.as_bytes(), &usvg::Options::default())
            .unwrap_or_else(|error| panic!("{name} did not parse: {error}"));
        /*
         * Each shape on its own bitmap, not the icon as a whole.
         *
         * A whole-icon count hides a partly broken icon: the five that filled
         * black also carry stroked paths, so the strokes alone cleared the
         * floor and the invisible dots passed unnoticed. Every shape the icon
         * declares is meant to be seen, so every shape is measured.
         */
        for (index, shape) in single_shape_trees(&markup).into_iter().enumerate() {
            let pixmap = rasterise(&shape, SIZE);
            let lit = pixmap
                .pixels()
                .iter()
                .filter(|pixel| pixel.alpha() > 32 && contrasts_with_surface(pixel))
                .count();
            if lit < FLOOR {
                failures.push(format!("{name} shape {index}: {lit} visible pixels"));
            }
        }

        let pixmap = rasterise(&tree, SIZE);

        /*
         * Opaque *and* not the surface colour.
         *
         * Alpha alone is not enough. The `fill="currentColor"` bug painted five
         * icons pure black on a near-black surface: every one of those pixels
         * is fully opaque and completely invisible, so a count of lit pixels
         * passed while the owner looked at empty squares. What has to be true
         * is that the ink *contrasts* with what it sits on, which is what a
         * person means by "the icon is displaying".
         */
        let lit = pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() > 32 && contrasts_with_surface(pixel))
            .count();
        if lit < FLOOR {
            failures.push(format!("{name}: {lit} visible pixels"));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} icons render blank or nearly blank at {SIZE}px: {failures:#?}",
        failures.len(),
        icons.len()
    );
}
