# Allocations: what is pooled, what thrashes, and what retains

Written 2026-08-11, from a read of `blitz-paint`, `blitz-dom`, `anyrender`, the vello
backends, and the vello / vello_encoding sources in the cargo registry. **Nothing here was
measured.** Every claim is a read of code, with file and line, and every number quoted
comes from [performance.md](performance.md), taken 2026-08-10. Where something is a
candidate rather than a finding it says so.

The question this answers: is the render path constantly churning memory, or is it doing
something smart with pools? The answer is both, split cleanly at the paint boundary
described in [partial-paint.md](partial-paint.md).

## The pooled half, below blitz-paint

This is well built, and it is not accidental. Nobody needs to write a memory pool here;
two already exist.

- **vello's encoding buffers are an arena.** `Scene::reset()` calls `Encoding::reset()`,
  which is `.clear()` on six `Vec`s (`vello_encoding-0.9.0/src/encoding.rs:78`). Capacity
  is retained, so after a handful of frames the CPU-side encode stops allocating
  altogether. The `self.scene.reset()` at the end of
  `ps-anyrender/crates/anyrender_vello/src/window_renderer.rs` is commented "memory
  optimisation", and that is exactly what it is.
- **GPU buffers are pooled with size classes.** `ResourcePool`
  (`vello-0.9.0/src/wgpu_engine.rs:122`) is a `HashMap<BufferProperties, Vec<Buffer>>`.
  `get_buf` rounds a request up to a power-of-two size class and pops a recycled buffer
  before creating one; buffers return to the pool after each recording. No per-frame
  `create_buffer`.
- **The DOM is a slab arena.** `nodes: Box<Slab<Node>>`
  (`ps-blitz-render/packages/blitz-dom/src/document.rs:213`). Node ids are indices, not
  boxes.
- **Glyphs stream.** `draw_glyphs` takes `impl Iterator<Item = Glyph>` and the vello
  painter consumes it in place. No `Vec` per glyph run on the hot path. The recording
  `Scene` does collect, which matters below.
- **The intermediate texture is created once** and reallocated only on resize.
- **Styles are refcounts.** `element_cx` does `(*styles).clone()` on a
  `ServoArc<ComputedValues>` (`blitz-paint/src/render.rs:511`): an atomic increment, not a
  deep copy.

## The thrashing half, blitz-paint itself

Every element, every frame, builds fresh `BezPath`s and drops them.

- `border_box_path()` is unconditional (`render.rs:354`, the default clip).
  `padding_box_path()` and `content_box_path()` when the element clips. Then `outline()`,
  `shadow_clip()`, per-edge `border_edge_shape()`, and the clip-path shape. Each is a
  `BezPath::new()` plus pushes, so each is a `Vec<PathEl>` allocation. Roughly 25
  path-producing sites across `render.rs`, `render/border.rs`, `render/background.rs`,
  `render/clip_path.rs` and `kurbo_css/css_box.rs`.
- They are pure temporaries: built from `final_layout`, encoded into vello, dropped, then
  rebuilt identically next frame from identical layout, for every visible element, at
  refresh rate.
- The code already knows. `render.rs:518`: "todo: maybe cache this so we don't need to
  constantly be figuring it out ... Also! we can cache the bezpaths themselves, saving us
  a bunch of work."

The shape matters more than the volume. Each allocation is **small**, a rounded rect being
a handful of `PathEl`s, so the cost is the *count*, not the bytes: thousands of small,
short-lived, single-threaded, LIFO-ish allocations per frame.

### There is no custom global allocator

Grepped across `agencyzero`, `ps-blitz-render`, `ps-anyrender` and `tauri-runtime-blitz`:
no `#[global_allocator]`, no mimalloc, no jemalloc. All of the churn above goes through
macOS system malloc, which is the least favourable allocator for that exact pattern.

That makes the cheapest experiment in this area a one-line change: set mimalloc as the
global allocator, run `blitz-bench scroll` and `blitz-bench type` before and after, keep it
or drop it. No design, no architecture, and it does not depend on any decision in
[partial-paint.md](partial-paint.md). Worth doing before caching a single path, because if
it lands most of the win then path caching buys the difference rather than the whole
figure.

## Instrumentation is compiled into the shipping build

[apps/gui/Cargo.toml](../apps/gui/Cargo.toml) enables `log-phase-times` on `blitz-dom` on
the base dependency line, and
[release.yml](../.github/workflows/release.yml) builds with `--features blitz-runtime`. So
per-frame phase instrumentation is in the distributed app.

