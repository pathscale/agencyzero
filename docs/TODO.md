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

## First: the inspector's 80% of a core does not reproduce

This section used to say the inspector cost 80% of a core, on the strength of
one pair of readings: 0.00s of CPU over 10s wall without `blitz-inspector`,
8.04s with it. **Re-measured on 2026-08-12 after 0.6.0, it does not reproduce,
and the build is not the variable.**

| what was run | idle CPU over 10s wall |
| --- | --- |
| 0.6.0, `--features blitz-runtime` | 0.13s, 1.3% of a core |
| 0.6.0, `--features blitz-inspector` | 0.09s, 0.9% |
| the same, under the bundle's pinned `LSEnvironment` | 0.03s, 0.3% |
| **the 0.5.51 binary the 8.04s came from** | **0.14s, 1.4%** |

Same machine, same store, same project open, both binaries executed directly
rather than through Finder. The 0.5.51 build in
`target/release/bundle/macos/AgencyZero.app` is the one the figure was taken
from, and today it reads 1.4%.

Nothing walks it back up. After six control clients attach and hang up, 1.0%.
After six page downs, after scrolling the transcript, after paging through
Settings: 0.9% to 1.4%. Over ten minutes of uptime with the app driven between
every reading, it stays between 0.7% and 1.6% while RSS drifts 665MB to 679MB.
The harness is [`scripts/perf/idle-cpu.sh`](../scripts/perf/idle-cpu.sh), in the
four modes above:

```sh
scripts/perf/idle-cpu.sh once      target/release/az-gui
scripts/perf/idle-cpu.sh clients   target/release/az-gui 6
scripts/perf/idle-cpu.sh after-use target/release/az-gui
scripts/perf/idle-cpu.sh soak      target/release/az-gui 10
```

It takes two `ps -o time=` reads a known interval apart, runs the binary under
the same environment the bundle pins, refuses to start when the store is
already locked, and refuses to report a number for a process that failed to
take the store. Two readings were once taken from an app that had never
started.

So one of these is true, and which one decides whether there is any work here:

