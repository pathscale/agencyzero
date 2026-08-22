# TODO: DOM-related work

Written 2026-08-11. A plan, not a design doc: each item says what to change, where, why,
what it depends on, and how to tell it worked. The reasoning behind each lives in the
linked document.

**Engine paths here are `ps-blitz/packages/blitz-dom/src/...`**, the checkout this
repository patches in. Chuzz now consumes the *published* `ps-blitz-*` crates rather
than a second checkout, so a fix here reaches it only once it is released; it keeps its
own list at `chuzz/docs/TODO-dom-related-work.md`. **A fix in this tree does not reach
chuzz until it ships.** Items marked ENGINE need landing in both, or the
two checkouts need converging first.

Nothing below is measured unless it says so. Numbers cited come from
[performance.md](performance.md), 2026-08-10.

## Read first: three ordering constraints

1. **The Taffy layout cache gates every speed number.** performance.md measured style at
   167 microseconds against 18 ms of layout per keystroke. Anything here that promises
   milliseconds is gated on [layout-caching-prior-art.md](layout-caching-prior-art.md).
2. **Snapshot correctness before hint narrowing.** Item 1a must land before 1c, or a
   performance fix becomes stale styles.
3. **Instrumentation currently ships.** `log-phase-times` is on the base `blitz-dom`
   dependency line, so the counters you would measure with are in the release build and are
   not free ([allocations.md](allocations.md)). Fix that, or measure before-and-after on the
   same build.

---

## 1. Invalidation sets: stop overriding the ones we already ship

**This is the top item.** Full reasoning in
[style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md).

Stylo implements Blink's invalidation-set design, and `blitz-dom` already calls it every
frame. We then override the result twice.

| | Theirs | Ours |
|---|---|---|
| The design | Blink `invalidation_set.h:63` (`.y .z {}` invalidates only `.z` descendants), `style-invalidation.md:10` | n/a |
| Same design in Rust | Stylo `invalidation/element/invalidation_map.rs:318`, `class_to_selector:321`, `id_to_selector:324`, `other_attribute_affecting_selectors:330` | compiled into our binary today |
| Processor | Stylo `invalidation/element/state_and_attributes.rs:282`, `:314` | reached via `stylo.rs:77` `process_style(root, Some(&self.snapshots))` |
| Snapshot input | Gecko supplies per-element snapshots | `document.rs:1238` `snapshot_node` |
| Override 1 | n/a | `document.rs:1300-1302`: `class_changed: true, id_changed: true, other_attributes_changed: true`, unconditionally |
| Override 2 | n/a | `mutator.rs:252` and `:261`: `restyle_subtree()` on node **and parent** |

### 1a. Make snapshots updatable ENGINE

- **Where:** `document.rs:1258`, the `// Do nothing / TODO: update snapshot` branch.
- **What:** merge the newly changed attribute into an existing snapshot instead of dropping
  it. Today the first snapshot of an element in a frame wins and later mutations are lost.
- **Why:** correctness on its own merits. It is also the reason override 2 cannot simply be
  deleted.
- **Depends on:** nothing.
- **Verify:** a test that mutates two different attributes on one element in one frame and
  asserts both appear in the snapshot.
- **Size:** small.

### 1b. Set the changed flags honestly ENGINE

- **Where:** `document.rs:1300-1302`, and the call sites that reach it, chiefly
  `mutator.rs:245` `set_attribute`.
- **What:** pass the `QualName` being written down into `snapshot_node` and set only the
  matching flag. `set_attribute` already has it and discards it.
- **Why:** these three flags are exactly what Stylo reads at `state_and_attributes.rs:282`
  and `:314` to choose which invalidation maps to walk. All-true forces the union of every
  map on every mutation. **This is the change that actually turns the precision on.**
- **Depends on:** 1a.
- **Verify:** `computed X/Y nodes` from `log-phase-times` should show a lower distinct-node
  count for a keystroke, with no visual change.
- **Size:** small to medium.

