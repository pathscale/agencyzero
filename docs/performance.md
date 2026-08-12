# Performance: what is slow, how to know, and what was fixed

Written 2026-08-10, from measurements taken that day against a live build. Every
number here came from an instrument, not an estimate. Where something is
inferred rather than measured it says so.

## How to measure

Nothing below is reproducible without the diagnostics build, so start there.

```sh
scripts/local-delivery.sh stable        # includes blitz-inspector
```

Then launch it. The build pins the control socket inside the bundle, so no
environment is needed at the call site:

```sh
open -n /Users/revenge/code/agencyzero/target/release/bundle/macos/AgencyZero.app
```

See [driving-the-app.md](driving-the-app.md) for why `open --env` is not enough
and how to launch directly when you need `log-phase-times` on stdout.

| Tool | What it answers |
|---|---|
| `cargo run -q -p blitz-bench -- frames` | One-shot read of the current frame window |
| `BENCH_PACE=0 cargo run -q -p blitz-bench -- scroll 200 -100` | Drives a fixed interaction and reports what it cost |
| `cargo run -q -p blitz-bench -- type 20` | Cost per keystroke, as a delta rather than a total |
| `cargo run -q -p blitz-bench -- click Settings` | Cost of one click, such as a tab switch |
| `cargo run -q -p blitz-bench -- nodes` | Tree size, which is the input to every layout cost |
| `sample <pid> 20 1 -f out.txt` | Native stack profile. Needs a symbols build, see below |
| direct launch, stdout to a file | Per-phase resolve timings from `log-phase-times` |

The bench drives the app through the inspector's MCP socket, so a measurement is
repeatable rather than a description of how someone happened to scroll.

### Two levels of inspection

- **Agent level**: MCP over a Unix socket (`blitz.agent.control`,
  `blitz.diagnostics`). Metrics live here.
- **Debug level**: a WebDriver-shaped HTTP server, enabled with
  `TAURI_BLITZ_DRIVER=127.0.0.1:0` and `TAURI_BLITZ_DRIVER_DESCRIPTOR=<path>`.
  Useful for driving elements. It has **no** performance routes.

Field names inside protocol variants are snake_case (`max_depth`), while the
frame wrapper is camelCase (`requestId`). This used to produce a silent timeout
that read as a hung app; malformed requests now come back as an error naming the
problem. See [driving-the-app.md](driving-the-app.md) for the nesting rules,
which are the other half of the same trap.

## Traps that cost real time

Each of these produced a confident, wrong conclusion before it was caught.

1. **The harness sets the frame interval.** With a `sleep(1/60)` between driven
   events, the reported interval is the harness's cadence, not the application's
   ceiling. Measured "20ms interval, 49fps"; with `BENCH_PACE=0` the same build
   did **308fps**. Always saturate before claiming a ceiling.
2. **Reading metrics perturbs them.** `DiagnosticsRequest::Metrics` polls the
   script loop and forces a resolve. It is reported separately under `snapshot`
   for exactly this reason. Do not sample it in a tight loop and then reason
   about the result.
3. **`residentBytes` is whole-process RSS**, read from `ps -o rss=`. It includes
   the JS heap, wgpu, and fonts. It is not attributable to layout, and a growing
   number there proves nothing on its own.
4. **The inspector's screenshot route does not reflect the running build.**
   Three different builds produced byte-identical PNGs with the same SHA256. Do
   not use it to judge visual correctness.
5. **`cargo fmt --check` gates the bundle build.** Unformatted code in any local
   path checkout (`ps-blitz`, `tauri-runtime-blitz`, `ps-anyrender`)
   fails the app build with a diff that looks unrelated to what you changed.
6. **Piping the build through `tail` discards its exit status.** The honest
   check is the binary's mtime, not the exit code you think you saw.
7. **Cumulative attribution hides the interaction you are measuring.** The
   `script.breakdown` totals run since launch, so a keystroke sits under startup
   and everything done before it. `blitz-bench type` reports the delta across
   the run; without a delta the first reading said typing cost 198 ms, and the
   truth was 22 ms with the rest belonging to earlier shortcuts.
