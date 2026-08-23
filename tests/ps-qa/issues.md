# Component audit inventory and failures

This file records measured renderer results, not legacy unit-test results. Run
the procedure in `docs/QA-button-audit-runbook.md` against a freshly restored
QA profile before changing any status.

## Current audit subject

- AgencyZero: PR 186, app version 0.8.32
- ps-qa: PR 7 at `d70a93f`, version 0.3.0
- blitz-control-protocol and tauri-runtime-blitz: PR 28, version 0.1.2
- Checks: 23 in 9 groups

The current run must use `--features blitz-inspector`, the explicit
`target/blitz-control.json` descriptor and `/tmp/qa-profile-db`. Every action is
addressed by semantic node id. Coordinate pointer activation is not valid audit
evidence.

ps-qa still provides generic coordinate `press` diagnostics. AgencyZero's RON
checks intentionally omit `press`; this application must use semantic actions
and explicit accessible names, resolving repeated rows to an exact node id.

## Required blocker checks

Record these before any component verdict:

| measurement | required result | current fresh result |
| --- | --- | --- |
| inactive top-level surfaces mounted | exactly one | pending fresh run |
| hidden and painted buttons | 0 expected | pending fresh run |
| ghost nodes | below the configured budget | pending fresh run |
| duplicate names | resolved to intended node id | pending fresh run |

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

## Outcome checks

`ps-qa list` currently loads:

| group | checks |
| --- | ---: |
| icons | 1 |
| hover | 4 |
| status | 2 |
| sections | 5 |
| tasklog | 2 |
| rename | 2 |
| dialog | 2 |
| delete | 1 |
| settings | 4 |
| **total** | **23** |

Fresh pass/fail results are pending the authorized inspector run. A result is
not green until its claimed defect has also been mutation-tested red.

## Manual release worklist

The automated audit excludes the exact `manual_controls` in `ps-qa.ron`:

- native file, directory, import, export and backup panels the harness cannot
  close;
- external URL, browser and repository controls.

`cover` must print each control it encountered. These are neither passes nor
automated failures. A person verifies them once per release.

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

`blitz-control-protocol` and `tauri-runtime-blitz` 0.1.2 are published. ps-qa
PR 7 is locally green with 29 tests and strict Clippy against the published
protocol. TRB PR 29 adds Linux protocol and macOS runtime CI plus ordered crate
publishing; both CI jobs are green.
