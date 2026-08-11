# GPUI and zng: what we should learn

Written 2026-08-11. Their references are pinned to
zed [`6634c94`](https://github.com/zed-industries/zed/tree/6634c945d3af826e6466d6da3eee0782c62b5a8d)
and zng [`af30332`](https://github.com/zng-ui/zng/tree/af30332fc3cb1405b9e49c06574835bf04b0fbec),
read that day, so the line numbers are stable. Ours are local reads. **Nothing here was
measured or built.**

Neither project has a DOM, CSS or Stylo, so neither is a candidate to swap to. They are
worth reading because they made **opposite bets on the same problem we have**, and one of
them lands squarely on our largest measured cost: the renderer at 6.55 ms, 76% of frame
work ([performance.md](performance.md)), because in our stack everything is a path.

- **GPUI** deleted the general path rasterizer for the common case and drew UI with eight
  specialized primitives.
- **zng** kept a general renderer (WebRender) and moved it into a separate process.

## 1. Primitives instead of paths

### Theirs

| Piece | Location |
|---|---|
| `Primitive` enum, eight variants, `Path` is one of them | [scene.rs:222](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/scene.rs#L222) |
| `Quad`: bounds, background, border_color, **corner_radii, border_widths** | [scene.rs:535](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/scene.rs#L535) |
| `Shadow`: corner_radii plus element_corner_radii | [scene.rs:574](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/scene.rs#L574) |
| `Underline` | [scene.rs:555](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/scene.rs#L555) |
| `MonochromeSprite` (glyphs), `PolychromeSprite` (images, emoji) | [scene.rs:711](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/scene.rs#L711), [:749](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/scene.rs#L749) |
| `quad_sdf`, the rounded-rect distance function | [shaders.metal:1063](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui_macos/src/shaders.metal#L1063) |
| `quad_fragment`, one shader for fill plus border plus radius | [shaders.metal:100](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui_macos/src/shaders.metal#L100) |
| Shadow as a **closed-form** Gaussian, no blur pass or render target | [shaders.metal:538](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui_macos/src/shaders.metal#L538) |
| The same design in WGSL, not Metal-locked | `crates/gpui_wgpu/src/shaders.wgsl`, 51 KB |

`Quad` is `#[repr(C)]`, so a rounded rectangle with a border is one struct uploaded to an
instance buffer and resolved analytically in a fragment shader. No tessellation, no path
encoding, no allocation.

### Ours

| Piece | Location |
|---|---|
| `PaintScene`: fill, stroke, glyphs, layers. Geometry is always `&impl Shape` | `ps-anyrender/crates/anyrender/src/lib.rs:185` (fill at `:221`, stroke at `:211`) |
| Border box path, rebuilt per element per frame | `ps-blitz-render/packages/blitz-paint/src/kurbo_css/css_box.rs:213` |
| Padding and content box paths | `css_box.rs:220`, `:227` |
| Per-edge border geometry, built as separate `BezPath`s | `css_box.rs:98`, called seven times in `render/border.rs:269-312` |
| Outline, shadow clip | `css_box.rs:199`, `:290` |
| The unconditional clip path, every element, every frame | `blitz-paint/src/render.rs:354` |
| The standing TODO: "we can cache the bezpaths themselves" | `blitz-paint/src/render.rs:518` |

A GPUI quad is a struct. Ours is `css_box.rs` plus `render/border.rs`, about 1,490 lines,
producing fresh `Vec<PathEl>` allocations for every element on every frame
([allocations.md](allocations.md)).

### The fact that makes this actionable

**Vello already has exactly one specialized non-path primitive**, and we already use it:

- `vello::Scene::draw_blurred_rounded_rect` at `vello-0.9.0/src/scene.rs:256`, encoding at
  `:301` via `encode_blurred_rounded_rect`.
- `anyrender`'s `draw_box_shadow` (`lib.rs:248`) maps straight onto it in the vello backend
  at `ps-anyrender/crates/anyrender_vello/src/scene.rs:175-185`.

So our box shadows are **already** GPUI-shaped: a parameterized primitive resolved
analytically on the GPU, not a blurred path. The pattern is proven in our exact stack. What
GPUI shows is that the same treatment applies to the far more common case, the plain
rounded rect with a border.

### The honest constraint

This is not a drop-in. Vello owns its pipeline: you cannot register a fragment shader with
it the way GPUI does with its own renderer. Adding a `Quad` primitive means either

1. extending vello's encoding with a rounded-rect-plus-border primitive, exactly as
   `encode_blurred_rounded_rect` was added, which means carrying a vello fork we do not
   have today (we fork `anyrender`, not vello); or
2. drawing quads in a separate wgpu pass outside vello and compositing, which reintroduces
   the z-order problem section 2 solves; or
3. not changing the renderer at all, and just caching the paths, which is the TODO already
   sitting at `render.rs:518`.

Option 3 is the cheap one and removes the allocation churn without touching the GPU cost.
Option 1 is the one that attacks the 6.55 ms. They are not exclusive, and option 3 is the
sane first move.

## 2. Batch by type, order by spatial index

### Theirs

| Piece | Location |
|---|---|
| `PrimitiveBatch`, batched by primitive **type**, not tree order | [scene.rs:477](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/scene.rs#L477) |
| `BoundsTree`, an R-tree assigning `DrawOrder` by intersecting bounds | [bounds_tree.rs](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/bounds_tree.rs) |

The R-tree is the enabling trick. Painter's order normally forces you to submit in tree
order; computing a `DrawOrder` per primitive from what it actually overlaps lets all quads
go in one batch and all glyphs in another, while still landing in the right order.

### Ours

`blitz-paint` emits in tree order into a single linear vello scene
(`blitz-paint/src/render.rs:113` walks from the root element). There is nothing to batch
because there is one primitive type.

**Relevance:** only if option 1 or 2 above is ever taken. Recorded here because a
half-built version of this (quads in a separate pass, no ordering solution) is the obvious
wrong turn, and this is the shape of the right answer.

## 3. `dirty_views` instead of damage regions

### Theirs

| Piece | Location |
|---|---|
| `dirty: bool`, `dirty_views: FxHashSet<EntityId>` | [window.rs:121-123](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/window.rs#L121) |
| `FrameDirtyAccumulator`, records when the frame first became dirty | [window.rs:125](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/window.rs#L125) |
| `invalidate_view(entity)`, wakes the platform only on the dirty transition | [window.rs:158](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/src/window.rs#L158) |

GPUI has **no damage regions at all**. It knows which views are dirty, redraws the whole
window when any are, and skips the frame entirely when none are. It made a full redraw
cheap instead of making redraw partial.

### Ours

`is_animating` drives an unconditional next-frame request
(`ps-blitz-render/packages/blitz-shell/src/window.rs:614`), the damage clear walks every
node each frame (`blitz-dom/src/resolve.rs:124`), and
[partial-paint.md](partial-paint.md) proposes building damage regions.

**This is a genuine challenge to that plan.** GPUI is a text-heavy editor with large
windows and it does not need damage tracking, because its frame is cheap enough not to
care. Our frame is expensive because of section 1. That ordering is worth taking seriously:
**fix what a frame costs before building machinery to draw fewer of them.** It does not
invalidate partial-paint.md, but stage 0 there should include "what would a frame cost if
quads were not paths" as a comparison point.

## 4. Renderer in a separate process

### Theirs

| Piece | Location |
|---|---|
| "Zng isolates all render and windowing related code to a different process" | [zng-view-api/src/lib.rs:6](https://github.com/zng-ui/zng/blob/af30332fc3cb1405b9e49c06574835bf04b0fbec/crates/zng-view-api/src/lib.rs#L6) |
| Respawn is a first-class init argument (`is_respawn`) | [lib.rs:277](https://github.com/zng-ui/zng/blob/af30332fc3cb1405b9e49c06574835bf04b0fbec/crates/zng-view-api/src/lib.rs#L277) |
| Mutual liveness watchdog, both sides monitor message frequency | [lib.rs:669](https://github.com/zng-ui/zng/blob/af30332fc3cb1405b9e49c06574835bf04b0fbec/crates/zng-view-api/src/lib.rs#L669) |

A GPU driver fault, a wgpu panic or a wedged renderer takes the view process, not the app.

### Ours

We already run a sidecar for the agent (`apps/gui/src/agent_proxy.rs`, spawn logic around
`:367-394`), so the pattern and its plumbing exist here. The renderer is in-process.
[xpc-sidecar.md](xpc-sidecar.md) is the design that was never built out.

**What to take:** zng is a working implementation of that design, and the two pieces worth
copying are the ones a first attempt omits: respawn as an explicit init state, and a
bidirectional liveness check so a hung renderer is detected rather than waited on.

## 5. A display-list IR is the right boundary, and we already have one

zng's app process builds its own `DisplayList` and ships it over IPC; the view process
translates that into WebRender in
[display_list.rs:16](https://github.com/zng-ui/zng/blob/af30332fc3cb1405b9e49c06574835bf04b0fbec/crates/zng-view/src/display_list.rs#L16),
**1,291 lines total**.

We have the same thing already: `anyrender::recording::Scene` is a `Vec<RenderCommand>`
(`ps-anyrender/crates/anyrender/src/recording.rs:14`) that implements `PaintScene` and
replays into any backend. The difference is vocabulary, not structure: **their IR is
primitive-shaped and ours is path-shaped.** Adding a `Quad` command to `RenderCommand` is
the same move as section 1, expressed in the layer we already own.

Two consequences worth recording:

- **This corrects a number in [why-not-webrender.md](why-not-webrender.md).** That document
  sized a WebRender integration from Servo at roughly 7,000 lines. zng does it in 1,291,
  because it translates from an IR rather than lowering from a box tree. The correction is
  noted there.
- **The conclusion survives on better grounds.** WebRender's display list has no path or
  polygon fill item at all: arbitrary shapes exist only as `ImageMaskClip`
  ([display_item.rs:253](https://github.com/servo/webrender/blob/e1c924ebad9ffdfe8c8c606aba77eb3f888c396a/webrender_api/src/display_item.rs#L253))
  or blob images. A path-shaped IR like ours cannot be translated to WebRender without
  rasterizing paths to masks first. That is a technical blocker, not a cost estimate.

## What we should not do

Swap to either. GPUI is a Rust widget toolkit and zng is a Rust widget framework. Neither
has a DOM, CSS or Stylo, and our frontend is HTML and SolidJS while chuzz is a browser.
Adopting either means discarding the thing that makes both projects work.

Also worth recording: GPUI pins `taffy = "=0.12.2"`
([Cargo.toml:95](https://github.com/zed-industries/zed/blob/6634c945d3af826e6466d6da3eee0782c62b5a8d/crates/gpui/Cargo.toml#L95))
and both our lockfiles resolve taffy to **0.12.2**. Same layout engine, same version, so
the taffy cache thrash in [performance.md](performance.md) is not an out-of-date-dependency
problem.

## Ranked

1. **Cache the bezier paths** (`render.rs:518`, the existing TODO). Cheap, removes the
   per-frame allocation churn from [allocations.md](allocations.md), needs no fork.
2. **Add `Quad` to `RenderCommand` and `PaintScene`** with a default that lowers to the
   current path calls, so no backend breaks. This is section 1 and section 5 in the layer
   we own, and it makes the next step possible without committing to it.
3. **Measure a frame with quads as primitives before building damage regions** (section 3).
   Belongs in partial-paint.md stage 0.
4. **Respawn and liveness in the sidecar design** (section 4), whenever xpc-sidecar.md is
   built out.
5. **Batch-by-type with a spatial index** (section 2), only if a native quad pass is ever
   built.

## Related

- [performance.md](performance.md) for the 6.55 ms this is aimed at.
- [partial-paint.md](partial-paint.md) for the plan section 3 challenges.
- [allocations.md](allocations.md) for the path churn section 1 removes.
- [why-not-webrender.md](why-not-webrender.md) for the estimate section 5 corrects.
- [webrender-good-design-to-review.md](webrender-good-design-to-review.md) for the same
  exercise against WebRender.