That feature gates `layout_counters`
(`ps-blitz-render/packages/blitz-dom/src/layout/mod.rs:29`), whose doc comment says
"Thread-local and read once per resolve, so the counting itself is free". It is not free:

- `note_computed` does a `HashMap` entry lookup and increment **per `compute_child_layout`
  call**. performance.md measured 16,842 of those per keystroke, serving a diagnostic a
  bundled app cannot display.
- Every frame, `worst_offenders(6)` allocates a `Vec` of every distinct node touched and
  sorts it.
- Every frame, `resolve.rs:194` builds a summary `String` with `format!`, and
  `print_times` takes `stdout().lock()` and issues a dozen `write!` calls. A
  Finder-launched bundle discards stdout, so this formats and writes to a discarded
  descriptor at refresh rate.

This is the class of bug [performance.md](performance.md) already caught and fixed once,
for `script_stats`: "the instrument was a measurable share of the measurement and inflated
every absolute it reported". Second instance, different module, still live, and this one
ships.

Two consequences:

1. The fix is one line: move `log-phase-times` off the base dependency onto the
   `blitz-inspector` feature, where `blitz-hybrid` and the bench already live.
2. Every number in performance.md was measured with this enabled, so it sits **inside**
   the current baseline rather than on top of it. Re-measuring after the fix moves the
   baseline, and the comparison to state is before-and-after on the same build, not
   against the recorded table.

Unmeasured, and possibly small next to 18 ms of taffy. But it is unambiguously non-zero
work in the ship build, for output the ship build discards.

## Retention: the 819 MB and 3.9 GB question

performance.md lists under **What is still open**: 819 MB RSS on a fresh stable instance
with a 4,899 node tree, 3.9 GB on a long-running Experimental one, unexplained.

Per-frame churn does not explain it. Churn is allocate-and-free; it costs CPU time, not
resident memory. What retains:

- **vello's `ResourcePool` never shrinks.** Buffers return to the pool and stay there. The
  peak frame permanently sets the floor, and on Apple unified memory those buffers are in
  RSS. One expensive frame, such as Settings mounting a thousand controls, raises the
  floor for the life of the process.
- **Retained tabs.** `display: none` keeps every tab ever opened alive with its styles,
  taffy caches and parley `inline_layout_data`. Deliberate, and documented in
  performance.md, but it means memory grows monotonically with tabs visited.
- **Boa's JS heap**, and the WorkTable store on the Rust side.

That is a candidate list, not attribution, and guessing here is how a week disappears.

### How to attribute it, without a rebuild

- `vmmap <pid>` separates Metal and IOAccelerator regions from MALLOC zones, which
  immediately answers GPU-pool versus CPU-heap.
- `heap <pid>` breaks the malloc side down by class.
- For per-frame allocation *counts*, a counting `#[global_allocator]` shim behind a
  feature would settle the `BezPath` question with a number rather than an argument.

The first two are read-only and need no build. Note that the only long-running instance is
usually the System one, and the working agreement forbids touching its process, so run
them yourself or start a Dev instance for the purpose.

## What this constrains elsewhere

Stage 4 of [partial-paint.md](partial-paint.md), cached scene fragments, trades per-frame
path churn for retained memory, and the recording format is not cheap: `RenderCommand`
owns a `BezPath` per fill and stroke, and `GlyphRunCommand` clones `FontData`, calls
`normalized_coords.to_vec()` and collects glyphs into a `Vec`
(`ps-anyrender/crates/anyrender/src/recording.rs`). Caching the transcript's fragments
keeps all of that resident.

With an unexplained 819 MB baseline, that trade should be made after the memory is
attributed, not before.

## Order of work, if this is the thread being pulled

1. Move `log-phase-times` onto `blitz-inspector`. One line, removes work from the ship
   build, and cleans the baseline everything else is measured against.
2. Try mimalloc as the global allocator. One line, measure with `blitz-bench`, keep or
   drop.
3. Attribute the RSS with `vmmap` and `heap` before adding anything that retains.
4. Only then consider caching paths or scene fragments, with 1 and 2 already banked so the
   measurement attributes the win correctly.

## Related

- [performance.md](performance.md) for the measurements, and the memory item this is
  attached to.
- [partial-paint.md](partial-paint.md) for the layer split this document assumes, and for
  the fragment-caching stage constrained above.
