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
  (`ps-blitz/packages/blitz-dom/src/document.rs:213`). Node ids are indices, not
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

Grepped across `agencyzero`, `ps-blitz`, `ps-anyrender` and `tauri-runtime-blitz`:
no `#[global_allocator]`, no mimalloc, no jemalloc. All of the churn above goes through
macOS system malloc, which is the least favourable allocator for that exact pattern.

That makes the cheapest experiment in this area a one-line change: set mimalloc as the
global allocator, run `blitz-bench scroll` and `blitz-bench type` before and after, keep it
or drop it. No design, no architecture, and it does not depend on any decision in
[partial-paint.md](partial-paint.md). Worth doing before caching a single path, because if
it lands most of the win then path caching buys the difference rather than the whole
figure.

## Instrumentation is compiled into the shipping build — FIXED 2026-08-11

> **This section describes a defect that has since been fixed.** `log-phase-times` now
> sits on the `blitz-inspector` feature (`apps/gui/Cargo.toml:53`) and the base `blitz-dom`
> dependency line carries only `system-fonts, parallel-construct`. The call site is
> `#[cfg]`-gated, so the code is not compiled rather than compiled and cheap. Kept because
> consequence 2 below still governs how to read every number taken before that date.

[apps/gui/Cargo.toml](../apps/gui/Cargo.toml) enables `log-phase-times` on `blitz-dom` on
the base dependency line, and
[release.yml](../.github/workflows/release.yml) builds with `--features blitz-runtime`. So
per-frame phase instrumentation is in the distributed app.

That feature gates `layout_counters`
(`ps-blitz/packages/blitz-dom/src/layout/mod.rs:29`), whose doc comment says
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
attributed, not before. **Still true, and more so**: the 2026-08-25 reading below puts the
footprint at 2.4G with 1.3G of live small allocations, so anything that adds retention is
being added on top of a problem that is getting worse, not better.

## Order of work, if this is the thread being pulled

**Status as of 2026-08-25.** Steps 1 and 3 are done; the order is kept because the
reasoning still reads correctly, with each line marked.

1. ~~Move `log-phase-times` onto `blitz-inspector`.~~ **Done 2026-08-11**,
   `apps/gui/Cargo.toml:53`. The base `blitz-dom` line carries only `system-fonts,
   parallel-construct`, so the ship build no longer pays for counters it cannot display.
2. Try mimalloc as the global allocator. **Not started, and re-scoped down** by the
   measurement below: still one line, still worth measuring, but aimed at churn rather
   than at footprint.
3. ~~Attribute the RSS with `vmmap` and `heap`.~~ **Done twice**, 2026-08-11 and
   2026-08-25. The answer both times is `MALLOC_SMALL`: many small live allocations, not
   the GPU pool.
4. Only then consider caching paths or scene fragments. Still correct, and note that
   [TODO.md](TODO.md) re-scoped path caching after measuring that clipped *area*, not path
   count, is the frame cost.

## Measured, 2026-08-25: 2.4G, and `MALLOC_SMALL` is 1.3G of it

`vmmap -summary` on the running System instance, az-gui 0.8.30, ~7.5h uptime. Read-only,
so it did not disturb the process.

| Region | Resident | Dirty |
|---|---|---|
| `MALLOC_SMALL` | **1.3G** | 1.1G, plus 407.5M swapped |
| `owned unmapped (graphics)` | 458.5M | 458.5M |
| `MALLOC_LARGE` | 86.9M | 86.9M |
| `IOSurface` | 56.4M | 56.4M |
| `MALLOC_LARGE (empty)` | 28.6M | 28.6M |

Physical footprint is **2.4G**, against the 855MB recorded on 0.5.25. This re-ranks the
candidate list above:

- **vello's `ResourcePool` is not the leading term**, which the 2026-08-11 reading already
  said. It is a weaker acquittal than recorded, though: that reading put "everything
  GPU-side" at 67M because `owned unmapped (graphics)` was not counted. The real GPU-side
  total is ~533M, so the pool deserves a second look once the small-allocation work lands.
- **Per-attribute `String`s are the leading hypothesis**, and they are exactly the shape
  `MALLOC_SMALL` holds: small, live, one per attribute per element, never shared.
  `node/attributes.rs:11` is a plain owned `String`, `:16` a plain `Vec<Attribute>`.
  Verified still true in ps-blitz at `0.3.0-beta.7`.
- **The mimalloc experiment loses most of its justification.** It was scoped against 78M
  of empty-but-resident malloc regions; that is 28.6M now, against 1.3G of *live* small
  allocations. A different allocator redistributes live objects rather than freeing them.

Caveat on the comparison: 7.5h of uptime here against a fresh instance on 0.5.25, so some
of the growth is session retention rather than a per-build regression. Same-build fresh
versus aged is the measurement that separates them, and it has not been taken.

## Related

- [performance.md](performance.md) for the measurements, and the memory item this is
  attached to.
- [partial-paint.md](partial-paint.md) for the layer split this document assumes, and for
  the fragment-caching stage constrained above.
