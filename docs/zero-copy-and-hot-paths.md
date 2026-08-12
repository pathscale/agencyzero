# Zero-copy, and what the hot paths actually copy

Written 2026-08-11, from a read of the frontend store, `blitz-script`'s DOM bindings,
`blitz-dom`'s mutator, `tauri-runtime-blitz`'s script queue, Tauri 2.11.5's callback
formatter, and Boa's string implementation. **Nothing here was measured.** Every claim is
a read of code, with file and line. Numbers quoted come from [performance.md](performance.md),
taken 2026-08-10.

The question this answers: is any of this zero-copy, and where does the copying actually
happen on the paths that run thousands of times per reply?

Short version: nothing on the hot paths is zero-copy, and **the streaming reply path is
quadratic in reply length**. The wire protocol is not at fault; the accumulation on the JS
side is.

## The streaming token path, copy by copy

One delta, from the agent to the screen. This runs once per token.

| # | Stage | Cost |
|---|---|---|
| 1 | Rust serializes `{projectId, delta}` | O(delta) |
| 2 | Tauri formats a **JavaScript source string** carrying it | O(delta) |
| 3 | Boa lexes, parses, compiles and runs that source | full parser invocation, per token |
| 4 | `setState("streaming", …, current => current + delta)` | **O(body)** |
| 5 | `holdBackPartialDirective(text())` scans the reply | **O(body)** |
| 6 | `splitBlocks(props.body)` re-parses the reply | **O(body)** |
| 7 | `set_node_text`: `to_std_string_lossy()`, then `!=` compare, then `clear` + `push_str` | 3 x O(tail block) |
| 8 | `ALL_DAMAGE` on the text node and its parent, parley reshapes the paragraph | O(tail block) |
| 9 | Full visible-tree paint, full-window GPU render | O(visible tree) |

Steps 4 through 7 walk the accumulated reply between five and seven times **per token**.
That is quadratic in reply length.

### Step 4: Boa has no rope

[workspace.tsx:1462](../apps/gui/frontend/src/stores/workspace.tsx) does
`current + delta`. In V8 that is nearly free: `+` builds a ConsString and the copy is
deferred, often forever. Boa has no cons-string or rope representation.
`JsString::concat_array` (`boa/core/string/src/lib.rs:636`) sums the lengths, allocates
`full_count`, and copies every operand in:

```rust
let (ptr, data_offset) = if latin1_encoding { SequenceString::<Latin1>::allocate(full_count) } …
for &string in strings { ptr::copy_nonoverlapping(s.as_ptr(), data.cast::<u8>(), count); … }
```

So every token memcpys the entire reply so far into a fresh buffer. A 50 KB reply arriving
in 4-character deltas copies on the order of 300 MB and makes ~12,500 allocations of
steadily growing size, all of it garbage. The one mercy is the latin1 path: ASCII stays
one byte per character rather than doubling to UTF-16.

**This is the single most valuable thing in this document.** A JS idiom that is free in a
browser is a full copy here, on the hottest path in the application.

### Steps 5 and 6: the same shape, already half fixed

`MessageBody`'s memo ([MessageBody.tsx:303](../apps/gui/frontend/src/features/project/MessageBody.tsx))
fixed the part performance.md records: unchanged blocks keep their identity, so `<For>`
stops tearing down and rebuilding the whole transcript per token. That fix is real and the
comment there is accurate about what it did.

But the memo's dependency is `props.body`, which changes every token, so `splitBlocks`
still re-parses the entire body on every token. The DOM churn is gone. The parse is not.
`holdBackPartialDirective` in
[TranscriptPane.tsx](../apps/gui/frontend/src/features/project/TranscriptPane.tsx) scans
the same string for the same reason.

### Step 7: the one place that avoids an allocation

`set_node_text` (`ps-blitz/packages/blitz-dom/src/mutator.rs:183`) compares
`text.content != value` in full, then does `clear()` + `push_str()`, reusing the existing
capacity. Two full passes, no allocation. That is the best-behaved stage on the path, and
it is still O(tail block) per token.

For what step 8 costs beyond the copy, see
[dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md).

## The IPC boundary: everything crosses as JavaScript source

Command responses and event payloads both return through `eval_script`, which pushes a
`String` onto a queue that Boa evaluates
(`tauri-runtime-blitz/crates/tauri-runtime-blitz/src/script_queue.rs:16`,
`webview.rs:255`).

