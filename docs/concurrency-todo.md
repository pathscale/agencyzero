# Concurrency: what runs on the window thread, and what does not have to

Written 2026-08-12. **Nothing here was measured.** It is a source review of this
application against the engine checkouts it actually builds (`ps-blitz`,
`ps-taffy`, `ps-anyrender`, and the local `tauri-runtime-blitz`), read alongside Chromium,
Gecko/WebRender, Stylo and fastrender. Where a number appears it is quoted from
[performance.md](performance.md) or [HANDOVER.md](HANDOVER.md), which are the measured
documents, and it says so.

The question that started it: closing Settings pauses, and the pause looks like the GUI
thread freeing something. It is not a free. It is a rebuild, and it is on the one thread
that also answers the operating system.

**Engine paths below are the checkouts, not the pinned revs.** `ps-blitz/…` is what
`.cargo/config.toml` patches in, so it is what runs. Line numbers were read from those
trees on 2026-08-12 and will drift.

## Three ordering constraints

1. **Present blocks, so it masks every other win.** `AutoVsync` resolves to FIFO and its
   `present` parks the calling thread until vblank
   (`ps-anyrender/crates/anyrender_vello/src/window_renderer.rs:491`). Free 5ms of main
   thread underneath that and the frame time will not move, because the thread was going
   to sit there anyway. **Item A1 comes before any other measurement in this document.**
2. **The taffy cache clear at `ps-blitz/packages/blitz-dom/src/resolve.rs:663`
   outranks everything else here**, and it is not a concurrency bug. If it fires as often
   as the source suggests, parallelising the work around it is optimising the wrong thing.
   Chain B is first in value and last in confidence, which is why it starts with a
   measurement rather than a change.
3. **Two of the three flag items are one line each and are already written.** They are not
   research. Chain A should be done and measured before anyone designs Chain D.

---

## 1. The thread map, ours

| Thread | What it owns |
|---|---|
| winit window thread | OS events, Boa/JS, DOM mutation, Stylo restyle, box construction, parley text shaping, taffy layout, vello scene encode, GPU submit, `present`, **and every non-async Tauri command** |
| tokio multi-thread pool | `async` commands, agent runs, proxy IO, `agent_control_server` |
| WorkTable per-table persistence workers | store writes, already off-thread |
| `angel` child process | relaunch, backup, restore |

The window thread's cycle, in order:

- `blitz-shell/src/application.rs:188` `window_event` handles the OS event, then
  `:209` posts `BlitzShellEvent::Poll` to itself.
- `blitz-shell/src/application.rs:81` calls `window.poll()`, which is
  `blitz-shell/src/window.rs:444` and runs script.
- `blitz-shell/src/window.rs:472` `redraw` then does, inline and in one call:
  `inner.resolve(...)` at `:482`, `paint_scene` at `:502`, and the renderer's submit and
  present inside `self.renderer.render(...)` at `:500`.

There is no seam in that sequence. A 200ms resolve is 200ms during which no OS event is
looked at.

**The comparison that matters.** Under WebKit, script, DOM and layout lived in a separate
WebContent process, so a blocking Tauri command on the main thread cost a stutter in
window handling only. With Blitz in process, the main thread *is* the renderer. The same
blocking command is now a dropped frame. Every habit inherited from the WebKit build is
mispriced.

---

## 2. Ours versus theirs, subsystem by subsystem

### 2.1 Event loop against render pipeline

| | Ours | Chromium | Gecko + WebRender | fastrender |
|---|---|---|---|---|
| Script, style, layout | window thread | Blink main thread | main thread | renderer worker thread |
| Scene / display list build | window thread (`window.rs:502`) | compositor commit, `cc/trees/proxy_impl.cc` | `RenderBackend` thread, `gfx/wr/webrender/src/render_backend.rs`, `scene_builder_thread.rs` | renderer worker |
| Raster | GPU via vello, encoded on window thread | worker pool, `cc/raster/` | GPU, renderer thread | software raster, renderer worker |
| Present | **window thread, blocking** | GPU process | compositor thread | renderer worker |
| Scroll | window thread, full pipeline | **compositor thread, main thread not involved** | APZ thread | renderer worker |

Ours is the only column where present and OS event handling are the same thread.

