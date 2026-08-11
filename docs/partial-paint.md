# Partial paint: prior art, and how to introduce damage

Written 2026-08-11, from a read of `blitz-paint`, `anyrender`, the vello backends, and the
vello / vello_cpu / vello_hybrid sources in the cargo registry. Nothing here was measured
on this date. The numbers quoted come from [performance.md](performance.md), taken
2026-08-10; every claim about *other* projects is recollection rather than a read of their
source, and is marked where it matters. The claims about this stack are reads, with file
and line.

This is a design note, not a plan of record. Stage 0 exists precisely because the plan
should not be committed to before the measurement it depends on.

## Why this document exists

An animation on one element costs a whole frame. Nothing in this stack can update a single
component, and the reason is not where people reach for it first: it is not layout, and it
is not selector matching.

"Damage-region redraw is the real answer" is already recorded under **What is still open**
in [performance.md](performance.md). This document is what that would mean concretely.

## The stack, top to bottom, for one frame of az-gui

| Layer | Crate | Incremental? |
|---|---|---|
| JS engine | `blitz-script` (Boa) | n/a |
| Retained DOM, frame orchestration | `blitz-dom` `resolve()` | yes |
| Style, selector matching, CSS animations | Stylo (`style`, from Servo) | yes, damage and restyle hints |
| Box layout | Taffy via `stylo_taffy` | yes, per-node caches |
| Text shaping | Parley / Fontique / Skrifa | cached |
| **Scene emit** | **`blitz-paint`** | **no** |
| **Renderer boundary** | **`anyrender`** | **no, by API shape** |
| **GPU backend and present** | **`anyrender_vello` -> vello -> wgpu -> Metal** | **no** |
| Frame loop, redraw cadence | `blitz-shell` | n/a, decides when |
| Windowing, events | winit | n/a |
| Tauri runtime shim | `tauri-runtime-blitz` | n/a |

Three consecutive layers own the whole-window property:

- **`blitz-paint`** is where it starts. `render.rs:113` walks from the root element and
  emits every visible node into a fresh scene. It culls to the viewport, so it is
  whole-*visible-tree* rather than whole-document, but nothing is keyed on what changed.
- **`anyrender`** is where it becomes structural. The trait is
  `fn render<F: FnOnce(&mut Self::ScenePainter<'_>)>(&mut self, draw_fn: F)`
  (`lib.rs:152`). A closure that paints a scene, with no rect, no region list, no way to
  say "this part is unchanged". Even if `blitz-paint` knew what was dirty it could not
  say so across this boundary. This is the layer that has to change first.
- **`anyrender_vello`** finishes it. `window_renderer.rs:423` calls `render_to_texture`
  with the whole scene, `maybe_blit_and_present()` swaps the whole surface, and
  `self.scene.reset()` throws the scene away so the next frame rebuilds from nothing.

`blitz-shell` does no whole-window work itself; it decides how often the above runs
(`window.rs:565` `redraw()`, and the `is_animating` to `request_redraw` bit at line 614).

That split is what the measurements show. Stylo and Taffy are already incremental, which
is why `resolve` is 0.37 ms while `renderer` is 6.55 ms, 76% of frame work. The layers
doing whole-window work are the ones that got expensive.

WebRender is not in this stack, despite being the reference design cited throughout this
document. Blitz borrows Servo's *style* engine (Stylo) and none of its renderer; the
renderer is Linebender's Vello on wgpu, chosen deliberately in
[blitz-performance-architecture.md](blitz-performance-architecture.md).

## Where blitz-paint actually stands

5,700 lines that walk the DOM and push commands into a sink. The structure is better than
"full repaint" implies:

- The sink is a trait, not a type: `PaintScene` in `ps-anyrender/crates/anyrender/src/lib.rs`.
  Backends are swappable and already are (vello, vello_cpu, vello_hybrid, skia).
- **There is already a recording type.** `anyrender::Scene`
  (`ps-anyrender/crates/anyrender/src/recording.rs`) is a `Vec<RenderCommand>` that
  implements `PaintScene`, plus `append_scene(scene, transform)` which replays a recording
  into any other sink with a transform applied. Fragment caching has a data structure and
  a replay path already built.
- **It is already used for exactly this.** `CustomWidgetSceneMap = HashMap<(usize, usize), Scene>`
  in `ps-blitz-render/packages/blitz-paint/src/lib.rs:31`: custom widgets paint once into a
  recorded Scene and get replayed. The precedent for cached fragments is in the file.