1. The control-server fix
   ([tauri-runtime-blitz 6173d83](https://github.com/pathscale/tauri-runtime-blitz))
   closed it after all. A hung-up peer returned the same transport error
   forever and every client that ever disconnected left a task spinning. The
   note that "with the fix in, the 8.04s stands" was written from a binary
   built off a warm target dir whose dependency graph resolved ps-blitz at
   **two revisions** — the graph CI could not compile at all (see agencyzero
   PR 141). What that binary contained is not knowable now.
2. The cost belongs to a state the app only reaches with a human at it, which
   nothing above walks into.

**Do not turn the feature off**, and do not spend a session on item 1's three
old leads until the number is seen again. The next move is the owner's: when
`az-gui` is next above a few percent, leave it running and say so, and take the
reading with `idle-cpu.sh`'s method rather than `ps %cpu`, which is a lifetime
average and was the source of the original alarm.

## Every item, by number

One table so a number can be looked up without knowing which section owns it.
The detail stays in the sections below; this is an index, not a second copy.

| # | Item | State |
|---|---|---|
| 1 | `log-phase-times` off the base dependency | done 2026-08-11 |
| 2 | Bound the streaming tail block | done 2026-08-11 |
| 3 | `vmmap`/`heap` on a live instance | half done |
| 4 | Make Stylo snapshots updatable | open |
| 5 | Clamp animation-driven redraw to a lower cadence | open |
| 6 | mimalloc as the global allocator | open, re-scoped to memory |
| 7 | Fix the Taffy cache: A/B 0.12.2 against 0.13.0 | half done |
| 8 | Honest snapshot flags, then narrow the restyle hints | gated on 4, 7 |
| 9 | Narrow `ALL_DAMAGE` on the mutation paths | gated on 7 |
| 10 | Batch pending invalidations | open |
| 11 | Cache the bezier paths | partly, re-scoped |
| 12 | Damage regions, stages 0 to 3 | gated on 1, 20 |
| 13 | Count the whole-document taffy cache clears | **closed 2026-08-12, premise false** |
| 14 | `BLITZ_PRESENT_MODE=mailbox` | **closed 2026-08-12, measured worse** |
| 15 | Pass Stylo a thread pool | open |
| 16 | Enable `blitz-dom/parallel-construct` | **done 2026-08-12, 7x on shaping** |
| 17 | Heavy read-only Tauri commands off the window thread | open |
| 18 | Renderer on its own thread | gated on 17 |
| 19 | Genet's shaping pre-pass, all four parts | amends 16 |
| 20 | A paint-list IR between layout and the renderer | prerequisite of 12, 18 |
| 21 | Research: a script-engine seam | open |
| 22 | W1: assert the engine's resolved features | open, highest of 22 to 26 |
| 23 | W2: assert instrumentation is absent from release | **now false by choice, see below** |
| 24 | W3: assert one copy of each pivotal crate | open |
| 25 | W4: assert no local `[patch]` reaches a shipped build | open, near-missed 2026-08-12 |
| 26 | W5: assert a target-aware native-dependency inventory | open |
| 27 | **Scheduling: tokio instead of rayon, and interruptible construction** | open, review written |

Item 16 shipped on 2026-08-12 and it was the largest single win of the day: a
tab switch re-shapes every text node in the pane it reveals, because a
`display: none` subtree keeps no inline layout. On six retained panes,
`pconstruct` went 35ms to 5.0ms and the whole switch 53ms to 22ms. It was one
line, written and switched off.

Item 27 is the question that came out of it, and it is a scheduling question
rather than a pool one. Rayon work-steals but its scope blocks the window
thread until the join finishes, its tail is the largest indivisible item, and it
cannot yield to an arriving keystroke; meanwhile a dozen `tokio-rt-worker`
threads sit idle beside it. **Two hard constraints**: Stylo's parallel traversal
takes a `rayon::ThreadPool` by signature (`stylo.rs:150`), and `stylo` declares
`links = "servo_style_crate"`, so moving style off rayon means a renamed fork.
And the construction fan-out relies on thread-locals for its `LayoutContext` and
its per-worker `FontContext` clone, which assume worker affinity that a
migrating scheduler does not give.

The full review, with what each step costs and what it does not fix, is
[tokio-instead-of-rayon.md](tokio-instead-of-rayon.md). Its conclusion in one
line: making construction *interruptible* is worth more than changing runtime,
and is a prerequisite for the runtime change paying off.

Item 13 was measured on 2026-08-12 and **closed**: there is no whole-document
clear left to count. `resolve.rs` clears one node, not the tree. On a 186-node
transcript, an idle resolve computes nothing and a resolve carrying one
streamed token computes 3 nodes, clears 3 caches and hits cache 61 times in 64,
at 720us against 315us idle. Items 7 to 12 are therefore not gated behind a
catastrophic invalidation, and the worry that "0.27ms per keystroke describes
only resolves that do not reconstruct" does not hold. Reproduce with
`cargo test -p blitz-tests --test streaming_token_cost --features counters --
--nocapture`; the magnitude still wants re-measuring against the real document,
which is 4,000 nodes rather than 186.

Item 14 was measured on 2026-08-12 and **closed without shipping**: three
unpaced runs each, first discarded, `mailbox` against `fifo` gave 107.3 and
117.5 fps against 116.7 and 120.1, with 5 and 4 missed refreshes against 2 and
1. FIFO is equal or better on every column, and the predicted drop in
`missed_refreshes` went the other way. Items 15, 16 and 17 were said to be
gated on it; they are not gated on anything now, but their measurements are
still taken under FIFO, which is what ships.

Item 23 is deliberately violated as of 2026-08-12: release bundles now build
`--features blitz-inspector`, unstripped, because two defects this week were
invisible until a crash report and a `sample` could name a function of ours.
The cost is real and accepted: `log-phase-times` rides that feature, so a
timing taken from a release build now contains its own instrument. Constraint 2
below therefore stands rather than being retired.

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

- ~~**The app burns ~76% CPU while completely idle.**~~ **Fixed 2026-08-12**, and
  the diagnosis above was wrong in an instructive way. It is not the frontend,
  and no attribute write is involved: `blitz-shell`'s `about_to_wait` set
  `ControlFlow::WaitUntil` for each animation frame and, when there was no next
  frame, left the control flow alone because `Wait` is the default. It is the
  default and it is not what the loop is still set to: the last animation
  frame's `WaitUntil` stays in force with a deadline already past, so the loop
  wakes immediately and keeps waking with nothing to do.

  Two `ps -o time=` reads 15s apart, twice on two separately built binaries:
  **11.45s of CPU over 15s wall before, 1.17s after — 76.3% against 7.8%.**

  Why it survived so long: there is nothing to see. `sample` on the busy process
  puts the entire main thread inside the run loop, 1327 of 5071 samples in
  `__CFRunLoopDoTimers` and ~800 in `mk_timer_arm`, with **no frame of layout,
  style, paint or script anywhere on the stack**. Every profile of the *app*
  came back empty, which read as "it must be the frontend". A stripped release
  binary made it worse, since even the engine frames were `???`.

- **Text spills past its container.** **Now reproducible, with a numeric
  fingerprint**, against the real document via the debug driver. It is one bug,
  not the several it looks like: overflowing inline content is **centred on its
  container instead of start-aligned**, so it hangs off *both* sides of every
  clipped box — tab labels, message bodies, code spans.

  Measured 2026-08-12, 40 offending elements in one session, the clearest:

  ```
  SPAN   (no class)                                w=873  x=702
  BUTTON min-w-0 flex-1 ... text-left truncate     w=230  x=1023
  ```

  Span centre 1138.5, button centre 1138. The span should start at the parent's
  left edge and be clipped by `truncate`; instead it starts 321px to its left.
  The button explicitly carries `text-left`, and the alignment call in
  `blitz-dom/src/layout/inline.rs:637` already passes
  `align_when_overflowing: false`, so the centring is coming from somewhere
  other than the `text-align` this code reads. **That is the next thing to
  find**, and the reproduction is: attach the driver, walk `div,p,span`, and
  report any element whose rect is wider than its parent's.

  Supersedes the previous entry here, which said this was not reproducible
  synthetically and recorded two refuted mechanisms. Both refutations stand;
  neither was the cause.

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

## Done, 2026-08-12

Two engine defects, both found the same way and neither by reading source: get
the process to say what it is doing, then read it.

- **The experimental boot crash.** `--features experimental` died about two
  seconds after `boot: ready` on 7 launches in 10, with `SIGSEGV`, `SIGBUS`, an
  out-of-bounds index inside stylo's calc resolver and once a stack overflow.
  One cause: a `calc()` reaches taffy as a raw pointer into the node's
  `ComputedValues`, and the renderer cached the taffy style across restyles that
  carry no relayout damage. Recolouring an element recomputes every descendant
  that inherits from it, the old arc drops, and layout resolves freed memory.
  Fixed in ps-blitz `87abcc1c` with a test that fails without it. Shipped 0.6.2.

  **macOS had been writing the answer to `~/Library/Logs/DiagnosticReports/` the
  whole time.** One report is a write into az-gui's own read-only mapping, which
  ends the "bad CSS value" reading immediately. Read those first, next time.

- **The 76% idle spin.** See "For the next micro release" above. One line in
  `blitz-shell`'s `about_to_wait`.

**Every performance number recorded before today was taken on a machine where
this app was burning 76% of a core in the background, on the same window
thread.** The phase timings, the 8.33ms frame, the keystroke figures: all of
them. Item B's re-baseline is no longer bookkeeping.

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

In `ps-blitz`, unpushed on `master`.

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
| [build-graph-witnesses.md](build-graph-witnesses.md) | asserting in CI that we build what we think we build |
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

Source reading, not measurement, from Genet read at `main` on 2026-08-12. Each doc named
below carries a dated addendum at its bottom with the line numbers and the detail; the
dependency audit that decided the adoption question is at the end of this section. Genet is a Servo fork on our exact stack (Stylo, Taffy, parley,
vello), so where it disagrees with us that is evidence rather than opinion.

**Two items above are amended rather than added to.** Item 16 is no longer a one-line
feature flip, and item 12 gains a prerequisite.

| # | Item | Gated on | Detail |
|---|---|---|---|
| 19 | **Amends item 16.** Port the four parts of Genet's shaping pre-pass, not just the rayon call: split width-independent shaping from line breaking; add a threshold (theirs is 24 leaves, and our whole document is the chrome UI their comment says to keep serial); **skip `display: none` leaves**, which is most of what a tab switch reconstructs given nine retained tabs and may be worth more than the parallelism; add a `GENET_SHAPE_SERIAL`-style A/B switch. Their `map_init` also softens item 16's memory caveat: the font-context clone is per worker, not per item, and parley's `Collection` is shared. | 14 | [concurrency-todo.md](concurrency-todo.md) addendum |
| 20 | **A paint-list IR between layout and the renderer.** Genet emits a `GenetPaintList` and lowers it to a scene in a separate crate, GPU-free. We paint straight from the DOM into a vello `Scene` inside `View::redraw`, so there is no value to diff, send or test. **This is the missing prerequisite under three separate workstreams**: item 12's stages 1 and 2, concurrency item 18's renderer thread, and the "Stage rendering and carry change metadata forward" decision that has sat unbuilt in the architecture doc. Sequence it before item 12 rather than beside it. | 13, and a decision on IR shape | [partial-paint.md](partial-paint.md) addendum, [blitz-performance-architecture.md](blitz-performance-architecture.md) addendum |
| 21 | **Research: a script-engine seam, keeping Boa behind it.** Genet runs Boa, Nova and Piccolo through one `ScriptEngine` trait, with `Budget`/`PumpOutcome`/`eval_bounded`/`pump` making script cooperatively interruptible. That is also the yield point concurrency section 2.8 says we lack. **Not free**: they carry forks of both Boa and Nova to get weak reflector references, because engines disagree about GC handles. Build it only if a second engine is actually wanted. | none | [js-engine-big-problem.md](js-engine-big-problem.md) addendum |
| 22 | **W1: assert the engine's resolved features.** Compare `cargo tree -e features -i` output for `ps-blitz-dom`, `ps-blitz-script` and `ps-anyrender-vello` against a checked-in expectation, and fail the build on a diff. Highest value of the five: this is the check that would have caught `incremental` being absent, which cost a measured 13x, and it catches item 16 in reverse once `parallel-construct` is on. | none | [build-graph-witnesses.md](build-graph-witnesses.md) W1 |
| 23 | **W2: assert instrumentation is absent from release** and present in the inspector build (`log-phase-times`, `dom-stats`). Item 1 fixed the instance by moving the feature onto `blitz-inspector`; nothing stops it moving back. **Retires constraint 2 at the top of this file.** | none | [build-graph-witnesses.md](build-graph-witnesses.md) W2 |
| 24 | **W3: assert exactly one copy of each pivotal crate** (`stylo`, `ps-taffy`, `ps-anyrender`, `ps-anyrender-vello`, `wgpu`, `parley`, `boa_engine`). All seven are single copies as of 2026-08-12, so this is cheap while it is true and expensive after it breaks. `stylo` is the one that fails as a link error rather than a type error, because it declares `links = "servo_style_crate"`. | none | [build-graph-witnesses.md](build-graph-witnesses.md) W3 |
| 25 | **W4: assert no local `[patch]` path reaches a shipped build.** Aimed at the committed `taffy = "../ps-taffy"` path that HANDOVER calls the sharpest edge in the tree, and at the tracked `.cargo/config.toml` patch block that makes a local build silently different from a release one. | none | [build-graph-witnesses.md](build-graph-witnesses.md) W4 |
| 26 | **W5: assert a target-aware native-dependency inventory** for the macOS release target. Note the trap before writing it: `Cargo.lock` names 34 `-sys` crates including the whole GTK and WebKit stack, none of which macOS builds, so the naive lock grep returns 34 false positives and gets switched off within a week. It has to be `cargo tree --target`. | none | [build-graph-witnesses.md](build-graph-witnesses.md) W5 |

**Items 22 to 26 are one class, not five unrelated checks.** We have hit "the build graph is
not what we believed" four times and recorded each separately: `blitz-dom/incremental` absent
and costing a measured 13x, `log-phase-times` shipping in release while being used to measure
it, `ps-anyrender-vello` reaching the app through `tauri-runtime-blitz` rather than where it
was looked for, and Genet's own fontconfig failure seen from outside. Genet asserts its
architecture mechanically instead, and its wasm target check would have replaced the entire
audit above with one command. The class, the prior art and the five traps are in
[build-graph-witnesses.md](build-graph-witnesses.md). None of the five is implemented.

**Recorded, not actioned:** Genet vendors Taffy `=0.12.1` with three patches (float slot
width-fit, a float exclusion-band accessor, flex `order`) that touch no file `ps-taffy`
touches. Worth reading before either fork drifts, and before `float_layout` ever becomes
ours. Not a reason to bump; their pin is 0.12.1 and item 7's A/B against 0.13.0 is
unaffected. See the [layout-caching-prior-art.md](layout-caching-prior-art.md) addendum.

**Negative result, recorded so it is not rediscovered:** Genet has not enabled Stylo's
parallel traversal either (`cascade.rs:374`, "Sequential (no rayon pool)"). Item 15 is
unexploited in both trees on the same stack. That is a reason to try it and a reason to
stop calling it a known win.

### The dependency audit, and the adoption verdict

The question that produced this section was whether Genet carries system or hidden C++
dependencies. The answer is not one answer, which is why it is recorded rather than
summarised.

**Method, and its limit.** Treeless shallow clone (`--depth 1 --filter=blob:none
--no-checkout`), 7.1 MB for 187,905 files, then per-file reads. **No `Cargo.lock` is
committed**, so the closure below is a manifest walk resolving `[workspace.dependencies]`
aliases to local paths, not a resolved graph. Feature unification can pull in what a
manifest walk misses, so treat it as a floor. A real `cargo tree` cannot be run today
because their build does not pass.

**In-tree: clean.** Zero `.c/.cc/.cpp/.h/.m/.mm` files outside `tests/`, which is WPT and
is 186,173 of the 187,905 files. Three `build.rs` in the repository, none containing
`cc::`, `cmake`, `bindgen` or `Command::new`.

**Pelt's closure: one C dependency.** `default-members = ["ports/pelt"]`, and that closure
is 60 local crates and 148 external. The only non-Rust build input is **`ring 0.17`**, via
`components/netfetcher` (`rustls` with `features = ["ring"]`, `ring` directly, plus `quinn`
and `h3`), which compiles C and per-architecture assembly. It is deliberate: their
`Cargo.toml:127` records removing `aws-lc-rs` to avoid "NASM-required C+asm crypto" and
names ring or `rustls-rustcrypto` as the replacements. Everything else that touches the
platform binds rather than builds (`windows`, `ash` which dlopens libvulkan, `libc`,
`mach2`, `dwrote` on Windows only, the AccessKit adapters, `arboard`). No HarfBuzz,
FreeType, fontconfig, SpiderMonkey, GStreamer or jemalloc.

**The workspace: all of it comes back**, through two vestigial Servo islands.
`components/fonts` declares `harfbuzz-sys` with `features = ["bundled"]`, which compiles
vendored HarfBuzz C++, plus `freetype-sys`, `yeslogic-fontconfig-sys` and `dwrote`; it is
reached only by `components/shared/layout`, which `genet-layout` explicitly does not use
(its manifest carries the commented-out line `# layout_api = ...  # EXPERIMENT: genet-layout
uses parley, not servo-fonts/layout-api`). Separately, `components/media/examples` is a
workspace member and depends on `servo-media-auto`, which selects `servo-media-gstreamer`
on x86_64 and aarch64, pulling `gstreamer-sys`, `glib-sys` and eleven more pkg-config
crates.

**Their CI proves it rather than the audit asserting it.** `cargo check --workspace
--all-targets` on `ubuntu-latest` with no apt step has failed on every run since at least
2026-08-09, on `yeslogic-fontconfig-sys`'s build script panicking with "pkg-config exited
with status code 1", and the same log shows the GStreamer `-sys` family being downloaded on
the way there. Their `cargo check -p genet-layout --target wasm32-unknown-unknown` witness
is **skipped** because the workspace check fails first, so their no-native-deps proof is
currently unproven rather than passing.

**Verdict.** The README's "entirely Rust" is true of the thing you would embed, apart from
ring, and false of the repository. **Do not depend on Genet**: one author, 0 stars, a
21,000-line layout engine against a moving WPT target, and a build that does not pass. Read
it for designs.

**One hazard to record in case it ever matters.** Only one Stylo is allowed in a dependency
graph, because `stylo` declares `links = "servo_style_crate"` and `[patch]` cannot rename
its target. Genet solved it by renaming and publishing their fork as `genet-stylo`. We
reach stylo 0.20 through ps-blitz, so two Stylos in one binary is a link error at best.

### What item 22 would be asserting

Genet's `support/ci/check_dependency_cones.py` fails CI unless: `genet-extract`'s dependency
set is **exactly** `{layout_dom_api}`; its build-dependencies are empty and its
dev-dependencies are fixtures only; it never reaches `genet-layout`, `genet-render`,
`paint`, `paint_list_render`, `netrender` or `wgpu`; and no crate under `components/`
path-depends on anything under `ports/`. The wasm target check is the second witness. Note
that the cone check passes on every one of their red runs, which is the point: it catches
the class of error it is aimed at, and says nothing about the one they actually have.
