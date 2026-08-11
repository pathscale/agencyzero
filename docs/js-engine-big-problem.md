# The streaming quadratic: what the JS engine has to do with it, and what it does not

Written 2026-08-11, from reading Boa at the pinned git rev this repository builds
(`8a1e8fe`), Brimstone at
[`9357af1`](https://github.com/Hans-Halverson/brimstone/tree/9357af1578873285873605cde15cae094f96cad5),
and the local frontend and `blitz-*` checkouts. **Nothing here was measured.** The
arithmetic below is arithmetic, and is labelled as such.

## Correction, first

An earlier summary of mine said that Brimstone "has exactly the thing our documented
quadratic needs". That is half true, and the false half matters more.

Brimstone does have cons strings, and Boa does not. But on **our** code path the engine's
rope would remove **one of six** full passes over the accumulated reply per token, because
we read the whole string back every token and reading forces a flatten. The quadratic is
architectural, not a property of the engine. Switching engines would not fix it, and fixing
it does not require switching engines.

## Second correction: step 1 does not remove the quadratic

Added 2026-08-11, after reading Boa rather than reasoning about it. Read this
before acting on the TODO, because the first item in that list is the one to
skip.

**`join` costs exactly what `+` costs.** Boa's `Array.prototype.join`
(`core/engine/src/builtins/array/mod.rs:1005-1026` at the pinned `8a1e8fe`)
collects a `Vec<JsString>` and makes a single `js_string!(&r[..])` call, which
lands in the same `concat_array` at `lib.rs:636`: one allocation of
`full_count`, one `copy_nonoverlapping` per operand. Holding `streaming` as
`string[]` and joining therefore allocates and copies the whole reply per token,
exactly as `current + delta` did.

And the join cannot be kept out of the per-token path, which is what step 1
asks for. `MessageBody` takes `body: string` and `splitBlocks(props.body)`
re-parses it every token at
[TranscriptPane.tsx:673](../apps/gui/frontend/src/features/project/TranscriptPane.tsx).
Something has to hand it a string on every delta.

**It is slightly worse than neutral.** `concat_array` makes two O(N) passes over
its operand list, the length sum and the copy loop, so joining N chunks adds an
O(N²) term across a reply that the string version never paid: about 156 million
pointer operations for the 12,500-token example above, on top of the same 312MB
of character copying.

Two further defects in step 1 as written:

- `props.streaming.length`
  ([TranscriptPane.tsx:686](../apps/gui/frontend/src/features/project/TranscriptPane.tsx))
  does not become "a sum over chunks". `Array.prototype.length` is the element
  count, so the character counter would read 12,500 instead of 50,000. It needs
  an explicit sum or a running total.
- The emptiness checks break silently, and there are more of them than a first
  pass finds: `ProjectTab.tsx:346`, `ProjectTab.tsx:463`, **`workspace.tsx:2092`**,
  and `<Show when={props.streaming}>` at `TranscriptPane.tsx:665`. `[]` is truthy
  and `[] !== ""` is always true, so "a run is streaming" becomes permanently
  true and the streaming bubble appears before the first token arrives.

### The refutation was already in this document

Step 2 says it outright: *"Without it the last block is the whole reply and the
DOM write stays O(body) per token no matter what the JS side does."* That last
clause is load-bearing and it applies to step 1 too. Bounding the block is what
makes any of the rest matter.

### Step 2 is not the fix either, and this is the third correction

Written after implementing it. Splitting prose on blank lines landed
(`MessageBody.tsx`), and reading the code around it says step 2's own claim was
also too strong.

- `MessageBody`'s memo calls `splitBlocks(props.body)` on every body change, and
  that walks the **whole body** to split it into lines no matter how many blocks
  come out. Still O(body) per token.
- The `sameBlock` comparisons across N paragraph blocks sum to the body length.
  Still O(body) per token.

**Correction, 2026-08-11, after testing it.** This section previously claimed the
DOM write was already bounded before the change, on the reasoning that the
`<For>` over `block.text.split(/\n{2,}/)` diffs paragraphs by value. That was
wrong, and the test says so: remove the blank-line flush and
`holds a finished paragraph still while the next one grows` fails.

The inner `<For>` never gets the chance to diff. With the whole reply as one
block, `sameBlock` fails on it, the memo hands the outer `<For>` a new block
object, and `<For>` tears the whole row down — inner `<For>` and every `<p>`
inside it. So passes 4 to 6 *were* costing what the ledger above says, and
splitting on blank lines is what bounds them.

So the paragraph split does two things: it bounds the DOM write, and it makes a
prefix cacheable. A paragraph closed by a blank line can never change again,
which makes everything before the last blank line provably settled, and a parse
whose only block is the whole message has no prefix to cache.

What it does *not* do on its own is make the parse sublinear, which is what the
incremental splitter below is for.

**The actual fix is an incremental parse**: keep the blocks already produced for
the settled prefix, and re-parse only from the last blank line onward. That is
the step that takes the per-token cost from O(body) to O(tail), and it is not
any of the five steps listed below.

### Measured, and fixed: 142x

Done 2026-08-11. `bun run bench` in `apps/gui/frontend`
([`streamingParse.bench.ts`](../apps/gui/frontend/src/features/project/streamingParse.bench.ts)),
timing what `MessageBody` actually does: parse every prefix of a reply arriving
in 4-character deltas.

| chars | full reparse | incremental | gain |
| --- | --- | --- | --- |
| 5,000 | 38.4 ms | 2.2 ms | 17.7x |
| 10,000 | 150.7 ms `x3.93` | 4.1 ms `x1.91` | 36.5x |
| 20,000 | 586.0 ms `x3.89` | 8.0 ms `x1.95` | 72.9x |
| 40,000 | 2348.0 ms `x4.01` | 16.4 ms `x2.05` | **142.8x** |

The ratio columns are the result, not the totals. Doubling the body used to
cost four times as much, which is the definition of the quadratic this document
is named for. It now costs twice as much. **A 40KB reply spent 2.3 seconds in
the parse and now spends 16ms.**

`createStreamingSplitter` keeps the blocks for everything up to the last blank
line and parses only what follows, so each character is parsed into a settled
block exactly once. A fence open across the boundary blocks the advance,
because a fence closed later turns settled prose into code retroactively. The
prefix is validated in constant time, by length and by the characters
immediately before the boundary; comparing all of it would reintroduce the cost
being removed, and a validation miss falls back to a full reparse, so it is slow
rather than wrong.

The equivalence test is the part that matters: every prefix of every body is
required to parse identically to a full reparse, across a fence spanning a
blank line, a table, a list, an unterminated fence and stray blank runs.

### Step 3 too: 6.1x, and the scan is now nearly free

`holdBackPartialDirective` had the same shape as the parse.
`lastIndexOf("<ps")` has to reach the start of the string before it can report
a miss, and a miss is the common case because most replies carry no directive.

| chars | whole body | last line only |
| --- | --- | --- |
| 10,000 | 9.6 ms | 4.4 ms |
| 40,000 | 105.9 ms | **17.3 ms** |

Both figures include the incremental parse underneath, which is 16.4ms of the
17.3, so the scan itself went from ~90ms to about 1ms.

The bound is exact, not a window: `isPromptSyntaxDirectiveLine` takes one line
and requires the directive to span it exactly, so an unterminated `<ps` can only
be on the last line. The test keeps the old whole-body scan as an oracle and
requires them to agree at every prefix.

### Pass 1 is all that is left, and it is small

The Boa concatenation is untouched and still copies the accumulated reply on
every token. It is now the whole of the remaining JS-side cost, and it is worth
sizing before anyone spends a day on it.

**Arithmetic, labelled as such**, on the 50,000-character example this document
opened with: 312,500,000 characters copied in total. ASCII takes Boa's latin1
path at one byte per character, so that is ~312MB of `copy_nonoverlapping`.
Memory bandwidth on this class of machine is on the order of 10GB/s, which puts
the whole of pass 1 at roughly **30 milliseconds spread across the entire
reply**, plus 12,500 allocations.

Against the 2.3 seconds the parse cost at 40KB, pass 1 is on the order of one
percent of the problem this document is named after. It is not worth the change
it would need, which is not the `string[]` of step 1 — that is neutral, shown
above — but `MessageBody` and the directive scan consuming chunks rather than a
string, across four files, plus a running character count and four emptiness
checks.

Two honest caveats. The bandwidth figure is an assumption rather than a
measurement, and it cannot be measured from the test suite: Node's V8 has cons
strings, so timing `s = s + delta` there measures a rope and tells you nothing
about Boa. It would have to be measured in the app. And allocation churn has
effects that do not show up as elapsed time, which is the same argument that
kept path caching alive in
[allocations-plan.md](allocations-plan.md).

**Recommendation: leave pass 1 alone** until something measures it in the app
and finds it matters.

### What to do instead

1. **Step 2 first.** Split prose on blank lines, bounding passes 3 to 6 to one
   paragraph. Independent of everything else, and the only step that changes the
   asymptotics on its own.
2. **Then measure.** Nothing in this document is measured, and it says so twice.
   Every figure here is arithmetic from source reading, which is how a step that
   wins nothing came to be ordered first.
3. **Revisit step 1 only if a real cost survives the bound**, and then do it
   properly: `MessageBody` consuming chunks rather than a joined string, a
   running character count, and every emptiness check converted. That is a
   larger change than "hold it as an array", and it is worth nothing until the
   tail is bounded.

## The chain, per streaming token

One delta arrives. Every row below walks the **entire accumulated reply**, not the delta.

| # | Pass | Where |
|---|---|---|
| 1 | `current + delta` allocates and copies the whole reply | [workspace.tsx:1462](../apps/gui/frontend/src/stores/workspace.tsx), into Boa `core/string/src/lib.rs:636` |
| 2 | `holdBackPartialDirective(text())` scans it | [TranscriptPane.tsx:673](../apps/gui/frontend/src/features/project/TranscriptPane.tsx) calling `:51` |
| 3 | `splitBlocks(props.body)` re-parses it | [MessageBody.tsx:303](../apps/gui/frontend/src/features/project/MessageBody.tsx) calling `:228` |
| 4 | `to_std_string_lossy()` copies and transcodes it | `blitz-script/src/dom/mod.rs:113`, reached from `dom/node.rs:238` and `:280` |
| 5 | `text.content != value` compares it in full | `blitz-dom/src/mutator.rs:183` |
| 6 | `clear()` + `push_str()` copies it again | `blitz-dom/src/mutator.rs:185-186` |

Passes 4 to 6 are bounded by the **tail block**, not the whole body, thanks to the memo at
`MessageBody.tsx:303`. That bound is worth nothing in the common case, and section
"Why the tail block is not a bound" explains why.

### The arithmetic

Take a 50,000 character reply arriving in 4-character deltas: 12,500 tokens. Each pass over
the accumulated body costs the prefix length, so one pass across the whole reply costs

```
sum of prefix lengths  =  L * N / 2  =  50,000 * 12,500 / 2  =  312,500,000 characters
```

Six passes is roughly **1.9 billion character-touches** for one reply, plus 12,500
allocations of steadily growing size in pass 1 alone, all of it garbage. This is arithmetic
from the code, not a measurement.

## Boa: three string representations, all eager

Boa's `JsString` (`core/string/src/lib.rs:138`) can be backed by three things, and none of
them is lazy:

| Representation | Where | What it is |
|---|---|---|
| `SequenceString<Latin1>` / `<Utf16>` | `core/string/src/vtable/sequence.rs`, used at `lib.rs:650`, `:653` | contiguous owned code units |
| `SliceString` | `core/string/src/vtable/slice.rs`, constructed at `lib.rs:575` | a view into an existing string |
| `StaticString` | `core/string/src/vtable/static.rs`, `lib.rs:557` | `'static` data |

`SliceString` means **substring is cheap**. There is no equivalent for concatenation.
`concat_array` (`lib.rs:636`) sums the lengths, allocates `full_count`, and
`copy_nonoverlapping`s every operand in:

```rust
let (ptr, data_offset) = if latin1_encoding {
    SequenceString::<Latin1>::allocate(full_count) ...
for &string in strings {
    ptr::copy_nonoverlapping(s.as_ptr(), data.cast::<u8>(), count);
```

The one mercy is the latin1 path: ASCII stays one byte per character rather than doubling
to UTF-16.

## Brimstone: cons strings, flattened in place

Brimstone's `StringValue` header carries a `kind`
([`src/js/runtime/string_value.rs:57`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L57)):

```rust
enum StringKind {
    /// A string which is the concatenation of a left and right string.
    Concat,
    OneByte,
    TwoByte,
}
```

`StringValue::concat`
([`:66`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L66))
computes the combined length, picks the wider encoding, and returns a `ConcatString` node.
**No copy.** `is_flat()` is at
[`:111`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L111).

`flatten()`
([`:314`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L314))
is the other half:

> If this string is a concat string, flatten it into a single buffer. This modifies the
> string value in-place and switches it from a concat string to a sequential string type.

It is idempotent: an already-flattened concat node forwards to its left child. That makes
flattening amortized **for a string that is read repeatedly without being appended to**.

## Why the rope does not save us

Every read forces a flatten. In `string_value.rs`, `code_unit_at`
([`:181`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L181)),
`code_point_at` ([`:191`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L191)),
`substring` ([`:199`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L199))
and `find` ([`:208`](https://github.com/Hans-Halverson/brimstone/blob/9357af1578873285873605cde15cae094f96cad5/src/js/runtime/string_value.rs#L208))
all begin by flattening.

Trace our loop on a rope engine:

1. Token N appends: `s_N = s_{N-1} + d_N`, O(1), a `ConcatString` over a flat left and a
   tiny right.
2. Pass 2 scans it for a partial directive: **flatten**, copying the whole body.
3. Passes 3 to 6 then read a flat string, as before.

The append became free and the very next line paid for it. A rope wins when you append many
times and read once. We append once and read four times, every token.

**Score: a rope removes pass 1 of 6.** Worth having, not worth an engine migration.

## Why the tail block is not a bound

`MessageBody`'s memo (`MessageBody.tsx:303`) reuses unchanged blocks, so only the final
block's text node is rewritten. That would bound passes 4 to 6 to the size of the last
block, which is the fix `performance.md` records for the transcript rebuild.

Except the last block is usually the whole reply. `splitBlocks` (`MessageBody.tsx:228`)
accumulates `prose: string[]` and flushes it only when it hits a **code fence**, and
`extractProseStructures` (`:153`) flushes prose only when it hits a **table** (`:167-178`).
Blank lines do not split prose.

So a fence-free, table-free reply, which is most replies, is **one prose block that grows
without bound**, and passes 4 to 6 rewrite all of it on every token.

## TODO: fix the quadratic

Ordered. Steps 1 and 2 are independent and can land in either order; together they make the
per-token cost proportional to the tail rather than the body.

### 1. Stop accumulating the reply in a JavaScript string

- **Where:** [workspace.tsx:1462](../apps/gui/frontend/src/stores/workspace.tsx),
  `setState("streaming", projectId, (current = "") => current + delta)`.
- **What:** hold `streaming` as `string[]` and push the delta. Join only where a string is
  genuinely required, and only over the tail once step 2 lands.
- **Why:** removes pass 1 outright and makes passes 2 and 3 addressable.
- **Depends on:** nothing.
- **Verify:** `RunStatusLine` reads `props.streaming.length`
  ([TranscriptPane.tsx:686](../apps/gui/frontend/src/features/project/TranscriptPane.tsx));
  that becomes a sum, so check the character counter still tracks. Existing tests:
  `TranscriptWindow.test.tsx`, `workspace.test.tsx`.
- **Size:** small.
- **Risk:** low. Frontend only, no engine or protocol change.

### 2. Bound the tail block: split prose on blank lines

- **Where:** `extractProseStructures` in
  [MessageBody.tsx:153](../apps/gui/frontend/src/features/project/MessageBody.tsx).
- **What:** flush the prose accumulator on a blank line, not only on a table. Each paragraph
  becomes its own block.
- **Why:** this is the step that actually bounds passes 4, 5 and 6. Without it the last
  block is the whole reply and the DOM write stays O(body) per token no matter what the JS
  side does.
- **Depends on:** nothing, but it is worth doing with step 1 so the win is visible in one
  measurement.
- **Verify:** `sameBlock` identity reconciliation should keep completed paragraphs stable,
  which is the observable proof. **This changes DOM structure**, one element per paragraph
  instead of one for the reply, so paragraph spacing and margins need visual checking per
  [ui-verification.md](ui-verification.md).
- **Size:** small.
- **Risk:** medium, because it is a rendering change. Markdown already treats a blank line
  as a paragraph break, so the semantics are right; the styling is what needs eyes.

### 3. Scan only the tail for a partial directive

- **Where:** `holdBackPartialDirective`, [TranscriptPane.tsx:51](../apps/gui/frontend/src/features/project/TranscriptPane.tsx),
  called at `:673`.
- **What:** it exists to hold back a `<ps @agency:...>` that is still arriving, so it only
  needs to inspect the end of the buffer. Scan a bounded suffix, long enough for the longest
  directive, instead of the whole body.
- **Depends on:** step 1 makes this natural, since the tail is already a separate chunk.
- **Size:** small.

### 4. Optional: block-delimited deltas from Rust

- **Where:** the `run:text` payload, `{ projectId, delta }`
  ([client.ts:442](../apps/gui/frontend/src/api/client.ts)), emitted from
  `apps/gui/src/projects.rs:10853` and `:11240`.
- **What:** have Rust say which block a delta belongs to, so the frontend appends without
  re-splitting anything.
- **Why:** removes pass 3 entirely rather than bounding it.
- **Depends on:** steps 1 to 3 should be measured first; this is a protocol change and may
  prove unnecessary.
- **Size:** medium. Protocol plus both sides.

### 5. Do not switch engines for this

Recorded as a decision, not a task. See below.

## What an engine swap would and would not buy

If Brimstone were adopted today, on this path:

- **Would remove:** pass 1.
- **Would not remove:** passes 2 to 6.
- **Would cost:** `blitz-script` is 6,659 lines written against Boa's API (`runtime.rs`
  1,306, `dom/element.rs` 1,205, `dom/node.rs` 777). Brimstone is unpublished on crates.io,
  self-described as "Not ready for use in production", and uses a compacting garbage
  collector, which changes the handle discipline an embedder must follow.

Steps 1 to 3 above remove more of the cost, for a fraction of the work, without changing
engines. Revisit Brimstone on its own merits when it publishes and drops the
not-for-production line; its cons-string design is correct and the project is active.

## Related

- [zero-copy-and-hot-paths.md](zero-copy-and-hot-paths.md) for the full copy ledger this
  expands on, including the IPC boundary and the store read path.
- [performance.md](performance.md) for the transcript-rebuild fix that bounded the DOM
  churn but not the parse.
- [TODO-dom-related-work.md](TODO-dom-related-work.md), item 8, which this document is the
  detail behind.

## Addendum, 2026-08-12: a third option this document did not consider

From the Genet review ([genet-review.md](genet-review.md)), a Servo fork on our stack that
removed SpiderMonkey. Source reading, not measurement.

The decision above stands: **do not switch engines for the quadratic.** Steps 1 to 3
remove more cost for a fraction of the work, and that arithmetic is unchanged.

What Genet adds is an option framed neither as "keep Boa" nor "switch to Brimstone":
**put a seam in and keep Boa behind it.** `components/script-engine-api/lib.rs` is one
trait (`ScriptEngine`) with three backends in tree, `script-engine-boa`,
`script-engine-nova` and `script-engine-piccolo`. The engine choice stops being a rewrite
and becomes a type parameter.

That changes the shape of the cost this document prices. The 6,659 lines of `blitz-script`
written against Boa's API is the number that makes an engine swap unaffordable. A seam
does not make that number smaller, but it converts it from a cost paid on the day you
switch into one paid once, in advance, whether or not you ever switch.

**The seam is not free, and their manifest shows the price.** They carry a fork of Boa
(`mark-ik/boa`, `genet` branch, adding `JsObject::downgrade()` and `WeakJsObject`) and a
fork of Nova (`merely-made/vano`, `genet-embedder` branch), both to get weak reflector
references. Engines do not agree about GC handle discipline, which is exactly the concern
this document raises about Brimstone's compacting collector, so a seam over two engines is
a seam plus two forks. That is the honest price, and it argues for building the seam only
if a second engine is actually wanted.

Two smaller things from the same file are useful regardless of the seam:

- `Budget` (`:51`), `PumpOutcome` (`:61`), `eval_bounded` (`:136`) and `pump(budget)`
  (`:188`) make script execution cooperatively interruptible.
  [concurrency-todo.md](concurrency-todo.md) section 2.8 records that we have no yield
  point anywhere in the pipeline, and this is what one looks like as an API.
- `drain_dead_reflectors` and `force_gc` on the same trait are the hooks that would let an
  embedder observe what Boa's collector is doing, which today we cannot see at all.
