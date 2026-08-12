# The DOM mutation contract, and why SolidJS does not get fine-grained work

Written 2026-08-11, from a read of `blitz-dom`'s mutator, `blitz-script`'s DOM bindings,
`blitz-html`, and the built frontend bundle. **Nothing here was measured.** Every claim
about this stack is a read of code, with file and line. Numbers quoted come from
[performance.md](performance.md), taken 2026-08-10. Claims about other parsers are
recollection and are marked as such.

The question this answers: SolidJS is fine-grained by design, so is the DOM underneath it
forcing whole-tree work, and would a different or faster parser help?

Short version: the parser is irrelevant, the DOM API is fine, and **every mutation path
throws away the precision SolidJS hands it**, at the first line, on purpose, with two
standing TODOs saying so.

## What SolidJS actually does at runtime

No VDOM and no diff. JSX compiles to a template plus fine-grained writes. The
dom-expressions template helper is in the bundle, minified:

```js
i=()=>{let t=document.createElement("template"); return t.innerHTML=e, t.content.firstChild},
o=()=>(a||(a=i())).cloneNode(!0)
```

`a||(a=i())` is the whole contract. Each unique template is parsed **once, lazily, on
first use**; every instance after that is `cloneNode(true)`. Reactive updates after that
are single writes: `data` / `nodeValue` on a text node, `setAttribute` for a class or
style, `insertBefore` and `remove` for list reconciliation.

So the runtime hot path is three operations, in this order of frequency: **attribute and
text writes**, **`cloneNode(true)`**, and **child insertion and removal**. Not parsing.

Worth keeping in view: performance.md already ruled the binding layer out. 12,184 binding
calls across a whole session cost **4.95 ms combined**. The bindings are not the problem.
What a binding call *triggers* is.

## Can we read partial DOM?

Yes, in both senses of the question, and one of them is already the innerHTML path.

- **Fragment parsing.** `blitz-html` exposes `parse_inner_html_into_mutator`
  (`ps-blitz/packages/blitz-html/src/html_sink.rs:120`), which calls html5ever's
  `parse_fragment_for_element`: it parses into an existing element without touching the
  rest of the tree. This is what Solid's `template.innerHTML = ...` goes through.
  html5ever is also a streaming tokenizer, so incremental feeding is available if
  something ever needs it.
- **Partial reads.** Nodes live in `Box<Slab<Node>>`
  (`ps-blitz/packages/blitz-dom/src/document.rs:213`), so access by id is O(1)
  indexing. Nothing in the API forces a whole-tree read.

The whole-tree behaviour in this stack is not in the DOM API. It is in what a mutation
triggers, below.

## Would a faster HTML parser help?

No, and the numbers say so before any benchmark does:

- The boot document [dist/index.html](../apps/gui/dist/index.html) is **376 bytes**: a
  title, three metas, a script tag and `<div id="root">`.
- The bundle beside it is **609 KB**, and Boa parses and executes all of it.
- Solid's templates are small fragments, parsed once each, lazily, per the memoization
  above. Total HTML parsed across a session is a few tens of KB.

Lexbor (C) is, by recollection, the fastest HTML5 parser available and has Rust bindings;
html5ever is slower. Swapping would save microseconds on a cost paid once.

If "parser" is the real question, the parser that matters is **Boa on 609 KB of
JavaScript**. performance.md's open **mount stall** (one `poll_hook` call measured at
812 ms, worst cases 785 to 1369 ms, once per session, steady state 0.67 ms) has the shape
of bundle evaluation plus first mount. That is a JS engine question, not an HTML one, and
it is the one worth attributing.

## The faults

Each is a line of code, not an inference.

### 1. Every text update damages the parent with `ALL_DAMAGE`

`set_node_text` (`blitz-dom/src/mutator.rs:174`) inserts `ALL_DAMAGE` on the text node,
calls `mark_ancestors_dirty()`, then inserts `ALL_DAMAGE` **on the parent element**. From
JS, `data`, `nodeValue` and `textContent` all route here
(`blitz-script/src/dom/node.rs:251`).

This is Solid's finest-grained update, and it is what every streaming token performs, once
per token.

### 2. `ALL_DAMAGE` means rebuild, not repaint

`ALL_DAMAGE` is `0b0111_1111` (`blitz-dom/src/layout/damage.rs:30`), which includes
`CONSTRUCT_BOX`, `CONSTRUCT_FC` and `CONSTRUCT_DESCENDENT`. A text change therefore asks
for box reconstruction and formatting-context reconstruction on the parent. The narrower
vocabulary exists in that same file (`ONLY_RELAYOUT`) and no mutation path reaches for it.