8. **The probe attaches to whichever descriptor sorts last.** Unpinned, the
   descriptor lands in `$TMPDIR/tauri-blitz-agent/<instance>.json`, and after a
   few runs the newest file can belong to a dead pid. Inspector bundles now pin
   `TAURI_BLITZ_CONTROL_DESCRIPTOR` via `LSEnvironment` so this cannot happen;
   if you launch some other way, set it explicitly and check the `pid` in the
   descriptor against `pgrep` before believing any number.
9. **Editing `Info.plist` after bundling breaks the app.** It invalidates the
   ad-hoc signature and macOS then refuses to launch it at all: `open` fails
   with `-54` and nothing starts. `local-delivery.sh` re-signs and verifies
   after pinning the env, and anything else that touches a built bundle must do
   the same.
10. **A build only reaches the app if the `[patch]` paths point at the checkout
    you edited.** The engine is consumed by path from the root `Cargo.toml`. Two
    people on two worktrees will each build a bundle that contains only their
    own work and neither will say so.

## What the numbers said

Measured on a 3,400 node tree, driven scroll, same binary throughout.

| | before | after |
|---|---|---|
| resolve mean | 30.58 ms | **0.37 ms** |
| resolve p95 | 78.23 ms | 1.21 ms |
| scene | 1.23 ms | 1.67 ms |
| renderer | 1.95 ms | 6.55 ms |
| frame total | 33.35 ms | 8.58 ms |
| active fps | 27.1 | 115.5 |
| missed refreshes | 172 / 256 | 3 / 219 |

`renderer` rising is not a regression: at 27fps the GPU was mostly idle, and at
115fps it is doing three times the work per second. Frame total is what matters
and it fell by 4x.

## The fixes, in order of how much they mattered

### 1. Incremental layout was compiled out (13x)

`blitz-dom` gates every dirty-tracking mechanism behind an `incremental` cargo
feature that is not in `default`, and nothing in the build graph enabled it. So
each resolve rebuilt the box tree, re-shaped every inline root, and cleared the
Taffy cache unconditionally (`layout/damage.rs:550`).

The fix is one line in `apps/gui/Cargo.toml`. **This is the most fragile win
here**: anyone who copies the dependency line without the feature restores a
13x regression with no error and no failing test. `document.rs` also honours a
`BLITZ_INCREMENTAL` override so both behaviours can be measured from one binary
rather than comparing two compilations.

### 2. Script geometry reads returned stale values (the jumping)

`element.scrollHeight` and `getBoundingClientRect` read `final_layout`
directly, so a read *after* a mutation returned the geometry from *before* it.
Any measure, mutate, re-measure sequence, which is how scroll position is
restored, did its arithmetic on stale numbers. Worse, `scrollTop = x` clamps
against the element's scrollable height, and after an insertion that height is
still the old smaller one, so the assignment lands short.

Six accessors and the scroll setter now flush layout first, as browsers do, and
mutations mark the tree dirty. It only resolves when something changed.

Marking started as a call at each mutation site and reached the tree ones only.
`className`, `id`, `value` and every other reflected property, all inline style
writes, `nodeValue` and `remove()` mutated without marking, so the stale read
this exists to prevent stayed reachable through them. Mutations now borrow
through `DomCtx::mutate_doc`, which sets the flag, so a mutation cannot forget.

Two paths deliberately keep the plain borrow, and both say so at the site. Node
creation, because a detached node moves no layout until it is inserted. And
`set_scroll_axis`, because it flushes and then moves a scroll offset, which is
not a layout change: marking there would discard the flush it just paid for and
force a full resolve on the next geometry read of every scroll.

"Costs nothing measurable" was true of the flush itself and is not true of what
it forces. See the typing section below: one flush per keystroke, 18 ms each.

**This was the cause of the jumping**, confirmed by the owner after the fix. It
was never a speed problem, which is why every performance fix left it intact.

### 3. The transcript was rebuilt on every streaming token

`<For>` reconciles by object reference. `timeline()` built a fresh wrapper per
row on every recompute and `props.messages` changes per token, so each token
tore down and rebuilt the entire visible transcript. `MessageBody.blocks` was a
plain function rather than a memo, re-parsing the whole body on every read,
which is quadratic in reply length.

