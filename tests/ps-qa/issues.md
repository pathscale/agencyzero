# Component audit inventory and failures

This is measured renderer evidence. It does not count jsdom event dispatch as a
working control. Every automated action resolves an accessible name to an exact
semantic node id; AgencyZero checks never use coordinate-pointer activation.

## Current subject

- AgencyZero PR 186, app 0.8.37
- ps-qa PR 10 candidate, 209 checks in 22 groups
- PathScale UI PR 262 candidate, package version 2.9.2
- tauri-runtime-blitz candidate based on 0.1.5; the next release will include
  native, selected, pressed and checked state in one semantic boolean
- disposable profile: `/tmp/qa-profile-db`
- launch contract: `az-gui --blitz-control`; no descriptor environment variable

## Exact inventory

Run 32699353075 materialized all deferred settings and Home rows before counting:

| category | controls |
| --- | ---: |
| total | 674 |
| reachable ordinary controls | 653 |
| unreachable | 0 |
| anonymous | 0 |
| disabled by current state | 8 |
| manual release controls | 12 |
| isolated lifecycle | 1 |
| stable/disabled instances reconciled to named outcomes | 661 |
| unverified ordinary controls | 0 |

The declaration gap is zero. `Enable inspection and agent control` is isolated
because success closes the inspector socket. Application Restart and Restart
AgencyProxy are manual release checks: either can terminate audit cleanup and
continuation, and their implementation changes infrequently.

## Rendered outcome evidence

| area | result | run |
| --- | ---: | ---: |
| project rename, including persisted replacement | 5/5 | 32696302228 |
| inert-pencil mutation (expected red) | 0/5 | 32702341694 |
| item creation, ordering, editing and Escape | 4/4 | 32698944567 |
| project-panel row move/edit/delete | 5/5 | 32709128655 |
| Home navigation/item edit/delete/search | 18/18 | 32709132027 |
| fork/setup dialog dismissal and workspace creation | 6/6 | 32707938707 |
| Settings menus, writes and backend round trips | 42/42 | 32699343684 |
| task-log copy/expand/page/clear | 9/9 | 32707599080 |
| shell and list chrome | 11/11 | 32709136042 |
| isolated session reset | 2/2 | 32708266768 |
| theme and glass controls | 19/19 | 32703091144 |

The settings snapshot verdict is not a click acknowledgement. Its log contains
`create_store_snapshot` followed by `store snapshot written`; the check only
passes after that successful write generation changes.

The rename negative control disables the pencil on a disposable ref. All five
checks then fail with the exact missing textbox/key target. The mutation is not
present on any delivery branch.

## Failures found and repaired

1. Both project pencils painted but did not enter edit mode through the live
   renderer. `EditableTitle` now uses one ordinary controlled Button/Input
   pattern with explicit Enter and Escape behavior. The real build is 5/5 and
   the inert mutation is 0/5.
2. The new-item editor used a nonstandard mount/blur sequence. It now uses an
   ordinary visible Input with explicit Enter/Escape behavior; a new row paints
   above every older row.
3. TRB exposed only `aria-selected`; pressed buttons and checked radios always
   reported false. The candidate now unifies native checked, `aria-selected`,
   `aria-pressed`, `aria-checked`, and option selection.
4. `ThemePicker` waited for slow settings round trips before reflecting button
   state. It now owns immediate controlled values and synchronizes persisted
   props. UI's `ComplexColorWheel` uses index-stable reactive rows so an
   adjustment update does not replace its semantic node.
5. The first theme manifest clicked `Text brightness 50%`, which was already the
   selected default. It now clicks the explicit non-default 75% stop.
6. `ps-qa click Restart` chose the earlier substring `Restart AgencyProxy`.
   Exact accessible names now outrank substrings, and the lifecycle workflow
   uses `button:Restart` explicitly.
7. Separate final gate steps stopped after the first `exit 1`, hiding later
   lifecycle failures. One aggregate gate now reports every failed stage before
   failing the job.
8. A single mutable 166-check process took 47 minutes and allowed one check to
   poison later areas. The full run now restores the committed profile and
   launches a fresh exact process for each of the 22 groups.
9. Project-panel and Home item editors closed during their autofocus transition
   because blur committed immediately. They now remain open until explicit
   Enter (save) or Escape (cancel); both real-renderer groups are green.
10. Empty model menus looked interactive in environments with no alternative
    installed model. Composer and Task Manager now expose those controls as
    disabled instead of opening an empty menu.

## Validation still running

- 32709197709: project-name rename
- 32709865981: shared UI LanguageSwitcher menu
- 32710039045: deterministic Composer behavior
- 32710160446: visible Resume-session path
- 32710302056: Settings unavailable-model and study-data state

No PR is updated and no candidate dependency is published until these runs are
classified. A focused failure is fixed and rerun; it is never averaged into a
pass count.

## Manual release worklist

The automated audit counts but does not activate controls that open an external
destination or native chooser the harness cannot close, or the two low-churn
restart controls that can terminate audit cleanup:

- Add dir
- Attach files
- Attach files for the task manager
- Back up & close
- Choose…
- Export JSONL
- Select backup file…
- Restart AgencyProxy
- Restart AgencyZero
- Star on GitHub
- View source

The duplicate accessible labels account for twelve concrete controls. A person
verifies them once per release.

## Acceptance contract

A control passes only when a named check drives the running rendered component
through a semantic node id and observes its promised visible, semantic, stored,
or process-level outcome. Inventory alone is not a pass. The broad sweep is a
diagnostic for newly introduced controls; the named reconciled outcomes are the
release gate.

The legacy frontend suite is manual-only. It currently has 78 files and 674
direct declarations. Delete a renderer-blind test only after its live
replacement passes and a negative mutation proves that replacement turns red.
