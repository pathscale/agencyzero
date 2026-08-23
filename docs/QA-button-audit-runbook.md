# Component outcome audit with ps-qa

This is the repeatable procedure for deciding whether controls work in the
running Blitz application. Findings and dated counts live in
`tests/ps-qa/issues.md`; this file contains no session status.

## What counts as evidence

`ps-qa` reads the semantic tree, addresses a control by its semantic node id,
and asserts the renderer state after activation. A jsdom event is not UI
evidence: it has no layout, hit-testing, clipping, compositor or native runtime.

Every automated check must assert an outcome. "The action was acknowledged" is
not an outcome. Examples:

- Collapse becomes Expand.
- Cancel removes the visible dialog.
- Rename produces a painted textbox with the expected accessible name.
- A captured icon contains visible ink, not merely a layout box.

## Build and launch

From the repository root:

```sh
cd apps/gui/frontend
bun run build
cd ../../..

# Cargo does not track the embedded frontend output. Force the binary relink.
touch apps/gui/src/main.rs
cargo build --release --bin az-gui

scripts/qa-profile-restore.sh /tmp/qa-profile-db
AZ_DATA_DIR=/tmp/qa-profile-db \
  ./target/release/az-gui &
```

The default build includes `blitz-inspector`; the AgencyZero Settings toggle is
the normal control enablement source. The committed QA profile stores that
toggle as enabled. `--blitz-control` is an enable-only recovery path so turning
the setting off cannot lock automation out of the control needed to turn it
back on. Never run against the System instance or its data directory. Stop the
exact QA PID with TERM; never use a broad name match or `-9`.

Run from the repository root, where `ps-qa.ron` and `tests/ps-qa/` live. ps-qa
discovers the newest live descriptor; use its `--descriptor` CLI option only to
disambiguate deliberately concurrent diagnostics instances:

```sh
ps-qa list
ps-qa qa
ps-qa qa rename
ps-qa qa rename-project-header --trace
```

The manual GitHub workflow is `.github/workflows/qa-panel.yml`. It builds the
frontend before Rust, restores the committed profile, and installs
`ps-qa ^0.3`. It remains advisory until the inventory says coverage is a
release gate.

## Select by name, act by node id

Start every investigation with `find`:

```sh
ps-qa find '*' --role button
ps-qa find 'Edit *' --role button --visible
ps-qa find '*' --role button --hidden --painted
```

`find` returns the semantic id. When a table has the same button name on every
row, activate the exact returned id:

```sh
ps-qa click --id 1842
```

Names select candidates; coordinates never select or activate controls. The
runtime delivers pointer-down, mouse-down, pointer-up, mouse-up and click to the
chosen node id. Double-click navigation is one node-addressed runtime action,
so the two clicks cannot drift outside the platform interval.

Useful diagnostics:

```sh
ps-qa dom '<name>' 8
ps-qa paint '<name>'
ps-qa capture '<name>' 4
ps-qa nodes
ps-qa panes
ps-qa audit
ps-qa ghost
ps-qa spill
```

`capture` answers whether ink was drawn. `paint` answers which styles the
renderer resolved. `dom` names the ancestor that made a control hidden or 0x0.

## Remove hidden-tree noise before coverage

Run these before `cover` or any count-based assertion:

```sh
ps-qa find '*' --role button --hidden --painted --count
ps-qa ghost
```

A hidden subtree with layout boxes is an application defect. Do not teach the
harness to guess which duplicate name is the visible copy; unmount the inactive
application subtree, then re-run coverage on a fresh process.

## Checks are application data

Checks live in `tests/ps-qa/*.ron`:

```ron
(
    id: "dialog-cancel-dismisses",
    group: "dialog",
    what: "the fork dialog's Cancel actually dismisses it",
    open: Some("Home"),
    hover: None,
    click: Some("Cancel"),
    subject: "Start fork",
    expect: Vanishes,
)
```

AgencyZero checks omit `press` and always use semantic node activation. The
generic ps-qa `press` command and `press: true` check option remain available
for other applications and pointer-path diagnostics; they are deliberately not
used by this suite.

Mutation-test every check: reintroduce the defect, confirm red, restore it, and
confirm green. A check that has only passed has not proved that it can detect
its claimed failure.

## Manual-only release controls

Never activate these unattended:

- a native dialog the harness cannot close;
- a control that opens a browser, URL or another application.

List each one in `ps-qa.ron` under `manual_controls`. `cover` reports them as a
named manual worklist and excludes them from automated pass/fail totals. Verify
that list manually for every release.

## Legacy frontend unit suite

The old frontend unit suite is manual-only in
`.github/workflows/frontend-unit.yml`. It may catch isolated logic regressions,
but it is not a UI delivery gate. Port component checks to `ps-qa` one by one;
delete renderer-blind tests once their outcome check exists, and delete tests
that never asserted a user-visible outcome.
