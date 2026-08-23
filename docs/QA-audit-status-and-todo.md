# The button audit: how to run it, what is left, what to fix next

Written 2026-08-23. Supersedes `HANDOVER-button-fixes-2026-08-22.md` for the
harness; that file is still the record of the four original dead controls.

The goal this serves: **coverage that tests the outcome of a button press**,
not that the press was acknowledged. We are not there yet, and the last section
says exactly what is missing.

---

## 1. What the harness is

`ps-qa` — its own repo (`github.com/pathscale/ps-qa`), published on crates.io.
It connects to a running app's MCP control socket, drives a real pointer, and
reads back the layout boxes the engine computed.

It was called `blitz-bench` and lived in this repo until 2026-08-23. The name
read as a benchmarker, so two agents in a row worked from one-off presses and
never found the `qa` mode that asserts outcomes. If you are reading an older
handover, `blitz-bench qa` is `ps-qa qa`.

```
src/      engine: Expect, Check, verdict, the MCP client, the sweep
tests/    the checks, one file per group - what THIS app promises
```

A second app pointed at this harness gets a different `tests/`, not a fork.

---

## 2. Running it

```sh
# Build both. blitz-inspector, NOT blitz-runtime: a blitz-runtime build answers
# every inspector call with diagnosticsUnavailable.
cargo build --release --features blitz-inspector --bin az-gui
(cd ../ps-qa && cargo build --release)

# Launch against a throwaway copy of the QA profile.
rm -rf /tmp/qa-profile-db && cp -c -R /tmp/qa-profile-pristine /tmp/qa-profile-db
AZ_DATA_DIR=/tmp/qa-profile-db \
  TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json" \
  ./target/release/az-gui &
sleep 18

export TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json"
Q=../ps-qa/target/release/ps-qa

$Q list                        # every check, no app needed
$Q qa                          # all 18
$Q qa dialog                   # one group
$Q qa dialog-cancel-dismisses  # one check, by id
QA_TRACE=1 $Q qa <id>          # print the node each step pressed
```

Exit code is 1 if any check fails.

### Diagnosing without writing a check

```sh
$Q layout "<name>"   # live boxes: x, y, w, h
$Q dom "<name>" 6    # attributes plus the ancestor chain
$Q paint "<name>"    # the colours the renderer resolved
$Q press "<name>"    # a real pointer: move, down, up
$Q click "<name>"    # a synthesised click at a node id
$Q nodes             # tree size and a role histogram
```

`dom` is usually fastest: a control that writes its state but never appears is
nearly always a hidden or zero-sized *ancestor*, which the chain shows at once.

---

## 3. The five traps that cost the most time

Read these before believing any measurement.

**1. Cargo will not rebuild if the source mtime lands in the same minute.**
The build reports `Finished` in 0.4s having compiled nothing, and you test a
stale binary while believing you tested the fix. This cost more cycles than any
other single thing. Check for a `Compiling` line; `touch` plus `sleep 61` if
you must.

**2. Retained panes keep real boxes and real names.** Opening a project leaves
Home alive behind it. `layout "Items"` can report a header belonging to a
surface that is no longer in front, and `press` can resolve to it. Two separate
wrong conclusions came from this. Filter by the pane's x range or resolve
through the surface subtree.

**3. A Home row opens on a *double* click.** Two `press` calls are not a double
click - each round-trips through the inspector and they land hundreds of
milliseconds apart, so the row folds there and back. Navigation that used
single presses appeared to work only when the surface was already open.

**4. The semantic tree's `visible` flag disagrees with the renderer.** Measured
on one node at one instant: `paint` reported the rename editor
`300.0x21.1 at 87,236 opacity=1.00 Visible` while `dom` reported that same id
`HIDDEN`. `visible` walks ancestors for `display:none` and `aria-hidden`, and a
wrapper whose class no longer says `hidden` was still carrying it in the style
tree while its subtree laid out and drew. **`paints()` judges on geometry for
this reason.** Trusting the flag reported "246 icons exist, none paints" for an
app visibly full of icons.

**5. A dirty instance poisons a delta.** `PaintsMore` and `Grows` compare
against a baseline, so an editor left open by an earlier press is already
counted. Restore the pristine profile before a run.

---

## 4. Writing a check

```rust
Check {
    id: "dialog-cancel-dismisses",   // stable handle: ps-qa qa <id>
    group: "dialog",                 // file in tests/
    what: "the fork dialog's Cancel actually dismisses it",
    open: Some("Home"),              // navigate first, if not on this surface
    hover: None,                     // hover first, for hover-revealed controls
    click: Some("Cancel"),           // what to drive
    press: true,                     // real pointer, not a synthesised click
    subject: "Start fork",           // what the assertion is about
    expect: Expect::Vanishes,
    panel_only: false,               // count only inside the side panel
}
```

| Expectation | Passes when |
| --- | --- |
| `Paints` | the subject has a non-zero box |
| `PaintsNamed` | a node matching `role:name` has a box - use when a control and its output share a name |
| `Vanishes` | nothing matching is on screen (may remain in the tree) |
| `PaintsMore` | more matching nodes on screen than before |
| `Grows` | more matching nodes in the tree than before |
| `Holds` | the count did not change |
| `Absent` | no matching node at all |

Prefer `Vanishes` to `Absent` for anything that closes: a dismissed dialog is
usually still in the tree at `0x0`.

`press: true` matters. `click` dispatches a `click` and nothing else, so a
control that acts on `mousedown` - the rename pencil - reads as dead to it.

### Mutation-test every check