- **Culling is per-element and already hierarchical.**
  `ps-blitz-render/packages/blitz-paint/src/render.rs:311` computes `screen_bbox` from
  `overflow.union(border_box)` and returns early if it misses `clip_rect`, and `clip_rect`
  is narrowed by every ancestor scrollport. Adding a second rect to that test is a handful
  of lines.

So blitz-paint is not missing the machinery. It is missing an *input*: nobody tells it
what changed. `blitz-dom` computes damage every frame and then throws it away at
`ps-blitz-render/packages/blitz-dom/src/resolve.rs:124`, in a loop that already visits
every node.

Two gaps below it are real:

- No backend overrides `append_scene`, so replaying a cached fragment into vello
  re-encodes command by command. vello's own `Scene::append`
  (`vello-0.9.0/src/scene.rs:464`) appends encoding buffers with a transform, which is far
  cheaper. That override is a small, isolated win sitting unclaimed.
- `vello::RenderParams` carries `width`, `height`, `base_color`, `antialiasing_method`. No
  damage rect. vello 0.9 cannot be asked to render part of a target.

## Prior art, ranked by how much it transfers

**WebRender (Rust, Gecko and Servo) is the best design in existence for this problem.**
Display list into picture cache slices, slices into tiles, tiles retained as GPU textures
keyed by their dependencies (transforms, images, clips). A frame rebuilds the display list
cheaply and only re-rasterizes tiles whose dependency set changed; everything else is
composited, and compositing a cached tile is close to free. This is the answer for content
shaped like a document, which is our content. Adopting it wholesale is not an option: it
is coupled to Gecko/Servo's display list, it is enormous, and
[blitz-performance-architecture.md](blitz-performance-architecture.md) chose Vello
deliberately. Read it as the reference design. Its central bet is the opposite of the
"cache the scene emit" instinct: **it rebuilds the display list every frame and caches the
rasterization**, which is where our 6.55 ms lives too.

**Chromium's cc** carries the most useful single lesson for decorative animation:
transform and opacity animations run on the compositor over already-rasterized layers and
never repaint. That is why an animated `transform` in a browser is nearly free and an
animated `background-position` is not. Blitz has no compositor and no such property split,
which is why the composer ring drift costs a full frame. If we ever want cheap always-on
decoration, "restrict it to compositable properties" is the browser's answer and it does
not exist here yet.

**Masonry (Linebender) is the most directly transferable, because it is the same
renderer.** It keeps a per-widget vello scene fragment and re-composes with
`Scene::append`, repainting only widgets that asked to be repainted. Proof that fragment
caching works against vello 0.9's encoding-append rather than being theoretically nice.
Small, readable, same crate stack we already build.

**Slint** has the cleanest small implementation of damage-region redraw: its software
renderer tracks dirty regions between frames, handles buffer age so it knows how stale
each swapchain buffer is, and redraws only the dirty area. One compact codebase showing
the whole partial-paint contract including the traps. Slint is already cited in the
architecture doc for compact runtime data, so this is not a new reference.

**vello_cpu 0.0.9 already has the primitive.** Its `region` module
(`vello_cpu-0.0.9/src/region.rs`) is documented as "rendering to a sub-region of a larger
buffer", splitting a buffer into tile-aligned regions. The sparse-strip architecture that
vello_cpu and vello_hybrid share is structurally friendlier to partial rendering than
vello 0.9's compute pipeline, because strips are per-tile by construction.

Not better, for completeness: egui repaints fully (its tessellation cache is a fragment
cache at a coarser grain), iced repaints fully on wgpu, Freya/Skia has dirty areas but
Skia's model buys less than WebRender's tiles. None are worth mining.

## Correction to record against performance.md

[performance.md](performance.md) says the `hybrid-renderer` feature is "a wash today":
vello is renderer 6.55 / scene 1.67, hybrid is renderer 2.41 / scene 7.29, so frame total
is roughly the same and neither wins.

That is true **under full repaint only**, and it stops being true the moment damage
exists. In `ps-blitz-render/packages/blitz-shell/src/window.rs:565`, `paint_time` is
measured around the `paint_scene` closure and `renderer_time` is everything else, so
hybrid's 7.29 ms "scene" is CPU strip generation happening inside the `PaintScene` calls.
**That cost is proportional to the content emitted.** Culling the emit to a damage rect
reduces it proportionally, with no backend change at all. vello's 6.55 ms is GPU fine
rasterization over the whole target, which culling the emit does not reduce; that one
needs the retained-texture route in stage 3.

