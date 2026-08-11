# TODO: what to work on, and what is still research

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
| 1 | Move `log-phase-times` off the base `blitz-dom` dependency onto `blitz-inspector`. One line, removes per-frame work from the shipping app, cleans the baseline. | [allocations.md](allocations.md) |
| 2 | Bound the streaming tail block: split prose on blank lines in `extractProseStructures`. The only step that changes the asymptotics on its own. | [js-engine-big-problem.md](js-engine-big-problem.md) |
| 3 | Two cheap memory measurements: `vmmap`/`heap` on a live instance, and distinct versus total attribute values on a tree. | [allocations.md](allocations.md), [blink-what-we-can-learn.md](blink-what-we-can-learn.md) section 7 |
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
- **Passes 4 to 6 in that document's ledger were already bounded**, by the `<For>` over
  `/\n{2,}/` which diffs paragraphs by value. Item 2 above is an enabler, not a fix.

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

Chuzz has a parallel set at `chuzz/docs/`, including its own `TODO.md`. Items marked ENGINE
in either repository need landing in both trees, or the trees need converging first.