**fastrender is the closest model to copy**, and I read its repository rather than
inferring: it runs the renderer on a worker thread inside one process, with the UI thread
doing window and tab management only, and a message protocol between them
(`src/ui/browser_app.rs`, `src/ui/render_worker.rs`, `src/ui/messages.rs`). Its own README:
"Currently the browser runs the renderer on a worker thread within the same process."

Two things about it are worth being precise on, because they cut against the instinct to
copy more than the split:

- **Inside that worker it is strictly sequential and has no rayon at all.** Its pipeline is
  parse, style, layout, paint, raster, with an immutable tree between stages: "Each stage
  produces an immutable tree consumed by the next. This separation enables caching: change
  only CSS and re-cascade without re-parsing HTML; scroll without re-laying-out." So its
  advantage over us is *isolation*, not data parallelism.
- **Its multiprocess design is documented and unimplemented.** `src/sandbox/` exists and is
  not integrated. Do not cite it as prior art for something that ships.

Chromium's compositor is the ambitious version of the same idea and buys something
fastrender's split does not: scroll and transform animations that keep running while the
main thread is busy. That is the single largest perceived-responsiveness feature in any
browser, and it is unavailable to us today at any main-thread speed.

### 2.2 Style: we link Firefox's parallel engine and give it one thread

This is the sharpest ours-versus-theirs in the document, because theirs *is* ours: Stylo is
a dependency, and the parallel traversal is compiled into the shipping binary.

| | Ours | Stylo as written (`stylo-0.20.0`, our own dependency) |
|---|---|---|
| Traversal entry | `blitz-dom/src/stylo.rs:150` `style::driver::traverse_dom(&traverser, token, rayon_pool)` | `driver.rs:88` same function |
| Pool passed | `stylo.rs:147` only when `StyleThreading::Parallel` | `driver.rs:91` `pool: Option<&rayon::ThreadPool>` |
| Default | `blitz-dom/src/config.rs:27` `#[default] Sequential` | Gecko and Servo both supply a pool |
| Strategy | sequential, always | `driver.rs:81` adaptive: "We start out with simple sequential processing, until we arrive at a wide enough level in the DOM that the parallel traversal would parallelize it." |
| Chunking | n/a | `parallel.rs:117` `distribute_work` in `work_unit_max` chunks; `driver.rs:75` reads pref `layout.css.stylo-work-unit-size`, which is **16** (`stylo_static_prefs-0.20.0/preferences.toml:38`) |
| Pool size | n/a | `global_style_data.rs:172` `STYLE_THREAD_POOL`, `num_cpus * 3/4` (`:192`) capped at `STYLO_MAX_THREADS = 6` (`:169`, `:196`) |

We never set it. `apps/gui/src/main.rs:95` builds
`DocumentConfig { base_url: Some(url.into()), ..Default::default() }`, and the default is
`Sequential`.

Two traps here:

- **The doc comment on `DocumentConfig::style_threading` is wrong.** `config.rs:54` says
  "Defaults to [`StyleThreading::Parallel`]". The `#[default]` attribute at `config.rs:27`
  is on `Sequential`. Anyone who reads the field's documentation instead of the enum
  concludes this is already on.
