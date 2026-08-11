# TODO: what to work on, and what is still research

> **New here, or resuming after a compaction?** There may be an untracked
> `docs/HANDOVER.md` beside this file, written at the end of a working session
> and deliberately not committed: it holds machine-local paths and in-flight
> state. Read it if it is there. This file is the item list; that one is the
> operating manual.

Written 2026-08-11. A high-level index. Every line points at the document that carries the
evidence, the line numbers and the caveats. **Read the linked doc before acting on an
item**, because several of these carry ordering constraints that are not obvious from a
one-line summary.

Everything produced on 2026-08-11 is source reading, not measurement. Each of those docs
says so at the top. `performance.md` remains the only measured document, and its
2026-08-11 addendum records what a source review added and where it qualified the earlier
numbers.

## Three constraints that govern the order

1. **The Taffy layout cache gates almost every speed number.** Style is 167 microseconds
   against 18 ms of layout per keystroke. Anything promising milliseconds waits on
   [layout-caching-prior-art.md](layout-caching-prior-art.md).
2. **Instrumentation currently ships in release builds**, so the counters you would measure
   with are inside the baseline. See [allocations.md](allocations.md). Fix it, or compare
   before-and-after on the same build.
3. **Engine changes land in a checkout AgencyZero does not currently share with chuzz.**
   Chuzz path-depends on `~/code/blitz-rust`; this repository builds ps-blitz from a pinned
   git rev. A fix in one does not reach the other.

## Resume here

Paused 2026-08-11 for one short unrelated project. This is where the performance
workstream picks up, in this order, and each line already has its measurement — see
"Done, 2026-08-11" below for what produced them.

**A. Why a scrollport clip costs ~110us.** The largest measured item left. Clip and
opacity layers are 44% of the frame, and within that the count is not the cost: a
background clip is about 0.8us, a scrollport clip about 110us, and the ~30 remaining ones
are worth **2.5ms of a 7.4ms frame**. Two candidates, and they need separating before
anything is designed:

  1. Whether vello allocates an intermediate render target per clip rather than using a
     scissor rect for an axis-aligned rectangle. A vello question.
  2. Whether nested scrollports re-clip regions an ancestor already clipped. Ours, and
     cheap to answer now that `layers_by_site` is on the `[blitz-frame]` line.

**B. Re-baseline everything unpaced.** Every frame-rate figure recorded before step 10 of
[allocations-plan.md](allocations-plan.md) came through a harness pacing itself at 60Hz.
The millisecond phase timings survive; the frame rates and `missedRefreshes` counts do
not. Until this is redone the workstream's own baseline is wrong. `BENCH_PACE=0`, three
runs, discard the first.

**C. The two deferred items, both re-scoped by measurement.** Path caching (item 11) is
now judged against an 8.33ms frame rather than a 40ms one, which is the whole reason it
was deferred rather than dropped. mimalloc (item 6) is a **memory** experiment aimed at
the 78MB of empty-but-resident malloc regions, not a speed one.

**Explicitly not next:** the Boa concatenation. Arithmetic puts it at ~30ms across a
50,000-character reply against the 2.3s the parse cost, and it cannot be measured outside
the app. Leave it until something measures it there.

**Two loose ends from that session**, neither performance work but both mine:

- Roughly 220 characters of `abcdefg…` typed into one of the five open project drafts in
  the real store, while testing the composer through `blitz-bench type`.
- Five UI-reachable commands with no Rust implementation — `resolveModeration` (5
  callsites), `cancelTask`, `setProjectModerator`, `setProjectStatus`, `reorderProjects` —
  which `selectApi()` routes to the mock. Inferred from the routing table, never confirmed
  live. `forkProject` is a sixth with no callsites and is simply dead.

## Do next

