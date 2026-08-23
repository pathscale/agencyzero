# Component audit inventory and failures

This file records measured renderer results, not legacy unit-test results. Run
the procedure in `docs/QA-button-audit-runbook.md` against a freshly restored
QA profile before changing any status.

## Current audit subject

- AgencyZero: PR 186, app version 0.8.36
- ps-qa: version 0.3.2, published from merged PR 9
- blitz-control-protocol and tauri-runtime-blitz: version 0.1.5, published
- PromptSyntax-rs: version 0.2.0, published
- PathScale UI: version 2.9.1, published
- Checks: 56 in 15 groups

The current run must use `--features blitz-inspector` and
`/tmp/qa-profile-db`. ps-qa discovers the live descriptor through its normal
CLI path. Every action is addressed by semantic node id. Coordinate pointer
activation is not valid audit evidence.

ps-qa still provides generic coordinate `press` diagnostics. AgencyZero's RON
checks intentionally omit `press`; this application must use semantic actions
and explicit accessible names, resolving repeated rows to an exact node id.

Inventory categories are mutually exclusive. A named, painted control disabled
by current state is `state-disabled`, not an unreachable UI failure; manual
exclusions and anonymous controls likewise cannot occupy two buckets. Inventory
exits red only for anonymous or genuinely hidden/zero-box controls.

## Required blocker checks

Record these before any component verdict:

| measurement | required result | current fresh result |
| --- | --- | --- |
| inactive top-level surfaces mounted | exactly one | passed in run 32672023708 |
| hidden and painted buttons | 0 expected | passed in run 32672023708 |
| ghost nodes | below the configured budget | passed in run 32672023708 |
| duplicate names | resolved to intended node id | visible painted node-id resolution; hidden matches reported |

If any row fails, fix or explain the measurement blocker and restart the app.
Do not interpret `qa`, `audit` or `cover` while ghost subtrees can satisfy name
lookups.

## Resolved launch blockers

- Run 32636554882 could not build because the configured `agency-proxy`
  sidecar had not been staged. The workflow now calls the repository's staging
  script before compiling the GUI.
- Run 32637260189 built and launched, then TRB 0.1.2 tried to allocate the
  macOS-26-only `NSGlassEffectView` on a macOS 14 runner and panicked before
  ps-qa attached. TRB PR 30 guards class availability and falls back to
  vibrancy. That run produced no tree or component verdict.
- Run 32638367663 still compiled crates.io 0.1.2: Cargo reported that the
  0.1.3 Git patches were unused because the lockfile selection remained on
  0.1.2. The workflow now advances that package to 0.1.3 explicitly before
  building.

## Outcome checks

`ps-qa list` currently loads:

| group | checks |
| --- | ---: |
| icons | 1 |
| hover | 4 |
| items | 1 |
| status | 2 |
| sections | 9 |
| chrome | 4 |
| tasklog | 2 |
| rename | 2 |
| toggles | 5 |
| verbosity | 1 |
| dialog | 3 |
| delete | 1 |
| settings | 8 |
| analytics | 6 |
| composer | 7 |
| **total** | **56** |

Run 32640904469 completed 19/23. Two failures were the same real UI regression:
semantic activation of both rename buttons left a 0x0 textbox. The component
used a pointer-only path; it now uses an ordinary button `click`. The idle
painted Stop button is also fixed by unmounting the control while retaining
only its layout slot.

The other two failures were invalid evidence: the status check compared a broad
hover-revealed count, and the fork Cancel semantic check disagreed with direct
release behavior. The status check now follows the exact clicked accessible
name. The fork checks now pass on the released node-id action path; it is not a
claimed UI regression.

Runs 32670085123 and 32670673970 verified the corrected released
harness/runtime path and clean process shutdown, but both rename outcomes
remained red. ps-qa 0.3.2 reported
the decisive distinction: each hidden 0x0 textbox still had a painted rename
button of the same name after node-id activation. The handler therefore did not
enter edit state; this is an application action regression, not a layout-only
failure. Restoring AgencyZero 0.8.30's `mousedown` phase did not change the
live result, which excludes gesture choice. Earlier live measurements in this
component identified the boundary: UI Button's Dynamic element painted but
dropped the nested consumer handler under Blitz. UI PR 262 fixes that once in
the library; Agency keeps the ordinary `onClick={start}` contract. Its live
rerun against UI 2.9.2 is pending.

Run 32672023708 deliberately remeasured that known failure after the workflow
started preserving ps-qa's pipeline exit status. The job finished red at
`Enforce outcome checks`, still uploaded the artifact, and stopped the exact
audit PID cleanly. A failing targeted group can no longer appear green because
`tee` consumed the harness exit code.

## Manual release worklist

The automated audit excludes the exact `manual_controls` in `ps-qa.ron`:

- native file, directory, import, export and backup panels the harness cannot
  close;
- external URL, browser and repository controls.

`inventory` counts these without activation and `cover` prints each one it
encountered. These are neither passes nor automated failures. A person verifies
them once per release.

## Known coverage gaps

These are missing assertions, not application failures:

1. Rename and fork checks do not yet assert the durable store result.
2. Editors open, but no outcome check types and persists a value.
3. Reorder controls lack ordered-sequence assertions; newest-item order now has a rendered check.
4. The icon check does not yet mutation-test captured ink.
5. Most controls have not been promoted from broad coverage into a specific
   outcome check.
6. The 713-test legacy frontend suite is renderer-blind and manual-only. Delete
   each obsolete test after its real outcome check exists, or immediately when
   it never asserted a user-visible outcome.

Response verbosity now has paired coverage: `verbosity-slider-changes` proves
the live rendered slider changes its semantic value through node-id keyboard
input, while the Rust run-builder test proves a stored non-default level is
appended to resumed provider turns rather than only the first system prompt.

## Dependency delivery status

`blitz-control-protocol` and `tauri-runtime-blitz` 0.1.5 are published after
green Linux protocol and macOS 14/26 runtime jobs. ps-qa 0.3.2 is published from
merged PR 9 with strict Clippy and generic post-action diagnostics. PromptSyntax
0.2.0 and PathScale UI 2.9.1 are also published. Agency's workflow now consumes
released versions rather than git patches and inventories every interactive
role by semantic node id with explicit manual, isolated and unverified classes.
