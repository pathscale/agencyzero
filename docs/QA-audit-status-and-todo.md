# Component outcome audit: status and next work

Updated 2026-08-23. The repeatable procedure is
`docs/QA-button-audit-runbook.md`; dated measurements and failures are in
`tests/ps-qa/issues.md`.

## Current stack

- AgencyZero PR 186 unmounts every inactive top-level surface. It also keeps
  the legacy frontend unit suite manual and preserves typecheck, lint and the
  production frontend build as automatic CI.
- tauri-runtime-blitz PR 30 carries the node-addressed control protocol,
  reusable glass support and the macOS availability fallback. Click activation
  targets the selected semantic node directly; coordinates do not select or
  retarget a control.
- ps-qa PR 8 provides node-addressed actions, role inventory, modal dismissal,
  nested-scroll reveal and isolated-control classification. AgencyZero's checks
  omit coordinate `press`, so this application uses semantic activation only.

The runtime and protocol changes are versioned as 0.1.4 but are not yet
published. The manual workflow pins TRB PR 30 at `7b44cd6` and ps-qa PR 8 at
`cf01312`; ps-qa has 34 passing tests and a green strict-Clippy gate. Remove
those Git pins only after the matching crates are published and locked.

## Evidence contract

An automated UI result is evidence only when it:

1. runs against the real Blitz renderer;
2. resolves a semantic control by accessible name and records its node id;
3. activates that node id, never a screen coordinate;
4. asserts the resulting renderer state;
5. fails when the claimed defect is deliberately restored.

For repeated row controls, use `ps-qa find` to list every matching semantic id,
then `ps-qa click --id <id>` for the intended row. A name alone is not a unique
selector in a table.

This is an AgencyZero suite invariant, not a restriction on the generic
harness. ps-qa retains coordinate-pointer activation for applications and
diagnostics that explicitly opt into that path.

## Audit order

Always remove measurement blockers before interpreting component failures:

1. Restore the committed QA profile and launch a fresh inspector build.
2. Run `find --hidden --painted` and `ghost`.
3. If inactive surfaces still own painted boxes, fix the application and start
   again. Do not compensate with selector heuristics.
4. Run all 26 outcome checks.
5. Run `audit` and `cover` only after the tree is trustworthy.
6. Record every failure, unreachable surface and manual-only control in
   `tests/ps-qa/issues.md`.

## Manual-only controls

`ps-qa.ron` declares `manual_controls`. The automated audit never activates:

- a native dialog it cannot close;
- a control that opens a URL, browser or another application.

`cover` reports each as a named manual-release worklist. They are neither
passes nor automated failures and must be checked by a person for each release.

## Legacy frontend unit suite

The renderer-blind frontend suite is available only through the manual
`Legacy frontend unit suite` workflow. Its 713 tests are not UI delivery
evidence. Conversion is one component at a time:

1. write and mutation-test a ps-qa outcome check;
2. delete the equivalent jsdom test;
3. delete any test that never asserted a user-visible outcome;
4. retain isolated logic tests only when renderer behavior is irrelevant.

The automatic Frontend job still runs install, typecheck, lint and production
build. Those are build-quality gates, not component outcome assertions.

## Remaining coverage work

- Add store-backed assertions for persistence outcomes such as rename and fork.
- Add typed-value assertions for editors and composers.
- Add ordered-list assertions for sort and reorder controls.
- Promote unverified controls from `cover` into mutation-tested outcome checks.
- Replace geometry-only icon checks with captured-ink assertions.

Do not call an open pull request or a green legacy suite “verified.” Verification
means the fresh renderer audit recorded in `tests/ps-qa/issues.md` is green for
the claimed outcome.