### 3. `setAttribute` restyles the parent's whole subtree

`set_attribute` (`mutator.rs:245`) sets `RestyleHint::restyle_subtree()` and `ALL_DAMAGE`
on the node, then `restyle_subtree()` on the **parent**, directly under a standing
`// TODO: make this fine grained / conditional based on ElementSelectorFlags`.

Solid writes attributes constantly: every reactive `class`, every `style`, and the
textarea `value` on every keystroke.

### 4. Insertion and removal damage both parents at full strength

`add_children_to_parent` (`mutator.rs:579`) inserts `ALL_DAMAGE` and `restyle_subtree()`
on the old parent and again on the new parent, under the same TODO. `<For>` reconciliation
moves nodes between positions, so a list reorder damages every parent it touches.

### 5. `cloneNode(true)` is a naive recursive deep copy

`deep_clone_node` (`blitz-dom/src/document.rs:872`) clones `node.data` per node (element
data, attribute vec, qualified name), clones the children `Vec`, collects a new
`Vec<usize>`, and recurses. Several allocations per node.

This is Solid's template instantiation, so it runs once per component instance, which
means once per list row. There is no template fast path: no structural sharing, no
copy-on-write, no batch allocation into the slab. See [allocations.md](allocations.md) for
the surrounding allocation picture.

### 6. A leaf update dirties a root-to-leaf path

`mark_ancestors_dirty()` plus `restyle_subtree()` on the parent means one text write in a
deep tree (tab, panel, list, row, span) marks the whole ancestor chain and a subtree.
Solid's entire design is that a leaf update touches a leaf.

### 7. The per-frame floor is O(all nodes) regardless

`resolve.rs:124` walks every node each frame to clear damage. On a 6,331 node tree that is
a fixed cost no amount of fine-graining removes. Also relevant to
[partial-paint.md](partial-paint.md) stage 1, which proposes to accumulate damage in that
same loop.

## The ordering constraint, which matters more than the list

Do not fix faults 1 to 4 first and expect a number to move.

performance.md records three separate attempts at exactly this narrowing, all built,
shipped and measured, all producing **identical** results to the digit: 16,842
recomputations over 140 distinct nodes, 18,158 of 35,000 cache lookups hit, 15 caches
cleared, every run of every build.

The reason is not in the DOM. **Taffy keys its cache on available space, and intrinsic
sizing re-descends the subtree with values that never match what was stored**, so 15 dirty
nodes still produce 3.4x the whole document in `compute_child_layout` calls. Until that
keying is fixed, tighter damage feeds a layout stage that ignores how tight it is.

The order is therefore:

1. Fix the taffy cache keying. It is the single largest engine cost in the application and
   the precondition for everything below.
2. Narrow the damage in the mutation paths, faults 1 to 4.
3. Gate each step on the `log-phase-times` counters (`computed X/Y nodes, N caches
   cleared`), which are the only instrument that has so far distinguished "tight
   invalidation" from "cache absorbing nothing". Note that those counters currently ship
   in the release build and are not free: see [allocations.md](allocations.md).

## Where to start, concretely

The cheapest defensible experiment is fault 1, and it is defensible on spec grounds rather
than as an optimisation: **a text node's content cannot change its parent's box
construction, only its size.** So `set_node_text` damaging the parent with `RELAYOUT`
rather than `ALL_DAMAGE` is arguably correct, not merely faster, and it is the operation
Solid performs most often.

performance.md names the sibling experiment for the same class: stop a `value` write on a
text input from inserting `ALL_DAMAGE` and from restyling the parent's subtree, since a
textarea is a layout leaf sized from `rows` and `cols` and its content cannot change its
box. Both need visual verification, which the inspector's screenshot route cannot provide
(it returned byte-identical PNGs across three different builds), so verification has to be
[ui-verification.md](ui-verification.md) against the mock, plus the owner looking.

## Related

- [performance.md](performance.md) for the measurements, the three identical negative
  results, and the taffy cache finding this document defers to.
- [partial-paint.md](partial-paint.md) for the paint-side half of the same problem, and
  for the damage accumulation that would share `resolve.rs:124` with fault 7.
- [allocations.md](allocations.md) for `deep_clone_node`'s allocation profile and for the
  instrumentation currently compiled into the shipping build.