### 1c. Narrow the restyle hints ENGINE

- **Where:** `mutator.rs:261` (parent) first, then `:252` (node). Same pattern at `:360`,
  `:473`, `:509`.
- **What:** drop the parent's `restyle_subtree()`, then reduce the node's own hint to
  `RESTYLE_SELF` where the snapshot path covers it. Removes a standing
  `// TODO: make this fine grained / conditional based on ElementSelectorFlags`.
- **Why:** a hint is a floor, not a ceiling. Whatever precision the invalidator computes,
  the subtree hint is unioned on top and wins.
- **Depends on:** 1a **and** 1b. performance.md already records this step done alone: it
  measured 18.17 ms against 18.90 ms, noise, because the snapshot still claimed everything
  changed.
- **Verify:** as 1b, plus visual verification per [ui-verification.md](ui-verification.md).
- **Size:** small, once 1a and 1b are in.

---

## 2. Pending invalidations: batch instead of invalidating at the mutation site

| | Theirs | Ours |
|---|---|---|
| Model | Blink `style-invalidation.md:134`: `StyleEngine` records into a `PendingInvalidationsMap` (`:92`) and pushes only when style is read (`:155`), because "there may be more mutations coming" | every mutation does its own ancestor walk inline |
| Sites | n/a | `mutator.rs:174` `set_node_text`, `:245` `set_attribute`, `:579` `add_children_to_parent`, each calling `mark_ancestors_dirty()` |

- **What:** accumulate per-node invalidation intent in a map, walk ancestors once at the top
  of `resolve`.
- **Why:** a SolidJS render touching fifty nodes currently pays fifty ancestor walks before
  anything reads style.
- **Depends on:** nothing, but it composes with the per-frame collection point
  [partial-paint.md](partial-paint.md) stage 1 needs anyway.
- **Verify:** count `mark_ancestors_dirty` calls per frame before and after.
- **Size:** medium. ENGINE.

---

## 3. Narrow `ALL_DAMAGE` on the mutation paths ENGINE

| | Theirs | Ours |
|---|---|---|
| Granularity | Blink separates style recalc, layout, prepaint and paint invalidation as distinct lifecycle phases (`document_lifecycle.h:47-79`) | `ALL_DAMAGE` is `0b0111_1111` at `layout/damage.rs:30`, including `CONSTRUCT_BOX`, `CONSTRUCT_FC`, `CONSTRUCT_DESCENDENT` |
| Text change | text content cannot change the parent's box construction | `mutator.rs:174` inserts `ALL_DAMAGE` on the text node **and on the parent** |

- **What:** give `set_node_text` a narrower damage set. A text node's content can change its
  parent's *size*, so `RELAYOUT` yes, `CONSTRUCT_BOX` no.
- **Why:** defensible on spec grounds rather than as an optimisation, and it is the mutation
  SolidJS performs most often (every streaming token).
- **Depends on:** ordering constraint 1. Expect no number until the Taffy cache is fixed.
- **Verify:** `caches cleared` count per keystroke, plus visual verification.
- **Size:** small. Full context in
  [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md).

---

## 4. `cloneNode(true)` is a naive recursive deep copy ENGINE

| | Theirs | Ours |
|---|---|---|
| Attribute storage | Blink `element_data.h:172` shares identical attribute sets via `ElementDataCache`, copy-on-write at `:219`, attributes inline at `:192` | `document.rs:872` `deep_clone_node`: per node a `data.clone()`, a `children.clone()`, a `Vec<usize>` collect, then recursion |

- **What:** a template fast path. Solid instantiates a template per component instance, so
  this runs once per list row.
- **Why:** several allocations per node, per instantiation, with no structural sharing.
- **Depends on:** nothing.
- **Verify:** allocation count per template instantiation.
- **Size:** medium.

---

## 5. DOM storage: shared attributes and rare data ENGINE

