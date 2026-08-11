# Genet and Pelt: a dependency audit, and four designs worth taking

Written 2026-08-12, from a treeless shallow clone read at `main` (last push 2026-08-10).
**Nothing here was measured**, and nothing was built: this is a source and manifest review
plus their own CI logs.

[Genet](https://github.com/merely-made/genet) is a Servo fork rebuilt on the Linebender
stack: Stylo for cascade, Taffy for layout, parley for text, vello for paint, with
SpiderMonkey removed and replaced by a pluggable script-engine trait. **Pelt** is its
reference browser and the workspace's `default-members`. MPL-2.0, one author, 0 stars,
created 2024-12-01.

It is worth our attention for one reason: **it is the same architectural bet as ps-blitz,
made independently and from the opposite direction.** They subtracted from Servo; we added
to Blitz. Both arrived at Stylo plus Taffy plus parley plus vello. Where the two
disagree is therefore evidence rather than opinion.

## Why this document exists

Two questions were asked of it: whether it carries system or hidden C++ dependencies, and
whether anything in it transfers. The dependency answer is not a single yes or no, which
is why it needed writing down rather than answering in passing.

## Method, and its limits

- Treeless shallow clone (`--depth 1 --filter=blob:none --no-checkout`): 7.1 MB for
  187,905 files, then `git show HEAD:<path>` per file read. The full clone is about 1.6 GB
  and there was no reason to pay it.
- **No `Cargo.lock` is committed**, so the closure below is a walk over workspace manifests
  resolving `[workspace.dependencies]` aliases to their local paths. It is not a resolved
  dependency graph. Feature unification can pull in something a manifest walk does not see,
  so treat the closure as a floor, not a ceiling. A real `cargo tree` should be run before
  anyone acts on it, and cannot be today: their build does not currently pass.

## The dependency answer

### In-tree: clean

Zero `.c`, `.cc`, `.cpp`, `.h`, `.m` or `.mm` files anywhere outside `tests/`, which is
WPT and accounts for 186,173 of the 187,905 files. Three `build.rs` in the whole
repository (`components/livery`, `components/nematic/src/knot/expand`,
`components/shared/embedder`), and none of them contains `cc::`, `cmake`, `bindgen` or
`Command::new`. They are code generators.

### Pelt's closure: one C dependency

`default-members = ["ports/pelt"]`, so `cargo build` at the root builds Pelt alone. That
closure is 60 local crates and 148 external ones. The only non-Rust build input in it is:

**`ring 0.17`**, reached through `components/netfetcher`, which takes
`rustls = { features = ["ring"] }`, depends on `ring` directly, and adds `quinn` and `h3`.
ring compiles C and per-architecture assembly.

It is a deliberate and documented trade, not an oversight. `Cargo.toml:127`:

> aws-lc-rs removed 2026-05-15 per Mark's directive: genet should default to pure-Rust
> crypto, not aws-lc's NASM-required C+asm crypto. ... Crypto provider for any future
> rustls revival should use `ring` (rustls feature `ring`, pre-built asm on Windows since
> ring 0.17 — no NASM needed) or `rustls-rustcrypto` (fully pure Rust, slower).

Everything else in Pelt's closure that touches the platform binds rather than builds:
`windows` and `windows-sys`, `ash` (which dlopens libvulkan), `libc`, `mach2`, `dwrote`
(Windows only, via `fonts_traits`), the AccessKit platform adapters, and `arboard`.

**Absent from Pelt's closure:** HarfBuzz, FreeType, fontconfig, SpiderMonkey, GStreamer,
GLib, jemalloc, rusqlite.

### The workspace: all of it comes back

`cargo check --workspace` is a different program. Two vestigial Servo islands drag the C
and C++ back in:

| Island | What it pulls | Reached by |
|---|---|---|
| `components/fonts` (`servo-fonts`) | `harfbuzz-sys` **with `features = ["bundled"]`, which compiles vendored HarfBuzz C++**; `freetype-sys` on Linux/Android/FreeBSD; `yeslogic-fontconfig-sys` on Linux/FreeBSD; `objc2-core-text` on macOS; `dwrote` on Windows | only `components/shared/layout` (`layout_api`), which `genet-layout` explicitly does not use |
| `components/media/*` | `gstreamer-sys`, `glib-sys` and eleven more GStreamer crates, all pkg-config | `components/media/examples` is a workspace member and depends on `servo-media-auto`, which selects `servo-media-gstreamer` on x86_64 and aarch64 |

`genet-layout`'s own manifest records the first one as a deliberate cut, in a
commented-out line:

```toml
# layout_api = { workspace = true }  # EXPERIMENT: genet-layout uses parley, not servo-fonts/layout-api
```

**This is not theoretical.** Their CI runs `cargo check --workspace --all-targets` on
`ubuntu-latest` with no apt step, and it has failed on every run since at least
2026-08-09. The failure is `yeslogic-fontconfig-sys`'s build script panicking on
"pkg-config exited with status code 1", and the same log shows the entire GStreamer `-sys`
family being downloaded on the way there. The `cargo check -p genet-layout --target
wasm32-unknown-unknown` step is **skipped**, because the workspace check fails first, so
their no-native-deps witness is currently unproven rather than passing.

### The verdict, stated precisely

The README's "entirely Rust" is true of the thing you would embed and false of the
repository. Taking `genet-layout` as a dependency would take Stylo, Taffy, parley, resvg
and image, and none of the C++. Taking the workspace would take HarfBuzz and GStreamer.

One integration hazard to record now, in case it is ever relevant: **only one Stylo is
allowed in a dependency graph**, because `stylo` declares `links = "servo_style_crate"`,
and `[patch]` cannot rename its target. Genet solved this by renaming and publishing their
fork as `genet-stylo` (`Cargo.toml:307-322` explains the extern-name binding rule at
length). We reach stylo 0.20 through ps-blitz. Two Stylos in one binary is a link error at
best.

## What transfers

### 1. The width-independent shaping pre-pass

`components/genet-layout/box_tree.rs:2183-2256`. **The most directly applicable thing in
the repository**, and it is our concurrency item 16 done better.

They shape every visible inline leaf into an *unbroken* `parley::Layout` before Taffy's
serial measure walk, on the observation that shaping is width-independent and only line
breaking is not. The measure callback then re-breaks the cached layout per probed width.

| | Ours (`ps-blitz-render`) | Theirs |
|---|---|---|
| Where | `blitz-dom/src/resolve.rs:553` `resolve_deferred_tasks` | `box_tree.rs` shaping pre-pass, ahead of Taffy |
| Parallelism | `resolve.rs:561` `into_par_iter()`, behind the `parallel-construct` feature, **off in this app** | `par_iter()` above a threshold, on by default |
| Threshold | none: always parallel when compiled in | `PARALLEL_SHAPE_THRESHOLD = 24`, with the comment "Small DOMs (chrome UI) stay single-threaded, a work-stealing pool's spin-up costs more than the handful of leaves saves" |
| Per-worker context | `document.rs:253` `thread_font_contexts`, a `FontContext` clone per rayon thread | `map_init` clones the font context **once per worker, not per item**, noting the clone is cheap because parley's `Collection` is shared |
| Hidden subtrees | reconstructed like any other | **skipped**: "A `display: none` leaf is never measured or painted, so skip it" |
| Serial A/B | `BLITZ_INCREMENTAL` covers incremental layout, nothing covers shaping | `GENET_SHAPE_SERIAL` forces the serial path from the same binary |

Four things to take, in that order of value. The threshold matters more for us than for
them, because our whole document *is* chrome UI. The `display: none` skip is steps 4 and 5
of the Settings-close trace in [concurrency-todo.md](concurrency-todo.md) section 3,
deleted rather than parallelised. And `map_init` plus the shared-`Collection` note
materially softens the memory caveat on that item.

### 2. A paint-list IR as the layout/render seam

`genet-layout` emits a `GenetPaintList` through `paint_list_api`, which deliberately lives
in the **separate netrender repository** so that it is engine-neutral, and
`paint_list_render` lowers `PaintCmd` to a netrender scene. The contract is GPU-free.

We paint straight from the DOM into a vello `Scene` on the window thread, via
`blitz-paint::paint_scene` called inside `View::redraw`.

This is not a new idea here. It is exactly the decision already recorded in
[blitz-performance-architecture.md](blitz-performance-architecture.md) under "Stage
rendering and carry change metadata forward" ("extract only visible, paint-dirty nodes
into renderer-owned frame data"), which has never been built. Genet is that decision,
implemented, by someone on the same renderer family. A paint list is the thing that makes
damage regions ([partial-paint.md](partial-paint.md)) and a renderer thread
([concurrency-todo.md](concurrency-todo.md) chain D) implementable at all, because it is a
value you can diff, send across a thread, and test without a GPU.

### 3. Budgeted script execution

`components/script-engine-api/lib.rs`: `Budget` (`:51`), `PumpOutcome` (`:61`),
`eval_bounded(source, budget)` (`:136`), `pump(budget)` (`:188`).

Cooperative yielding at the engine boundary, the same idea as fastrender's fuel.
[concurrency-todo.md](concurrency-todo.md) section 2.8 records that we have no yield point
anywhere in the pipeline; this is what one looks like as an API.

It also reframes the engine question in
[js-engine-big-problem.md](js-engine-big-problem.md). That document's conclusion, "do not
switch engines for this", stands. What genet adds is a third option that document does not
consider: **put a seam in and keep Boa behind it.** They run Boa, Nova and Piccolo through
one trait.

The seam is not free, and the cost is visible in their manifest: they carry a fork of Boa
(`mark-ik/boa`, `genet` branch, adding `JsObject::downgrade()` and `WeakJsObject`) and a
fork of Nova (`merely-made/vano`, `genet-embedder` branch), both for weak reflector
references. A seam over engines that do not agree about GC handles is a seam plus two
forks.

### 4. Mechanical architecture enforcement in CI

`support/ci/check_dependency_cones.py` asserts, in CI and as a hard failure:

- `genet-extract`'s dependency set is **exactly** `{layout_dom_api}`;
- its build-dependencies are empty and its dev-dependencies are fixtures only;
- it never reaches `genet-layout`, `genet-render`, `paint`, `paint_list_render`,
  `netrender` or `wgpu`;
- no crate under `components/` path-depends on anything under `ports/`.

Alongside it, `cargo check -p genet-layout --target wasm32-unknown-unknown` is a standing
witness that the layout crate has no native dependencies. That is a far cheaper test than
the manifest audit in this document, which is the argument for it.

See "Where this leaves a gap" below: this is the one finding here with no home in our docs.

## What does not transfer

- **The Servo inheritance.** The workspace still carries the media stack, the fonts crate,
  ipc-channel, webxr, webgpu, and a `[workspace.dependencies]` table naming mozjs and
  thirteen GStreamer crates. That inheritance is what has their CI red, and it is the part
  of the repository we would be adopting a maintenance burden from.
- **Depending on it.** One author, 0 stars, a 21,000-line layout engine aimed at a moving
  WPT target, and a build that does not currently pass. Read it for designs.
- **Their Stylo threading, because they do not have any.**
  `components/genet-layout/cascade.rs:374` says so outright: "Sequential (no rayon pool)."
  This is a **negative result worth recording**: concurrency item 15 (give Stylo its thread
  pool) is unexploited in both trees, and nobody has a measurement saying it is not worth
  it. That raises the case for trying it and removes any claim that it is a known win.

## An adjacent fork worth knowing about

Genet vendors Taffy at `=0.12.1` (`support/patches/taffy`, documented in their
`GENET_PATCHES.md` and `UPSTREAM_PR.md`) with three patches:

1. a `find_content_slot` width-fit fix (a full-width float yielded a zero-width slot at its
   right edge, which they note is present on Taffy `main` too);
2. a float exclusion-band accessor, feeding parley-measured inline float wrap;
3. flex `order`, which Taffy does not model.

`ps-taffy` carries the measure cache and the known-dimension relaxation. **The two sets do
not overlap**, and both sit on the 0.12 line. Worth reading before either fork drifts
further, and worth knowing about if `float_layout` ever becomes ours. See
[layout-caching-prior-art.md](layout-caching-prior-art.md).

## Where this leaves a gap

Finding 4 has no home in this documentation set, and neither does the audit in the first
half of this document. The underlying subject is the same in both cases and it is not
performance: **it is whether the build graph is what we believe it is.**

We have hit that class repeatedly and recorded each instance separately rather than the
class:

- `blitz-dom/incremental` was not in the build graph and cost a measured 13x
  ([performance.md](performance.md), which calls it "the most fragile win here");
- `log-phase-times` shipped in release builds while being used to measure them
  ([allocations.md](allocations.md));
- [HANDOVER.md](HANDOVER.md) records `cargo tree -e features -i <crate>` as a rule learned
  the hard way, because `ps-anyrender-vello` reaches the app through `tauri-runtime-blitz`
  rather than where it was looked for;
- and genet's own fontconfig failure is the same class from the outside.

The countermeasures are scattered across four documents as war stories. A CI witness of
the shape genet uses would turn all of them into a test. **Recommended, not done here**:
either a short `docs/build-graph-witnesses.md`, or a rule in `AGENTS.md` under
Verification, since a working-agreement change is the owner's call.

## Related

- [concurrency-todo.md](concurrency-todo.md) for items 15 and 16, which findings 1 and 3
  amend, and chain D, which finding 2 unblocks.
- [partial-paint.md](partial-paint.md) for what a paint list would be used for.
- [blitz-performance-architecture.md](blitz-performance-architecture.md) for the staging
  decision finding 2 implements.
- [js-engine-big-problem.md](js-engine-big-problem.md) for the engine question finding 3
  reframes.
- [layout-caching-prior-art.md](layout-caching-prior-art.md) for the Taffy fork comparison.
