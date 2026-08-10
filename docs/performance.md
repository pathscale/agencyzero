# Performance: what is slow, how to know, and what was fixed

Written 2026-08-10, from measurements taken that day against a live build. Every
number here came from an instrument, not an estimate. Where something is
inferred rather than measured it says so.

## How to measure

Nothing below is reproducible without the diagnostics build, so start there.

```sh
scripts/local-delivery.sh stable        # includes blitz-inspector
```

Then launch with the control socket pinned somewhere findable:

```sh
cd /Users/revenge/code/agencyzero && open -n \
  --env BLITZ_INCREMENTAL=1 \
  --env TAURI_BLITZ_CONTROL_DESCRIPTOR=/Users/revenge/code/agencyzero/target/blitz-control.json \
  /Users/revenge/code/agencyzero/target/release/bundle/macos/AgencyZero.app
```

`open` does not inherit the shell environment, so every `--env` is load-bearing.

| Tool | What it answers |
|---|---|
| `scripts/blitz-probe.py frames` | One-shot read of the current frame window |
| `BENCH_PACE=0 scripts/blitz-bench.py scroll 200 -100` | Drives a fixed interaction and reports what it cost |
| `scripts/blitz-bench.py nodes` | Tree size, which is the input to every layout cost |
| `sample <pid> 20 1 -f out.txt` | Native stack profile. Works because `strip = false` |

The bench drives the app through the inspector's MCP socket, so a measurement is
repeatable rather than a description of how someone happened to scroll.

### Two levels of inspection

- **Agent level**: MCP over a Unix socket (`blitz.agent.control`,
  `blitz.diagnostics`). Metrics live here.
- **Debug level**: a WebDriver-shaped HTTP server, enabled with
  `TAURI_BLITZ_DRIVER=127.0.0.1:0` and `TAURI_BLITZ_DRIVER_DESCRIPTOR=<path>`.
  Useful for driving elements. It has **no** performance routes.

Field names inside protocol variants are snake_case (`max_depth`), while the
frame wrapper is camelCase (`requestId`). Getting this wrong produces a silent
timeout rather than an error, which costs half an hour every time.

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
   path checkout (`ps-blitz-az-30faf`, `tauri-runtime-blitz`, `ps-anyrender`)
   fails the app build with a diff that looks unrelated to what you changed.
6. **Piping the build through `tail` discards its exit status.** The honest
   check is the binary's mtime, not the exit code you think you saw.

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
eight mutation sites mark the tree dirty (`blitz-script/src/state.rs`,
`dom/element.rs`, `dom/node.rs`). It only resolves when something changed, so it
costs nothing measurable.

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

## What is still open

- **The mount stall.** One `poll_hook` call measured 812 ms. Steady state is
  0.67 ms, so this is one event, not a per-frame cost. It is the largest single
  remaining stall.
- **`renderer` at 6.55 ms** is now 76% of frame work. The `hybrid-renderer`
  feature swaps Vello for the lighter pipeline: renderer falls to 2.41 ms but
  scene rises to 7.29 ms, so it is a wash today. Damage-region redraw is the
  real answer.
- **`set_final_layout`** (`blitz-dom/src/layout/mod.rs:452`) takes a mutex lock
  on the shared font context, and taffy calls it once per node per pass. Not
  measured; it is the most suspicious code read during this work.
- **The poll loop.** `ScriptDocument::poll` is spun up to 100 times per
  snapshot. Idle polls cost approximately nothing, so this is a latency and
  design question rather than a throughput one, but a reactive runtime should be
  driving redraws from mutations instead. The waker machinery already exists.

## What the instrumentation added

None of the above was visible before this work. Layout reported the cost of
taking a snapshot as though it were the cost of a frame, with `scene`, `submit`
and `present` hardcoded to zero (`tauri-runtime-blitz/src/runtime.rs:689`), and
script execution had no timing at all.

- `blitz-shell/src/frame_stats.rs` publishes real per-frame timings with p95 and
  worst case. A one second mean hides the single slow frame anyone notices.
- `blitz-script/src/script_stats.rs` times `ScriptDocument::poll` and attributes
  it by source: event name, timer, startup, DOM call.
- Fields that cannot be measured are `None` with a comment saying why, never
  zero. A zero that looks like a measurement is how the original metrics misled
  for a year.
