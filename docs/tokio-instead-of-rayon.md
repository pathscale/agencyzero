# Moving the engine's parallelism to tokio

Written 2026-08-12, from reading the code it describes and measuring the work it
is about. Every number here was taken today on the application's own transcript
markup and its shipped stylesheet; every line number was checked rather than
recalled.

The question is not "is tokio faster than rayon". It is whether the engine's
parallel work should be *scheduled* rather than *forked*, and what that costs.

## What is parallel today, exactly

Two places. That is the whole surface.

| | Where | Shape |
|---|---|---|
| Style traversal | `blitz-dom/src/stylo.rs:150` | `style::driver::traverse_dom(&traverser, token, rayon_pool)` |
| Inline construction | `blitz-dom/src/resolve.rs:603` | `deferred_construction_nodes.into_par_iter()` |

Neither is on in a shipped build until today: style still defaults to
`StyleThreading::Sequential`, and `parallel-construct` was written and left off.

## What the flag bought, measured

A tab switch, six retained panes, 1,432 nodes, `display: none` to visible:

| | pconstruct | whole switch |
|---|---|---|
| sequential | 35ms | 53ms |
| `parallel-construct` | **5.0ms** | **22ms** |

Seven times on the shaping. That is the ceiling rayon offers on this workload,
and it is now the baseline any other model has to beat.

What remains in the 22ms: `layout` 8.9ms, `style` 6.2ms, `pconstruct` 5.0ms,
`construct` 1.3ms.

## The case against rayon, stated fairly

Rayon work-steals, so it balances throughput across a fork-join scope. It gives
nothing for tail latency, and tail latency is what a dropped frame is:

- **The scope blocks its caller until the join completes.** During a tab switch
  that caller is the window thread, so the frame waits for the slowest chunk no
  matter how well the rest balanced.
- **The tail is the largest indivisible item.** One long code block's shaping
  cannot be split, and stealing does not help a single item.
- **No priority, no preemption, no yield.** A scope in flight cannot stand aside
  for an arriving keystroke. It finishes.
- **It is a second pool.** The application already runs a multi-thread tokio;
  a `sample` taken today shows a dozen `tokio-rt-worker` threads idle while the
  window thread does everything. Rayon adds its own global pool beside them,
  sized to the same cores, neither aware of the other.

## What tokio would actually take

### The blocker, first

**Stylo's parallel traversal takes a rayon pool by signature.**
`style::driver::traverse_dom(&traverser, token, Option<&rayon::ThreadPool>)` is
Firefox's API, and `stylo.rs:150` calls it directly. There is no tokio-shaped
entry point. So style parallelism is rayon or sequential unless Stylo is forked,
and forking it is not cheap: `stylo` declares `links = "servo_style_crate"`, so
only one copy may exist in a dependency graph and `[patch]` cannot rename the
target. Genet solved exactly this by renaming and publishing `genet-stylo`.

That means a tokio migration **cannot be total**. Either style stays on rayon,
or the fork is on the table, and those are very different projects.

### Inline construction, which is the part worth moving

`resolve_deferred_tasks` (`resolve.rs:595`) is the 35ms. Its body is more
interesting than a `par_iter`:

- Each task takes a `LayoutContext` from a thread-local (`LAYOUT_CTX.take()`).
- Each takes a per-thread `FontContext` clone from `self.thread_font_contexts`,
  a `ThreadLocal` keyed by worker.

Both assume **worker affinity**: a fixed set of threads, each keeping its own
scratch context between items. Tokio's model is tasks migrating across workers,
so thread-locals stop being a per-worker cache and become a per-poll lottery.
That is not fatal, and it is not free either: the contexts have to move into the
task or into a pool keyed by something other than the thread, and a `FontContext`
clone is not cheap enough to do per item.

The concrete work:

1. **`Send` bounds.** Tasks must be `Send`. `blitz-dom` carries
   `unsafe impl Send for Node`, so this compiles rather than being safe; moving
   to a runtime that genuinely migrates work across threads leans on that
   assertion much harder than a fork-join scope does. Auditing it is part of the
   cost, not a footnote.
2. **No scoped borrows.** Rayon's scope can borrow `&mut self` for the duration.
   Tokio tasks are `'static`, so the inputs must be owned or `Arc`-shared. The
   task already returns owned `ConstructionTaskResult`s, which helps, but the
   `&self.font_ctx` and `&self.thread_font_contexts` reads do not survive as-is.
3. **Which tokio primitive.** `spawn_blocking` is sized for I/O waits and its
   pool grows unboundedly; `block_in_place` steals the current worker and needs
   the multi-thread flavour; a dedicated `Runtime` with `worker_threads` set is
   a third pool by another name. Only a purpose-built task set with a bounded
   semaphore behaves like a CPU pool.
4. **Cancellation, which is the actual prize.** A tokio task can be dropped. A
   rayon scope cannot. If a tab switch is superseded before its shaping
   finishes, tokio can abandon the work; rayon will complete it and throw the
   result away.

### What it does not fix

Tokio does not make one item's shaping faster, and it does not reduce the 8.9ms
of layout or the 6.2ms of style. The frame still cannot paint until the pane it
is showing has boxes. Moving the same 35ms onto tokio tasks, without changing
when the frame waits, buys the pool unification and nothing else.

## The thing that actually fixes p99

Neither pool addresses the real defect, which is that the frame is *hostage to a
join at all*. The fix is a budget and a resume point: shape what fits in this
frame, paint, continue next frame. Genet runs script that way already
(`Budget` / `eval_bounded` / `pump`, item 21), and the concurrency review says
the same seam is missing for our script engine.

Under that model the runtime question stops being load-bearing: work becomes a
sequence of bounded steps with yield points, and tokio is the better host
because a bounded step is a task, not a join. Chasing the runtime first and the
interruptibility second means paying the migration before knowing whether it
changes a frame.

## Recommended order

1. **Ship `parallel-construct`.** Done today, 7x on the shaping, one line.
2. **Measure the pools fighting**, which is the untested half of the argument
   against rayon: run the tab-switch benchmark with the app's tokio runtime
   under load rather than idle. If rayon's 5.0ms degrades badly while tokio
   workers are busy, that is the evidence for migration, with a number.
3. **Make construction interruptible** before moving it. A budgeted, resumable
   shaping pass is worth more than a runtime change and is a prerequisite for
   the runtime change paying off.
4. **Then decide on tokio**, with steps 2 and 3 answered, and with style
   explicitly excluded unless the Stylo fork is separately justified.

## Open questions, none of them answered yet

- Does the rayon pool actually contend with tokio's workers in this app, or are
  they idle at the moment shaping runs? Step 2 above.
- What is the per-item cost distribution of shaping? The tail item bounds every
  model, and nothing has measured it.
- Can `FontContext` be shared rather than cloned per worker? Genet's `map_init`
  suggests it is per-worker there too, so this may be inherent to parley.
- Is `unsafe impl Send for Node` defensible under a migrating scheduler? It is
  load-bearing for any answer that is not "keep the fork-join".