| # | Item | Detail |
|---|---|---|
| 1 | ~~Move `log-phase-times` off the base `blitz-dom` dependency onto `blitz-inspector`.~~ **Done** 2026-08-11, `apps/gui/Cargo.toml:33`. | [allocations.md](allocations.md) |
| 2 | ~~Bound the streaming tail block: split prose on blank lines in `extractProseStructures`.~~ **Done** 2026-08-11, along with the incremental parse that followed it. See "Done" below before re-issuing this. | [js-engine-big-problem.md](js-engine-big-problem.md) |
| 3 | **Half done.** ~~`vmmap`/`heap` on a live instance~~ (done: 855MB, `MALLOC_SMALL` 552M, GPU-side only 67M). Still open: distinct versus total attribute values on a tree. | [allocations.md](allocations.md), [blink-what-we-can-learn.md](blink-what-we-can-learn.md) section 7 |
| 4 | Make Stylo snapshots updatable (`document.rs:1258`). A correctness fix, and it unblocks the invalidation work. | [style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md) |
| 5 | Clamp animation-driven redraw to a lower cadence (`blitz-shell/src/window.rs:614`). Best value per line available. | [animation-gap.md](animation-gap.md) |
| 6 | Try mimalloc as the global allocator. One line, measure, keep or drop. | [allocations.md](allocations.md) |

Items 1 to 6 are independent of each other and of the layout cache.

## Then, in order

| # | Item | Gated on | Detail |
|---|---|---|---|
| 7 | Fix the Taffy cache: A/B 0.12.2 against 0.13.0, then port Yoga's validity heuristics and Chromium's LRU shape upstream | item 1 | [layout-caching-prior-art.md](layout-caching-prior-art.md) |
| 8 | Honest snapshot flags, then narrow the restyle hints | items 4 and 7 | [style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md) |
| 9 | Narrow `ALL_DAMAGE` on the mutation paths | item 7 | [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) |
| 10 | Pending invalidations: batch instead of invalidating at the mutation site | none, but composes with 12 | [blink-what-we-can-learn.md](blink-what-we-can-learn.md) section 2 |
| 11 | Cache the bezier paths (`render.rs:518`, the standing TODO) | none | [GPUI-and-zng-what-we-should-learn.md](GPUI-and-zng-what-we-should-learn.md) |
| 12 | Damage regions, stages 0 to 3 | item 1 for a clean baseline | [partial-paint.md](partial-paint.md) |

The full DOM-side breakdown, with per-item verification steps and sizes, is
[TODO-dom-related-work.md](TODO-dom-related-work.md).

## For the next micro release

- **The app burns ~76% CPU while completely idle.** Measured on 0.5.35, PID 6443,
  four minutes after launch with nobody typing and the pointer still: `fps=30.7`,
  `frames=488`, and in that window `poll_hook` 1,305 calls / 1,441ms, `timers`
  279 calls, and **`dom:attr=` 3,698 writes**, roughly 230 attribute writes a
  second with no input. An earlier instance held 74.8% for four hours, so it
  reproduces immediately and is not a startup effect.

  **It is not the engine.** `resolve` is 2.81ms mean and `layout:flush_from_script`
  fired 3 times. The taffy cache is working. Something in the frontend writes
  attributes continuously, each write dirties layout and asks for a frame, and
  30fps is exactly `ANIMATION_TARGET_FPS` — the app is pinned to its animation
  ceiling by a loop with no animation in it.

  Unverified candidates, in order of suspicion: `followTail` in
  `TranscriptPane.tsx:363`, which writes `scroller.scrollTop` and could be
  re-triggered by the scroll event that write emits; and whatever drives
  `poll_hook`. `useNow` (`workspace.tsx:2676`) ticks once a second and cannot
  account for 230 writes a second on its own. **Get a trace before choosing.**

- **Text spills past its container in the transcript.** Seen in a screenshot on a
  real session. **Not reproducible synthetically**, and two mechanisms were
  tested and refuted: the engine wraps `overflow-wrap: anywhere` prose correctly
  inside a fixed-width box, and a flex *column* child is not forced wider by
  unbroken text, because `min-width: auto` binds the main axis, which for a
  column is height. Both measured, neither is the cause.

  A three-element fixture cannot express a bug about position relative to other
  elements. Reproduce against the real document instead.

## Two benchmarks to build, from real shape