Tauri decides how to encode the payload in `tauri-2.11.5/src/ipc/format_callback.rs`:

```rust
const MIN_JSON_PARSE_LEN: usize = 10_240;
let return_val = if json.len() > MIN_JSON_PARSE_LEN && (first == b'{' || first == b'[') {
    cb(&serialized)   // JSON.parse('…')
} else {
    cb(json)          // raw JS source
};
```

Above 10 KiB it emits `JSON.parse('…')`. Below it, the payload is **raw JavaScript source
for the full parser**. The constant's own comment says the number was "set 10 KiB
arbitrarily" and cites a Chrome benchmark.

That threshold is tuned for V8, where the JS parser is fast and the tradeoff is genuinely
close. Boa's general parser is far more expensive relative to its JSON parser, so the
crossover almost certainly sits much lower here. Every event payload and most command
responses are on the wrong side of it, which means every streaming token pays a full JS
parse for a few dozen bytes of JSON.

Unmeasured, and measurable: `script_stats` already attributes poll time by source.

## Opening a project: six to eight copies of every message body

`list_messages` ([projects.rs:2833](../apps/gui/src/projects.rs)):

1. `select_by_project_id(…).execute()` returns **owned** rows. rkyv 0.8 is a zero-copy
   format and worktable stores archived pages, but the zero-copy property is spent at
   `execute()`: every field is materialized into an owned `String`.
2. `row.id.clone()`.
3. `full_body(…)` stitches overflow chunks into a fresh `String`, copying the body again.
4. `serde_json` serializes the `Vec<MessageDto>`, copying and escaping every body.
5. Over 10 KiB, Tauri escapes that JSON again into a JS string literal.
6. Boa's `JSON.parse` allocates a `JsString` per field.
7. Solid writes each into a text node; `to_std_string_lossy`
   (`blitz-script/src/dom/mod.rs:113`) copies it back to UTF-8.
8. `set_node_text` copies it into `text.content`.

Six to eight copies of a body between the store page and the screen. Once per project
open, not once per token, which is why it is third on the list below rather than first.

## What is zero-copy or pooled

The picture below the paint boundary is genuinely good, and this document should not be
read as saying otherwise:

- vello's encoding buffers are a retained arena, and its GPU buffers are a size-classed
  pool. See [allocations.md](allocations.md).
- The DOM is a slab arena; glyphs stream through `impl Iterator` rather than a `Vec` per
  run.
- `text.content` reuses its allocation on write.
- Boa's latin1 representation means ASCII strings do not double in width.
- **The streaming event carries only the delta**, not the accumulated body
  (`run:text: { projectId, delta }`,
  [client.ts:442](../apps/gui/frontend/src/api/client.ts)). The wire protocol is correct.
  The quadratic is entirely on the JS side of it.

## Order of work

1. **Stop accumulating the reply in a JavaScript string.** This is the entire quadratic.
   Hold `streaming` as an array of chunks and re-split only the tail after the last fence
   boundary, and steps 4, 5 and 6 all collapse. Frontend-only, no engine change.
   Alternatively have Rust send block-delimited deltas so the frontend appends to the last
   block and never re-parses. This is the exception to "measure first": the quadratic is
   visible in the source and does not need a benchmark to justify removing.
2. **Measure the per-event JS parse** with the existing `script_stats` buckets before
   touching Tauri's threshold. If it is significant, the fix is a fast path in the script
   queue for the `runCallback(id, …)` shape, which is a hack and should be labelled as one
   at the site.
3. **Leave the store read path alone** until 1 and 2 are done. It is once per project
   open.

Caveat on all three: the counters you would measure with currently ship in the release
build and are not free, per [allocations.md](allocations.md). Fix that first or measure
before-and-after on the same build.

## Related

- [allocations.md](allocations.md) for what the render path allocates per frame, what
  retains, and the instrumentation currently in the shipping build.
- [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md) for what
  step 8's `ALL_DAMAGE` triggers, and why fine-grained framework updates get whole-subtree
  work.
- [partial-paint.md](partial-paint.md) for step 9, and why one animated element costs a
  whole frame.
- [performance.md](performance.md) for the measurements, including the transcript rebuild
  fix that step 6 is the remaining half of.
