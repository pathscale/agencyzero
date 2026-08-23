# Inventory: what is covered, what passes, what is unknown

Measured 2026-08-23 against `az-gui 0.8.30` (`fe9ada58e*`, `--features
blitz-inspector`) on the committed profile, restored fresh before the run.

Reproduce every number here with:

```sh
scripts/qa-profile-restore.sh                       # in the agencyzero repo
AZ_DATA_DIR=/tmp/qa-profile-db \
  TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json" \
  ./target/release/az-gui &
ps-qa qa            # the 18 checks
ps-qa cover home    # the coverage buckets, per surface
```

A number without a date is a number nobody has re-measured. Re-run and edit the
date rather than trusting a row.

---

## 1. The headline

| | |
| --- | --- |
| Controls on the four surfaces as they open | **297** |
| Plus controls that only exist once something is opened | 48 |
| Controls a check asserts an outcome for | **19** (6%) |
| Checks passing | **17 of 19** |
| Controls pressed, asserted only as "something changed" | 118 |
| Controls never driven at all | **173** |

The gap between 18 and 345 is the honest state of this harness. The sweep
presses far more than 18, but pressing is not asserting: `cover` reports that a
press changed the tree, not that it changed it correctly. Only the 18 below
would catch a control that does the wrong thing.

The window holds 2,843 buttons in total. The 297 above are the ones actually on
a surface; the rest belong to retained panes that are no longer in front, which
is its own hazard - see unknown 7.

---

## 2. The 18 checks

Green means the assertion held on the run above, on a fresh profile.

| id | group | asserts | state |
| --- | --- | --- | --- |
| `icons-paint` | icons | icon nodes occupy a box | **pass** |
| `hover-1` | hover | hovering a row reveals move-up | **pass** |
| `hover-2` | hover | hovering a row reveals edit | **pass** |
| `hover-3` | hover | hovering a row reveals delete | **pass** |
| `hover-does-not-gate-row-controls` | hover | row controls paint hovered or not | **pass** |
| `status-1` | status | a status click does not remove the row | **FAIL** |
| `status-2` | status | the marker never cycles into a terminal state | **pass** |
| `sections-1` | sections | the Items header is on screen | **pass** |
| `sections-2` | sections | the Task log header is on screen | **pass** |
| `sections-3` | sections | the Agent I/O header is on screen | **pass** |
| `sections-4` | sections | collapsing is acknowledged | **pass** |
| `sections-5` | sections | expanding restores the control | **pass** |
| `tasklog-1` | tasklog | rows render their copy control | **pass** |
| `tasklog-2` | tasklog | revealing earlier entries adds rows | **pass** |
| `rename-opens-editor` | rename | the Home pencil opens an editor | **pass** |
| `rename-project-header` | rename | the project header pencil opens its editor | **FAIL** |
| `dialog-opens` | dialog | the fork dialog opens | **pass** |
| `dialog-cancel-dismisses` | dialog | Cancel actually dismisses it | **pass** |
| `delete-asks-first` | delete | delete asks before destroying | **pass** |

### The `hover` group does not test hover

Measured 2026-08-23: **13 of the 19 `Edit ` controls in the tree already paint
with the pointer parked away from every row.** Asked as a delta rather than as
presence, the same subject reports `13 -> 13`.

So `hover-1`, `hover-2` and `hover-3` pass on controls that were on screen the
whole time. They would pass if hover were removed from the application
entirely. Three of the nineteen checks are named for a behaviour they do not
exercise, which is worse than having no check: the group's name reads as
coverage.

`hover-does-not-gate-row-controls` now asserts what is actually true, with
`Holds`. If the panel ever moves to hover-gated controls it goes red, which is
the right direction to fail - it would mean the three above had started testing
something.

Not counted as a failure below because nothing is broken. It is a coverage
claim that was never real.

### The two failures

**`status-1` - the check is wrong, not the app.** It counts nodes named
`"Edit "` and requires the count to hold; hovering to reach the marker reveals
two more row controls, so the count moves 19 -> 21 and the check calls it a
regression. It has never once measured the thing its name describes. Fix the
subject (count the row, or assert the specific item survives) before believing
either outcome.

