# Button audit: how to run it, what it can and cannot see

Written 2026-08-22. This is the procedure, not a status report: any agent should
be able to follow it from a cold checkout and get the same numbers. Findings
live in `HANDOVER-button-fixes-2026-08-22.md`.

## What this audit is

Every button in the running app, pressed, with the result checked against what
the button's name promises. A `Collapse` must become an `Expand`, a `Delete`
must remove its row, a `Copy` must change nothing. A control that is skipped is
counted in its own bucket rather than quietly passing.

The unit suites cannot do this job and never could. All 711 frontend tests
passed for weeks while the rename pencil was dead on 31 surfaces, because jsdom
has no hit-testing, no layout and no renderer: it dispatches an event straight
at the node it is handed. Every fault found in this audit was invisible there.
Treat a green `vitest` run as saying nothing about whether a control works.

## Prerequisites

```sh
# 1. A pristine profile to restore from. Build one once:
#    launch the app against /tmp/qa-profile-db, get it into a useful state,
#    quit, then clone it. On APFS `cp -c` is copy-on-write, so this is instant.
cp -c -R /tmp/qa-profile-db /tmp/qa-profile-pristine

# 2. The binaries. `blitz-inspector`, NOT `blitz-runtime`: the sweep talks to
#    the diagnostics channel, and a `blitz-runtime` build answers every
#    inspector call with `diagnosticsUnavailable`.
cargo build --release --features blitz-inspector --bin az-gui
cargo build --release --bin blitz-bench
```

Never `cargo tauri build` / bundle. Re-signing the bundle makes macOS SIGKILL
the owner's running window, which looks exactly like a crash bug.

## Running it

```sh
scripts/button-sweep.sh              # all four surfaces, from a pristine profile
scripts/button-sweep.sh home         # one surface
scripts/button-sweep.sh --keep       # leave the instance up to inspect
SWEEP_TRACE=1 scripts/button-sweep.sh project
```

The script restores the profile before every run, because the sweep presses
destructive controls on purpose. A sweep whose subject changes underneath it
cannot tell a fix from a coincidence.

### The frontend must be rebuilt separately

`cargo` does not track `apps/gui/dist`, so a frontend-only change produces a
binary that still embeds the old bundle and a test that silently measures the
code you just replaced. After editing anything under `apps/gui/frontend/src`:

```sh
cd apps/gui/frontend && bun run build
cd ../../.. && touch apps/gui/src/main.rs   # force the relink
cargo build --release --features blitz-inspector --bin az-gui
```

Confirm you are testing what you think: change a node id or a box you expect to
move, and check the ids in `blitz-bench dom` actually differ from the last run.

## Verifying one control by hand

```sh
export TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json"

./target/release/blitz-bench press "<name>"      # a real pointer: move, down, up
./target/release/blitz-bench click "<name>"      # a synthetic click at a node id
./target/release/blitz-bench layout "<name>"     # live boxes: x, y, w, h
./target/release/blitz-bench dom "<name>" 6      # attributes + ancestor chain
./target/release/blitz-bench nodes               # tree size, as a change detector
```

`press` and `click` are not interchangeable, and the difference is diagnostic.
`press` delivers `move`/`down`/`up`; `click` dispatches a single synthetic
`click` at a node id. The rename pencil opens on `mousedown`, so it works under
`press` (textbox `0x0` -> `300x21`) and does nothing under `click`. When the
owner reports a control working that the sweep calls dead, this is the pair that
tells them apart.

Always verify on a **freshly launched instance**. A full sweep leaves the tree
at ~14,000 nodes against a 1,421-node baseline, and working controls start
reading as dead past that point.

## Two measurement traps

Both produced confident, wrong conclusions before.

**1. `layout` reports retained nodes as visible and sized.** Opening a project
keeps Home alive behind it, with real boxes. `Sort ascending` at x=797 is
Home's; the panel's is x=1246. Filter by the pane's x range, or resolve the id
through `reach::on_surface_subtree`, before believing any single match.

**2. Click cost proves nothing.** "Acknowledged in 0.01ms" was read as a
detached handler. `Copy this message`, which works, also reports 0.00ms.

## What cannot run headless

The sweep drives the app through the inspector socket, not the window server:
it injects pointer phases into Blitz's own event pipeline and never moves the
real cursor, so it does not steal focus. It still needs a window to render into.

| | Runs unattended | Needs a display | Cannot be automated |
| --- | --- | --- | --- |
| `cargo test --workspace --features blitz-runtime` | yes | no | - |
| `vitest run` (711 tests) | yes | no | - |
| `scripts/button-sweep.sh` (263 controls) | yes | yes, a window server | - |
| 5 macOS file panels | - | - | yes |

**The 5 native panels are the hard exclusion.** They are AppKit windows outside
the webview: invisible to the tree, unreachable by an injected event, and
Escape through the control protocol goes to the window underneath. The sweep
does not press them. It traces each to its `app.dialog()` call site through
`reach::NATIVE_CHOOSERS` and prints them as a manual worklist:

```
Add dir                              choose_project_directory
Attach files                         choose_attachments
Attach files for the task manager    choose_attachments
```

Re-derive that list with `grep -n '\.dialog()' apps/gui/src/*.rs` — seven call
sites today. If that count changes, `NATIVE_CHOOSERS` is stale and the sweep
will press something it cannot dismiss, which strands an open/save panel on the
owner's screen with no owning process. Check for the residue with
`pgrep -lf openAndSavePanel`.

**On Linux CI:** the Rust workspace and the frontend suite run anywhere. The
sweep needs `xvfb-run` for a window server *and* a Linux `az-gui`, which does
not exist yet — the app is macOS-targeted. The native panels can never run
there at all. So CI today means the two test suites; the sweep stays a local,
attended step until there is a Linux target.

## Reading the output

```
= project    84 buttons: 17 swept, 0 unreachable, 0 hidden, 1 vanished,
                         0 nav, 2 native, 68 blocked (UNACCOUNTED -4)
```

- **swept** — pressed, and the result matched the name's promise.
- **vanished** — planned, then gone by the time its turn came. Not a fault:
  closing one tab legitimately removes its neighbours' close buttons.
- **navigation** — leaves the surface, so it is exercised as an opener.
- **native** — a macOS file panel, from the list above.
- **blocked** — on the surface, reachable in principle, and unreachable because
  one bug upstream trapped the window. This is the bucket that matters: 68
  blocked meant a single broken dialog was hiding a third of the app.
- **UNACCOUNTED** — the buckets do not sum to `in_tree`. Non-zero means the
  harness is lying to you; fix that before reading anything else.

A trapped dialog is caught automatically and reported as
`TRAPPED: no dismiss control and no Escape closes it`.

## Before you conclude anything

- Rebuilt the frontend *and* forced the relink? A stale bundle is the single
  most common way to "verify" a fix that is not in the binary.
- Used `blitz-inspector`, not `blitz-runtime`?
- Fresh instance, near the 1,421-node baseline?
- Checked `x` against the pane, not just the name?
- Checked the log for `REACTIVITY_HALTED`? One reactive write from an owned
  scope freezes the *entire* app, and every control then reads as dead. See
  `lib/live.ts`. If a change makes every button stop working at once, this is
  why — look there before suspecting the buttons.
