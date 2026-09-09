# Performance measurement: what is correct here and what is not

**Written 2026-09-06**, from a review prompted by getting the same thing wrong in another
repository and having to undo it. The mistake is easy to make, silent when made, and the shape of
the fix is already half present in this codebase.

## The rule

**Put the timer on the function, not on its callers.**

```rust
#[performance_measurement(name = "projects")]
async fn load_worktrees(...) -> Result<Vec<Worktree>> { ... }
```

expands to a clock read, the original body, and a record, in that order, inside the function. If
the function runs, there is a row. There is no call site to instrument, no feeder to forget, and
adding a twentieth caller cannot lose coverage.

The alternative - a timer placed where a call happens - fails silently and in the worst possible
way. A table that prints `[0]` looks like *"this did not happen"* and is indistinguishable from
*"nobody wired this up"*. Two real instances of that, both in EKOPathRS, both found only by
reading the printed table beside a report that contradicted it:

* one table was fed from a search controller that does not run on the path that emits an object,
  so it printed an empty table next to a report saying 109 transforms had fired;
* another listed two transforms of the fifteen that fired, because the timer sat one layer inside
  `apply_phases` and the caller asked `Transform::analyse` directly.

Both were fixed by moving the measurement onto the thing being measured.

`web3.trading-backend`'s `performance_measurement` crate is the house implementation and it is on
crates.io. `WorkTable` already depends on it optionally. Its `PerformanceProfiler` keys a global
map by `&'static str` and updates min, max, mean and count in place; the attribute macro in its
`codegen` half is what wraps the function.

## What this repository gets right

`apps/gui/frontend/src/api/tauri.ts:37`, in `tauriCall`, and its own comment states the principle:

> Every command, for free: this is the only place they go through, so the table gets the whole
> backend surface without a call site knowing.

That is correct and should not be changed. One choke point that everything passes through is the
same idea as putting the timer on the function: coverage does not depend on anyone remembering.

`apps/gui/frontend/src/lib/perf.ts` is a real accumulating table - `record`, `measure`, `start`,
`snapshot`, `reset` - surfaced through `features/settings/SettingsTab.tsx`. Four other components
record into it directly (`ProjectPanel`, `ProjectTab`, `TranscriptPane`, `stores/workspace`).

## What is wrong

### 1. The Rust half has 32 hand-placed timers and no table

| file | `Instant::now()` |
|---|---:|
| `apps/gui/src/projects.rs` | 19 |
| `apps/gui/src/agent_proxy.rs` | 7 |
| `apps/gui/src/angel.rs` | 2 |
| `apps/gui/src/main.rs` | 2 |
| `apps/gui/src/prs.rs` | 1 |
| `apps/gui/src/db/tables.rs` | 1 |
| **total** | **32** |

`performance_measurement` is **not a dependency of this workspace**. There is no aggregation, no
snapshot, and nothing the Settings panel can read. Each timer's value goes into a one-off field
such as `study.latency = Some(started.elapsed())` - a number on a struct, useful to whoever wrote
that line and to nobody else.

This is exactly the pattern that produces an empty table: a timer exists only where somebody
remembered, and nothing anywhere tells you where they did not.

### 2. Sixteen of the thirty-two are started and never read

32 `Instant::now()` against 16 `.elapsed()` in the same tree. Half the timers in the Rust half of
this application start a clock whose value is discarded. That is not a measurement, it is a
`let` binding, and the compiler will not complain because `Instant::now()` has no `#[must_use]`
obligation that survives being bound.

Any audit of "what do we measure" that greps for `Instant::now` overcounts by 2x.

### 3. The two halves report differently and cannot be compared

The TypeScript side measures the **IPC boundary**: `command X took 40 ms`. The Rust side measures
nothing centrally. So a slow command can be seen, and nothing says which part of it was slow. The
handoff between the two is the least interesting boundary in the system and it is the only one
instrumented.

## What to do

**1. Take the dependency.** `performance_measurement = "0.1"` in the workspace, plus
`performance_measurement_codegen` for the attribute. Both are already published and are what
`WorkTable` uses.

**2. Annotate the functions that hold the 32 timers**, and delete the hand-placed
`Instant::now()`/`elapsed()` pairs that only fed a local field. Start with `projects.rs`, which
has 19 of them and is where the owner's measured wins came from - a `find()` inside a `map()` was
191k closure calls and 930 ms of a 976 ms timeline build, and reads returning every row where the
query builder offers `limit`/`range_on`. Those were found by hand; the table is what finds the
next one.

**3. Keep the `tauriCall` choke point.** It is right, and after step 2 it becomes the outer row
of a nesting rather than the only row.

**4. Surface the Rust table beside the TypeScript one** in `SettingsTab.tsx`. One command that
returns `PerformanceProfiler::get_state()` as rows, rendered under the existing
"Application internal performance" section. Two tables side by side, same columns, so a slow
command and the function inside it appear together.

**5. Keep the runtime toggle honest.** `blitz-inspector` is compiled into shipping builds on
purpose and is near-free with the toggle off - cold load 31 ms toggle-off against 87 to 105 ms
toggle-on, same binary. The measurement table should be the same: on by default so a report is
never silently empty, and one relaxed load to turn it off. **Do not re-discover the feature flag
as the cost** - that has already happened once here.

## What not to do

**Do not time a region below the clock's resolution.** A function that runs in tens of
nanoseconds records noise about itself; count it and divide by a timed region that contains it.

**Do not report a sum as a share of the wall clock.** Annotated functions nest, so an outer row
contains its inner rows and the column does not add up to the run. Say so in the table rather
than subtracting children from parents, which turns every row into a difference of two
measurements.

**Do not rank on `count * median`.** A power-of-two bucket estimate reported one site as 2.16 ms
when its true total was 435 ms, because its median was 8 us against a 3.47 ms maximum. Keep the
exact total and rank on it; percentiles are for shape.

## How to know it worked

The check is not that a table appears. It is that **a function that ran has a row and a function
that did not is absent**, with no third case. Concretely: pick a command, exercise it once, and
confirm every annotated function on its path appears. Then delete an annotation and confirm that
row disappears rather than reading zero.