The owner's design: one for the project chat, one for settings, with the text
anonymized to gibberish preserving **length and shape**. Captured from the live
0.5.35 instance so the fixtures have a target to hit:

| surface | nodes | role histogram |
| --- | --- | --- |
| project chat | 4,350 | generic 3,119, button 528, presentation 385, option 158 |
| settings | 4,506 | generic 3,256, button 534, presentation 389, option 158 |

`agency-tools` (formerly and still referred to as `wt-tools`) reads the store
read-only and is safe while the GUI is open: `list-messages --bodies` gives the
length distribution the gibberish should match.

**Do not capture a baseline until the idle CPU loop above is fixed**, or the
benchmark bakes a 30fps idle spin into its own numbers.

## Recorded bugs, not yet investigated

- **Transcript text runs under the turn header.** Seen on 0.5.34, 2026-08-11: the first
  lines of a message render beneath the sticky `Turn N · tokens · cost` pill instead of
  clearing it, so they are unreadable. The transcript carries `pt-14`
  ([TranscriptPane.tsx:565](../apps/gui/frontend/src/features/project/TranscriptPane.tsx)),
  which is presumably meant to reserve that space, so the question is whether the header
  is taller than the reserve or is positioned outside the flow.

  A second artefact in the same screenshot: a lighter vertical band down the right of the
  message bubble, roughly the width of a scrollbar gutter. Whether the two share a cause
  is unknown.

  **Observed in a screenshot only.** Nothing here has been measured against the live box
  tree, and a screenshot cannot tell a layout fault from a paint fault. Read the geometry
  with `blitz-bench layout` before designing anything, or this becomes another session
  spent on a plausible mechanism the tests then refute.

## Open research

Questions that are not yet decisions. Each has a document arguing a position; none has a
measurement behind it.

- **What a frame would cost with quads as primitives rather than paths.** GPUI has no
  damage regions at all and does not need them. That is a live alternative to item 12 and
  belongs in its stage 0. [GPUI-and-zng-what-we-should-learn.md](GPUI-and-zng-what-we-should-learn.md)
- **Whether damage should be derived by comparison rather than from flags.** WebRender
  rebuilds per-tile dependency lists every frame and diffs them, which removes the
  stale-pixel failure mode by construction. It would change item 12's stage 1 before it is
  built. [webrender-good-design-to-review.md](webrender-good-design-to-review.md)
- **Where the 819 MB and 3.9 GB actually go.** Candidate list exists, attribution does not.
  Item 3 is the first move. [allocations.md](allocations.md)
- **Whether the renderer should keep a full-repaint model.** Decided against WebRender for
  concrete reasons; the alternatives are damage regions or cheaper frames.
  [why-not-webrender.md](why-not-webrender.md)
- **Renderer process isolation.** zng runs the renderer in a separate process with respawn
  and a liveness watchdog. We already spawn a sidecar for the agent, and
  [xpc-sidecar.md](xpc-sidecar.md) is the design that was never built.
  [GPUI-and-zng-what-we-should-learn.md](GPUI-and-zng-what-we-should-learn.md) section 4
- **JavaScript engine.** Boa has no rope strings, which is one of six passes in the
  streaming quadratic. Brimstone has cons strings, is unpublished and self-describes as not
  production ready. Revisit when that changes; do not act now.
  [js-engine-big-problem.md](js-engine-big-problem.md)

## Done, 2026-08-11

Appended as the work landed. Everything here is measured unless it says otherwise, which
is the difference between this section and the rest of this document.

### Against the list above

