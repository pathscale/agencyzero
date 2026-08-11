# Layout caching: what five other engines do better than Taffy

Written 2026-08-11, from reading each engine's cache implementation that day. Every
external reference is pinned to a commit so the line numbers stay valid:

| Project | Pinned at |
|---|---|
| Taffy | [`d4a2b3b`](https://github.com/DioxusLabs/taffy/tree/d4a2b3bf17ed268e4ea5fc1f5a7c76430ad9c499) |
| Yoga | [`2071cb5`](https://github.com/react/yoga/tree/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b) |
| Chromium | [`7e6a84f`](https://github.com/chromium/chromium/tree/7e6a84f5165fd617dbf3d032f755e11804bf8ff6) |
| Gecko | [`6e5e5c5`](https://github.com/mozilla-firefox/firefox/tree/6e5e5c514eed06f70f74ade5a5586a8124031ec8) |
| Servo | [`35bc372`](https://github.com/servo/servo/tree/35bc3727ae28f7b41a5613755e2be5e385f7fc66) |
| Slint | [`b8c95d4`](https://github.com/slint-ui/slint/tree/b8c95d4e7059587a574a921dc67fb86c1f3fc9b6) |
| Masonry | [`7fe469d`](https://github.com/linebender/xilem/tree/7fe469d6bd1ddc486d406a6eb4f9e776b5ffe34d) |

**Nothing here was measured or built.** Our numbers come from
[performance.md](performance.md), taken 2026-08-10.

## The problem this is about

[performance.md](performance.md) measured **16,842 `compute_child_layout` calls from 15
dirty nodes** on a 4,899 node tree, a **52% cache hit rate**, and 18 ms of layout per
keystroke, and named it "the single largest engine cost in the application". Three
frontend fixes were tried against it and all three measured byte-identical, which is what
ruled the application out.

It is not a mystery and it is not misconfiguration. Taffy's own changelog says so under
0.12.0, the line we run:

> **More correct caching logic.** The cache key now includes the axis, parent size, and
> available space ... **This is a performance hit (~10% in common cases, ~60% in
> pathalogically ones) but is necessary for correctness.** (#911)

We are on 0.12.2. Our workload is the pathological case. Every engine below has a cache
that handles that case better, and four of the five ideas are portable.

---

# Group 1: Taffy versus Yoga, side by side

## Structure

| | Taffy | Yoga |
|---|---|---|
| Entries per node | 9 fixed slots + 1 final-layout entry | 8-entry ring + 1 `cachedLayout` |
| | [`src/tree/cache.rs:11`](https://github.com/DioxusLabs/taffy/blob/d4a2b3bf17ed268e4ea5fc1f5a7c76430ad9c499/src/tree/cache.rs#L11) | [`yoga/node/LayoutResults.h:25`](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/node/LayoutResults.h#L25) |
| Slot choice | **deterministic function of the query**, `compute_cache_slot` | **append**, index wraps at 8 |
| | [`cache.rs:187`](https://github.com/DioxusLabs/taffy/blob/d4a2b3bf17ed268e4ea5fc1f5a7c76430ad9c499/src/tree/cache.rs#L187) | [`CalculateLayout.cpp:2787`](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/CalculateLayout.cpp#L2787) |
| Store behaviour | **overwrites whatever occupies that slot** | appends, evicts oldest on wrap |
| | [`cache.rs:245`](https://github.com/DioxusLabs/taffy/blob/d4a2b3bf17ed268e4ea5fc1f5a7c76430ad9c499/src/tree/cache.rs#L245) | [`CalculateLayout.cpp:2799`](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/CalculateLayout.cpp#L2799) |
| Lookup | **exact key equality** on packed bits | **validity predicate** per entry |
| | [`cache.rs:225`](https://github.com/DioxusLabs/taffy/blob/d4a2b3bf17ed268e4ea5fc1f5a7c76430ad9c499/src/tree/cache.rs#L225) | [`Cache.cpp:44`](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/Cache.cpp#L44) |
| Ours | `blitz-dom` counts hits at `src/layout/mod.rs:516`, clears at `src/layout/damage.rs:90` | n/a |

## The two defects, precisely

### Defect 1: definite sizes collide in one slot

`compute_cache_slot` documents the assumption at
[`cache.rs:170`](https://github.com/DioxusLabs/taffy/blob/d4a2b3bf17ed268e4ea5fc1f5a7c76430ad9c499/src/tree/cache.rs#L170):

> definite available space shares a cache slot with max-content because a node will
> generally be sized under one or the other but not both

So a node measured at `Definite(300.0)` and then at `Definite(180.0)` writes both results
to the same slot, and `store`
([`cache.rs:245`](https://github.com/DioxusLabs/taffy/blob/d4a2b3bf17ed268e4ea5fc1f5a7c76430ad9c499/src/tree/cache.rs#L245))
overwrites unconditionally. Intrinsic sizing that re-descends with several definite widths
therefore destroys its own cache as it goes.

**Ours: null.** We do not wrap, patch or configure this; we inherit it through
`stylo_taffy`.

### Defect 2: lookup is key equality, not validity

Taffy's `get` for `RunMode::ComputeSize` returns an entry only when
`entry.key.kd_available_space == key.kd_available_space` and the parent size matches.

Yoga instead asks whether the **stored result is still correct**, in
[`Cache.cpp`](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/Cache.cpp).
Three heuristics, each a few lines:

| Heuristic | Line | Meaning |
|---|---|---|
| `sizeIsExactAndMatchesOldMeasuredSize` | [#L16](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/Cache.cpp#L16) | StretchFit and the requested size equals what we measured last time |
| `oldSizeIsMaxContentAndStillFits` | [#L22](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/Cache.cpp#L22) | new query is FitContent, old was MaxContent, and the new available size is at least the measured size, so the old answer still fits |
| `newSizeIsStricterAndStillValid` | [#L31](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/Cache.cpp#L31) | both FitContent, the new available space is smaller, but the content already fit inside it |

The third is our miss pattern exactly: re-descend with tighter available space where the
content already fit in less.

The lookup that uses them is
[`CalculateLayout.cpp:2712`](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/CalculateLayout.cpp#L2712),
a linear scan over live entries calling `canUseCachedMeasurement` on each.

**Ours: null.** No validity test exists anywhere in the stack.

### Defect 3 (ours, not Taffy's): we had to build our own cache instrumentation

Yoga publishes a `NodeLayout` event per node per pass tagged
`kCachedLayout` / `kLayout` / `kCachedMeasure` / `kMeasure`
([`CalculateLayout.cpp:2831`](https://github.com/react/yoga/blob/2071cb5c6eacc8b58f693267bad70cf41dc0fe8b/yoga/algorithm/CalculateLayout.cpp#L2831)),
so hit rate by kind is a built-in, always-available signal.

**Ours:** `layout_counters` in `blitz-dom/src/layout/mod.rs:29`, which we added, which is
gated behind `log-phase-times`, and which currently ships in the release build at a cost
(see [allocations.md](allocations.md)).

---

# Group 2: the other four engines, folded in

Two of them have caches better than Taffy's in ways Yoga does not cover. One has a
fundamentally different model. One has nothing to teach here, and saying so is part of the
answer.

## Chromium LayoutNG: N-way LRU, and it says why

**Better than both Taffy and Yoga.** Blink keeps **two separate caches**, each 8-way LRU,
each documented with the workload that forced it.

`MeasureCache`
([`measure_cache.h:23`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/layout/measure_cache.h#L23)):

> Implements an N-way LRU cache for "measure" layout results. Some layout algorithms (grid
> in particular) will measure an element multiple times with different constraint spaces.

`MinMaxSizesCache`
([`min_max_sizes_cache.h:17`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/layout/min_max_sizes_cache.h#L17)):

> Implements an N-way LRU cache for min/max sizes. Some layout algorithms (grid in
> particular) query the min/max sizes of an element multiple times with different initial
> block-size each time.

Both cap at 8 entries, and both comments name the exact test page that set the number.

Three mechanisms worth copying:

1. **Validity predicate, like Yoga.** `MeasureCache::Find` scans most-recent-first and
   calls `CalculateSizeBasedLayoutCacheStatus`, not an equality operator
   ([`measure_cache.cc:13`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/layout/measure_cache.cc#L13)).
2. **True LRU promotion.** A hit that is not already most-recent is erased and pushed to
   the back, so hot entries survive
   ([`measure_cache.cc:25`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/layout/measure_cache.cc#L25),
   and the same pattern in
   [`min_max_sizes_cache.h:43`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/layout/min_max_sizes_cache.h#L43)).
   Taffy's fixed slots have no notion of recency at all.
3. **Record whether the result even depends on the varying input.** `MinMaxSizesCache::Entry`
   stores `depends_on_block_constraints`
   ([`min_max_sizes_cache.h:36`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/layout/min_max_sizes_cache.h#L36)).

There is also a 72 KB test file, `layout_result_caching_test.cc`, which is the honest
signal for how subtle this is: cache correctness here is worth more tests than the cache
has lines.

## Gecko: cache on whether the result depends on the input at all

**The strongest single idea in this whole sweep**, and neither Yoga nor Taffy has it.

`IntrinsicISizesCache`
([`layout/generic/IntrinsicISizesCache.h`](https://github.com/mozilla-firefox/firefox/blob/6e5e5c514eed06f70f74ade5a5586a8124031ec8/layout/generic/IntrinsicISizesCache.h))
checks a frame state bit, `NS_FRAME_DESCENDANT_INTRINSIC_ISIZE_DEPENDS_ON_BSIZE`, before
choosing how to cache:

- **No dependency** on the varying input: one unkeyed entry serves every query, stored
  inline at `max(sizeof(nscoord) * 2, sizeof(void*))` with no allocation
  ([#L14-L17](https://github.com/mozilla-firefox/firefox/blob/6e5e5c514eed06f70f74ade5a5586a8124031ec8/layout/generic/IntrinsicISizesCache.h#L14)).
- **Dependency exists**: fall back to an out-of-line keyed cache holding the last
  percentage basis.

And the subtlety that makes it correct, in `GetOrSet`
([#L27](https://github.com/mozilla-firefox/firefox/blob/6e5e5c514eed06f70f74ade5a5586a8124031ec8/layout/generic/IntrinsicISizesCache.h#L27)):
it re-reads the dependency bit **after** computing, because computing is what discovers
the dependency.

Why this matters for us: our measurement was **16,842 recomputations over 140 distinct
nodes**. Most of those nodes almost certainly do not depend on the available space that
varies between queries. Under Gecko's model they would hit a single entry every time,
regardless of how many different constraints arrive.

## Slint: the cache is the reactive property graph

A different model rather than a better cache. Slint's layout results are stored as a
**property** (`layout.rs:872` calls it "the layout cache property"), in flat arrays with
two-level indirection for repeaters
([`internal/core/layout.rs:582`](https://github.com/slint-ui/slint/blob/b8c95d4e7059587a574a921dc67fb86c1f3fc9b6/internal/core/layout.rs#L582)),
and constraints are summarized as a compact `LayoutInfo` of min/preferred/max/stretch
([`layout.rs:24`](https://github.com/slint-ui/slint/blob/b8c95d4e7059587a574a921dc67fb86c1f3fc9b6/internal/core/layout.rs#L24)).

Because properties track their dependencies, invalidation is automatic and recomputation
is demand-driven. There is no hand-written validity predicate because there is no explicit
cache key.

**Not portable to us.** Taffy is called imperatively from Blitz's `resolve`, and Stylo
computes styles eagerly. Adopting this means adopting a reactive property system for
layout inputs, which is a re-architecture, not a patch. Recorded because it is the only
model in the sweep that makes the whole class of bug structurally impossible, and because
`LayoutInfo` is a useful reminder that a compact constraint summary can be cheaper to
cache than a full measurement.

## Servo: same architecture as us, and its cache is weaker

Worth knowing precisely because Servo is the closest comparable.
[`components/layout/layout_box_base.rs`](https://github.com/servo/servo/blob/35bc3727ae28f7b41a5613755e2be5e385f7fc66/components/layout/layout_box_base.rs)
holds:

- `cached_inline_content_size`: **a single entry**, keyed on the block-size constraint,
  with an explicit `TODO: Should we keep multiple caches for various block sizes?` at
  [#L111](https://github.com/servo/servo/blob/35bc3727ae28f7b41a5613755e2be5e385f7fc66/components/layout/layout_box_base.rs#L111).
- `cached_layout_result`: **a single entry**, plus a `cached_layout_result_dirty` flag
  ([#L52-L57](https://github.com/servo/servo/blob/35bc3727ae28f7b41a5613755e2be5e385f7fc66/components/layout/layout_box_base.rs#L52))
  used to preserve the cache across passes rather than clearing it.

So Servo has fewer entries than Taffy and no validity predicate. **Nothing to adopt on
caching.** One unrelated idea worth noting: `subtree_size`
([#L59](https://github.com/servo/servo/blob/35bc3727ae28f7b41a5613755e2be5e385f7fc66/components/layout/layout_box_base.rs#L59))
is a per-box count of its subtree, used as the heuristic for when parallel layout is worth
it.

## Masonry: dirty flags, no measurement cache

Masonry is a widget toolkit, so its layout protocol is a single pass with no intrinsic
re-descent, and there is nothing to cache per constraint.
[`masonry_core/src/core/widget_state.rs`](https://github.com/linebender/xilem/blob/7fe469d6bd1ddc486d406a6eb4f9e776b5ffe34d/masonry_core/src/core/widget_state.rs)
carries `request_layout` and `needs_layout` booleans (#L187, #L189), propagates them
upward (`self.needs_layout |= child_state.needs_layout`, #L374), and caches the resulting
`layout_border_box_size` (#L93).

**Nothing to adopt for caching.** Recorded so this engine is not revisited expecting more.

---

# Who has better caching, ranked

| Engine | Multi-entry | Validity predicate | LRU | Dependency-aware | Built-in hit instrumentation |
|---|---|---|---|---|---|
| **Chromium LayoutNG** | 8, two caches | yes | yes | partial | n/a |
| **Gecko** | keyed fallback | n/a | n/a | **yes** | n/a |
| **Yoga** | 8 ring | **yes** | no | no | **yes** |
| **Taffy (ours)** | 9 fixed slots | **no** | no | no | no (we added it) |
| Servo | 1 | no | no | no | no |
| Masonry | n/a | n/a | n/a | n/a | n/a |

Chromium and Yoga are the two worth a deeper head-to-head later. Gecko contributes one
orthogonal idea that beats both.

# Actionable, in order

1. **Confirm the regression is what we think it is.** Read taffy #911, then A/B taffy
   0.12.2 against 0.13.0 with the `computed X/Y nodes, N caches cleared` counters. The bump
   is not free: 0.13 changes `grid_template_areas`, `BlockContext::place_floated_box`, and
   the numeric helpers, and it has to happen in Blitz, which pins `taffy = "0.12.1"`.
2. **Port Yoga's three validity heuristics into Taffy's `get`.** Smallest change with the
   clearest mechanism, roughly 40 lines, and it directly targets the re-descent-with-tighter-space
   miss. Upstream as a PR rather than a fork, since #911 shows the maintainers are already
   weighing exactly this tradeoff.
3. **Replace the 9 fixed slots with an 8-entry LRU** (Chromium's shape). Removes the
   definite-size collision at `cache.rs:187` without changing correctness, because slot
   choice stops being load-bearing.
4. **Add dependency tracking** (Gecko's idea, Chromium's `depends_on_block_constraints`):
   record whether a measurement actually varied with the available space, and if it did
   not, let one entry answer every query. Highest ceiling of the four, and the most work.
5. **Split the cache by query kind** (Chromium's `MeasureCache` versus `MinMaxSizesCache`),
   only if 2 to 4 leave measurable misses.

Steps 2 to 5 are all changes to Taffy, not to us. Our only local lever is step 1, plus
deciding whether to carry a patched Taffy while an upstream PR lands.

# Related

- [performance.md](performance.md) for the measurement, and the three application-side
  fixes that measured identical.
- [allocations.md](allocations.md) for the cost of the counters this would be measured
  with, which currently ship in the release build.
- [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) for why
  narrowing DOM damage cannot pay off until this is fixed.

# Addendum, 2026-08-12: a second fork of Taffy 0.12, with no overlapping patches

From [genet-review.md](genet-review.md). Source reading, not measurement.

Actionable step 1 above notes that our only local lever is deciding whether to carry a
patched Taffy. There is now a second party carrying one, on the same version line, and
their patches and ours do not touch the same code.

Genet vendors Taffy at `=0.12.1` in `support/patches/taffy`, documented in their own
`GENET_PATCHES.md` and `UPSTREAM_PR.md`, with three changes:

1. a `find_content_slot` width-fit fix, where a full-width float yielded a zero-width slot
   at its right edge so a fixed-width BFC child was placed beside the float instead of
   below it, which they note is present on Taffy `main` too;
2. a float exclusion-band accessor, feeding parley-measured inline float wrap;
3. flex `order`, which Taffy does not model at all.

`ps-taffy` carries the measure cache, Yoga's validity test, slots as plain storage, and the
known-dimension relaxation, all of which are `cache.rs` and the `get` path. Theirs are
float placement and flex ordering. **No file is touched by both.**

Three things follow:

- If `float_layout` ever becomes ours, patch 1 is a bug fix we would otherwise rediscover,
  and patch 2 is the accessor an inline float wrap needs. Both are worth reading first.
- Their `UPSTREAM_PR.md` says they intend to upstream at their own pace. If the cache work
  in step 2 above goes upstream as a PR rather than a fork, as recommended, the two sets
  can converge in Taffy rather than in either fork.
- It is mild evidence for step 1's premise. Two independent consumers on the 0.12 line
  both found it necessary to fork, for unrelated reasons, which says more about Taffy's
  release cadence than about either fork.

**Not a reason to bump.** Their pin is `=0.12.1`; step 1's A/B against 0.13.0 is unaffected
by any of this.