**`rename-project-header` - unknown, and the more interesting of the two.**
`could not press "Rename project": no visible, enabled, sized button matching
it`. The control is not on the surface the check runs against. Either the check
navigates to the wrong place or the control is genuinely absent; nobody has
resolved which. It passed in isolation on 2026-08-22 against the old profile,
which points at navigation rather than the app.

Its sibling `rename-opens-editor` failed during the 2026-08-23 profile rebuild
and is **not** an app bug: the profile briefly contained two projects named `e`,
so the by-name press was ambiguous. Pressing the pencil by hand opened the
editor every time, `0x0 -> 300x21.1`. Fixed in the scrubber, not in the app or
the check. Recorded because "a rename check went red" is exactly the shape of
report that gets misfiled as a regression.

Neither failure is a confirmed application bug. **No confirmed application bugs
are open.**

---

## 3. Coverage per surface

From `ps-qa cover <surface>`, fresh instance, 2026-08-23.

| surface | on open | revealed | swept | vanished | native | unaccounted |
| --- | --- | --- | --- | --- | --- | --- |
| home | 169 | 47 | 79 | 89 | 1 | 0 |
| project | 113 | 1 | 28 | 83 | 2 | 0 |
| settings | 14 | 0 | 10 | 1 | 3 | 0 |
| analytics | 1 | 0 | 1 | 0 | 0 | 0 |

`swept` means pressed and something in the tree changed. It does **not** mean
the right thing changed.

`revealed` is a control that did not exist when the surface was counted - a
dialog's own buttons, which only appear once it opens. They are pressed, and
they extend the denominator rather than inflating `swept`.

`vanished` is the large number and it is mostly honest: opening a dialog or
collapsing a section removes buttons that were counted at the start. It is also
where a real regression would hide, because a control that disappeared because
it broke is reported the same way. **89 of home's 169 is high enough to deserve
its own investigation** - it is the single largest unexplained bucket in this
table.

### `UNACCOUNTED` used to be negative. Fixed 2026-08-23

`cover home` reported `UNACCOUNTED -47`: the buckets summed to *more* than the
total. A dialog's controls do not exist when the surface is counted, so pressing
them charged `swept` against a denominator that never included them. The check
that exists to make a coverage regression a number rather than silence was
therefore broken, and broken in the forgiving direction - reporting a surplus,
which reads as "more than covered".

Fixed by giving those controls their own `revealed` bucket that extends the
total. Two tests hold it: one that a dialog no longer overflows the total,
one that a surplus cannot cancel out a real gap. `total.blocked` was also never
summed into the run total, so a control trapped behind an undismissable dialog
counted on its surface line and vanished from the headline.

The `swept` numbers above are lower than the pre-fix ones (home was 126) because
the old figure double-counted. These are the truthful ones.

---

## 3b. Findings from a single live instance, 2026-08-23

One app, many probes, no rebuild between them. Recorded here because each is a
number somebody should either fix or deliberately accept.

**70 on-screen buttons have no accessible name.** Measured with `layout`,
filtering to a real box: 70 controls paint, are pressable, and announce nothing.
Two consequences, and the second is the one that shows up in this file. A screen
reader reads them as unlabelled. And `ps-qa` drives controls *by name*, so these
cannot be reached by any check that could ever be written: they are a permanent
floor under the 173 never-driven controls, not a backlog item. Naming them is
the only thing that makes them testable.

**Settings is correctly unmounted when you leave it**, contrary to a first
reading here that said otherwise. 7 `Parse Prompt Syntax controls` nodes stay in
the tree after navigating to Home, all at `0x0`. That matches the note at
`App.tsx:235-250`: Settings is ~9308px tall and deliberately not retained. The
first reading came from an `awk` column slip, which is worth recording as its
own warning: `layout` prints `id role x y w h`, and reading `$4` as width says a
node paints when it does not.

**Clicking an already-open Settings tab does raise it.** Probed directly - open
Settings, go Home, click Settings - and the surface came back. `openSettings()`
in `stores/workspace.tsx` guards only the tab *append*; `focus()` is called
unconditionally. Recorded because the opposite was suspected, and a suspicion
that is not written down gets re-investigated.

**`spill` reports scrolled content as spill.** 8 tab-strip children sit at
negative x, up to 1,375px left of their parent, which reads as a serious layout
break. The parent is a scroller: `scroll=1186.0`, `content=2068.1`,
`client=855.2`. They are scrolled out of view, exactly as intended. `spill`
should subtract the container's scroll offset before judging, or it will keep
costing somebody an afternoon.