Both now reuse unchanged entries. The mounted window is bounded at 48 rows and
slides rather than growing forever.

### 4. Settings mounted everything at once (7x)

`Section` is deliberately never unmounted, so search can ask each row whether it
matches. Correct for search, expensive on open: seventeen sections and about a
thousand controls in one synchronous commit.

| | before | after |
|---|---|---|
| first open | 1388 ms | **196 ms** |

Sections now mount over several ticks and stay mounted, so search is unaffected.

Attribution during that open shows why this had to be fixed in the application
and not the engine:

```
event:click          1 call    193.9 ms
dom:insertBefore     7 calls     0.0 ms
dom:setAttribute    15 calls     0.0 ms
dom:createElement    0 calls     0.0 ms
```

DOM binding overhead is nil. The cost is component construction inside the
handler.

### 5. Typing costs 22 ms per keystroke, and 18 ms of it is taffy

Measured 2026-08-10 on a 6,331 node tree, twenty driven keystrokes per run, six
runs across two builds, machine otherwise idle.

| Layer | Per keystroke |
|---|---|
| `event:input` | 22.0 ms |
| of which `layout:flush_from_script` | 18.8 ms, exactly one per keystroke |
| of which the resolve's `layout` phase | **18 ms** |
| of which the resolve's `style` phase | 0.167 ms |
| `event:keydown` | 0.08 ms |

[`Composer.tsx`](../apps/gui/frontend/src/features/project/Composer.tsx) `resize()`
writes `style.height = "auto"`, reads `scrollHeight`, and writes the measured
height back. The read forces a synchronous resolve, as a browser would, and that
resolve spends essentially all of its time in taffy.

The comparison that makes this actionable: **frame-driven resolves on the same
tree cost 130 µs to 2 ms.** A resolve forced from the composer costs 18 ms. It is
not tree size. Something about setting `height: auto` on one textarea invalidates
far more layout than the change warrants, and `set_attribute` inserting
`ALL_DAMAGE` is the obvious suspect.

Note what this does to the headline number. `frameWindow.resolve` reads 1.28 ms
mean and looks healthy, because the expensive resolve already happened inside
script and is no longer counted as layout. **A cheap `resolve` mean does not mean
layout is cheap once script forces flushes.** Read `layout:flush_from_script` in
the script breakdown alongside it.

Typing is also not `keydown`. It is `input`, at 250x the cost. A cumulative
`event:keydown` total looks alarming because shortcuts and tab opens land there;
per keystroke it is 0.08 ms.

## What was ruled out, with the measurement that ruled it out

Negative results, recorded because each one looked obviously correct and each
would have cost a day.

- **DOM binding overhead is not a factor.** 12,184 binding calls across a whole
  session cost **4.95 ms combined**: `setAttribute` 4,036 calls / 1.51 ms,
  `insertBefore` 4,423 / 1.48 ms, `createTextNode` 2,139 / 1.15 ms. This
  confirms the Settings finding at three orders of magnitude more calls. Work on
  the JS-to-DOM boundary buys nothing measurable.
- **Selector matching is not a factor.** `mutator.rs` `set_attribute` marks
  `RestyleHint::restyle_subtree()` on both the element and its parent, with a
  standing TODO to narrow it via `ElementSelectorFlags`. Removing the parent's
  subtree restyle, building it and measuring gave 18.17 ms → 18.90 ms, which is
  noise. The whole `style` phase is 167 µs, so nothing in selector matching can
  be worth more than that.
- **`set_final_layout` is not the font-context bottleneck.** It was the most
  suspected line in the codebase, on the belief that taffy calls it once per node
  per pass and it locks the shared font context each time. It only locks when the
  node **is a text input** (`text_input_data_mut()` returns `Some`), so on this
  tree that is a handful of locks per pass, not 6,331.