| # | Item | State |
|---|---|---|
| 1 | `log-phase-times` off the base dependency | **Done.** On `blitz-inspector` now. The `strings` check suggested for it is the weaker evidence: a bare `Resolve(` survives in both builds, so counting it alone reads as a failed removal. The call site is `#[cfg]`-gated, so the code is not compiled rather than compiled and cheap. [allocations-plan.md](allocations-plan.md) step 1 |
| 2 | Split prose on blank lines | **Done, and it was not the fix.** See "the streaming parse" below. |
| 3 | `vmmap`/`heap` on a live instance | **Half done.** 855MB resident, `MALLOC_SMALL` 552M, everything GPU-side 67M — which rules out vello's `ResourcePool` as the main cause. The distinct-versus-total attribute-value half is not done. [allocations-plan.md](allocations-plan.md) step 3 |
| 6 | mimalloc | Not started. Re-scoped by the above to a **memory** experiment, not a speed one: 78M of empty-but-resident malloc regions is the claim. |
| 7 | A/B taffy 0.12.2 against 0.13.0 | **Half done.** Bumped to 0.13.0 and the suite is green; the A/B measurement is not taken. Four call sites changed, one of them an upstream correctness fix: `grid_template_areas` now carries its own row and column counts, because a row of only `.` cells belongs to the template but to no area. |
| 11 | Cache the bezier paths | **Partly, and re-scoped.** Three per-element `BezPath` builds removed from paint. Caching stays deferred: the measurement below says clipped area is the cost, not path count. |

### The streaming parse: 142x, measured

`splitBlocks` was quadratic and now is not. Doubling the reply used to cost 4x and now
costs 2x; a 40KB reply spent 2348ms in the parse and now spends 16.4ms. `bun run bench`
reproduces it. Every prefix of every test body must parse identically to a full reparse,
across a fence spanning a blank line, a table, a list and an unterminated fence.

The directive scan had the same shape and got the same treatment: only the last line is
searched, which is exact rather than a heuristic because a directive is a line. 105.9ms to
17.3ms at 40KB, and since 16.4 of that 17.3 is the parse underneath, the scan itself went
from about 90ms to about 1ms.

**That closes the streaming quadratic.** What remains is the Boa concatenation, and
arithmetic puts it at roughly 30ms spread across a 50,000-character reply — about one
percent of the 2.3 seconds the parse cost. Leave it alone: the change it would need is
`MessageBody` and the directive scan consuming chunks across four files, and it cannot even
be measured from the test suite, because Node's V8 has cons strings and Boa does not.

Two corrections came out of building it, both recorded in
[js-engine-big-problem.md](js-engine-big-problem.md):

- **Step 1 of that plan wins nothing.** Boa's `Array.prototype.join` collects a
  `Vec<JsString>` and makes one `js_string!` call into the same `concat_array` that `+`
  uses, so holding the reply as `string[]` and joining costs exactly what concatenating
  cost. It is slightly worse than neutral, and it breaks the character counter and four
  emptiness checks.
- ~~Passes 4 to 6 were already bounded by the `<For>` over `/\n{2,}/`.~~ **That was wrong,
  and testing it is what showed it.** Remove the blank-line flush and the paragraph-identity
  test fails: with the whole reply as one block, `sameBlock` fails on it, the memo hands the
  outer `<For>` a new object, and the row is torn down along with the inner `<For>` and every
  `<p>` in it — so the inner value-diff never runs. Item 2 does bound the DOM write.

### Renderer, and a correction that invalidates earlier numbers

- **Every fps figure in this repository described the benchmark, not the app.**
  `blitz-bench scroll` paced itself at 60Hz and said so nowhere. Unpaced the app runs
  **120.6 fps with zero missed refreshes** and an 8.33ms interval, which is one refresh
  period. The millisecond phase timings are unaffected and stand; the frame rates and
  "missing a refresh" counts do not. The bench now prints its pace above the numbers that
  pace governs. [allocations-plan.md](allocations-plan.md) step 10
- **Keystroke 21.55ms to 3.50ms.** A text input answers `scrollHeight` from its parley
  editor instead of forcing a full `doc.resolve`, which was 89% of the cost of typing a
  character. `layout:flush_from_script` left the profile rather than shrinking.
- **Scene layers 351 to 39.** 314 of them were `background-image: none` layers, which is
  still one layer in CSS, each pushing a clip and allocating a path to draw nothing.