## 4. Unknowns

Not bugs. Things nobody has measured, listed so they stop being invisible.

1. **173 controls are never driven.** 345 reachable, 118 swept, 18 asserted.
   Which 173 is not written down anywhere, because `cover` prints counts and not
   names.
2. **No assertion reads the store.** Every check judges the screen. "A fork
   dialog closed" is asserted; "a fork exists" is not. A control that updates
   the UI and writes nothing passes everything here.
3. **No assertion drives the keyboard.** `ps-qa type` exists and no check calls
   it. `rename-opens-editor` proves the editor opens, never that a typed name
   is kept.
4. **No ordering assertion.** Sorting and reordering cannot be verified at all:
   the checks would pass if a sort reversed the wrong column.
5. **No pixel assertion.** `paints()` is geometry-only, because the semantic
   tree's `visible` flag disagrees with the renderer. The icons regression that
   started this whole audit was an ink failure that geometry cannot see.
6. **5 macOS file panels cannot be driven.** Native `app.dialog()` call sites.
   Counted as `native`, never pressed.
7. **Retained panes still confound name lookups.** 124 to 2,731 nodes are
   retained off-surface depending on where the app has been. A `layout` or
   `press` by name can resolve into a pane that is no longer in front; two wrong
   conclusions on 2026-08-22 came from exactly this.
8. **The two `status` and `rename` failures above.**

---

## 5. Open issues

Numbered so they can be referred to. Ordered by what makes the numbers
trustworthy, then by what extends them.

### 1. `status-1` asserts the wrong subject
Described above. The check has never measured what it claims to.

### 2. `rename-project-header` does not reach its control
Resolve navigation-vs-absent. It is the only check whose failure could still be
an application bug.

### 3. Name `cover`'s unreached controls
The 173 are a list nobody can act on while it is only a subtraction. Print the
names; a bucket without names cannot be promoted into a check.

### 4. Explain home's 89 vanished
More than half of home's controls end in that bucket. Some of it is honest - a
collapse legitimately retires a section's contents - but 89 is large enough that
a genuinely broken control would be indistinguishable from the normal case.

### 5. No store assertions
The single largest hole. Turns "the dialog closed" into "the fork exists".
Needs a read path from `ps-qa` to the store, or a diagnostics call exposing it.

### 6. No `Typed` expectation
Drive keystrokes, assert the value landed and persisted.

### 7. No `Ordered` expectation
Capture the sequence of names matching a selector before and after, assert the
permutation.

### 8. No pixel assertions
Assert ink, not just a box. This is what the original regression needed.

### 9. Per-group fixtures
`tests/ps-qa/` hardcodes `theta theta north indi`, `e756` and `Home`. A check should
declare what it needs - "a project with items" - and the runner should find one.

**This is not hypothetical.** Rebuilding the profile on 2026-08-23 renamed both
fixtures and broke 15 references across 6 files at once. Worse, before the
scrubber was fixed it had produced *two* projects named `e`, so `press "Rename
e"` was ambiguous, pressed the wrong one, and reported a working editor as dead
- the app was fine, verified by hand: `0x0 -> 300x21.1`. A check that names its
fixture is a check that a data change can silently invert.

### 10. Promote the remaining controls in dependency order
Navigation first, then destructive, then the rest.

---

## 6. Rules that keep these numbers honest

Learned the expensive way; each one invented a false finding before it was
written down.

- **Restore the profile before every run.** `PaintsMore` and `Grows` compare
  against a baseline, and an editor left open by an earlier press is already
  counted.
- **A check that has only ever passed proves nothing.** Break the app on
  purpose, confirm red, restore, confirm green. Two checks here were wrong when
  written and passed anyway.
- **`press: true`, not `click`.** `click` dispatches a click and nothing else,
  so a control acting on `mousedown` reads as dead.
- **Prefer `Vanishes` to `Absent`.** A dismissed dialog is usually still in the
  tree at `0x0`.
- **Check for a `Compiling` line.** Cargo will not rebuild if the source mtime
  lands in the same minute, and you will test a stale binary believing you
  tested the fix.
- **A Home row opens on a double click.** Two `press` calls are not one.
