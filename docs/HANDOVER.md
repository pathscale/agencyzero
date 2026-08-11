# Handover: read this first

Written 2026-08-11, at the end of a long session, for whoever picks this up —
including a future me after a context compaction. Compaction loses the things
that were never written down, and what gets lost first is *process*: which tool
to reach for, which surface answers which question, and which of them lie.

This file is the entry point. It does not restate the plans; it says where they
are, what state they are in, and what you have to know to not waste a day.

---

## The three repositories, and how they are wired

| repo | branch | what it is |
| --- | --- | --- |
| `~/code/agencyzero` | `alloc` | the app |
| `~/code/ps-blitz-render` | `master` | the renderer fork (blitz-dom, blitz-script, blitz-paint, blitz-shell) |
| `~/code/ps-taffy` | `main` | the layout fork, branched from `DioxusLabs/taffy` at `main` |

Every one of them was checkpointed on 2026-08-11 to a branch named
`checkpoint/2026-08-11-*`. Nothing is pushed anywhere. `ps-blitz-render` is 58
commits ahead of `pathscale/master`.

**The wiring between them is local-only and must not be committed:**

- `agencyzero/.cargo/config.toml` carries an appended `[patch]` block pointing
  ps-blitz at `~/code/ps-blitz-render`. That file **is tracked** and also holds
  dead-strip rustflags, so **append, never overwrite**. It shows as modified in
  `git status` forever; that is intentional.
- `ps-blitz-render/Cargo.toml` points `taffy` at `../ps-taffy` by path. **This
  one is committed with the local path on it**, which will break any other
  machine. It is the sharpest edge in the tree right now.

`ps-taffy` is renamed to package `ps-taffy` with `[lib] name = "taffy"`, so
every `use taffy::…` in the dependent tree is unchanged. That is the house
convention for a fork of something we do not own — same as `ps-blitz-dom`
carrying `[lib] name = "blitz_dom"`. The fork that forgot that line is
`ps-accesskit-xplat`, whose doctest has been failing ever since and is the one
expected failure in `cargo test --workspace`.

**Publishing and upstreaming are both dead.** The owner's words: PRs go to
`pathscale/`, never to the original project. Do not raise it again.

---

## Building and running: the loop that actually works

```bash
scripts/local-delivery.sh quick     # ~50s
open /Users/revenge/code/agencyzero/target/release/bundle/macos/AgencyZero.app
```

`quick` builds the frontend dist and `az-gui`, swaps the binary into the bundle
already on disk, re-signs, restamps the bundle's date, and prints it. Full
bundles (`stable`) take several minutes and rebuild parts that cannot have
changed. **Build a bundle only when asked.**

Four things about this that each cost real time to learn:

1. **Never install to `/Applications`.** There are copies there from Aug 10 that
   nothing here writes to. Opening "AgencyZero" from Spotlight or the Dock
   starts one of those, and no build will ever reach it.
2. **The dist must be rebuilt.** Tauri embeds the frontend into the binary at
   compile time, so a Rust-only rebuild silently ships a stale frontend. `quick`
   does this now; it did not at first, and a frontend fix appeared to do nothing.
3. **The bundle's date used to lie.** Swapping the binary left the enclosing
   `.app` mtime untouched, so Finder and `stat` showed the last *full* build.
   Fixed by touching the bundle, but remember the shape: a fresh binary in a
   stale-looking bundle reads as a build that did nothing.
4. **Quit with `kill -TERM`.** Not a forced kill and not the AppleScript quit.
   `apps/gui/src/main.rs:2307` routes SIGTERM/SIGINT/SIGHUP to a graceful
   shutdown, and the WorkTable store is single-writer. Check who holds it with
   `lsof +D ~/Library/Application\ Support/com.pathscale.agencyzero/db`.

---

## Measuring: which surface answers which question

This is the part that gets lost, and getting it wrong wastes hours.

### The real app, via `blitz-bench` — anything with a number attached

```bash
cargo run -q -p blitz-bench -- frames        # phase timings per presented frame
cargo run -q -p blitz-bench -- layout Ask    # live boxes of named nodes
cargo run -q -p blitz-bench -- type 40 Ask   # drive real keystrokes
cargo run -q -p blitz-bench -- scroll        # drive wheel events
cargo run -q -p blitz-bench -- nodes|tree|watch|click
```