- **The documented hazard does not apply to us.** `config.rs:13` warns that two
  `Document`s resolving `Parallel` concurrently share Stylo's global pool and can panic
  with "already mutably borrowed" (DioxusLabs/blitz#430). This app has one document, no
  `<iframe>`, no sub-documents (`grep` for both returns nothing in
  `apps/gui/frontend/src` and `apps/gui/src`), and every resolve happens on the window
  thread. The traversal is also adaptive, so a small restyle stays sequential and pays
  nothing.

Why it matters more than the node count suggests: `blitz-dom/src/mutator.rs:248`
`set_attribute` raises `RestyleHint::restyle_subtree()` on the node (`:255`) **and on its
parent** (`:262` to `:267`, under a standing `// TODO: make this fine grained`). One class
toggle on a tab wrapper therefore restyles every retained tab under `<main>`, not the two
that changed. See
[style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md) for the
correctness half of that same code.

### 2.3 Layout: nobody parallelises this, and neither should we

`ps-taffy/src` contains no rayon and no threads. Chromium's LayoutNG is main-thread only;
its win is an immutable, cacheable fragment tree, not threads. Gecko is main-thread only.
Servo tried parallel layout and its successor does not rely on it.

**Do not open a parallel-layout workstream.** The measured cost in this application is
cache behaviour, and that is already the subject of TODO item 7 and
[layout-caching-prior-art.md](layout-caching-prior-art.md), where HANDOVER records the win
already taken: layout 8.0ms to 0.27ms per keystroke, `compute_child_layout` 16,140 to 141.

Which is exactly why the next item is the important one in this document.

### 2.4 The whole-document cache clear (not concurrency, ranks above it)

`ps-blitz/packages/blitz-dom/src/resolve.rs:663`:

```rust
if !self.deferred_construction_nodes.is_empty() {
    for (_, node) in self.nodes.iter_mut() {
        node.cache_mut().clear();
    }
}
```

If **any** node had its inline layout reconstructed during this resolve, **every** node in
the document loses its taffy cache. The comment above it is honest about why: it is the
workaround for the text-spill bug, clearing the rebuilt nodes and their ancestors was tried
and was not enough, and it says outright that "It costs a full layout on resolves that
reconstruct, which are rare next to the ones that do not."

The question is whether "rare" holds. Reading the mutation paths, it may not:

- `mutator.rs:178` `set_node_text` inserts `ALL_DAMAGE` on the text node (`:193`) and on
  its parent (`:203`). `ALL_DAMAGE` includes `CONSTRUCT_BOX`/`CONSTRUCT_FC`, which is the
  gate at `resolve.rs` `resolve_layout_children_recursive`, so the parent re-collects; an
  all-inline parent then pushes a deferred inline task at
  `blitz-dom/src/layout/construct.rs:610`. **That is every streaming token.**
- A tab switch reconstructs the revealed subtree wholesale, so it clears too.

If that is right, the headline "layout 0.27ms per keystroke" describes resolves that do not
reconstruct, and streaming and tab switching get the uncached number. This is a
measurement, not an argument, and it is item B1.

It is also the same site as the open "text spills past its container" bug in
[TODO.md](TODO.md), which is a reason to be careful rather than a reason to hurry.

### 2.5 Box construction and text shaping: we already wrote the parallel version and left it off

| | Ours | Blitz upstream | Chromium |
|---|---|---|---|
| Deferred inline construction | `blitz-dom/src/resolve.rs:553` `resolve_deferred_tasks` | same | n/a |
| Parallel fan-out | `resolve.rs:561` `into_par_iter()`, behind `parallel-construct` | **enabled**: `apps/browser/Cargo.toml:53`, `apps/readme/Cargo.toml:47` | main thread, but heavily cached (`ShapeCache`, `ShapeResult`) |
| Per-thread font context | `blitz-dom/src/document.rs:253` `thread_font_contexts: ThreadLocal<RefCell<Box<FontContext>>>`, used at `resolve.rs:577` | same | n/a |
| Feature declared | `blitz-dom/Cargo.toml:52`, with `rayon` at `:94` and `thread_local` at `:109`, both unconditional | same | n/a |
| Enabled by this app | **no**: `../apps/gui/Cargo.toml` asks for `["system-fonts"]` only | n/a | n/a |

The comment at `construct.rs:608` states the intent: "Deferring construction of inline
layouts to a dedicated phase allows us to multithread the expensive text shaping step." We
defer it and then do it on one thread.

This phase is most of what a tab switch or a first Settings open costs, because the
revealed subtree's box tree is rebuilt and every all-inline container reshapes from
scratch. It is the one place in the stack where data parallelism is already written,
tested upstream, and switched off here.

Cost to watch: one cloned `FontContext` per rayon worker. Against the 855MB RSS recorded in
TODO item 3, that is a real tradeoff and belongs in the same measurement.

### 2.6 Paint and present

Ours, `ps-anyrender/crates/anyrender_vello/src/window_renderer.rs:491`, in the source's own
words:

> `AutoVsync` resolves to FIFO, whose `present` blocks the calling thread until the next
> vblank. That call happens on the main thread, so the block also stalls event handling: a
> frame costing 3ms of real work still occupies the thread for a full refresh interval, and
> input arriving during the wait is deferred to the frame after next.

`present_mode_from_env` at `:498` reads `BLITZ_PRESENT_MODE` and defaults to `AutoVsync`.
The identical code and comment exist in
`crates/anyrender_vello_hybrid/src/window_renderer.rs:556`. **Nothing in agencyzero sets
that variable**: `scripts/local-delivery.sh:68` pins `BLITZ_INCREMENTAL`,
`TAURI_BLITZ_CONTROL_DESCRIPTOR`, `BLITZ_FRAME_STATS` and `BLITZ_FRAME_STATS_FILE` into
`LSEnvironment`, and not this one.

The root `Cargo.toml` already complains about it in a comment ("FIFO blocks the main thread
in `present`, which stalls event handling for a whole refresh interval per frame") and
nothing was done.

Theirs: Chromium presents in the GPU process and the renderer never blocks on vblank;
scheduling is driven by `BeginFrame` messages instead. WebRender presents on its renderer
thread. In both, a slow frame is a late frame, not a frozen input queue.

### 2.7 The IPC boundary: 34 of 97 commands run inside the frame

`tauri-runtime-blitz/crates/tauri-runtime-blitz/src/ipc.rs:15` states the rule: "JavaScript
invokes the handler on the document's owning thread." The handler is installed at `:26` and
calls Tauri's IPC handler inline.

Tauri then decides. `tauri-macros-2.6.3/src/command/wrapper.rs`:

- a non-`async fn` gets `ExecutionContext::Blocking` (`:50`), whose `body_blocking` emits
  `let result = $path(...)` and runs **on the calling thread**;
- `#[tauri::command(async)]` on a sync fn is labelled `"sync_threadpool"` (`:264`) and goes
  through `body_async`, which hands the call to `respond_async_serialized` and off the
  window thread.

So every non-async command in this app executes between two frames of the UI it is
serving. There are 97 commands and 34 are non-async:

| File | Commands (line numbers) |
|---|---|
| `apps/gui/src/projects.rs` | `list_projects:1958`, `get_home_snapshot:1978`, `list_items:2011`, `get_item_context:2194`, `list_messages:2833`, `get_io_persist:5259`, `list_agent_io:5390`, `list_running_tasks:5900`, `list_task_log:5925`, `list_approval_rules:7027`, `list_recoverable_sessions:7965`, `get_checkpoints:8569`, `get_project_concise:8610`, `get_project_notes:8641`, `list_rate_limits:8720` |
| `apps/gui/src/main.rs` | `list_capabilities:672`, `get_build_info:707`, `get_persistence_failure:712`, `log_frontend:727`, `list_table_sizes:750`, `open_external:796`, `get_log_path:817`, `get_workspace_root:861`, `create_workspace_root:874`, `get_data_location:886`, `set_data_location:1070`, `get_store_backup_status:1084`, `get_settings:1301`, `greet:1455` |
| `apps/gui/src/prs.rs` | `list_pull_requests:629`, `discover_pull_requests:711`, `refresh_pull_request:717` |
| `apps/gui/src/questions.rs` | `list_questions:94` |
| `apps/gui/src/study.rs` | `get_study_summary:298` |

Not all are equal. `greet` and `get_build_info` are free. The ones that scale with the
store are the problem: `list_messages:2833` scans `question_reply`, scans `message`, calls
`full_body` per row to stitch overflow chunks back together, builds a DTO per row and
sorts. `list_table_sizes:750` walks the data directory counting files. Those run inside
your frame.

Writes are already off-thread at the storage layer: `apps/gui/src/db/tables.rs` gives every
table a WorkTable persistence worker (`persistence_monitor` per table, `:240` onward). It
is the reads and the DTO construction that are not.

Theirs: in Chromium the equivalent work is in the browser process by construction and the
renderer reaches it over async Mojo. There is no version of this where a store read happens
on the compositor's clock.

### 2.8 Scheduling and yielding

| | Ours | Chromium | fastrender |
|---|---|---|---|
| Interruptible main-thread work | none: `resolve` is one call | task queues with priorities and idle tasks, `third_party/blink/renderer/platform/scheduler/main_thread/` | fuel-based: "Each operation consumes fuel; when fuel exhausts, execution yields to the host" |
| Frame budget | none | yes, drives idle-task admission | n/a |
| Application-level staging | **yes, frontend only** | `requestIdleCallback` | n/a |

We do have one piece of this, and it is worth crediting because it is the pattern the rest
should follow. `apps/gui/frontend/src/features/settings/SettingsTab.tsx` mounts Settings in
stages: `SETTINGS_FIRST_PAINT = 3` at `:2230`, `admitSection` at `:2256`, and each
`Section` admits itself when it comes within `SETTINGS_PREBUILD_PX` of the viewport
(`:2238`, `:2295`). performance.md records what that bought: first open 1388ms to 196ms.

There is no equivalent on the way out, and no engine-side equivalent at all.

The animation clamp is done: `ANIMATION_TARGET_FPS = 30` at `blitz-shell/src/window.rs:163`,
`poll_animation_frame` at `:543`, and `ControlFlow::WaitUntil` at
`blitz-shell/src/application.rs:256`. That was TODO item 5.

### 2.9 Garbage collection

Boa collects stop-the-world inside a single context, on the window thread. Chromium's
Oilpan marks incrementally, marks concurrently on worker threads, and sweeps lazily
(`third_party/blink/renderer/platform/heap/`).

Nothing to do here now. It is listed because it is the mechanism a user's phrase
"unloading something from memory" actually describes, and because it is the reason a
teardown that produces a lot of garbage can stall visibly even after the engine work above
is done.

---

## 3. Closing Settings, traced

Settings is never unmounted. `apps/gui/frontend/src/App.tsx:117` renders `<SettingsTab />`
unconditionally inside the boot gate and toggles `class` between `flex min-h-0 min-w-0
flex-1` and `hidden`. Closing the tab is `closeTab` in
`apps/gui/frontend/src/stores/workspace.tsx:1790`, which filters the tab array and calls
`focus`, and `focus` (`:1621`) only sets `activeKey` and a pref. **One attribute write on
one `div` is the entire application-level cost.**

What that write costs in the engine, in order:

1. `blitz-dom/src/mutator.rs:248` `set_attribute` snapshots the node (`:251`), sets
   `restyle_subtree()` and `ALL_DAMAGE` on it (`:255`, `:256`), and sets
   `restyle_subtree()` on **the parent** (`:262` to `:267`). The parent is `<main>`, so
   this restyles Home, Settings, and up to eight retained project tabs
   (`RETAINED_PROJECT_LIMIT = 8`, `App.tsx:28`).
2. Style runs sequentially: `stylo.rs:147` passes no pool.
3. `blitz-dom/src/layout/damage.rs:221` sees `display` changed, so
   `box_tree_needs_rebuild` is true for both subtrees.
4. `resolve.rs:334` `resolve_layout_children` re-collects, and every all-inline container in
   the revealed tab is queued at `construct.rs:610` for fresh parley shaping.
5. `resolve.rs:553` shapes them **one at a time**, because `parallel-construct` is off.
6. `resolve.rs:663` throws away the taffy cache for the whole document.
7. `resolve.rs:141` lays out uncached.
8. Three full-slab walks follow regardless of what changed: `clamp_scroll_offsets` at
   `resolve.rs:145` and `:58`, the `Position::Fixed` filter at `:697` which calls
   `primary_styles()` on every node, and the damage clear at `:155`. Retained hidden tabs
   are in the slab and are visited by all three.
9. `paint_scene` re-encodes the scene, then `present` parks the thread until vblank.

Steps 2, 5, 6 and 9 are addressed by items A2, A3, B and A1 respectively. Steps 1, 3 and 8
are not concurrency and belong to TODO items 8, 9 and the DOM list.

**The honest answer to "can a worker do the cleanup".** No, not as stated, and not for a
reason that a better design would fix cheaply. Boa and `blitz-dom` are deliberately
single-threaded (`tauri-runtime-blitz/.../script_queue.rs:10`: "`ScriptDocument` is
intentionally single-threaded"). The JS heap, the DOM and the layout tree are one thread's
data, so there is nothing separable to hand to a worker.
`ScriptQueue::enqueue_task` (`script_queue.rs:67`) is the seam, and everything it accepts
still runs on the document thread. What is reachable is: do less work (items B, and TODO 8
and 9), do it in parallel within the frame (A2, A3), stop blocking on vblank (A1), and
eventually move the whole pipeline off the OS thread (chain D).

---

## 4. The plan

Each item says what to change, what it depends on, and how to know it worked. Sizes are
guesses. Measure with three unpaced runs and discard the first, per
[HANDOVER.md](HANDOVER.md).

### Chain A: the flags. Independent of everything else, ordered only by measurement.

#### A1. Stop `present` parking the window thread

- **Where:** set `BLITZ_PRESENT_MODE=mailbox`. Cheapest correct home is `main` before any
  thread is spawned, defaulting rather than forcing so `fifo` still reproduces the old
  timing. `scripts/local-delivery.sh:68` `LSEnvironment` is the diagnostics-only
  alternative and must not ship.
- **Why:** `ps-anyrender/crates/anyrender_vello/src/window_renderer.rs:491`. A 3ms frame
  currently holds the thread for a full refresh interval and defers input by two frames.
- **Depends on:** nothing.
- **Blocks:** A2, A3, and every frame number in chains B and C. Under FIFO a main-thread
  saving does not show up in frame time.
- **Verify:** `BENCH_PACE=0 cargo run -q -p blitz-bench -- scroll`. Expect `frame total`
  to fall toward the sum of its phases and `missed_refreshes` to drop. Tearing is the
  failure mode to look for; `mailbox` should not tear, `immediate` will.
- **Size:** one line.

#### A2. Give Stylo its thread pool

- **Where:** `apps/gui/src/main.rs:95`, add
  `style_threading: blitz_dom::StyleThreading::Parallel`.
- **Why:** section 2.2. We link the parallel traversal and never pass a pool.
- **Depends on:** A1 for a readable measurement.
- **Verify:** the `style` phase on the stdout resolve line during a tab switch, which is
  the case that restyles every retained tab. Note performance.md measured style at 167
  microseconds on a *keystroke*, so a keystroke is the wrong workload to judge this on:
  use the switch. Also fix the wrong doc comment at
  `ps-blitz/packages/blitz-dom/src/config.rs:54` in the same change.
- **Size:** one line, plus a comment recording why the multi-document hazard does not
  apply here.

#### A3. Turn on `parallel-construct`

- **Where:** `apps/gui/Cargo.toml`, `blitz-dom` features, add `"parallel-construct"`.
- **Why:** section 2.5. The rayon fan-out at `resolve.rs:561` exists, upstream's own apps
  enable it, and text shaping is most of a tab switch.
- **Depends on:** A1 for a readable measurement.
- **Verify:** `cargo run -q -p blitz-bench -- click Settings`, and the `pconstruct` phase
  on the resolve line. **Measure RSS in the same run** (`vmmap`, per TODO item 3): this
  clones a `FontContext` per rayon worker via
  `blitz-dom/src/document.rs:253`, and the memory question is already open.
- **Size:** one line. The risk is memory, not correctness.

### Chain B: the cache clear. Highest value, lowest confidence, so it starts with a measurement.

#### B1. Find out how often `resolve.rs:663` actually fires

- **What:** count it. The resolve line already prints `caches_cleared` under
  `log-phase-times`; add a counter for the whole-document clear specifically, or read the
  hit rate across two workloads.
- **Compare:** a streaming reply against an idle document, and a tab switch against a
  scroll. If the hit rate collapses during streaming, the answer is yes.
- **Depends on:** nothing. Does not depend on chain A, because it is a ratio and not a
  duration.
- **Verify:** `grep "computed " /tmp/az.log` per HANDOVER's direct-launch recipe.
- **Size:** small. **Do this first in the whole document.**

#### B2. If it fires often, find why per-node clearing was insufficient

- **What:** the comment at `resolve.rs:655` says clearing the rebuilt nodes and their
  ancestors did not fix the spill, and that non-incremental mode does not spill. That is a
  reproducible difference, and it names the experiment: find what the full clear
  invalidates that the ancestor walk does not.
- **Depends on:** B1 saying yes.
- **Do not:** propose a narrowing without running the spill case. This site is the open
  "text spills past its container" bug in [TODO.md](TODO.md), two mechanisms for which have
  already been tested and refuted.
- **Size:** medium, and genuinely research.

#### B3. Narrow the clear

- **Depends on:** B2, and on TODO item 7 for a stable cache to measure against.
- **Verify:** the spill case first, then the hit rate.
- **Size:** unknown until B2.

### Chain C: get store reads out of the frame.

#### C1. Audit the 34 non-async commands

- **What:** classify each as read or write, and find whether the frontend ever depends on
  two of them completing in call order. `#[tauri::command(async)]` makes completion order
  non-deterministic, which is safe read-against-read and not safe read-against-write.
- **Depends on:** nothing.
- **Size:** small, and it is the whole risk of this chain.

#### C2. Move the heavy read-only ones off the window thread

- **Candidates**, all read-only and all scaling with store size: `list_messages:2833`,
  `list_task_log:5925`, `list_agent_io:5390`, `get_home_snapshot:1978`, `list_items:2011`,
  `list_projects:1958`, `list_running_tasks:5900`, `list_recoverable_sessions:7965`,
  `list_rate_limits:8720`, `get_item_context:2194`, `get_project_concise:8610`,
  `get_project_notes:8641`, `list_approval_rules:7027`, `list_pull_requests:629`,
  `list_questions:94`, `get_study_summary:298`, plus the two filesystem walkers
  `list_table_sizes:750` and `get_store_backup_status:1084`.
- **Leave alone:** the cheap ones (`greet`, `get_build_info`, `list_capabilities`,
  `get_log_path`, `get_settings`, `get_persistence_failure`, `get_io_persist`,
  `get_checkpoints`, `get_data_location`), where a thread hop costs more than the call, and
  the writers (`set_data_location:1070`, `create_workspace_root:874`, `log_frontend:727`),
  where moving a reader across a still-sync writer is exactly the reordering C1 is looking
  for.
- **Note for whoever does it:** `body_async` uses `respond_async_serialized`, which spawns
  onto the async runtime rather than a dedicated blocking pool, so a blocking store read
  occupies a tokio worker for its duration. That is off the window thread, which is the
  point, but it is not free and it is worth a comment at the site.
- **Depends on:** C1.
- **Verify:** `blitz-bench click` on a project tab with a large transcript, and
  `script.breakdown` for the `event:click` total.
- **Size:** small per command, and mechanical.

### Chain D: the architecture. Only after A, B and C are measured.

#### D1. Decide whether to adopt fastrender's split

- **What:** renderer on its own thread, window thread doing OS events and message passing
  only. The seam already exists in shape: `blitz-shell`'s `View` owns the document and the
  renderer and talks to winit through `BlitzShellEvent`, and `ScriptQueue`
  (`script_queue.rs:67`) is already a thread-safe ingress to the document thread.
- **Why it is a decision and not a task:** it needs a `Send` audit of everything `View`
  owns, it interacts with `run_on_main_thread` in
  `tauri-runtime-blitz/.../runtime.rs:274` and the main-thread id checks at `:278` and
  `:311`, and macOS window and accessibility APIs are main-thread only, so the split is not
  where a naive reading puts it.
- **Depends on:** A and C being measured, so the decision is made against a real remaining
  cost rather than this document's reasoning.

#### D2. Compositor-style scroll

- **What:** scroll without running the pipeline, which is Chromium's largest
  responsiveness feature and is what makes a busy main thread survivable.
- **Depends on:** D1, and it composes with damage regions (TODO item 12,
  [partial-paint.md](partial-paint.md)).
- **Status:** research. Nothing here is a design yet.

### Explicitly not on this list

- **Parallel layout.** Section 2.3. No engine worth copying does it, and our measured cost
  is cache behaviour.
- **Moving DOM teardown to a worker.** Section 3. There is nothing separable to move.
- **Anything from fastrender's multiprocess design.** It is unimplemented there.

---

## Addendum, 2026-08-12: what the Genet review amended

Source review of [Genet](https://github.com/merely-made/genet), a Servo fork on the same
Stylo + Taffy + parley + vello stack, read at `main` on 2026-08-12. It arrived at this
stack by subtracting from Servo where we arrived by adding to Blitz, so where the two
disagree that is evidence rather than opinion. Three items above change. **Still not
measured.**

The adoption verdict (do not depend on it, and why) is recorded in
[TODO.md](TODO.md) under "From the Genet review".

### A3 is no longer "flip a feature flag"

Genet does the same work and does it better, at
`components/genet-layout/box_tree.rs:2183-2256`:

| | Ours (`ps-blitz`) | Theirs |
|---|---|---|
| Where | `blitz-dom/src/resolve.rs:553` `resolve_deferred_tasks`, after box construction | a shaping pre-pass ahead of Taffy's measure walk |
| What is parallel | whole inline-layout construction, width-dependent work included | shaping only, which is width-independent; line breaking stays in the serial measure |
| Parallelism | `resolve.rs:561` `into_par_iter()`, behind `parallel-construct`, **off in this app** | `par_iter()` above a threshold, on by default |
| Threshold | none: compiled in, it always fans out | `PARALLEL_SHAPE_THRESHOLD = 24` |
| Per-worker context | `document.rs:253` `thread_font_contexts`, one `FontContext` clone per rayon thread | `map_init`, one clone per worker rather than per item |
| Hidden subtrees | reconstructed like any other | **skipped entirely** |
| Serial A/B | `BLITZ_INCREMENTAL` covers incremental layout; nothing covers shaping | `GENET_SHAPE_SERIAL` |

The difference is not the rayon call, it is what surrounds it, and each of the four is a
separate small change here:

1. **Split shaping from line breaking.** They shape each visible inline leaf into an
   *unbroken* `parley::Layout` in a pre-pass, because shaping is width-independent and only
   line breaking is not; the serial measure walk then re-breaks the cached layout per
   probed width. `blitz-dom` defers whole inline-layout construction instead, so the
   parallel phase carries width-dependent work with it.
2. **Add a threshold.** `PARALLEL_SHAPE_THRESHOLD = 24`, commented "Small DOMs (chrome UI)
   stay single-threaded, a work-stealing pool's spin-up costs more than the handful of
   leaves saves." `resolve.rs:561` has no threshold; compiled in, it always fans out. Our
   entire document is chrome UI, so this matters more here than it does for a browser.
3. **Skip `display: none` leaves.** "A `display: none` leaf is never measured or painted,
   so skip it." That is steps 4 and 5 of the Settings-close trace in section 3, deleted
   rather than parallelised. **This may be worth more than the parallelism**, because with
   Settings, Home and up to eight project tabs retained, most of what a tab switch
   reconstructs is invisible.
4. **Add a serial A/B switch.** `GENET_SHAPE_SERIAL` sizes the win from one binary, the way
   `BLITZ_INCREMENTAL` does for incremental layout. Nothing covers shaping here.

The memory caveat on A3 softens. Their `map_init` clones the font context **once per
worker rather than per item**, and notes the clone is cheap because parley's `Collection`
is shared. `blitz-dom`'s `thread_font_contexts` clone is the same parley clone, so the RSS
worry was probably overstated. Measure it anyway; it is one `vmmap` in a run already
planned.

### A2 gains a negative result

`components/genet-layout/cascade.rs:374`: "Sequential (no rayon pool)." **Genet has not
turned Stylo's parallel traversal on either.** So this is unexploited in both trees on the
same stack, and nobody has a measurement saying it is not worth it. That is a reason to
try it and a reason to stop describing it as a known win.

### D1 has a missing prerequisite, and it has a name

Chain D asks whether the renderer moves to its own thread and notes the seam is not where
a naive reading puts it. The reason is now clearer: **there is no value to send.** We paint
straight from the DOM into a vello `Scene` inside `View::redraw`, so "move the renderer"
means moving the DOM.

Genet emits a `GenetPaintList` through `paint_list_api`, kept in a separate repository so
it stays engine-neutral, and lowers it to a scene with `paint_list_render`. GPU-free
contract. That IR is the prerequisite for D1, and it is the same thing
[partial-paint.md](partial-paint.md) needs for damage and
[blitz-performance-architecture.md](blitz-performance-architecture.md) already decided
under "Stage rendering and carry change metadata forward".

**Reorder chain D accordingly:** a paint-list IR comes before the thread, and it pays off
even if the thread never happens.

### Section 2.8 gains a concrete API

`components/script-engine-api/lib.rs` gives the yield point this section says we lack:
`Budget` (`:51`), `PumpOutcome` (`:61`), `eval_bounded(source, budget)` (`:136`),
`pump(budget)` (`:188`). Cooperative budgeting at the engine boundary, the same shape as
fastrender's fuel, expressed as a trait rather than a scheduler.