A check that has only ever passed proves nothing. **Break the app on purpose,
confirm the check goes red, restore, confirm green.** Two checks here were
wrong when first written and passed anyway:

- `Paints` on `textbox` stayed green while the control was dead, because other
  textboxes on the surface always paint.
- A name-based subject was satisfied by the *pencil*, since the control and the
  editor it opens share an accessible name.

Neither would have been caught by running the check.

---

## 5. Current state: 12 of 18 pass

```
delete     0/1     dialog     2/2     hover      3/3     icons      1/1
rename     0/2     sections   5/5     status     1/2     tasklog    0/2
```

**No confirmed application bugs remain.** Every control driven individually
works, verified by before/after measurement rather than by the press being
acknowledged:

| Control | Evidence |
| --- | --- |
| Rename pencil (Home) | textbox `0x0` -> `300x21` |
| Rename pencil (project header) | textbox `0x0` -> `650x23` |
| Fork dialog Cancel | dialog `1344x900` -> `0x0` |
| Home fork Cancel | `Start fork` `76x32` -> `0x0` |
| Delete | row grows `Delete? Delete Cancel` |
| Home row activation | 1422 -> 2026 nodes |
| Collapse/Expand Recent | label flips both ways |
| Expand the prompt area | -> `Shrink the prompt area` |

The sweep's 21 candidates resolved to **20 false positives and 1 real bug**
(the pencil, fixed in `801d26a` - it needed four presses, now one).

### Why the 6 failures are not app bugs

`rename`, `delete`, and `tasklog` **pass in isolation and fail in a full run**.
`ps-qa qa rename-opens-editor` alone: PASS. In `ps-qa qa`: FAIL. The checks
share one instance, and an earlier check leaves the app on a surface where the
next one's `arrived` test sees a *retained* Home behind the live pane.

`status` fails on `"Edit " went 20 -> 22, expected no change` - hovering
revealed two more row controls, which the assertion counts as the marker
misbehaving.

---

## 6. TODO, in order

### P0 - makes the numbers trustworthy

- [ ] **Reset state between checks.** Each check should start from a known
      surface, or the runner should restore the pristine profile per group.
      This is the single highest-value fix: it is why 6 checks fail in a full
      run and pass alone, and until it lands no total from `ps-qa qa` means
      anything.
- [ ] **Fix `status-1`'s subject.** Counting `"Edit "` catches hover-revealed
      controls. Count the *row*, or assert the specific item is still present.

### P1 - the actual goal: outcomes, not appearances

Everything below is missing coverage, not a bug.

- [ ] **`Ordered` expectation.** Capture the sequence of names matching a
      selector before and after, assert the expected permutation. Without it
      **no sort or reorder control can be verified** - the current checks would
      pass if sorting reversed the wrong column.
- [ ] **Store assertions.** Read the durable store after an action and assert
      the row. Turns "a dialog closed" into "a fork exists", "the editor
      opened" into "the name persisted". Needs a read path from `ps-qa` to the
      store, or a diagnostics call that exposes it.
- [ ] **`Typed` expectation.** Drive keystrokes into a field and assert the
      value landed. `ps-qa type` exists; no check uses it.

### P2 - breadth

- [ ] **The other ~250 controls.** The sweep enumerates 268; 18 have checks.
      Promote them in dependency order: navigation, then destructive, then
      the rest.
- [ ] **Per-group fixtures.** `tests/` hardcodes `alpha sigma omega west` (23
      items) and `Home`. A check should declare what it needs - "a project with
      items" - and the runner should find one.
- [ ] **Pixel assertions.** `paints()` is geometry-only because `visible` lies.
      Nothing asserts actual ink except `ps-qa paint` by hand. The icons
      regression that started all this was exactly an ink failure.

### P3 - known, deliberately deferred

- [ ] **`local-delivery.sh:231,280` ships bundles with `blitz-inspector`**, so
      the installed app carries the control socket. Wanted as a runtime gate,
      not a compile-out, since chuzz needs this surface.
- [ ] **`aria-pressed` is not mapped** into `SemanticNode::selected` in
      `tauri-runtime-blitz`, so a toggle that only flips `aria-pressed` and a
      colour is invisible. `Extra Thinking` is classified `Inert` for this
      reason; verify it with `ps-qa paint`.
- [ ] **5 macOS file panels** cannot be driven at all. Traced to their
      `app.dialog()` call sites in `reach::NATIVE_CHOOSERS` and printed as a
      manual worklist. Re-derive with
      `grep -n '\.dialog()' apps/gui/src/*.rs` - seven call sites today. **Check
      each entry against a running build**: three entries once named the panel
      or the row instead of the button, matched nothing, and the sweep opened
      panels it could not dismiss.

---

## 7. The QA profile

`/tmp/qa-profile-pristine`, 114M, restored before every run by
`scripts/button-sweep.sh`.

It is **not** short of data - `project_item` carries 52KB of rows, and there
are projects with 12 and 23 open items. A previous conclusion that "every
project reports Items0" was wrong twice over: four projects were sampled that
happened to have none, and the readings themselves came from a stale surface
that had never navigated.

Useful fixtures in it today:

| Project | Why |
| --- | --- |
| `alpha sigma omega west` | 23 open items, 99 turns - the panel row controls |
| `theta sigma beta amber alpha beta ea` | 12 open items |
| `e` | first Home row, for row-level controls |

If the profile is ever lost, rebuild it by launching against a fresh
`AZ_DATA_DIR`, creating a project with a dozen items and some task-log
activity, quitting, and `cp -c -R` to the pristine path.