- **`BENCH_PACE=0` or the number is about the harness.** `scroll` and `type`
  sleep 1/60s between events by default. Unpaced the app does 120fps with zero
  missed refreshes; paced it reads 53 and looks broken. Every fps figure in this
  repository written before 2026-08-11 describes the bench, not the app.
- **Three runs, discard the first.** The first interaction after a launch is
  cold and reads several milliseconds high.
- **`layout` printed NaN for every box** until 2026-08-11, because `bounds`
  arrives as an array and the reader asked for named keys. Fixed. Mentioned
  because it had been consulted while broken.

### stdout — the layout counters, and only there

The resolve line carries the cache hit rate, the phase split and the layout
hotspots, from `blitz-dom/src/resolve.rs`. **It goes to stdout, which a
Finder-launched bundle discards.** Nobody had seen it. To read it, run the
binary directly:

```bash
BLITZ_INCREMENTAL=1 \
TAURI_BLITZ_CONTROL_DESCRIPTOR=$PWD/target/blitz-control.json \
  ./target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui > /tmp/az.log 2>&1 &
```

Then `grep "computed " /tmp/az.log`. You get `computed N over D distinct of T
nodes, cache H/L hits P%`, the `layout hotspots:` line naming the worst nodes,
and the per-phase split.

### The frame log — scene layer counts

`BLITZ_FRAME_STATS=1` plus `BLITZ_FRAME_STATS_FILE=…` writes a once-per-second
`[blitz-frame]` line carrying `layers_by_site=…`. `local-delivery.sh` pins both
into `LSEnvironment`, so a `stable` build writes `target/blitz-frame.log`.
Delete it before a run worth reading. The MCP surface carries timings only, so
layer counts exist nowhere else.

### The mock on :3010 — markup only, and it cannot stream

[ui-verification.md](ui-verification.md) describes it. It answers exactly one
question: does the markup come out right.

- **It proves nothing about performance, ever.** The browser runs V8 and a real
  DOM; the app runs Boa and `blitz-dom`. V8 has cons strings and Boa does not.
- **It emits no `run:text`.** `grep -c "run:text" src/api/mock.ts` returns 0, by
  design — `client.ts:419` says "it fakes no run". Nothing in the streaming path
  can be exercised there. Two attempts to do so looked like a driving problem.
- **Its projects are fixtures.** They were renamed on 2026-08-11 to `foo.bar`,
  `baz.qux` and `quux.dev` precisely because they used to carry the names of
  real repositories, and carrying one of those names into a statement about the
  running app is how invented data gets reported as fact. It happened.

### jsdom / vitest — the function, not the application

```bash
cd apps/gui/frontend && bun run test:run     # 509 tests
bun run bench                                # streaming parse benchmark, excluded from the suite
```

---

## Where the plans live

| document | what it holds |
| --- | --- |
| [TODO.md](TODO.md) | the index, with a **"Resume here"** section at the top |
| [allocations-plan.md](allocations-plan.md) | every performance measurement taken, step by step, with what each retired |
| [layout-caching-prior-art.md](layout-caching-prior-art.md) | the taffy cache thesis and its 5-item actionable list |
| [js-engine-big-problem.md](js-engine-big-problem.md) | the streaming quadratic, closed |
| [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) | the `ALL_DAMAGE` faults, item 9 |
| [driving-the-app.md](driving-the-app.md) | the tooling above, in full |

---

## What is in flight right now

### Doing: the owner's two remaining composer bugs (frontend only)

Reported as three; the first is fixed. Remaining:

- **The chat does not pin to the prompt area** — it slides under as the prompt
  grows.
- **With dialogs open the chat defaults to the wrong position**, cut under them.
  A wrong bottom calculation.

Both are **frontend, not engine**, which matters because the DOM work is
blocked. The transcript is a plain flex column: `az-scroll flex min-h-0 flex-1
flex-col … px-6 pt-14 pb-2` at `TranscriptPane.tsx:565`, inside
`Panel class="relative flex min-w-0 flex-1 flex-col"`, with the composer below
it as `flex flex-none flex-col … px-4 pt-2 pb-4` in `ProjectTab.tsx`. `az-scroll`
supplies `overflow-y: auto` (`theme.css:562`). Nothing reads `promptHeight`
outside the composer, and there is no bottom padding tied to it. On paper the
chain is correct, so the question is whether Blitz honours it — measurable with
`blitz-bench layout` before and after growing the prompt.