- **The poll loop is already event driven.** `blitz-shell` sets
  `ControlFlow::Wait`; wakeups come from the timer thread, the script queue and
  winit events. The `for _ in 0..100 { document.poll(None) }` spins are in the
  diagnostics and agent-control request handlers only, so they are observer cost,
  never per-frame cost. The 10 ms `ControlFlow::wait_duration` in
  `blitz-shell/src/application.rs` needs both the `debug-control` feature and
  `TAURI_BLITZ_DRIVER` in the environment, and neither release nor ordinary
  inspector runs have it. Converting the loop to "event driven" wins nothing
  because it already is.

### 6. The layout cost is taffy cache thrash, not invalidation breadth

`resolve` now prints what it recomputed, not just what it took:

```
computed 16842/4899 nodes, 15 caches cleared]: 7.8ms    <- one keystroke
computed     0/4899 nodes,  0 caches cleared]: 1.2ms    <- idle
```

Fifteen caches cleared, and **16,842 `compute_child_layout` calls on a 4,899
node tree**: 3.4x the whole document from fifteen dirty nodes. The invalidation
is already tight, so narrowing damage further cannot help. Taffy keys its cache
on available space, and intrinsic sizing re-descends the subtree with values
that never match what was stored, so the cache absorbs almost nothing.

That is the thing to fix, and it is one level below anything tried so far.

Absolute numbers move with composer content: the same keystroke costs 22 ms with
sixty characters in the field and 12 ms when empty, because the textarea's own
measurement grows. Compare within one state, never across.

### 7. Settings is a JavaScript cost, not a layout one

Switching to Settings: **150 ms in `event:click`, of which 32 ms is layout.** The
resolves it triggers are small (27 nodes computed, 592 µs). The remaining ~118 ms
is component construction, which matches the earlier attribution during the first
open. Do not look for this one in the engine.

Tabs are retained, not unmounted: inactive tabs get `class="hidden"` in
[`App.tsx`](../apps/gui/src/App.tsx), which is `display: none`. Taffy skips them,
so they cost memory and style but not layout, and "cache the neighbouring tabs"
is already what happens. The cost lands when a tab is shown and its whole
subtree lays out at once.

### 8. The layout cost does not come from anything the frontend does

Three fixes were tried against the typing cost. All three were built, shipped
and measured, and all three changed **nothing**:

| Attempt | Result |
|---|---|
| Narrow the parent `restyle_subtree` in `set_attribute` | 18.17 → 18.90 ms, noise |
| Measure the composer against a definite height, not `auto` | identical |
| Memoise the cost chip's text so keystrokes stop rewriting it | identical |

Identical is meant literally. Every run of every build reported **16,842
recomputations over 140 distinct nodes, 18,158 of 35,000 cache lookups hit, 52%,
15 caches cleared**, to the digit.

That determinism is the finding. The layout pass is byte-identical regardless of
what the application writes during a keystroke, so no frontend change can move
it. What remains is the one thing common to every keystroke: the textarea's own
`value` write, which goes through `set_attribute` and inserts `ALL_DAMAGE` on the
node plus `restyle_subtree` on its parent. A textarea is a layout leaf sized from
`rows` and `cols`, so its content cannot change its box, yet a value write
damages it as though it could.

The hotspots are named, and they are composer chrome rather than the transcript:

```
2703:div(Block)x460  2332:span(Block)x371  2346:span(Block)x371
2334:span(Block)x371 2450:span(Flex)x287   2445:span(Block)x287
```

`2450` is the cost-estimate chip. It is recomputed hundreds of times even when
its text is memoised and never rewritten, which is what rules the frontend out.

The next experiment is engine-side and narrow: stop a `value` write on a text
input from inserting `ALL_DAMAGE` and from restyling the parent's subtree, since
neither can change that leaf's box, and see whether the 140-node region stops
being invalidated. It needs visual verification, which the broken screenshot
route cannot provide.

## What is still open

- **What a textarea `value` write damages.** The only remaining candidate, and
  the only thing that varies with nothing.
- **Taffy cache misses.** 16,842 recomputations from 15 dirty nodes, 52% hit
  rate, and the single largest engine cost in the application.
- **Settings' ~118 ms of component construction.** Application-side.
- **Memory.** 819 MB RSS on a fresh stable instance with a 4,899 node tree, and
  3.9 GB on a long-running Experimental one. Unexplained, and worth explaining
  before anything is added that retains more.
