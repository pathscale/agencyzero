# Component audit inventory and failures

This file records measured renderer results, not legacy unit-test results. Run
the procedure in `docs/QA-button-audit-runbook.md` against a freshly restored
QA profile before changing any status.

## Current audit subject

- AgencyZero: PR 186, app version 0.8.32
- ps-qa: PR 8 at `682b202`, version 0.3.0
- blitz-control-protocol and tauri-runtime-blitz: PR 30 at `7b44cd6`,
  version 0.1.4 pending publication
- Checks: 24 in 10 groups

The current run must use `--features blitz-inspector` and
`/tmp/qa-profile-db`. ps-qa discovers the live descriptor through its normal
CLI path. Every action is addressed by semantic node id. Coordinate pointer
activation is not valid audit evidence.

ps-qa still provides generic coordinate `press` diagnostics. AgencyZero's RON
checks intentionally omit `press`; this application must use semantic actions
and explicit accessible names, resolving repeated rows to an exact node id.

## Required blocker checks

Record these before any component verdict:

| measurement | required result | current fresh result |
| --- | --- | --- |
| inactive top-level surfaces mounted | exactly one | passed before outcome run |
| hidden and painted buttons | 0 expected | failed: idle `Stop the run` painted |
| ghost nodes | below the configured budget | failed: 119 hidden layout nodes in capped tree |
| duplicate names | resolved to intended node id | semantic node-id actions enabled |

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
| sections | 5 |
| tasklog | 2 |
| rename | 2 |
| dialog | 2 |
| delete | 1 |
| settings | 4 |
| **total** | **24** |

Run 32640904469 completed 19/23. Two failures were the same real UI regression:
semantic activation of both rename buttons left a 0x0 textbox. The component
used a pointer-only path; it now uses an ordinary button `click`. The idle
painted Stop button is also fixed by unmounting the control while retaining
only its layout slot.

The other two failures were invalid evidence: the status check compared a broad
hover-revealed count, and the fork Cancel semantic check disagreed with direct
release behavior. The status check now follows the exact clicked accessible
name. Fork remains a harness/action investigation, not a claimed UI regression.

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
3. Sort and reorder controls lack ordered-sequence assertions.
4. The icon check does not yet mutation-test captured ink.
5. Most controls have not been promoted from broad coverage into a specific
   outcome check.
6. The 713-test legacy frontend suite is renderer-blind and manual-only. Delete
   each obsolete test after its real outcome check exists, or immediately when
   it never asserted a user-visible outcome.

## Dependency delivery status

`blitz-control-protocol` and `tauri-runtime-blitz` 0.1.2 are published. TRB PR
30 carries the macOS availability guard and the 0.1.4 version bump; Linux
protocol and both macOS runtime jobs are green. ps-qa PR 8 is green with 30
tests and strict Clippy against the published protocol, and inventories every
interactive role by semantic node id with explicit exclusions and unverified
controls.