### Next: taffy, the known-dimension rejections

Miss reasons were instrumented and are recorded in
[allocations-plan.md](allocations-plan.md):

| rejection reason | share |
| --- | --- |
| parent size differs | **70%** |
| known dimension differs | **20%** |
| available space differs | 9% |
| no entry at all | <1% |

The 20% is the target: the validity test demands known dimensions match exactly,
and a node measured with a known width of 300 versus one offered `Definite(300)`
may well have the same answer. Same shape as the relaxation that already worked.

### Attempted and backed out: the parent-size relaxation

The 70% one. Built it — a `depends_on_parent_size` predicate on the length type
and on `Style`, supplied by the embedder — and it broke four
`grid_align_items_baseline_child_multiline` tests. **Two theories were refuted
by those same tests**: restricting it to the measure path changed nothing, and
storing the whole `LayoutOutput` so baselines survive changed nothing either.
Backed out rather than left half-understood. **Next step is to read one of those
four tests and find what actually differs, not to propose a third mechanism.**

### Blocked: DOM item 9, narrowing `ALL_DAMAGE`

Every fault is in `ps-blitz-render/packages/blitz-dom` — `mutator.rs:174`,
`:245`, `:579`, `layout/damage.rs:30`, `document.rs:872`, `resolve.rs:124`. The
owner is holding it for a "blitz mega update". Note that ps-blitz is already 58
commits ahead, so item 9 adds to a merge that is already large rather than
creating one.

---

## What landed today, so it is not re-done

- **Taffy cache**: layout 8.0ms → 0.27ms per keystroke, `compute_child_layout`
  16,140 → 141, hit rate 50% → 77%. Three fixes: Yoga's validity test, slots as
  plain storage rather than fixed categories, and sizing the cache to the working
  set. 5,541 generated layout tests unchanged throughout.
- **`element.style.x = y` was a silent no-op across the whole application.**
  `element.style` returned a throwaway object whose prototype had four members
  and no CSS property accessors. Fixed with a proxy. This is why the composer
  grew its container but never the field inside it.
- **Streaming quadratic closed**: incremental parse 142x, bounded directive scan
  6.1x. A 40KB reply spent 2.4s in the parse and now spends 17ms.
- **Textarea measured in device pixels** on a HiDPI display, so it wrapped at
  half its box width. Every existing test built its viewport at scale 1.0, the
  one scale at which the confusion cancels.
- **Scene layers 351 → 39**: 314 were `background-image: none` layers, still one
  layer in CSS, each pushing a clip and allocating a path to draw nothing.
- **Layer count is not the cost; clipped area is.** ~0.8µs for a background
  clip, ~110µs for a scrollport clip.
- **Every fps figure recorded before today described the benchmark's pacing.**

---

## Rules that are not negotiable, and were learned the hard way

- **Measure before theorising.** Two full sessions were lost to plausible
  mechanisms that the tests then refuted. When something will not reproduce, get
  a trace; do not narrate a theory from a screenshot.
- **Check whether the instrument already exists.** Three times in one day the
  timer being written already existed, once two crates away. Also
  `cargo tree -e features -i <crate>` when a feature looks like it is not
  compiled in: `ps-anyrender-vello` reaches the app through
  `tauri-runtime-blitz`, not through `ps-blitz-shell`.
- **A constant is only as good as the workload it was measured against.**
  `CACHE_SIZE` was tuned to 16 while `element.style` writes were dead. With that
  fixed the working set grew and 16 became the thrashing case. It is 24 now.
- **A tool that reports something untrue is worse than one that fails.** Two
  turned up today: `blitz-bench layout` printing NaN, and `quick` producing fresh
  binaries in stale-dated bundles.
- **Never touch the running instance or the store without checking.** Single
  writer. `lsof` first.
- **Never take over the desktop without asking**, and say which surface a fact
  came from — real app, mock, jsdom, or source reading. Mixing them is how a
  fixture project got reported as a real one.
- One change per commit. No AI attribution. No em dashes. Branch, never `master`
  in agencyzero.
