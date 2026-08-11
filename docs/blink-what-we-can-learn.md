# Blink: what is comparable, and what we can learn

Written 2026-08-11, from reading Blink at
[`7e6a84f`](https://github.com/chromium/chromium/tree/7e6a84f5165fd617dbf3d032f755e11804bf8ff6),
the same commit as [layout-caching-prior-art.md](layout-caching-prior-art.md). Line
numbers are stable against that commit. Our references are local reads. **Nothing here was
measured or built.**

Blink is far too large to review as a whole, so this covers only the subsystems that map
onto problems already documented in this repository. Each section is theirs, then ours,
then what to take.

## What is comparable at all

| Blink | Ours |
|---|---|
| `core/dom` | `blitz-dom` |
| `core/css` + Blink's own style engine | `blitz-dom` + Stylo |
| `core/layout` (LayoutNG) | Taffy via `stylo_taffy` |
| `core/paint` | `blitz-paint` |
| `platform/graphics` + cc + Skia | `anyrender` + vello + wgpu |
| `core/animation` | nothing equivalent |
| `bindings/` (V8) | `blitz-script` (Boa) |
| `DocumentLifecycle` | `BaseDocument::resolve()` |

Layout caching is covered separately in
[layout-caching-prior-art.md](layout-caching-prior-art.md) and is not repeated here.

## 1. Invalidation sets: the answer to our biggest DOM defect

**Theirs.** Blink precomputes, from the stylesheet, which elements a given class, id or
attribute change can possibly affect.
[`core/css/style-invalidation.md:10`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/style-invalidation.md#L10)
states the alternative in one line:

> The simplest possible approach is to invalidate everything in response to every change.

`InvalidationSet`
([`invalidation_set.h:63-90`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/invalidation/invalidation_set.h#L63))
documents the model by example:

- `.y .z {}`: class `y` gets a DescendantInvalidationSet **containing class z**, so
  changing `y` invalidates only descendants that are `.z`.
- `.v * {}`: class `v` gets `wholeSubtreeInvalid`, the explicit fallback.
- Sibling rules get `SiblingInvalidationSet`, with `InvalidationType` distinguishing
  descendants, siblings and nth-siblings
  ([`invalidation_set.h:51`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/invalidation/invalidation_set.h#L51)).

The doc is honest that this is conservative: "they err on the side of correctness, so we
invalidate elements that do not need recalculation".

**Ours.** `set_attribute` (`blitz-dom/src/mutator.rs:245`) sets
`RestyleHint::restyle_subtree()` on the node **and again on the parent**, with a standing
`// TODO: make this fine grained / conditional based on ElementSelectorFlags`. Every
reactive `class` write from SolidJS takes that path. There is no stylesheet-derived
knowledge of what a class can affect.

**What to take.** This is the mature answer to fault 3 in
[dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md). Stylo already
computes selector features for its own bloom-filter machinery, so the ingredients may
partly exist; the missing piece is a class-to-invalidation-set map consulted at mutation
time instead of `restyle_subtree()`. Large, but it is the difference between "restyle the
subtree" and "restyle the four elements that could match".

Note the ordering constraint from
[dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md): narrowing
style invalidation cannot pay off while the layout cache is thrashing, and performance.md
measured the style phase at 167 microseconds against 18 ms of layout. **Do the layout cache
first.** This is the second move, not the first.

## 2. Pending invalidations: batch, do not invalidate at mutation time

**Theirs.** A DOM change does not invalidate anything immediately. `StyleEngine` gathers
the relevant invalidation sets and calls
`PendingInvalidations::ScheduleInvalidationSetsForNode`, which records them in a
`PendingInvalidationsMap` keyed by node
([`style-invalidation.md:92`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/style-invalidation.md#L92),
[`:134`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/style-invalidation.md#L134)).
The map is only pushed **when style is about to be read**
([`:155`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/style-invalidation.md#L155)),
with the stated reason: "there may be more mutations coming".

**Ours.** Every mutation does its invalidation work inline, at the mutation site:
`insert_damage(ALL_DAMAGE)` plus `mark_ancestors_dirty()` on both the node and its parent,
in `set_node_text` (`mutator.rs:174`), `set_attribute` (`:245`) and
`add_children_to_parent` (`:579`). A SolidJS render that touches fifty nodes pays fifty
ancestor walks before anything reads style.

**What to take.** This one is smaller than section 1 and independent of it: accumulate
per-node invalidation intent in a map, and walk ancestors once when `resolve` starts rather
than once per mutation. It also composes with the damage accumulation proposed in
[partial-paint.md](partial-paint.md) stage 1, which wants a per-frame collection point
anyway.

## 3. Compositor animations: an enumerated answer to "can this be free?"

This closes the loop on the question that started this whole line of work, the composer
ring drift burning a core for decoration.

**Theirs.** `CompositorAnimations::CheckCanStartAnimationOnCompositor`
([`compositor_animations.h:146`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/animation/compositor_animations.h#L146))
returns a bitfield of **21 enumerated reasons** an animation cannot be accelerated
([`:70-143`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/animation/compositor_animations.h#L70)),
including:

| Reason | Bit |
|---|---|
| `kUnsupportedCSSProperty` | 1 << 13 |
| `kTransformRelatedPropertyCannotBeAcceleratedOnTarget` | 1 << 10 |
| `kFilterRelatedPropertyMayMovePixels` | 1 << 12 |
| `kTargetHasInvalidCompositingState` | 1 << 5 |
| `kTargetHasIncompatibleAnimations` | 1 << 6 |
| `kAnimationHasNoVisibleChange` | 1 << 17 |
| `kAffectsImportantProperty` | 1 << 18 |

The shape of the enum implies the accelerated set is transform-, filter- and
opacity-related properties, with everything else falling to `kUnsupportedCSSProperty`. That
is an inference from the failure reasons rather than a read of the allowlist itself, so
confirm before relying on the exact set.

`kAnimationHasNoVisibleChange` is worth noticing on its own: they refuse to run an
animation that cannot change any pixel.

**Ours.** One document-wide boolean. `is_animating()`
(`blitz-dom/src/document.rs:1640`) ORs `has_canvas`, `has_active_animations`,
`subdoc_is_animating`, custom widgets and scroll state, and `blitz-shell/src/window.rs:614`
requests the next frame whenever it is true. There is no notion of a property being cheap,
no compositor to run it on, and no way to ask why a given animation costs a frame.

**What to take.** Not the compositor, which needs the layerisation Blink has and we do not.
Two smaller things:

- **A "no visible change" check.** Cheap, and it is the generic version of the trick the
  composer ring already does by hand by dropping the class on blur.
- **A property classification**, even if the only two classes today are "needs a full frame"
  and "we could composite this later". Writing it down is what makes the eventual
  compositor path possible instead of a rewrite. This is the same idea recorded in
  [webrender-good-design-to-review.md](webrender-good-design-to-review.md) section 1 as
  treating opacity and transform as dependency values.

## 4. DocumentLifecycle: phases as a checked state machine

**Theirs.** `DocumentLifecycle::LifecycleState`
([`document_lifecycle.h:47-79`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/dom/document_lifecycle.h#L47))
is an explicit state machine, with paired in-progress and clean states for every phase:

```
kVisualUpdatePending
kInStyleRecalc  -> kStyleClean
kInPerformLayout -> kAfterPerformLayout -> kLayoutClean
kInCompositingInputsUpdate -> kCompositingInputsClean
kInPrePaint -> kPrePaintClean
kInPaint -> kPaintClean
```

Illegal transitions are a checked error, so "read layout during paint" is caught rather
than producing a stale number.

**Ours.** `BaseDocument::resolve()` (`blitz-dom/src/resolve.rs:43`) is a linear function
that runs style, damage, construct, flush, layout and transforms in sequence, instrumented
with `debug_timer` phases but with no state and no enforcement.

**What to take.** The relevance is concrete, not aesthetic.
[performance.md](performance.md) documents that a geometry read from script forces a
synchronous resolve costing 18 ms per keystroke, and that this cost hides from
`frameWindow.resolve` because it happens inside script. A lifecycle state would make
"script forced a layout flush from inside phase X" a first-class, attributable event
instead of something discovered by adding a `layout:flush_from_script` bucket after the
fact. Worth adopting as an enum plus assertions long before it is worth adopting as
architecture.

## 5. Paint result caching: they cache display items and whole subsequences

**Theirs.** `core/paint/README.md` describes two layers of paint caching
([`:403`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/paint/README.md#L403)):

- **Display item caching**
  ([`:409`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/paint/README.md#L409)):
  when a painter would produce a `DrawingDisplayItem` identical to last frame's, the
  previous one is reused.
- **Subsequence caching**
  ([`:415`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/paint/README.md#L415)):
  a whole `PaintLayer`'s display items are recorded as a subsequence, and if the layer is
  known to produce identical output, the entire subsequence is taken from cache without
  repainting.

**Ours.** `blitz-paint` rebuilds the whole visible tree into a fresh scene every frame
(`blitz-paint/src/render.rs:113`), and the vello scene is reset at the end of each frame.

**What to take.** This is exactly stage 4 of [partial-paint.md](partial-paint.md), and it
is worth noting that Blink implements *both* granularities: per-item and per-layer. Our
`anyrender::Scene` recording (`ps-anyrender/crates/anyrender/src/recording.rs:14`) is
already the right container for the per-layer version. The per-item version is likely not
worth it for us, because our items are cheap to rebuild and expensive to compare.

## 6. Empty paint phase optimization: a cheap idea we could use now

**Theirs.** Blink walks the layout tree once per paint phase, and sets a
`NeedsPaintPhaseXXX` flag on the containing self-painting layer during paint invalidation
when an object actually has content for that phase. Painting then skips the entire tree
walk for phases whose flag is unset
([`README.md:428`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/paint/README.md#L428)).

**Ours.** We do not have separate paint phases, so this does not port directly. The
transferable form is the underlying pattern: **a precomputed flag that lets a traversal be
skipped entirely**, rather than a traversal that discovers there was nothing to do. The
per-frame damage-clear loop at `blitz-dom/src/resolve.rs:124` walks every node
unconditionally and is the obvious candidate.

## 7. core/dom storage: where Blink spends memory and we do not think about it

`core/dom/README.md` is almost entirely web-platform semantics (shadow trees, slots, flat
tree traversal, event retargeting), which matters to chuzz and not to us. The transferable
material is in the storage headers, and it lands on the unexplained 819 MB RSS in
[allocations.md](allocations.md).

### 7a. Attribute sets are shared and copy-on-write

**Theirs.** `ShareableElementData` is produced by the parser for elements with identical
attributes and managed by an `ElementDataCache`
([`element_data.h:172`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/dom/element_data.h#L172)):

> This is a memory optimization since it's very common for many elements to have duplicate
> sets of attributes (ex. the same classes).

The attributes live inline after the object rather than in a separate allocation
([`:192`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/dom/element_data.h#L192)),
and `UniqueElementData` is created only when an element actually mutates its attributes
([`:219`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/dom/element_data.h#L219)).
Deriving inline style from the `style` attribute explicitly does **not** force uniqueness,
because all elements with the same style attribute share the same parsed block.

**Ours.** `Attribute` is `{ name: QualName, value: String }`
(`blitz-dom/src/node/attributes.rs:7`) and `Attributes` wraps a plain `Vec<Attribute>`
(`:15`). Every element owns a separate heap `String` per attribute value, with no sharing,
no interning and no copy-on-write.

**Why it matters here specifically.** Our UI is Tailwind, so class attributes are long and
massively duplicated: every row of a list carries a byte-identical class string, and we
allocate a fresh `String` for each. This is the single most plausible unexamined
contributor to the RSS number, and unlike most of that list it is testable cheaply by
counting distinct versus total attribute values on a live tree.

### 7b. Rare fields live in a side table

**Theirs.** `NodeRareData`
([`node_rare_data.h:108`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/dom/node_rare_data.h#L108))
"provides sparse storage of fields for Node and Element", so the common node stays small
and only nodes that need a field pay for it.

**Ours.** `Node` (`blitz-dom/src/node/node.rs:90`) is one flat struct carrying, for every
node including whitespace text nodes: `children: Vec<usize>`, `layout_children` and
`paint_children` as `RefCell<Option<Vec<usize>>>`, `stacking_context`, a `SharedRwLock`
guard, `before`/`after`, the full Taffy `style: Style<Atom>`, the 9-slot Taffy `cache`, and
**two** `Layout` structs (`unrounded_layout` and `final_layout`).

`ElementData` (`node/element.rs:35`) does the same one level down: `background_images` and
`mask_images` are `Vec`s present on every element regardless of whether it has either.

Nothing here is wrong, and inline storage is often the right call in Rust. But it is the
opposite of Blink's decision, made for a reason Blink states plainly, and we have an
unexplained memory number.

### 7c. Class lists are parsed once, not per query

**Theirs.** Blink parses the `class` attribute into a `SpaceSplitString` held on the
element data, described at
[`element_data.h:54`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/dom/element_data.h#L54)
as "attributes, inline style, and parsed class names and ids".

**Ours.** `has_class` (`blitz-dom/src/stylo.rs:514`) and `each_class` (`:633`) both call
`split_ascii_whitespace()` on the raw attribute value every time Stylo asks
(`:522`, `:640`).

**Honest caveat, and it is the important part.** [performance.md](performance.md) measured
the whole style phase at **167 microseconds** and explicitly ruled selector matching out as
a factor. So do not sell this as a performance fix. It is a design observation, and the
place it might matter is memory rather than time if the split ever gets cached.

### 7d. Whitespace: we do the layout half and pay for the DOM half

**Theirs.** Blink avoids creating layout objects for insignificant whitespace text nodes
"to save memory, and save CPU by having fewer layout objects to traverse"
([`WhitespaceLayoutObjects.md:8`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/dom/WhitespaceLayoutObjects.md#L8)).

**Ours.** We already do this for the layout tree: whitespace nodes are filtered out of
layout children (`blitz-dom/src/layout/construct.rs:296`, `:318`, `:393`) and
whitespace-only anonymous blocks are deleted (`:93`).

But the per-frame damage-clear loop at `blitz-dom/src/resolve.rs:124` iterates
`self.nodes`, the **DOM slab**, not the layout tree. Every whitespace text node a JSX
template leaves behind therefore costs a full `Node` struct in memory and a visit on every
frame, forever, despite contributing nothing to layout.

That is a concrete, cheap thing to measure: compare `blitz-bench nodes` against the count
of nodes that survive into the layout tree. If the gap is large, the fixed per-frame floor
in section 6 is larger than it needs to be.

## What not to take

- **The compositor and layerisation.** Sections 3 and 5 depend on `PaintLayer`, property
  trees and cc. That is the WebRender-scale commitment already ruled out in
  [why-not-webrender.md](why-not-webrender.md).
- **Blink's style engine wholesale.** We have Stylo, which is the same lineage of ideas
  with a Rust implementation and an existing bridge.
- **V8 bindings.** Covered in the Aurora review: the engine swap is small, the DOM bindings
  are the project.

## Ranked

1. **Pending invalidations** (section 2). Smallest, independent, and it composes with the
   damage collection point [partial-paint.md](partial-paint.md) stage 1 needs anyway.
2. **A `DocumentLifecycle`-style enum with assertions** (section 4). Cheap, and it turns
   script-forced layout flushes into an attributable event rather than a discovery.
3. **A "no visible change" guard and a property classification for animations**
   (section 3). Small, and it is the seam any future compositor path needs.
4. **Invalidation sets** (section 1). The real fix for our worst DOM defect, and correctly
   fourth: performance.md measures style at 167 microseconds against 18 ms of layout, so
   this cannot pay until the layout cache is fixed.
5. **Subsequence caching** (section 5), which is already stage 4 of partial-paint.md and
   carries the memory constraint recorded there.

Two measurements from section 7 belong ahead of most of that list, because they are cheap
and they feed the open memory question in [allocations.md](allocations.md):

- **Count distinct versus total attribute values** on a live tree. If Tailwind class
  strings are duplicated as heavily as they look, shared attribute data (7a) is a large
  and well-understood win.
- **Compare DOM node count against layout node count** (7d). The difference is whitespace
  we pay for on every frame and in every `Node` struct.

## Related

- [layout-caching-prior-art.md](layout-caching-prior-art.md) for Blink's layout caches,
  reviewed separately.
- [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) for the
  mutation-path defects sections 1 and 2 address.
- [partial-paint.md](partial-paint.md) for the paint-side plan sections 5 and 6 touch.
- [performance.md](performance.md) for the measurements that set the ordering.
