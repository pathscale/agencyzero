# Allocations: what to measure, in what order, and what it said

> Tooling, repository wiring and what is in flight may be in an untracked
> `docs/HANDOVER.md` beside this file.

One workstream under
[Blitz performance architecture](blitz-performance-architecture.md), covering
allocation churn and resident memory. Sibling plans cover the other lines in
that document's tracked workstreams; nothing here speaks for them.

A working list, kept current as each step runs. It exists because the last
several performance efforts here reasoned from screenshots and plausible
mechanisms rather than from numbers, and that is expensive: a whole session went
into a text-spill theory that its own tests refuted, twice.

Two rules the order below encodes:

- **Nothing is optimised before it is measured.** A `TODO` in the source saying
  a thing should be cached is not a measurement.
- **Nothing is measured until the instrument is trustworthy.** See step 1: the
  phase counter is charged to the phase it measures, so it inflates precisely
  the number everyone has been reading.

The reading this plan tests is in [allocations.md](allocations.md), with the
damage-tracking half in [partial-paint.md](partial-paint.md). Neither was
measured; that is what the steps below are for.
Numbers in [performance.md](performance.md) predate both step 1 and the
node-leak fix in ps-blitz, so treat them as void rather than as a comparison.

Status key: `[ ]` not started, `[~]` in progress, `[x]` done, `[-]` dropped
(with the reason).

