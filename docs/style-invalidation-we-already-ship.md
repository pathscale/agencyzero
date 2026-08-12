# Style invalidation: we already ship the mature design, and override it twice

Written 2026-08-11, from reading Blink at
[`7e6a84f`](https://github.com/chromium/chromium/tree/7e6a84f5165fd617dbf3d032f755e11804bf8ff6),
Stylo 0.20.0 in the local cargo registry, and the `ps-blitz` checkout. **Nothing
here was measured or built.** Numbers quoted come from [performance.md](performance.md),
taken 2026-08-10.

This is about the **Blitz engine layer**, not about AgencyZero. Every line below applies
equally to any embedder of `blitz-dom`, including chuzz, which has the same finding written
up against its own checkout in `chuzz/docs/blink-for-a-browser.md`.

## The claim, up front

[dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) named our
worst DOM defect: a `class` write restyles the node's subtree **and the parent's subtree**.
The obvious conclusion was that we need Blink-style invalidation sets, which is a large
project.

That conclusion was wrong in a useful way. **Stylo already implements invalidation sets,
blitz-dom already calls into them, and then blitz-dom overrides the result twice.** The
work is not to build the mature design. It is to stop defeating the one we compile.

## What Blink does

Blink precomputes from the stylesheet which elements a class, id or attribute change can
affect. `InvalidationSet`
([`invalidation_set.h:63`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/invalidation/invalidation_set.h#L63))
documents it by example: for `.y .z {}`, class `y` gets a descendant invalidation set
**containing class z**, so changing `y` invalidates only `.z` descendants. `.v * {}` gets
`wholeSubtreeInvalid` as the explicit fallback. Their own doc states the alternative
plainly
([`style-invalidation.md:10`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/css/style-invalidation.md#L10)):

> The simplest possible approach is to invalidate everything in response to every change.

## Stylo has the same design

Not an equivalent. The same design, because Gecko drives Stylo the same way.

| Piece | Stylo 0.20.0 |
|---|---|
| `pub struct InvalidationMap` | `invalidation/element/invalidation_map.rs:318` |
| `class_to_selector` | `invalidation_map.rs:321` |
| `id_to_selector` | `invalidation_map.rs:324` |
| `other_attribute_affecting_selectors` | `invalidation_map.rs:330` |
| Processor that reads snapshots | `invalidation/element/state_and_attributes.rs:282` (`if snapshot.class_changed()`), `:314` (`if snapshot.id_changed()`) |
| Entry point | `invalidation/stylesheets.rs:252`, `pub fn process_style<E>(&self, root: E, snapshots: Option<&SnapshotMap>)` |

The design needs one input from the embedder: a **snapshot** of what the element looked
like before the mutation, so the invalidator can diff selector matches then against now.

## blitz-dom already provides that input

`resolve_stylist` calls the invalidator with the snapshots, every frame:

```rust
// ps-blitz/packages/blitz-dom/src/stylo.rs:77
self.stylist.flush(&guards).process_style(root, Some(&self.snapshots));
```

And `snapshot_node` (`blitz-dom/src/document.rs:1238`) builds `ServoElementSnapshot`
values, correctly skipping never-styled nodes to avoid a Stylo panic. The machinery is
wired end to end.

## Then we override it twice

### Override 1: every snapshot claims everything changed

`snapshot_node` fills the snapshot with, unconditionally
(`blitz-dom/src/document.rs:1300-1302`):

```rust
class_changed: true,
id_changed: true,
other_attributes_changed: true,
```

Those three flags are exactly what `state_and_attributes.rs:282` and `:314` consult to
decide **which invalidation maps to walk**. Setting all three on every snapshot tells the
invalidator that the class, the id and every other attribute changed, so it must union the
invalidations for all of them. A `value` write on a textarea is processed as though the
element's classes and id had also changed.

### Override 2: the mutation sites add a subtree sledgehammer

`set_attribute` (`blitz-dom/src/mutator.rs:245`) then adds, on top of the snapshot:

- `data.hint |= RestyleHint::restyle_subtree()` on the node (`:252`)
- `data.hint |= RestyleHint::restyle_subtree()` on the **parent** (`:261`)

with a standing `// TODO: make this fine grained / conditional based on
ElementSelectorFlags`. The same pattern appears at `:360`, `:473` and `:509`.

A restyle hint is a floor, not a ceiling. Whatever precision the invalidator computes, the
subtree hint is unioned on top and wins.

## Why you cannot simply delete the sledgehammer

This is the part that makes the fix ordered rather than a one-line revert.

`snapshot_node` at `document.rs:1258` contains:

```rust
if let Some(_existing_snapshot) = self.snapshots.get_mut(&opaque_node_id) {
    // Do nothing
    // TODO: update snapshot
}
```

**The first snapshot of an element in a frame wins, and later mutations to that element are
not recorded.** A component that writes `class` and then `value` on the same element in one
frame produces a snapshot describing only the first. Today that is masked, because the
subtree hint fires regardless. Remove the hint first and you convert a performance problem
into a correctness problem: stale styles that no test catches.

The `class_changed: true` blanket also currently masks it, which is why these two overrides
have to be unwound in the right order.

## The ordered fix

1. **Make snapshots updatable.** Replace the "do nothing" branch at `document.rs:1258` with
   a real update that merges the newly changed attribute into the existing snapshot. This
   is a correctness fix on its own merits, independent of performance.
2. **Set the changed flags honestly.** `snapshot_node` should take the attribute being
   changed and set only the relevant flag, rather than all three. `set_attribute` already
   knows the `QualName`; it just does not pass it down. This is the change that actually
   turns on `InvalidationMap`'s precision.
3. **Then narrow the hints.** Remove the parent `restyle_subtree()` at `mutator.rs:261`
   first, since a parent's subtree hint is the broadest of the two and the invalidator plus
   an honest snapshot should cover what it was insuring against. Then reduce the node's own
   hint from `restyle_subtree()` to `RESTYLE_SELF` where the snapshot path covers it.
4. **Verify with the counters, not with a stopwatch.** `computed X/Y nodes, N caches
   cleared` from `log-phase-times` is the signal. A correct change should reduce the
   distinct-node count with no visual difference.

Steps 1 and 2 are local to `blitz-dom` and do not need Stylo changes.

## Honest expectations

**Do not expect this to be fast.** [performance.md](performance.md) measured the whole
style phase at **167 microseconds** against **18 ms** of layout per keystroke, and
explicitly ruled selector matching out as a factor:

> Removing the parent's subtree restyle, building it and measuring gave 18.17 ms to
> 18.90 ms, which is noise.

That experiment is exactly step 3 done alone, without steps 1 and 2, and it measured
nothing. This document explains why it measured nothing: the snapshot was still claiming
everything changed, so the invalidator still had to union every map.

The value here is not milliseconds today. It is:

- **Correctness.** The snapshot update gap at `document.rs:1258` is a real bug hiding
  behind a performance workaround.
- **Headroom.** Restyle breadth feeds the damage that feeds layout. As long as every
  attribute write dirties a subtree, the damage narrowing proposed in
  [partial-paint.md](partial-paint.md) stage 1 has a floor it cannot go below.
- **Removing a standing TODO** that three separate mutation paths cite as a known
  compromise.

And the ordering constraint from
[dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) still holds:
**fix the Taffy cache first**, per [layout-caching-prior-art.md](layout-caching-prior-art.md).
This is the second move.

## Related

- [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) for the
  defect this answers, and the other mutation-path faults.
- [blink-what-we-can-learn.md](blink-what-we-can-learn.md) for the rest of the Blink
  review, including pending invalidations, the document lifecycle, and DOM storage.
- [layout-caching-prior-art.md](layout-caching-prior-art.md) for the cost that must be
  fixed before this one can show a number.
- `chuzz/docs/blink-for-a-browser.md` for the same finding against chuzz's checkout, where
  the stylesheets are arbitrary and the stakes are higher.