The two backends respond to damage completely differently, and the cheap half of the work
pays out immediately on hybrid and barely at all on vello. The line to carry forward is
"a wash under full repaint, and hybrid is the better target if partial paint is the
direction", not "a wash".

## The staged design

Each stage is independently shippable, measurable, and revertible. The first is worth
doing even if the rest is abandoned.

### Stage 0: split the 6.55 ms before designing against it

`ps-anyrender/crates/anyrender_vello/src/window_renderer.rs:430` already has a
`debug_timer` behind `log_frame_times` printing `cmd` / `render` / `present` / `poll`.
Turn it on and get the split.

- If most of it is `present` blocking on vsync, damage rendering buys much less than the
  headline suggests and `BLITZ_PRESENT_MODE=mailbox` matters more.
- If it is `render`, the stages below are pointed at the right thing.

performance.md's own trap list is emphatic about not reasoning from an unattributed
aggregate, and that applies to its own headline number.

Two cheap changes belong before or alongside this measurement, both from
[allocations.md](allocations.md), because each moves the baseline the stages below are
judged against:

- `log-phase-times` is enabled on `blitz-dom` from the base dependency line, so per-frame
  phase instrumentation is compiled into the shipping app: a `HashMap` op per
  `compute_child_layout`, a sort per frame, and a `format!` plus locked `stdout` write per
  frame into a descriptor a bundle discards. Moving it onto `blitz-inspector` is one line.
- There is no custom global allocator anywhere in the stack, while `blitz-paint` produces
  thousands of small short-lived allocations per frame. Trying mimalloc is also one line.

Neither depends on any decision in this document, and either could absorb enough of the
frame cost to change what the stages below are worth.

### Stage 1: accumulate damage, change nothing else

`blitz-dom` already visits every node each frame to clear damage
(`resolve.rs:124`). Union a paint-space rect into a small damage list in the same pass and
expose `take_paint_damage()`. Merge overlapping rects, cap the list at about 8, and fall
back to full-window when the cap is hit or coverage exceeds roughly half the viewport.
Cost is arithmetic inside a loop already paid for.

Ship it behind a flag that only **logs**. That answers empirically: what does one
keystroke damage? What does the composer ring drift damage? What does a streaming token
damage? Those numbers decide whether stages 2 to 4 are worth anything, and today nobody
knows them. Same move that made the typing cost legible.

One hard requirement: the rect must be **ink bounds, not layout bounds**. Outlines, box
shadows, blur, filters and transforms all paint outside the border box. The existing cull
at `render.rs:307` uses `overflow.union(border_box)`, which is not ink bounds, so it
cannot be reused as-is. Under-reporting damage produces stale pixels on screen, which no
test catches and which reads as "the app is buggy" rather than "the damage rect is wrong".
Be conservative, inflate on anything uncertain, and land the full-window fallback in the
first commit.

### Stage 2: cull the emit to damage

Intersect the damage rect into `clip_rect` at `render.rs:173` and add one early return to
the per-element test. Roughly twenty lines. On hybrid this cuts the dominant cost
immediately. On vello it cuts the 1.67 ms scene phase and leaves the GPU cost alone.

Cull on ink bounds, not `screen_bbox`, or an element whose shadow bleeds into the damage
rect gets skipped while its shadow should have been repainted.

### Stage 3: render damage-sized, keep a retained target

Where the vello GPU cost falls, and there is a head start:
`ps-anyrender/crates/wgpu_context/src/surface_renderer.rs` already supports an
intermediate texture created once, resized on resize, rendered into, then blitted to the
surface by `maybe_blit_and_present()` at line 305. It exists for alpha and format
conversion, but it is exactly the retained frame buffer damage rendering needs, and the
blit-then-present plumbing is written and working.

1. Add `fn render_damaged(&mut self, damage: &[Rect], draw_fn)` to `WindowRenderer`, with
   a default body that ignores `damage` and calls `render`. No backend breaks, no flag day.
2. In the vello backend, render the damage rect into a correctly sized target with a
   translated transform, `copy_texture_to_texture` into the retained intermediate, then
   blit and present as today.
3. Snap damage rects out to tile multiples so antialiasing never straddles a boundary and
   produces seams.

Rendering into a smaller target rather than clipping inside a full-size one is deliberate:
`RenderParams.base_color` clears, and vello's fine stage writes every tile of its target,
so a clipped full-size render would erase the retained content it is trying to preserve.
Two extra GPU copies, both trivial next to a compute pipeline.

wgpu exposes neither buffer age nor incremental present, and Metal has no partial present,
so the retained texture is not a shortcut around a proper API. It is the only route on
this platform.