- **Layer count is not the cost; clipped area is.** Removing those 312 bought 0.26ms.
  Removing the ~30 remaining bought 2.5ms. About 0.8us for a background clip against 110us
  for a scrollport clip. That redirects item 12 and the whole layer question.
  [allocations-plan.md](allocations-plan.md) step 9

### Engine correctness fixes, each with a failing-first test

In `ps-blitz-render`, unpushed on `master`.

- **Node leak**: box construction orphaned its anonymous blocks on every rebuild, +11 nodes
  per resolve, 14 nodes to 22,353 in one session.
- **Textarea measured in device pixels**: CSS pixels went into parley, device pixels came
  back out, so on a 2x display a textarea wrapped at half its box width and reported four
  times its height. Every existing test built its viewport at scale 1.0, the one scale at
  which the confusion cancels.
- **Scroll offsets never re-clamped** when content shrank, and **`focus_node_id` /
  `mousedown_node_id` surviving node removal**, which explains a crash.

### Known open, with a measurement: the composer's second line is invisible

Stashed at the owner's request, but the mechanism is now measured rather than described,
via `blitz-bench layout` against a live 0.5.31.

Typing 220 characters into the project composer, reading the boxes after each pass:

| | y | height |
|---|---|---|
| textarea, empty | 767 | 24.4 |
| after ~100 chars | 743 | **24.4** |
| after ~220 chars | 719 | **24.4** |
| `Send` / `Attach` / `Expand`, throughout | **829** | 27.8 |

The control row never moves, so the composer shell grew 48px — exactly two lines — while
the textarea's own box stayed one line tall. The gap between the textarea's bottom and the
controls went from 37.6px to 85.6px. Something computes the right height and reserves the
space; the textarea element does not receive it.

That points at the `field.style.height` write in `resize()`
([Composer.tsx](../apps/gui/frontend/src/features/project/Composer.tsx)) rather than at
`scrollHeight`, since `setPromptHeight` clearly got a correct number. Next step is to read
the element's computed height against what `resize()` wrote, not to theorise further.

### Tooling

- **`scripts/local-delivery.sh quick`**: builds the frontend dist and `az-gui`, swaps the
  binary into the existing bundle, re-signs. Under a minute against several. Default to it
  while iterating; build a bundle only when asked. [driving-the-app.md](driving-the-app.md)
- **Benchmarks run on request**: `bun run bench` in `apps/gui/frontend`, excluded from the
  default suite so CI cost is zero.

## Reference: what each document covers

| Document | Covers |
|---|---|
| [performance.md](performance.md) | the measurements, plus a 2026-08-11 addendum correcting and extending them |
| [allocations.md](allocations.md) | per-frame allocation, retention, the shipping instrumentation |
| [zero-copy-and-hot-paths.md](zero-copy-and-hot-paths.md) | the copy ledger across every boundary |
| [js-engine-big-problem.md](js-engine-big-problem.md) | the streaming quadratic, Boa versus Brimstone |
| [layout-caching-prior-art.md](layout-caching-prior-art.md) | Taffy versus Yoga, Chromium, Gecko, Servo, Slint, Masonry |
| [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) | mutation-path damage faults |
| [style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md) | the Stylo invalidation we override twice |
| [blink-what-we-can-learn.md](blink-what-we-can-learn.md) | Blink subsystem review, including DOM storage |
| [partial-paint.md](partial-paint.md) | damage regions, staged plan, prior art |
| [webrender-good-design-to-review.md](webrender-good-design-to-review.md) | WebRender's design, side by side |
| [why-not-webrender.md](why-not-webrender.md) | why it is not a dependency |
| [GPUI-and-zng-what-we-should-learn.md](GPUI-and-zng-what-we-should-learn.md) | primitives instead of paths, process isolation |
| [animation-gap.md](animation-gap.md) | what is missing, what is not, and the stopgaps |
| [TODO-dom-related-work.md](TODO-dom-related-work.md) | the DOM plan in full |
| [allocations-plan.md](allocations-plan.md) | the pre-existing allocation workstream plan |
| [blitz-performance-architecture.md](blitz-performance-architecture.md) | the design thesis all of this is tested against |
| [concurrency-todo.md](concurrency-todo.md) | what runs on the window thread, ours against Chromium, Gecko, Stylo and fastrender |

