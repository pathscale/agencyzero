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

`ps-qa` is a harness and knows nothing about this application. Two files here
tell it everything it needs, and both are data:

```
ps-qa.ron            surfaces, sections, tab names, the controls not to press
tests/ps-qa/*.ron    the checks, one file per group - what THIS app promises
tests/ps-qa/issues.md  the inventory: what is covered, what is not
```

Neither needs a recompile. Correcting a selector is an edit and a re-run.

A second application pointed at the same harness writes its own pair.

---

## 2. Running it

```sh
# The harness is a published crate. A caret, so patches arrive without a commit
# here: the checks and the profile are what pin behaviour, and they live here.
cargo install ps-qa --version '^0.1' --locked

# blitz-inspector, NOT blitz-runtime: a blitz-runtime build answers every
# inspector call with diagnosticsUnavailable.
cargo build --release --features blitz-inspector --bin az-gui

# Launch against a throwaway copy of the QA profile, expanded from the tree.
scripts/qa-profile-restore.sh
AZ_DATA_DIR=/tmp/qa-profile-db \
  TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json" \
  ./target/release/az-gui &
sleep 18

export TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json"

# Run from the repository root: ps-qa.ron and tests/ps-qa/ are found relative
# to the working directory.
ps-qa list                        # every check, no app needed
ps-qa qa                          # all of them
ps-qa qa --toon                   # the same run as TOON, for a reader that is
                                  # a program. The column format loses any field
                                  # containing a space, which `what` and every
                                  # failure message have.
ps-qa qa dialog                   # one group
ps-qa qa dialog-cancel-dismisses  # one check, by id
QA_TRACE=1 ps-qa qa <id>          # print the node each step pressed
```

Exit code is 1 if any check fails.

### Diagnosing without writing a check

```sh
ps-qa layout "<name>"   # live boxes: x, y, w, h
ps-qa dom "<name>" 6    # attributes plus the ancestor chain
ps-qa paint "<name>"    # the colours the renderer resolved
ps-qa press "<name>"    # a real pointer: move, down, up
ps-qa click "<name>"    # a synthesised click at a node id
ps-qa nodes             # tree size and a role histogram
ps-qa spill             # boxes that stick out of their container
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

A check is data, in `tests/ps-qa/*.ron`. No recompile: edit and re-run.

```ron
(
    id: "dialog-cancel-dismisses",   // stable handle: ps-qa qa <id>
    group: "dialog",                 // and the file it lives in
    what: "the fork dialog's Cancel actually dismisses it",
    open: Some("Home"),              // navigate first, if not on this surface
    hover: None,                     // hover first, for hover-revealed controls
    click: Some("Cancel"),           // what to drive
    press: true,                     // real pointer, not a synthesised click
    subject: "Start fork",           // what the assertion is about
    expect: Vanishes,
    panel_only: false,               // count only inside the side panel
)
```

Files are read in name order, so the numeric prefixes decide the run order.

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

## 5. Current state: 16 of 18 pass

Measured 2026-08-23 on the committed profile, fresh instance.

```
delete     1/1     dialog     2/2     hover      3/3     icons      1/1
rename     1/2     sections   5/5     status     1/2     tasklog    2/2
```

The full inventory - every check, the coverage buckets per surface, the
unknowns, and the ten open issues - is `tests/ps-qa/issues.md`.
That file is the one to update after a run; this section is a summary of it.

The four that went green were never application bugs. They failed because the
checks share one instance and an earlier one left the app on a surface the next
did not expect, which the rebuilt profile no longer triggers. The reset-between-
checks work below is still worth doing: nothing guarantees it stays that way.

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

### Why the 2 failures are not app bugs

`status-1` fails on `"Edit " went 19 -> 21, expected no change` - hovering to
reach the marker reveals two more row controls, which the assertion counts as
the marker misbehaving. The check has never measured what its name claims.

`rename-project-header` cannot find `Rename project` on the surface it runs
against. Unresolved: either it navigates to the wrong place or the control is
genuinely absent. It is the only check whose failure could still be an
application bug.

Three harness faults were ruled out underneath it (ps-qa#5), and they are worth
knowing about because each one made a working control look dead:

- `open_named` and `press_named` never tested whether a box was **on screen**.
  An overflowing tab strip parks project tabs at negative x, so navigation
  pressed at points like `-742,32`, outside the window, and nothing happened.
- The first name match in tree order won, before any visibility test. A project
  name matches in the tab strip, in the Home list and in its own header, so the
  press often went to a copy the owner could not see.
- The viewport came from `main`, which starts below the title bar at y=58, so
  the whole tab strip counted as scrolled away.

`rename-opens-editor` was red for the second and third of those and passes now.
`rename-project-header` survives all three, so whatever remains is on the
surface itself. Do not restart from the `mousedown`/`stopPropagation` theory:
the press was never landing, so no evidence was ever collected about the
handler.

A third, `rename-opens-editor`, went red during the profile rebuild and is worth
recording because it looked exactly like a regression. The rebuilt profile
briefly had *two* projects named `e`, so pressing by name was ambiguous and hit
the wrong one. Pressing the pencil by hand opened the editor every time,
`0x0 -> 300x21.1`. Fixed in the scrubber; the app was never involved.

---

## 6. TODO, in order

### P0 - makes the numbers trustworthy

- [ ] **Reset state between checks.** Each check should start from a known
      surface, or the runner should restore the profile per group. Still worth
      doing: the four checks this used to break now pass on the rebuilt profile,
      but nothing *guarantees* that, and a check that passes by luck of ordering
      is a check that will go red for the wrong reason later.
- [ ] **Fix `status-1`'s subject.** Counting `"Edit "` catches hover-revealed
      controls. Count the *row*, or assert the specific item is still present.
- [x] **A reproducible profile.** Was a 114M directory in `/tmp`, unversioned
      and full of the owner's real transcripts. Now `tests/data/qa-profile.tar.zst`.
- [x] **`cover`'s bucket accounting.** Reported `UNACCOUNTED -47`, a surplus,
      which read as better-than-covered. Dialog controls now extend the total
      rather than inflating `swept`.

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

`tests/data/qa-profile.tar.zst`, 2.9M in the tree, 31M expanded. Restored before
every run by `scripts/button-sweep.sh`, or by hand with
`scripts/qa-profile-restore.sh`. See `tests/data/README.md`.

It replaced a 114M directory in `/tmp` that nobody could reproduce and that
carried the owner's real work: 33,792 occurrences of their home directory, two
collaborators' email addresses, and the verbatim shell history of every command
an agent had run. Do not resurrect that workflow. If a profile is not in the
tree it does not exist, and if it came from a live store unscrubbed it cannot go
in the tree.

It is **not** short of data - two projects keep 2,600 task-log rows and 1,200
messages each so timings stay meaningful, and the other 292 are capped at 20 and
12.

Useful fixtures in it today:

| Project | Why |
| --- | --- |
| `theta theta north indi` | the panel row controls, opened by name in 14 checks |
| `theta cobalt sigma north iota kappa` | the second heavy transcript |
| `e756` | first Home row, for row-level controls |

**These names are generated.** A rebuild that changes how names are scrubbed
changes them, and every check that opens one by name has to change with it: that
happened on 2026-08-23 and broke 15 references across 6 files. Tracked as issue
9 in `tests/ps-qa/issues.md`.

Rebuild with `AZ_BUILD_QA_PROFILE`; see `tests/data/README.md` for the full
command and for what the builder does and does not scrub.