### Stage 4: cached fragments, only if 1 to 3 do not close the gap

Per-subtree `anyrender::Scene` recordings keyed by node id, invalidated by the same damage
from stage 1, replayed via `append_scene`. Do the `append_scene` override in
`anyrender_vello` first (native `Scene::append` instead of command-by-command replay),
because it is small, isolated, and makes every later fragment cheap. Cache candidates are
subtrees that are large, stable and clip-free: the transcript, not the composer.

Last on purpose. It is the instinctive fix, it attacks the smaller number, and WebRender's
whole design says the rasterization is what deserves caching.

**This stage trades CPU churn for resident memory, and that trade is currently unpriced.**
`blitz-paint` builds and drops a fresh `BezPath` per element per frame, which is what
caching removes; but a `RenderCommand` owns a `BezPath` per fill and stroke, and
`GlyphRunCommand` clones `FontData`, calls `normalized_coords.to_vec()` and collects glyphs
into a `Vec`. Caching the transcript's fragments keeps all of that resident. performance.md
reports 819 MB RSS on a fresh instance and 3.9 GB on a long-running one, unexplained. Do
not add a retaining cache on top of an unattributed number: attribute it first, per
[allocations.md](allocations.md).

## Traps, named in advance

- **Z-order.** Repainting a rect means replaying everything intersecting it in order, not
  just the damaged node. Stage 2 is a cull, never a "paint only these nodes".
- **Backdrop filters and non-normal blend modes** read what is behind them. Damage under
  one must expand to that layer's full bounds.
  [theme.css](../apps/gui/frontend/src/styles/theme.css) has both.
- **Scroll** dirties an entire scrollport. Treat it as full-window from the start; the
  tile-translation trick browsers use is a much later stage.
- **The instrument perturbs the thing.** Damage tracking that reports small damage while
  something paints outside it is worse than no damage tracking, because the app looks
  broken in a way the metrics call healthy. The full-window fallback and a debug mode that
  draws the damage rect as an overlay belong in the same commit as the tracking.

## Related

- [performance.md](performance.md) for the measurements this rests on, and the open items
  it belongs to.
- [blitz-performance-architecture.md](blitz-performance-architecture.md) for the "retain
  DOM state and incrementally reuse rendered work" decision, which is this document's
  parent.
- [allocations.md](allocations.md) for what allocates per frame and what retains, the two
  one-line changes that belong before stage 0, and the memory constraint on stage 4.
- [driving-the-app.md](driving-the-app.md) for how to run the diagnostics build that
  stage 0 needs.

## Addendum, 2026-08-12: Genet has the IR this document assumes

From [genet-review.md](genet-review.md). Source reading, not measurement.

Every stage above needs something to attach damage to, and this document has been quiet
about what that is because today there is nothing: `View::redraw` calls
`blitz-paint::paint_scene`, which walks the DOM and writes into a vello `Scene` in one
pass. There is no intermediate value, so "cull the emit to damage" (stage 2) means
threading damage through a tree walk rather than filtering a list.

Genet, on the same renderer family, has the intermediate value. `genet-layout` emits a
`GenetPaintList` through `paint_list_api`, and `paint_list_render` lowers `PaintCmd` into
a netrender scene. Both of those crates live in a **separate repository** from the engine,
deliberately, so the contract stays engine-neutral, and the contract is GPU-free.

Why that belongs in this document rather than only in the concurrency one:

- **Stage 1 becomes a diff instead of a bookkeeping exercise.** Damage accumulated as
  flags on nodes has to be kept correct against every mutation path, which is the trap
  named at the top of "Traps, named in advance". A paint list can be compared against last
  frame's, which is WebRender's bet, recorded above as the design worth reading.
- **Stage 2 becomes a filter over a `Vec`**, which is testable without a window.
- **Stage 0 gets cheaper to measure**, because a paint list can be counted, sized and
  diffed off-GPU, where today the only instrument is `layers_by_site` on the frame line.

It is also not a new decision.
[blitz-performance-architecture.md](blitz-performance-architecture.md), "Stage rendering
and carry change metadata forward", already says to "extract only visible, paint-dirty
nodes into renderer-owned frame data". Genet is that decision implemented by someone else
on our stack. The novelty is only the evidence that it is buildable here.

**What this does not settle:** whether the IR should be a flat command list, WebRender's
tiled picture cache, or GPUI's quads. That question is still open above, and a paint list
is compatible with all three. It should be sequenced before stage 1 rather than treated as
an alternative to it.