- **The mount stall.** One `poll_hook` call measured 812 ms, and worst-case
  figures of 785 ms to 1369 ms still show up once per session. Steady state is
  0.67 ms, so this is one event, not a per-frame cost.
- **`renderer` at 6.55 ms** is now 76% of frame work. The `hybrid-renderer`
  feature swaps Vello for the lighter pipeline: renderer falls to 2.41 ms but
  scene rises to 7.29 ms, so it is a wash today. Damage-region redraw is the
  real answer.
- **Slow pages generally.** Typing is the case that got measured because it is
  reproducible. Other heavy views are still reported slow and are not yet
  attributed. Anything that measures geometry after mutating (autosize, scroll
  restoration, virtualised lists) pays the same forced resolve, so measure with
  `blitz-bench type` first and check whether `layout:flush_from_script`
  dominates before assuming a new cause.

`set_final_layout` and the poll loop were listed here and are now ruled out; see
the section above for the measurements.

## What the instrumentation added

None of the above was visible before this work. Layout reported the cost of
taking a snapshot as though it were the cost of a frame, with `scene`, `submit`
and `present` hardcoded to zero (`tauri-runtime-blitz/src/runtime.rs:689`), and
script execution had no timing at all.

- `blitz-shell/src/frame_stats.rs` publishes real per-frame timings with p95 and
  worst case. A one second mean hides the single slow frame anyone notices.
- `blitz-script/src/script_stats.rs` times `ScriptDocument::poll` and attributes
  it by source: event name, timer, startup, DOM call, and script-forced layout
  flush.
- `layout:flush_from_script` is the bucket that located the typing cost. A
  geometry read is nanoseconds and the resolve it forces is not, so folding them
  together reports an accessor as expensive when the cost belongs to the
  mutation before it. Its **call count** carries as much as its total: one flush
  per keystroke is the signature of a measure-mutate-measure cycle.
- Per-DOM-call timing is behind the `dom-stats` cargo feature, which
  `debug-control` enables. A shipping build has no reader for it and should not
  pay two clock reads per DOM operation. It can also be turned on alone to
  profile a build shaped like the shipping one.
- The static-label buckets accumulate in a thread-local and fold into the shared
  log once per poll. They previously took a process-global mutex per call, which
  on a 4,000 node mount is tens of thousands of lock acquisitions: the
  instrument was a measurable share of the measurement and inflated every
  absolute it reported.
- Fields that cannot be measured are `None` with a comment saying why, never
  zero. A zero that looks like a measurement is how the original metrics misled
  for a year.

## Addendum, 2026-08-11: what a source review added

Written the day after the measurements above, from reading this stack against WebRender,
GPUI, zng, Blink, Gecko, Servo, Slint, Masonry, Yoga, Taffy, Aurora, Boa and Brimstone.
**Nothing in this addendum was measured.** It explains, corrects and extends what is above;
where it contradicts an earlier line, the contradiction is called out.

### Two things above were measured with a thumb on the scale

- **The instrumentation ships.** `log-phase-times` is enabled on the base `blitz-dom`
  dependency line in `apps/gui/Cargo.toml`, and `release.yml` builds with
  `--features blitz-runtime`, so per-frame phase instrumentation is in the distributed app:
  a `HashMap` op per `compute_child_layout` (16,842 of them per keystroke, by the number
  above), a sort per frame, and a `format!` plus locked `stdout` write per frame into a
  descriptor a bundle discards. **Every number above was taken with this on**, so it sits
  inside the baseline rather than on top of it. See [allocations.md](allocations.md).
- **"`hybrid-renderer` is a wash" holds only under full repaint.** Hybrid's 7.29 ms "scene"
  is CPU strip generation inside the `PaintScene` calls, so it is proportional to emitted
  content and falls with damage culling; vello's 6.55 ms is GPU rasterization over the whole
  target and does not. The two backends respond to damage completely differently. See
  [partial-paint.md](partial-paint.md).

### The taffy cache thrash has a name and a cause

Section 6 above is right that the cache absorbs almost nothing, and section 8 is right that
no frontend change moves it. The cause is documented upstream. Taffy's own changelog, under
**0.12.0**, the release line we run:

