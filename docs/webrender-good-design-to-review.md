# WebRender design elements worth reviewing, side by side with ours

Written 2026-08-11. WebRender references are pinned to commit
[`e1c924e`](https://github.com/servo/webrender/tree/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a)
on `servo/webrender`, fetched and read that day, so every line number below is stable.
References to our code are local reads. **Nothing here was measured or built.**

Companion to [why-not-webrender.md](why-not-webrender.md), which explains why adopting
WebRender is off the table (OpenGL only, and a re-platform rather than a port). This
document is the opposite exercise: the specific code worth reading, what it does better,
and what we would change here.

**One finding corrects why-not-webrender.md.** Section 5 shows that the "CSS-shaped
display list collapses ~2,600 lines of bezier lowering" claim was wrong. The measurement
is there; that doc has been corrected.

## 1. Picture caching and tile damage

### Theirs

The design is documented in the module header, and it is worth reading in full:
[picture.rs#L41-L60](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L41-L60).

> Each tile keeps track of the elements that affect it, which can be: primitives, clips,
> image keys, opacity bindings, transforms. These dependency lists are built each frame
> and compared to the previous frame to see if the tile changed.

| Piece | Location |
|---|---|
| `Tile` | [picture.rs#L773](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L773) |
| `local_dirty_rect`, `device_dirty_rect` | [#L781](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L781), [#L785](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L785) |
| `world_valid_rect`, `device_valid_rect` | [#L787](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L787), [#L789](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L789) |
| `is_valid` | [#L800](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L800) |
| `InvalidationReason` (why a tile died) | [#L745](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L745) |
| `PrimitiveDependency` enum | [#L351](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L351) |
| `TileDescriptor` (the comparable dependency set) | [#L1419](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L1419) |
| `TileCacheInstance` | [#L1761](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L1761) |
| `TileNode` quadtree, `TileNodeKind` | [#L7240](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L7240), [#L7208](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L7208) |
| `TileNode::update_dirty_rects` (quadtree walk) | [#L7553](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L7553) |
| `Tile::update_dirty_rects` and `update_content_validity` | [#L863](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L863), [#L897](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L897) |

Three things stand out beyond "they have damage rects":

1. **Damage is derived by comparison, not by trusting invalidation flags.** Each tile's
   dependency list is rebuilt every frame and diffed against last frame's. A missed
   invalidation cannot produce a stale tile, because nothing relies on the mutation site
   having remembered to mark anything.
2. **Dependencies include opacity bindings and transforms**, not just geometry. An
   animated opacity is a *dependency value*, so tiles that reference it invalidate and
   tiles that do not are untouched.
3. **The dirty rect comes out of a quadtree**, so one changed primitive in a corner of a
   large tile yields a small rect rather than the whole tile.

Tiles are fixed size, 2048x512 for content and 128x128 for the UI slice, and slices are
capped (currently 8) with a squash-to-one fallback when a display list exceeds it
([#L30-L40](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L30-L40),
[#L61-L70](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/picture.rs#L61-L70)).

### Ours

Nothing equivalent. `blitz-dom` computes per-node `RestyleDamage`, then discards it every
frame in `resolve.rs:124`, and `blitz-paint/src/render.rs:113` repaints every visible node
into a fresh scene.

### What to adopt

[partial-paint.md](partial-paint.md) stage 1 proposes accumulating damage **from the
restyle flags**. WebRender's model says that is the more fragile of the two designs, and
its own trap list agrees: under-reported damage produces stale pixels no test catches.
Their approach removes the failure mode by construction.

Two concrete amendments to stage 1 worth considering:

- Record an **invalidation reason** per damage rect from the first commit. `InvalidationReason`
  exists because "why did this repaint" is otherwise unanswerable, and we will ask it.
- Treat **opacity and transform as dependency values** rather than as damage triggers, so a
  compositable animation can eventually skip repaint entirely. This is also the missing
  piece behind the composer ring drift costing a full frame.

The quadtree is a later refinement. The fixed-size-tile decision is not, because it
determines whether damage is expressed in tiles or in free rectangles, and that choice is
hard to reverse.

## 2. Spatial tree and scroll frames

### Theirs

| Piece | Location |
|---|---|
| `SpatialTree` | [spatial_tree.rs#L648](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/spatial_tree.rs#L648) |
| `set_scroll_offsets` | [#L1150](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/spatial_tree.rs#L1150) |
| `update_tree` | [#L1166](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/spatial_tree.rs#L1166) |
| `CoordinateSystemId` and why ids are shared | [#L23-L30](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/spatial_tree.rs#L23-L30) |

Scroll offsets are properties of spatial nodes, updated per frame without rebuilding the
display list. Content inside a scroll frame keeps its rasterization; only the transform
that positions it changes. `CoordinateSystemId` is shared across nodes in the same
axis-aligned space specifically so mask generation can be skipped, which is the kind of
optimisation only a spatial tree makes expressible.

### Ours

`blitz-dom/src/document.rs:1750` `scroll_node_by` mutates the scroll offset, and
`is_animating` at `document.rs:1661` includes `scroll_animation`, so a scroll drives full
frames. `blitz-paint` narrows `clip_rect` per scrollport
(`blitz-paint/src/render.rs:341`) and culls what falls outside, which is real and useful,
but every visible node is still re-emitted every frame.

### What to adopt

This is why [partial-paint.md](partial-paint.md) stage 1 has to declare scroll
full-window: without a spatial concept, a scroll is indistinguishable from everything
moving. The upgrade path is to make scroll offset a property applied at composite time
rather than an input to emit. That is a bigger change than damage tracking and should
follow it, but the ordering is worth writing down now, because a damage design that bakes
in "scroll invalidates everything" is harder to lift later.

## 3. Compositor surfaces and partial present

### Theirs

| Piece | Location |
|---|---|
| `Compositor` trait | [composite.rs#L1152](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L1152) |
| `create_surface` | [#L1154](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L1154) |
| `CompositorKind` | [#L357](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L357) |
| `partial_present` capability hook | [#L295-L305](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L295-L305), [#L327](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L327) |
| `CompositeState` | [#L534](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L534) |
| CoreAnimation-specific handling | [#L843](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L843) |

The important shape: **partial present is modelled as an optional capability with a
full-present default** ([#L341](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/composite.rs#L341)),
not as a mode the whole renderer is built around. `CompositorKind` also carries a
"draw previous regions when doing partial present" flag for platforms where the front
buffer content is not preserved.

### Ours

`anyrender`'s `WindowRenderer::render` takes a draw closure and nothing else
(`ps-anyrender/crates/anyrender/src/lib.rs:152`), and `anyrender_vello` renders and
presents the whole surface (`window_renderer.rs:423`).

### What to adopt

This validates [partial-paint.md](partial-paint.md) stage 3's proposed signature: add
`render_damaged(damage, draw_fn)` with a default body that ignores the damage and calls
`render`. That is the same optional-capability-with-safe-default shape WebRender arrived
at, which is reassuring for a design nobody here has built before.

Worth stealing directly: the **"redraw previous regions" flag**. Our stage 3 keeps a
retained intermediate texture, so we are in the preserved-content case, but the flag is
the seam that makes the design portable to a platform that is not.

## 4. Glyph rasterization

### Theirs

[`wr_glyph_rasterizer/src/platform/macos/font.rs`](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/wr_glyph_rasterizer/src/platform/macos/font.rs),
913 lines, all of it about matching what macOS actually does:

- `determine_font_smoothing_mode` [#L75](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/wr_glyph_rasterizer/src/platform/macos/font.rs#L75),
  with the reasoning at [#L58-L74](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/wr_glyph_rasterizer/src/platform/macos/font.rs#L58-L74):
  newer macOS versions deprecate subpixel AA and the prefs are murky, so WebRender
  **renders a probe glyph at startup** and inspects the subpixels to discover which of
  three modes the OS is actually in.
- A `GammaLut` [#L26](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/wr_glyph_rasterizer/src/platform/macos/font.rs#L26)
  for contrast and gamma correction matching CoreGraphics.
- A `CTFont` cache keyed by `(FontKey, FontSize, Vec<FontVariation>)`
  [#L38](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/wr_glyph_rasterizer/src/platform/macos/font.rs#L38).

### Ours

We render glyph outlines through vello, and approximate Apple's appearance with a
compile-time flag: `FONT_EMBOLDEN_ENABLED` in `blitz-paint/src/lib.rs:22`, applied at
`blitz-paint/src/text.rs:116`, with hinting switched off when it is on
(`text.rs:126`, `hint: !FONT_EMBOLDEN_ENABLED`).

That is a hand-rolled emulation, decided at compile time, of a thing WebRender determines
by asking the running OS.

### What to adopt

[blitz-performance-architecture.md](blitz-performance-architecture.md) makes
browser-quality text a **correctness requirement**, not a performance goal, and requires
validation against the WebKit reference. Against that standard a compile-time embolden
constant is the weakest link in the text stack.

Two options, in increasing order of cost:

1. Keep vello outline rendering and replace the constant with a **runtime probe** in the
   spirit of `determine_font_smoothing_mode`, so the emulation at least tracks the OS.
2. Rasterize glyphs through CoreText into an atlas, matching native exactly, and give up
   vello's resolution-independent outline rendering for text.

Option 2 is what a browser does and what the stated requirement implies. Option 1 is
cheap and strictly better than today. Neither is verifiable through the inspector's
screenshot route, which returns byte-identical PNGs across different builds, so both need
[ui-verification.md](ui-verification.md) plus the owner looking.

## 5. CSS-shaped primitives, and a correction

### Theirs

The display list vocabulary is CSS-shaped rather than path-shaped
([display_item.rs](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs)):

| Item | Line |
|---|---|
| `RectangleDisplayItem` | [#L358](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L358) |
| `TextDisplayItem` | [#L422](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L422) |
| `BorderDisplayItem` | [#L554](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L554) |
| `BoxShadowDisplayItem` | [#L624](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L624) |
| `GradientDisplayItem` | [#L675](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L675) |
| `RadialGradientDisplayItem`, `ConicGradientDisplayItem` | [#L741](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L741), [#L753](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L753) |
| `RectClipDisplayItem`, `RoundedRectClipDisplayItem` | [#L261](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L261), [#L268](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L268) |
| `ClipChainItem` | [#L735](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L735) |

### The correction

[why-not-webrender.md](why-not-webrender.md) claimed roughly 2,600 lines of bezier
lowering here "exist because the sink only understands paths" and could collapse against
a CSS-shaped display list. **That was wrong, and measuring both sides shows the opposite.**

| Feature | WebRender | Ours |
|---|---|---|
| Borders | `border.rs` 1,478 + `prim_store/borders.rs` 385 = **1,863 lines** | `render/border.rs` **641 lines** |
| Box shadow | `box_shadow.rs` **583 lines** plus render-task blur plumbing | `render/box_shadow.rs` **146 lines** |
| Gradients | `prim_store/gradient/` **~78 KB** across conic, linear, radial, mod | `gradient.rs` **520 lines** |

Two of those three were never bezier lowering at all:

- Our `box_shadow.rs` calls `scene.draw_box_shadow(...)` at `render/box_shadow.rs:77` and
  `:134`. `anyrender` already has a **native blurred-rounded-rect command**, so the sink
  is not path-only.
- Our `gradient.rs` converts CSS gradients into **native `peniko::Gradient` brushes**
  (`gradient.rs:138`, `:169`), not paths.

Genuine path lowering is `kurbo_css/css_box.rs` (847) and `render/border.rs` (641), about
1,490 lines, and WebRender's border code is larger than ours, not smaller. The complexity
does not disappear with a CSS-shaped item; it moves into the renderer as segmentation,
interning, render tasks and dedicated shaders.

### What is actually worth taking

Not the display list shape. Two mechanisms underneath it:

- **Interning and caching of expensive primitives.** `BoxShadowKey`
  ([box_shadow.rs#L25](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/box_shadow.rs#L25))
  keys a shadow by its parameters, and the blurred result is produced by a two-pass
  separable blur render task
  ([#L138-L159](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender/src/box_shadow.rs#L138-L159))
  that identical shadows share. Our theme applies the same few shadows to many elements,
  and we recompute each one every frame.
- **Segmentation**, so an opaque interior does not go through the blended path. This is a
  renderer-side idea that composes with damage rather than competing with it.

## Ranked: what to do with this

1. **Dependency-comparison damage rather than flag-trusted damage** (section 1). Changes
   the design of partial-paint.md stage 1 before it is built, and removes its worst
   failure mode.
2. **`render_damaged` with a full-present default** (section 3). Already the plan; this is
   independent confirmation, plus the redraw-previous-regions flag.
3. **A runtime font-smoothing probe** to replace the compile-time embolden constant
   (section 4). Small, and the current constant is the weakest link against a stated
   correctness requirement.
4. **Intern and cache blurred shadows** (section 5). Self-contained, no dependency on the
   damage work.
5. **Scroll as a spatial property** (section 2). Largest, and correctly last, but the
   damage design should not foreclose it.

## Related

- [why-not-webrender.md](why-not-webrender.md) for why none of this arrives as a
  dependency, and for the licensing constraint on copying rather than reimplementing.
- [partial-paint.md](partial-paint.md) for the staged plan sections 1 and 3 amend.
- [blitz-performance-architecture.md](blitz-performance-architecture.md) for the text
  correctness requirement section 4 is tested against.