Chuzz has a parallel set at `chuzz/docs/`, including its own `TODO.md`. Items marked ENGINE
in either repository need landing in both trees, or the trees need converging first.

## Concurrency, added 2026-08-12

Source review, not measurement. Full reasoning, the ours-against-theirs comparison with
line numbers, and the per-item verification steps are in
[concurrency-todo.md](concurrency-todo.md). Read it before acting on any line below: three
of these are one-line changes whose *measurement* has an ordering constraint, and one is a
research item that must start with a count rather than a fix.

The finding behind all of it: with Blitz in process the window thread owns OS events, Boa,
style, layout, paint, `present` **and** every non-async Tauri command. Under WebKit those
lived in another process, so habits carried over from that build are mispriced.

| # | Item | Gated on | Detail |
|---|---|---|---|
| 13 | **Count how often `resolve.rs:663` clears the whole document's taffy cache.** It fires when any inline layout is reconstructed, which reading the mutation paths suggests is every streaming token and every tab switch. If so it outranks everything else here, and the measured "0.27ms per keystroke" describes only resolves that do not reconstruct. | none | [concurrency-todo.md](concurrency-todo.md) B1 |
| 14 | **Set `BLITZ_PRESENT_MODE=mailbox`.** `AutoVsync` is FIFO and its `present` parks the window thread until vblank, so a 3ms frame still costs a refresh interval and input slips two frames. The renderer's own source says so; nothing sets it. **This blocks the measurement of 15, 16 and 17**, because under FIFO a main-thread saving does not show up in frame time. | none | [concurrency-todo.md](concurrency-todo.md) A1 |
| 15 | **Pass Stylo a thread pool** (`main.rs:95`, `StyleThreading::Parallel`). We link Firefox's parallel style traversal and run it sequentially, because `DocumentConfig` defaults to `Sequential` and its own doc comment says the opposite. The multi-document hazard the comment warns about does not apply: one document, no iframes, one resolving thread. | 14 | [concurrency-todo.md](concurrency-todo.md) A2 |
| 16 | **Enable `blitz-dom/parallel-construct`.** The rayon fan-out over deferred inline construction, which is the parley shaping a tab switch is mostly made of, is written and switched off here while upstream's own `apps/browser` and `apps/readme` enable it. Measure RSS in the same run: it clones a `FontContext` per worker, and item 3 is open. | 14 | [concurrency-todo.md](concurrency-todo.md) A3 |
| 17 | **Move the heavy read-only Tauri commands off the window thread** with `#[tauri::command(async)]`. 34 of 97 commands are non-async and therefore execute between two frames of the UI they serve, including `list_messages`, `list_task_log` and a filesystem walk in `list_table_sizes`. Audit call-order dependence first; leave the cheap ones and the writers sync. | none, but audit before edit | [concurrency-todo.md](concurrency-todo.md) C1, C2 |
| 18 | **Decide whether the renderer moves to its own thread**, fastrender's model: UI thread does OS events and message passing, renderer worker does the pipeline. Needs a `Send` audit and interacts with the main-thread id checks in `tauri-runtime-blitz`. Compositor-style scroll is the item after it and composes with item 12. | 14, 17 measured | [concurrency-todo.md](concurrency-todo.md) D1, D2 |

**Not on the list, with the reason:** parallel layout (no engine worth copying does it, and
our cost is cache behaviour, which is item 7); moving DOM teardown to a worker (Boa and
`blitz-dom` are deliberately single-threaded, so there is nothing separable to hand over);
anything from fastrender's multiprocess design (unimplemented there).

## From the Genet review, added 2026-08-12

Source reading, not measurement. [genet-review.md](genet-review.md) carries the evidence,
the dependency audit and the line numbers; each doc named below has a dated addendum at its
bottom with the detail. Genet is a Servo fork on our exact stack (Stylo, Taffy, parley,
vello), so where it disagrees with us that is evidence rather than opinion.