> **More correct caching logic.** The cache key now includes the axis, parent size, and
> available space ... This is a performance hit (~10% in common cases, ~60% in
> pathalogically ones) but is necessary for correctness. (#911)

The mechanism is a 9-slot cache with deterministic slot assignment in which `Definite(_)`
shares a slot with `MaxContent`, so two different definite widths overwrite each other, and
a lookup that requires exact key equality. Yoga, Chromium and Gecko each solve this
differently and better. Taffy 0.13.0 shipped 2026-08-08 and has not been A/B tested here.
See [layout-caching-prior-art.md](layout-caching-prior-art.md).

### Why the negative result in section 8 was negative

Section 8 records that narrowing the parent `restyle_subtree` in `set_attribute` measured
18.17 ms against 18.90 ms, noise. That experiment could not have worked in isolation:
`snapshot_node` sets `class_changed`, `id_changed` and `other_attributes_changed` to `true`
unconditionally, which is what Stylo reads to decide which invalidation maps to walk, so
the invalidator still had to union every map regardless of the hint.

Stylo already implements Blink-style invalidation sets and `blitz-dom` already calls them;
we override the result twice. See
[style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md).

### The transcript fix bounded the churn, not the parse

Section 3 above is accurate about what it fixed. The remaining half: the memo's dependency
is `props.body`, which changes every token, so `splitBlocks` still re-parses the whole body
per token. Worse, `splitBlocks` flushes prose only on a code fence and
`extractProseStructures` only on a table, so a fence-free reply is **one prose block that
grows without bound** and its text node is rewritten in full every token.

Combined with Boa having no rope (`current + delta` memcpys the whole reply per token), the
accumulated body is walked five to seven times per token. See
[js-engine-big-problem.md](js-engine-big-problem.md) for the per-pass ledger and the fix.

### Candidates for the unexplained memory

The 819 MB and 3.9 GB under **What is still open** now have a candidate list, none of it
measured:

- vello's GPU `ResourcePool` is size-classed and **never shrinks**, so the peak frame
  permanently sets the floor, and on unified memory that is RSS.
- Every element owns a separate heap `String` per attribute, with no sharing or
  copy-on-write. Our UI is Tailwind, so class strings are long and duplicated per list row.
  Blink shares identical attribute sets for exactly this reason.
- `Node` carries everything inline for every node, including whitespace text nodes, where
  Blink keeps rare fields in a side table.

Two cheap measurements would size the first two: `vmmap <pid>` separates Metal regions from
MALLOC zones, and counting distinct versus total attribute values on a live tree tests the
duplication directly. See [allocations.md](allocations.md).

### A second full-slab walk per frame

`resolve.rs:124` clearing damage over every node is noted elsewhere as a fixed per-frame
floor. `resolve.rs:56` `clamp_scroll_offsets` is a **second** walk over the same slab each
frame. Both iterate the DOM slab rather than the layout tree, so whitespace text nodes that
were correctly excluded from layout are still visited every frame.

### Where the rest of it went

| Document | Covers |
|---|---|
| [partial-paint.md](partial-paint.md) | damage regions, the staged plan, prior art |
| [allocations.md](allocations.md) | per-frame allocation, retention, the shipping instrumentation |
| [zero-copy-and-hot-paths.md](zero-copy-and-hot-paths.md) | the copy ledger across every boundary |
| [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) | mutation-path damage faults |
| [style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md) | the invalidation override |
| [layout-caching-prior-art.md](layout-caching-prior-art.md) | Taffy versus five other engines |
| [js-engine-big-problem.md](js-engine-big-problem.md) | the streaming quadratic |
| [blink-what-we-can-learn.md](blink-what-we-can-learn.md) | Blink subsystem review |
| [webrender-good-design-to-review.md](webrender-good-design-to-review.md), [why-not-webrender.md](why-not-webrender.md), [GPUI-and-zng-what-we-should-learn.md](GPUI-and-zng-what-we-should-learn.md) | renderer prior art |
| [TODO-dom-related-work.md](TODO-dom-related-work.md) | the plan drawn from all of it |
