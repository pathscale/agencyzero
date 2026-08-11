# Allocations: what to measure, in what order, and what it said

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

**Result:**

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

**Result:**

---

## 4. mimalloc as the global allocator, as an A/B

`[ ]` There is no `#[global_allocator]` in `agencyzero`, `ps-blitz-render`,
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
paths churn inside `paint_scene`, so their cost is in `scene_ms`. Take it during
a scroll, where the most elements are repainted per frame.

**Result:** pending a live instance, same as step 2.

**Worth keeping as a lesson:** this step was written as "add a timer", and the
timer already existed two crates away. Reading before building is cheaper than
either measuring or guessing.

---

## 6. Cache the paths, if and only if step 5 justifies it

`[ ]` Gated on step 5's `scene_ms` reading, not on the source comment.
`render.rs:518` already says "we can cache the bezpaths themselves,
saving us a bunch of work". Each allocation is small — a rounded rect is a
handful of `PathEl`s — so the cost is the count, not the bytes. Cache only the
sites paint shows to be hot.

**Result:**

---

## Explicitly not doing

- **Building a mempool.** Two already exist below the paint boundary: vello's
  encoding buffers are an arena that retains capacity across `Scene::reset()`,
  and its GPU buffers are pooled by power-of-two size class. The DOM is a slab.
  Glyphs stream. Styles are refcounted `ServoArc` clones. Nothing there needs
  pooling; the churn is all above it, in `blitz-paint`.
- **Un-retaining tabs.** A documented tradeoff, not a defect.