**Two items above are amended rather than added to.** Item 16 is no longer a one-line
feature flip, and item 12 gains a prerequisite.

| # | Item | Gated on | Detail |
|---|---|---|---|
| 19 | **Amends item 16.** Port the four parts of Genet's shaping pre-pass, not just the rayon call: split width-independent shaping from line breaking; add a threshold (theirs is 24 leaves, and our whole document is the chrome UI their comment says to keep serial); **skip `display: none` leaves**, which is most of what a tab switch reconstructs given nine retained tabs and may be worth more than the parallelism; add a `GENET_SHAPE_SERIAL`-style A/B switch. Their `map_init` also softens item 16's memory caveat: the font-context clone is per worker, not per item, and parley's `Collection` is shared. | 14 | [concurrency-todo.md](concurrency-todo.md) addendum, [genet-review.md](genet-review.md) §1 |
| 20 | **A paint-list IR between layout and the renderer.** Genet emits a `GenetPaintList` and lowers it to a scene in a separate crate, GPU-free. We paint straight from the DOM into a vello `Scene` inside `View::redraw`, so there is no value to diff, send or test. **This is the missing prerequisite under three separate workstreams**: item 12's stages 1 and 2, concurrency item 18's renderer thread, and the "Stage rendering and carry change metadata forward" decision that has sat unbuilt in the architecture doc. Sequence it before item 12 rather than beside it. | 13, and a decision on IR shape | [partial-paint.md](partial-paint.md) addendum, [blitz-performance-architecture.md](blitz-performance-architecture.md) addendum |
| 21 | **Research: a script-engine seam, keeping Boa behind it.** Genet runs Boa, Nova and Piccolo through one `ScriptEngine` trait, with `Budget`/`PumpOutcome`/`eval_bounded`/`pump` making script cooperatively interruptible. That is also the yield point concurrency section 2.8 says we lack. **Not free**: they carry forks of both Boa and Nova to get weak reflector references, because engines disagree about GC handles. Build it only if a second engine is actually wanted. | none | [js-engine-big-problem.md](js-engine-big-problem.md) addendum |
| 22 | **Build-graph witnesses in CI.** The one finding with no home in this doc set. We have hit "the build graph is not what we believed" four times and recorded each separately: `blitz-dom/incremental` missing and costing a measured 13x, `log-phase-times` shipping in release while being used to measure it, `ps-anyrender-vello` reaching the app through `tauri-runtime-blitz` rather than where it was looked for, and Genet's own fontconfig failure from the outside. Genet asserts its architecture mechanically instead: a dependency-cone check that fails CI if a crate gains a forbidden dep, plus `cargo check -p <crate> --target wasm32-unknown-unknown` as a standing no-native-deps proof. **Needs a home before it needs an implementation**: either a short `docs/build-graph-witnesses.md` or a rule in `AGENTS.md` under Verification, which is the owner's call. | none | [genet-review.md](genet-review.md) §4 and "Where this leaves a gap" |

**Recorded, not actioned:** Genet vendors Taffy `=0.12.1` with three patches (float slot
width-fit, a float exclusion-band accessor, flex `order`) that touch no file `ps-taffy`
touches. Worth reading before either fork drifts, and before `float_layout` ever becomes
ours. Not a reason to bump; their pin is 0.12.1 and item 7's A/B against 0.13.0 is
unaffected. See the [layout-caching-prior-art.md](layout-caching-prior-art.md) addendum.

**Negative result, recorded so it is not rediscovered:** Genet has not enabled Stylo's
parallel traversal either (`cascade.rs:374`, "Sequential (no rayon pool)"). Item 15 is
unexploited in both trees on the same stack. That is a reason to try it and a reason to
stop calling it a known win.

**Do not depend on Genet.** One author, 0 stars, 21,000-line layout engine against a moving
WPT target, and `cargo check --workspace` has failed on every run since 2026-08-09 because
the inherited Servo islands still pull HarfBuzz, FreeType, fontconfig and GStreamer. Pelt's
own closure is clean apart from `ring`. Read it for designs.