> **Read [step 10](#10-the-frame-rate-was-the-benchmarks-own-pacing) before any
> fps or `missed_refreshes` figure in this document.** `blitz-bench scroll`
> paced itself at 60Hz and said so nowhere, so every frame-rate number recorded
> below describes the harness. Unpaced, the app runs at 120fps with no missed
> refreshes. The millisecond phase timings are unaffected and still stand; the
> frame rates and the "missing a refresh" counts do not.

---

## 0. Make the measuring tool reliable — blocks everything below

`[x]` **`blitz-bench` connected to dead instances.** Fixed 2026-08-11.
Discovery warned that a descriptor named a pid that was not running, and then
connected to it anyway: a refused connection at best, and at worst a successful
attach to a stale socket describing a process nobody is looking at.

Discovery now walks the descriptor directory newest-first, reads each one and
returns the first whose pid is actually running. Only when none is live does it
fall back to the most recent, which is the case `warn_if_stale` already
described at the call site.

The override still works and still wins, for a build launched by hand:

```bash
TAURI_BLITZ_CONTROL_DESCRIPTOR=/Users/revenge/code/agencyzero/target/blitz-control.json
```

**Result:** the failure was real and immediate — the first `blitz-bench layout`
run of the day picked a descriptor naming pid 19991, printed a warning that it
was not running, and connected to it regardless, failing with a refused
connection while a live instance was open the whole time.

---

## 1. Take the phase instrumentation out of the shipping build

`[x]` **Done 2026-08-11.** `apps/gui/Cargo.toml:52` enabled `log-phase-times` on the
base `blitz-dom` dependency, and `.github/workflows/release.yml:150` builds
`--features blitz-runtime`, so it is compiled into the distributed app. Move it
onto `blitz-inspector`, where `blitz-hybrid` and the bench already live.

What it costs in a build that cannot display any of it:

- `note_computed` is a `HashMap` `entry()` lookup and increment per
  `compute_child_layout`. `performance.md` measured 16,842 of those per
  keystroke.
- `worst_offenders(6)` allocates a `Vec` of every distinct node touched and
  sorts it, every frame.
- `resolve.rs` builds a summary `String` with `format!` and `print_times` takes
  `stdout().lock()` for a dozen `write!` calls, every frame, to a descriptor a
  Finder-launched bundle discards.

This is first, ahead of anything cheaper, for a reason that is easy to miss:
`note_computed` is called from *inside* `compute_child_layout`, so its cost is
attributed to the layout phase. It does not inflate the total evenly. It
inflates the one phase that dominates every reading — layout was 71.6% of a
39ms median resolve in the 2026-08-11 trace — which makes the phase split
itself untrustworthy until this moves.

Verify it actually left, rather than assuming:

```bash
strings -a "target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui" | grep -c "Resolve("
```

Zero for a plain `blitz-runtime` build; non-zero for the inspector build.

**Result:** moved onto `blitz-inspector` as `blitz-dom/log-phase-times`, so the
bench and the hybrid pipeline still get it and a release build does not.

The `strings` check above turned out to be the weaker half of the evidence, and
worth recording as a caution: a bare `Resolve(` fragment survives in *both*
builds, so counting it alone would have read as a failed removal. The payload
is what moved.

| string | `blitz-runtime` (ships) | `blitz-inspector` |
| --- | --- | --- |
| `Resolve(` | 1 | 1 |
| ` distinct of ` | 0 | 1 |
| `layout hotspots` | 0 | 1 |

The proof is upstream of the binary anyway: the counter's call site is
`#[cfg(feature = "log-phase-times")]` at `blitz-dom/src/layout/mod.rs:142`, so
without the feature the call is not compiled, rather than compiled and cheap.

**Consequence for every number recorded before this date:** they were taken
with the counter charging to the layout phase. The 2026-08-11 trace read layout
at 71.6% of a 39ms median resolve. That split cannot be compared against
anything measured after this change; step 2 starts the baseline over.

---

## 2. Re-baseline typing and scrolling

`[ ]` With the instrument in the inspector build only, against a running
instance:

```bash
cargo run -q -p blitz-bench -- type 40
cargo run -q -p blitz-bench -- scroll
```

Record ms/keystroke and the phase split. **Then stop and read it.** This number
decides whether anything below is worth doing: if typing is still tens of
milliseconds per keystroke, that is the problem, and allocator or paint work is
a detour until it is understood.

Prior baseline, for shape only and not for comparison — it was taken with the
instrument on, before the node leak was fixed: 19.36ms/keystroke, 16.84ms in
`layout:flush_from_script`.

**Result, 0.5.25, 2026-08-11.** 40 keystrokes into a live composer:

| | per keystroke |
| --- | --- |
| `event:input` | **21.55ms** |
| of which `layout:flush_from_script` | **19.16ms** |
| `event:keydown` | 0.07ms |
| `dom:attr=` | 0.01ms |

**89% of a keystroke is one synchronous layout.** The composer autosizes by
reading `scrollHeight`, and every geometry read flushes layout so the answer
describes the mutations script has already made. So each character typed forces
a full resolve of the document before the keystroke can return.

Frame timings during the same run: `resolve` 32.63ms mean, `scene` 1.05ms,
`renderer` 2.00ms, 26.9 fps with 139 of 256 frames missing a refresh.

### Fixed, and re-measured on 0.5.26

A text input now answers `scrollHeight` from its own parley editor instead of
flushing. `TextInputData::set_text` re-applies the wrap width and refreshes that
layout as the text changes, so the editor's height is already current: resolving
the document could not change the answer, only charge for it.

| | 0.5.25 | 0.5.26 |
| --- | --- | --- |
| `event:input` | 21.55ms | **3.50ms** |
| of which `layout:flush_from_script` | 19.16ms | **absent from the profile** |
| frame `total` | 40.04ms | **10.05ms** |

6.2x on the keystroke, 4x on the frame, and the forced resolve is gone rather
than reduced.

**The composition inverted, and it settles step 6.** A full `frames` reading on
0.5.26:

| phase | 0.5.25 | 0.5.26 | share now |
| --- | --- | --- | --- |
| `resolve` | 37.56ms | **1.76ms** | 13% |
| `scene` | 0.76ms | **4.36ms** | **32%** |
| `renderer` | 1.72ms | **7.52ms** | **55%** |
| total | 40.04ms | **13.64ms** | |
| active fps | 24.7 | 38.2 | |
| missed refreshes | 136/239 | 18/256 | |

Resolve fell 21x and stopped being the problem. Paint did not get slower — the
same work is simply no longer hidden behind a cost three times its size, and
frames that used to be dropped now present. It is 32% of the frame.

So the deferral was right and the argument for it has been paid off inside the
hour: judging paint as 1.9% of a frame that was 93.8% resolve measured the
wrong ratio, exactly as the owner said. **Step 6 is now the second-largest item
in the frame**, behind the renderer.

Two cautions on this table. The two readings cover different activity, so the
means are not strictly like-for-like. And `residentBytes` fell 855MB to 671MB
across it, which is mostly a freshly launched process rather than a saving:
step 3 has to be re-taken on an instance with comparable history before that
number means anything.

---

## 3. Split the memory question before theorising about it

`[ ]` Read-only, no rebuild, needs a running 0.5.24 or later:

```bash
vmmap $(pgrep -x az-gui) | tail -40
heap $(pgrep -x az-gui) | head -40
```

`vmmap` separates Metal / IOAccelerator regions from MALLOC zones, which
answers GPU-pool versus CPU-heap in one shot. `heap` breaks the malloc side
down by class.

Run it on 0.5.24 or later specifically. Every memory figure taken before
2026-08-11 includes an unbounded node leak — box construction orphaned its
anonymous blocks on every rebuild, +11 nodes per resolve, never freed, 14 nodes
to 22,353 in a single session — which is now fixed and which no candidate list
written before then accounts for.

Candidates, in the order they are worth ruling out:

- vello's `ResourcePool` never shrinks, so the most expensive frame the app ever
  drew permanently sets the memory floor.
- Retained tabs keep every tab ever opened alive, with its styles, taffy caches
  and parley layout. Deliberate and documented; means memory grows with tabs
  visited.
- Boa's JS heap, and the WorkTable store.

**Result, 0.5.25, 2026-08-11.** 855MB resident. `vmmap -summary`, by region:

| region | resident | dirty |
| --- | --- | --- |
| `MALLOC_SMALL` | **552.1M** | 507.6M |
| `MALLOC_LARGE` | 48.8M | 48.8M |
| `MALLOC_LARGE (empty)` | 47.8M | 47.8M |
| `MALLOC_SMALL (empty)` | 30.2M | 30.2M |
| `IOSurface` | 56.4M | 56.4M |
| `IOAccelerator (graphics)` | 10.9M | 10.9M |
| `MALLOC metadata` | 4.0M | 4.0M |

**The CPU heap is the answer, not the GPU pool.** Everything GPU-side —
`IOSurface` plus `IOAccelerator` — is 67MB of 855MB. The candidate this list
led with, vello's `ResourcePool` never shrinking and sitting in RSS on unified
memory, is ruled out as the main cause: it cannot account for more than a
twelfth of the figure.

`MALLOC_SMALL` at 552M resident and 507M dirty is where the mass is: many small
live allocations, which is what the remaining candidates predict — retained
tabs holding styles, taffy caches and parley layout, plus Boa's heap and the
WorkTable store. Splitting those needs `heap` by class, not `vmmap`.

One number does bear on step 4: **78M of *empty* malloc regions are still
resident** (`MALLOC_LARGE (empty)` 47.8M plus `MALLOC_SMALL (empty)` 30.2M).
That is the allocator holding pages it is no longer using, which is the one
place a different allocator has an obvious claim — on memory, not on speed.

---

## 4. mimalloc as the global allocator, as an A/B

`[~]` Re-scoped by steps 2, 3 and 5: this is now a **memory** experiment, not a
speed one. Paint is 1.9% of a frame and typing is 89% synchronous layout, so an
allocator cannot move the frame numbers much. But 78M of empty-but-resident
malloc regions is a direct claim on the 855MB.

There is no `#[global_allocator]` in `agencyzero`, `ps-blitz`,
`ps-anyrender` or `tauri-runtime-blitz`, so every allocation goes through macOS
system malloc — the least favourable allocator for thousands of small,
short-lived, single-threaded, LIFO-ish allocations per frame, which is exactly
the shape `blitz-paint` produces.

One line, then re-run step 2 and compare. Keep it or drop it on the numbers. No
design and no agreement about damage tracking required, which is what makes it
worth trying early — but after steps 1 and 2, or the comparison is taken
through a distorting lens.

**Result:**

---

## 5. Read the paint number that already exists

`[x]` **Checked 2026-08-11, and the premise was wrong.** Paint is measured
already, unconditionally, and has been all along.

The seven phases in the resolve timer are indeed all pre-paint, which is what
made it look unmeasured. But `blitz-shell/src/frame_stats.rs` records every
presented frame's `resolve`, `paint_scene` and renderer cost, publishes them
process-globally, and says in its own header why recording is unconditional:
gating the shared data would leave a normally launched app reporting nothing,
"which is what pushed the previous consumer into inventing numbers".

It reaches the bench without any new code. `scene_ms` — "the `paint_scene` call
that turns the resolved document into renderer commands" — travels in
`RendererMetrics`, and `blitz-bench frames` prints mean, p95 and max for it
beside resolve and renderer:

```bash
cargo run -q -p blitz-bench -- frames
```

So the thesis in [allocations.md](allocations.md) is testable directly: build
paths churn inside `paint_scene`, so their cost is in `scene_ms`.

**Result, 0.5.25, 2026-08-11.** 239 presented frames, 120Hz display:

| phase | mean | p95 | max | share |
| --- | --- | --- | --- | --- |
| `resolve` | 37.56ms | 78.23 | 82.26 | **93.8%** |
| `scene` (all path churn) | **0.76ms** | 1.32 | 1.64 | **1.9%** |
| `renderer` | 1.72ms | 2.60 | 5.03 | 4.3% |
| total | 40.04ms | 80.99 | 85.16 | |

24.7 active fps, 136 of 239 frames missing a refresh.

**This retires the thesis as a performance priority.** Every `BezPath` built and
dropped by all ~25 sites, for every element, every frame, is inside that
0.76ms. Caching all of them perfectly wins under 2% of a frame. The reading in
[allocations.md](allocations.md) is accurate about the code and correct that the
churn is real; it is simply not where the time is. Resolve is.

**Worth keeping as a lesson:** this step was written as "add a timer", and the
timer already existed two crates away. Reading before building is cheaper than
either measuring or guessing.

---

## 6. Cache the paths, if and only if step 5 justifies it

`[~]` **Deferred, not dropped. Revisit 2026-08-11.** I marked this dropped on
step 5's measurement and the owner disagreed; the disagreement is recorded here
because it has a real case behind it.

The measurement: all the churn lives in `scene_ms`, 0.76ms of a 40.04ms frame,
so perfect caching of every site wins under 2% **of a frame shaped like this
one**. That last clause is the whole argument.

Why it may still matter:

- **The denominator is about to move.** 93.8% of that frame is resolve, and
  resolve is the thing being worked on. If resolve came down to single-digit
  milliseconds, 0.76ms stops being 1.9% and starts being a quarter of the
  frame. Judging paint against a frame dominated by a cost we intend to remove
  measures the wrong ratio.
- **0.76ms is a mean over one sample of activity.** Scene cost scales with the
  count of painted elements, so a dense scroll or a full Settings page is not
  the same measurement. `scene` p95 was 1.32 and max 1.64 in that window; a
  worse window has not been taken.
- **Allocation churn has effects that do not show up as frame time.** 78M of
  empty-but-resident malloc regions in step 3 is the allocator holding pages
  it was handed back, and thousands of small short-lived allocations a frame is
  exactly the pattern that produces that.

What would settle it, in order: finish the resolve work, re-take `frames`
during a heavy scroll rather than at rest, and only then judge 0.76ms against
whatever the frame has become.

Gated on that re-measurement, not on the source comment at `render.rs:518`.
`render.rs:518` already says "we can cache the bezpaths themselves,
saving us a bunch of work". Each allocation is small — a rounded rect is a
handful of `PathEl`s — so the cost is the count, not the bytes. Cache only the
sites paint shows to be hot.

**Result:**

---

## 7. Split the renderer figure — done, and it says the cost is work

`[x]` **Measured 2026-08-11.** After steps 1, 2 and 6, `renderer` was the
largest item in the frame at 5.03ms of 8.45ms under scroll, and it was one
opaque number: `render()` minus paint.

No new instrumentation was needed. `anyrender_vello`'s `render()` already
contains a `debug_timer!` splitting the phases, behind a `log_frame_times`
feature nothing enabled. Enabling it took one non-obvious step: the renderer
reaches the app through `tauri-runtime-blitz`, not through `ps-blitz-shell`, so
a feature added anywhere in the ps-blitz workspace is never consulted. Naming
`ps-anyrender-vello` directly in `apps/gui/Cargo.toml` under `blitz-inspector`
is what reaches the copy actually built, because cargo unifies features across
the graph. `cargo tree -e features -i ps-anyrender-vello` shows which.

263 frames under scroll:

| phase | mean | share |
| --- | --- | --- |
| `render` — `render_to_texture`, vello encode and GPU submit | **2.84ms** | **62.5%** |
| `cmd` — scene encode, i.e. `paint_scene` | 1.50ms | 33.1% |
| `present` — blit and present | 0.20ms | 4.4% |
| `poll` — non-blocking device poll | 0.00ms | 0.0% |

**The backpressure hypothesis is dead.** A 120Hz display at 52fps with most
frames missing a refresh looked like waiting on vsync; `present` is 4.4% of the
renderer figure. This is work.

The target is `render_to_texture`. That is inside vello rather than in this
codebase, so the lever here is scene complexity, not the submit path: how many
draw commands and, especially, how many clip layers the scene contains.
`LayerManager` already counts `layers_wanted` against a `LAYER_LIMIT`, so the
count is available. That is the next reading to take, and step 8 takes it.

---

## 8. Count the layers a scene pushes

`[~]` The one lever on `render_to_texture` that lives in this codebase. Each
clip or opacity layer is a push, a pop and a region the rasteriser composites
separately, so the count is the part of scene complexity most likely to explain
2.84ms of GPU-side work per frame.

The counter was half there and half broken. `LayerManager` incremented
`layers_wanted` and nothing ever read it, and the high-water depth was recorded
with `layer_depth.update(|x| x.max(layer_depth.get()))` — a value maxed against
itself — so the deepest nesting a scene reached was never stored at all.
`layer_depth_used` carried an `#[allow(unused)]` saying "only used for
debugging", which is how a line that could never work went unnoticed.

It now publishes per painted scene and rides the once-per-second
`[blitz-frame]` line as the worst scene of each sample window:

```
layers_wanted_max=… layers_used_max=… layer_depth_max=…
```

Not on the MCP surface, so `blitz-bench` cannot read it. That surface carries
timings only, and adding a field there means changing the protocol crate, the
runtime and the bench across two more repositories for one reading. The log
line already existed and already knew how to write to a file.

Reading it needs the file, because a Finder-launched bundle discards stderr.
`scripts/local-delivery.sh` pins `BLITZ_FRAME_STATS` and
`BLITZ_FRAME_STATS_FILE` into `LSEnvironment` beside the control descriptor, so
a `stable` build writes to `target/blitz-frame.log`. It appends, so delete it
before a run worth reading:

```bash
rm -f target/blitz-frame.log
```

Two things to read out of it, one of which is not about performance:

- **`wanted` above `used`** means the scene hit `LAYER_LIMIT` (1024) and layers
  were silently skipped. A skipped layer is a skipped clip, so content that
  should have been cut off at a scrollport edge was drawn whole. That would be
  a correctness bug hiding inside a performance counter.
- **`used` against `layer_depth_max`** separates two different costs: many
  shallow clips, versus deep nesting the rasteriser has to keep live at once.

What it cannot answer: draw commands. Layers are the countable part of scene
complexity today; fill and stroke counts are not tallied anywhere, and adding
that tally is only worth it if the layer count comes back small.

**Result, 0.5.31, 2026-08-11. 351 layers per scene, depth 8, and it never
moves.**

Fourteen consecutive sample windows, idle and through 120 wheel events, every
one of them:

```
layers_wanted_max=351 layers_used_max=351 layer_depth_max=8
```

Two things fall out of that before any timing.

`wanted == used`, so the limit is never reached and no clipping is being
silently skipped. The correctness worry this step was watching for is not
happening.

And the count does not move with content. A scroll that repaints an entirely
different part of the list pushes the same 351 layers, so this is structural
chrome, not the scrolled document. Whatever generates it is in the frame around
the content.

### The A/B: 44% of the frame

`LAYER_LIMIT` cut from 1024 to 8 makes a clean experiment, because a refused
layer does not change what is painted. `maybe_push_layer` returns false, the
matching pop is skipped, and `paint_layer` still runs: the scene emits the same
draw commands minus 342 push/pop pairs. Culling is done separately against
`clip_rect` in `render_element`, so nothing is being drawn less either.

Same bench, same build, same session:

| `blitz-bench scroll` | 351 layers | 9 layers |
| --- | --- | --- |
| `scene` | 2.35ms | **1.24ms** |
| `renderer` | 4.73ms | **2.65ms** |
| `total` | 8.08ms | **4.52ms** |
| active fps | 53.3 | 59.9 |

**Clip and opacity layers are 3.56ms of an 8.08ms frame.** They cost about
equally on both sides of the boundary: roughly half the scene encode and
roughly half the renderer. That is the ceiling on this lever, and it is the
largest single item found in this document since resolve.

It is a ceiling, not a target. Those layers are doing real work; the question
the next step has to answer is how many of them are load-bearing.

Caveat worth keeping: the limited build renders wrong, and obviously so —
nothing is clipped to its container. It is a measurement, never a build to
look at. It was launched in front of the owner without that warning, which
read as a broken app rather than as an experiment.

### What to read next

Which CSS produces 351. There are five call sites, and they are not equal:

- `render.rs:382` and `:424` — the element clip and the scrollport
- `render.rs:448` — per child
- `render/box_shadow.rs:47`
- `render/background.rs:146`

A per-site tally is a handful of counters and would say whether this is one
pattern repeated across the chrome, which could be fixed once, or genuinely
351 distinct clips. Do that before designing anything: a fix aimed at the
wrong site wins nothing, and the flatness of the count across scroll says the
answer is a small number of repeated structures.

---

## 9. Where the layers come from, and the correction it forced

`[x]` **Measured 2026-08-11.** Five sites go through `LayerManager`. Three more
push straight onto the scene and were invisible to step 8 entirely: inset
shadows, CSS masks and border clips are not subject to `LAYER_LIMIT` and appear
in neither `wanted` nor `used`. They are counted by hand now, so the per-site
sum is deliberately larger than `used` rather than a split of it.

At rest:

| site | count |
| --- | --- |
| `bg-image` | **314** |
| `overflow` | 36 |
| `inset-shadow` | 10 |
| `border` | 4 |
| `effect` | 1 |
| `clip-path`, `outset-shadow`, `mask` | 0 |

**314 of them draw nothing.** `background-image: none` is still one layer in
CSS, and every element has at least one, so `draw_background` looped over the
whole document pushing a clip layer and building a `BezPath` for a layer whose
draw call is an empty match arm. Skipping those takes the count 351 to 39.

Masks genuinely do have to push unconditionally, and say so at their call site:
compositing an empty layer with `intersect` clears the mask built so far.
Backgrounds composite source-over and have no such requirement.

### The correction: count was never the cost

Three points on the same bench, same scroll:

| layers | frame total |
| --- | --- |
| 351 | 8.08ms |
| 39 — the 312 empty background clips gone | **7.82ms** |
| 9 — about 30 more gone, via `LAYER_LIMIT` | 4.52ms |

Removing 312 layers bought 0.26ms. Removing the next 30 bought 3.30ms. That is
roughly **0.8us for a background clip and 110us for an overflow clip**, and it
says the lever is clipped area, not layer count.

Step 8 measured that clip layers are 44% of the frame, and that stands. What
does not stand is the reading anyone would naturally take from 351: that the
bulk of the count is the bulk of the cost. It is not. **The 36 overflow clips,
each covering a whole scrollport, are where the 3.3ms is.**

The background fix is kept regardless: 314 path allocations and 314 push/pop
pairs per frame for no visual effect, and it makes the remaining count mean
something, since what is left is layers that actually clip something.

**Next, and it is a different question than step 8 posed:** why a scrollport
clip costs ~110us, and whether 36 of them are all needed. Candidates worth
separating before any fix: whether vello is allocating an intermediate target
per clip rather than using a scissor rect for axis-aligned rectangles, and
whether nested scrollports are re-clipping regions their ancestors already
clipped. The first is a vello question, the second is ours.

One caveat on the arithmetic above: the 9-layer number was taken on the build
before the background fix, so the middle row and the last row come from
different binaries. Re-running `LAYER_LIMIT=8` on the current build would turn
that inference into a measurement.

**Re-run 2026-08-11, and the single-run numbers above were unreliable.** The
first `scroll` after a launch is cold and reads several milliseconds high;
repeated runs settle. Three runs each, on one binary:

| layers | frame total, repeated |
| --- | --- |
| 39 | 7.39, 7.40, 7.53 |
| 9 | 4.95, 4.85, 4.88 |

So the ~30 remaining clips are worth about **2.5ms**, not the 3.3ms inferred
across two binaries. The shape of the conclusion holds and the arithmetic in it
did not: take three runs, discard the first.

---

## 10. The frame rate was the benchmark's own pacing

`[x]` **Measured 2026-08-11.** Every fps figure in this document, back to the
24.7 in step 5, describes `blitz-bench`, not the application.

`scroll` sleeps `1.0 / 60.0` between wheel events
([`main.rs:58`](../crates/blitz-bench/src/main.rs:58)), so it asks for about 60
frames a second and gets about 53 once the sleep overhead counts. It printed
nothing about this, and `fps` and `missed_refreshes` were reported directly
underneath, so the numbers read as an application failing badly on a 120Hz
display.

`BENCH_PACE=0` removes the sleep. Same build, same scroll, three runs:

| | paced (default) | unpaced |
| --- | --- | --- |
| fps | 53.2 | **120.6, 120.8, 114.6** |
| missed refreshes | 234/256 | **0, 0, 2 of 256** |
| `interval` | 18.99ms | **8.28, 8.35, 8.35ms** |
| `resolve` | 0.92ms | 0.28ms |
| `scene` | 2.15ms | 1.28ms |
| `renderer` | 4.54ms | 6.71ms |
| `total` | 7.39ms | 8.24ms |

8.33ms is one refresh period at 120Hz. **The app runs at the display's full
rate and drops nothing.**

### What this retires, and what survives

Retired: "24.7 fps", "38.2 fps", "52.3 fps", "136 of 239 frames missing a
refresh", and every sentence in this document built on them. The application
was never missing those refreshes; it was being asked for frames 60 times a
second and delivering them.

Also retired, and it was mine: step 7 concluded "the backpressure hypothesis is
dead, this is work, not vsync." That was measured under pacing, where there is
no backpressure to find because the app is idle between events. Unpaced,
`renderer` *rises* from 4.54ms to 6.71ms while everything else falls, which is
exactly what waiting on a full swapchain looks like. The phase split inside
that figure was real work for that condition; the generalisation was not.

Surviving: every millisecond phase timing. `resolve`, `scene` and `renderer` are
measured per presented frame and do not care why the frame was requested. The
keystroke result, the node leak, the layer costs and the memory split all stand.

### What it changes about priorities

The budget is 8.33ms and unpaced `total` is 8.24ms, so the headroom is thin
rather than absent, and it is thin against 120Hz rather than 60. That makes the
2.5ms of clip cost in step 9 worth more, not less: it is the difference between
sitting at the edge of the budget and having a third of it spare.

But the honest statement of the problem changed. This was being worked as "the
app cannot keep up." It keeps up. The question is how much room is left when
the content is heavier than a scroll of the current view, and that is a
different experiment than any run so far.

**Instrument fixed rather than remembered.** `scroll` now prints its pace above
the numbers that pace governs, and names `BENCH_PACE=0`. A harness invisible in
its own output is precisely the distorting instrument the second rule at the
top of this document is about, and it went unnoticed for the length of a
workstream.

---

## 11. The Taffy measure cache, in ps-taffy

`[x]` **Measured 2026-08-11.** The one item on the list whose premise survived
every other fix today. `performance.md` measured 16,842 `compute_child_layout`
calls at a 52% hit rate on 2026-08-10, and the assumption was that it was
tangled up with the 18ms keystroke the `scrollHeight` fix removed. It was not:
the keystroke is now 3.3ms and the cache was still missing half its lookups on
the same order of calls.

**The instrument already existed and nobody had seen it.** `layout_counters`
prints `cache N/M hits P%` on every resolve, from
`blitz-dom/src/resolve.rs:196`. It goes to **stdout**, which a Finder-launched
bundle discards, and the frame log only captures the `[blitz-frame]` line.
Running the binary directly is what surfaces it. Third time today that the
timer being reached for already existed.

Both defects named in
[layout-caching-prior-art.md](layout-caching-prior-art.md) were real, and each
was worth about the same:

| typing one character | baseline | + validity | + slot fix | + size 16 |
| --- | --- | --- | --- | --- |
| `compute_child_layout` calls | 16,140 | 7,589 | 3,334 | **176** |
| cache lookups | 32,186 | 22,169 | 9,182 | **692** |
| distinct nodes touched | 160 | 134 | 127 | **17** |
| **layout phase** | **8.0ms** | 5.7ms | 2.6ms | **0.28ms** |

**28x on the layout phase**, and the third change was the largest of the three.
The 17 distinct nodes is the number to read: around 15 are genuinely dirty per
keystroke, so the cache now recomputes what changed and nothing else.

**Defect 2, lookup is equality rather than validity.** Yoga asks whether a
stored result is *still correct* rather than whether the question was
identical. `newSizeIsStricterAndStillValid` was named in that document as "our
miss pattern exactly", and it was: intrinsic sizing re-descends offering a
sequence of definite widths, and an answer measured under a wider offer still
holds when the content fit inside the narrower one.

**Defect 1, definite sizes collide in one slot.** `compute_cache_slot` mapped
each question to a fixed slot and documented the assumption that made it safe —
a node is generally sized under definite *or* max-content but not both.
Intrinsic sizing breaks exactly that, so with neither dimension known every
definite width landed in slot 5 and each measurement destroyed the one before
it. The cache was evicting the entries it was about to be asked for.

Correctness is carried by taffy's own suite: **5,541 generated layout tests
pass unchanged** across both changes. The only tests that moved are the two
hand-written ones asserting how often a leaf is measured, 7 to 6, which is the
quantity being optimised. They were updated to the new exact count rather than
loosened to an upper bound, because `<= 7` would stay green if the cache
silently got worse again.

Frame after both, under typing: resolve 1.61ms, scene 0.80ms, renderer 4.47ms,
total 6.87ms at 114fps. **The renderer is now 65% of the frame and layout is no
longer the largest item in the application.** That changes what is worth doing
next, and step 9's scrollport clips inherit the position.

**Defect 3, the cache was smaller than the working set.** Nine slots was one
per category under the fixed-slot scheme; once slots are plain storage it is a
working-set size, and nine is below ours. This was not in the prior-art
document and only showed up because the first two fixes made it visible.

It is a cliff rather than a curve, which is why it went unnoticed: 12 slots is
no better than 9, because below the working set the eviction thrashes either
way. 16 is just past the edge, 24 buys nothing further, and the cost is about
16MB of resident memory on a 6,331 node tree.

### Attempted and backed out: ignoring the parent size

Instrumented the rejection reasons, because the next fix should target whatever
actually dominates rather than whatever reads best. Cumulative over a session:

| rejection reason | count | share |
| --- | --- | --- |
| **parent size differs** | **269,464** | **70%** |
| known dimension differs | 76,520 | 20% |
| available space differs | 33,294 | 9% |
| no entry at all | 1,328 | <1% |

So the parent-size equality check discards 70% of otherwise usable entries, and
Gecko's idea says most of those nodes cannot care: a node's geometry only
follows the parent's size if some length in it is a percentage.

Built it — a `depends_on_parent_size` predicate on the length type and on
`Style`, supplied by the embedder at lookup — and **it broke four grid baseline
tests**, `grid_align_items_baseline_child_multiline` in all four box/direction
combinations.

Two theories, both refuted by those same four tests. First that the final-layout
entry was the problem, since a box can follow its parent through stretch
alignment without any percentage: restricting the relaxation to the measure path
alone changed nothing. Second that the measure cache discards baselines, since
it stores `Size<f32>` and rebuilds with `from_outer_size`: storing the whole
`LayoutOutput` changed nothing either.

Backed out rather than left half-understood. The 70% figure is real and the idea
is still the highest-ceiling item on
[layout-caching-prior-art.md](layout-caching-prior-art.md)'s list, but something
about grid baseline alignment depends on the parent size through a path neither
theory covers, and shipping a cache that is wrong for grid is worse than a cache
that misses.

**What would settle it:** read one of those four tests and find what actually
differs, rather than proposing a third mechanism. That is where to pick this up.

Not done: Chromium's true LRU promotion, and Gecko's "does the result depend on
the varying input at all", which this document's prior-art sibling calls the
strongest idea in its sweep. Neither is worth building now. Eviction is
insertion-ordered because `get` takes `&self` and cannot record a touch, and
with the cache sized to the working set almost nothing is evicted, so a better
eviction policy has almost nothing left to improve. Revisit if a measurement
asks.

---

## Explicitly not doing

- **Building a mempool.** Two already exist below the paint boundary: vello's
  encoding buffers are an arena that retains capacity across `Scene::reset()`,
  and its GPU buffers are pooled by power-of-two size class. The DOM is a slab.
  Glyphs stream. Styles are refcounted `ServoArc` clones. Nothing there needs
  pooling; the churn is all above it, in `blitz-paint`.
- **Un-retaining tabs.** A documented tradeoff, not a defect.