| | Theirs | Ours |
|---|---|---|
| Shared attribute sets | `element_data.h:172`, with the stated reason: "very common for many elements to have duplicate sets of attributes (ex. the same classes)" | `node/attributes.rs:7` `Attribute { name, value: String }`, `:15` a plain `Vec<Attribute>`. One owned `String` per attribute per element |
| Rare fields in a side table | `node_rare_data.h:108`, "sparse storage of fields for Node and Element" | `node/node.rs:90` carries everything inline for every node; `node/element.rs:35` puts `background_images` and `mask_images` on every element |

- **What:** measure first. Count distinct versus total attribute values on a live tree.
- **Why:** our UI is Tailwind, so class strings are long and duplicated per list row. This
  is the most plausible unexamined contributor to the unexplained 819 MB RSS in
  [allocations.md](allocations.md).
- **Depends on:** nothing. The measurement is cheap and should happen before any change.
- **Size:** measurement small, fix medium.

---

## 6. The whitespace tax on the DOM slab ENGINE

| | Theirs | Ours |
|---|---|---|
| Rationale | `WhitespaceLayoutObjects.md:8`: avoid layout objects for insignificant whitespace "to save memory, and save CPU by having fewer layout objects to traverse" | we already do the layout half: `layout/construct.rs:296`, `:318` filter whitespace from layout children |
| The gap | n/a | `resolve.rs:124` iterates the **DOM slab**, not the layout tree, so every whitespace text node costs a `Node` struct and a visit every frame |

- **What:** compare `blitz-bench nodes` against the count surviving into the layout tree.
- **Why:** sizes a fixed per-frame floor. Note `resolve.rs:56` `clamp_scroll_offsets` is a
  **second** full-slab walk per frame.
- **Size:** measurement trivial.

---

## 7. Class lists are re-split on every query ENGINE, low priority

| | Theirs | Ours |
|---|---|---|
| Parsed once | Blink stores parsed class names on element data (`element_data.h:54`) | `stylo.rs:514` `has_class` and `:633` `each_class` both call `split_ascii_whitespace()` on every Stylo query |

**Caveat, and it is the point:** performance.md measured the whole style phase at 167
microseconds and explicitly ruled selector matching out. Do not sell this as a performance
fix. Listed for completeness and because a cached split may help memory if it is interned.

---

## 8. Frontend: the streaming write path

Not an engine item, but it terminates in the DOM write path and it is the largest
quadratic in the app. Full detail in
[zero-copy-and-hot-paths.md](zero-copy-and-hot-paths.md).

- **Where:** `apps/gui/frontend/src/stores/workspace.tsx:1462`,
  `apps/gui/frontend/src/features/project/MessageBody.tsx:303`.
- **What:** stop accumulating the reply in a JavaScript string. Boa has no rope, so
  `current + delta` memcpys the whole reply per token.
- **Why:** the accumulated body is walked five to seven times per token.
- **Depends on:** nothing. This is the one item that does not need to wait for a measurement.
- **Size:** small to medium, frontend only.

---

## Suggested order

1. Item 5 and 6 measurements. Cheap, and they inform everything about memory.
2. Item 8. Frontend-only, no engine coordination, largest single win in the app.
3. Item 1a. Correctness fix, unblocks the rest of item 1.
4. Taffy cache work ([layout-caching-prior-art.md](layout-caching-prior-art.md)), which
   gates any speed number from items 1b, 1c and 3.
5. Items 1b, 1c, then 3.
6. Items 2 and 4 when convenient.
7. Item 7 only if a measurement ever points at it.

## Related

- [style-invalidation-we-already-ship.md](style-invalidation-we-already-ship.md), item 1.
- [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md), items 2 to 4.
- [blink-what-we-can-learn.md](blink-what-we-can-learn.md), items 2, 5, 6, 7.
- [layout-caching-prior-art.md](layout-caching-prior-art.md), the gate on most of this.
- [allocations.md](allocations.md), items 5 and 6, and the instrumentation caveat.
- [zero-copy-and-hot-paths.md](zero-copy-and-hot-paths.md), item 8.
