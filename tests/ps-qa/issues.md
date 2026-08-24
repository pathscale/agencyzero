# Component audit inventory and failures

This is measured renderer evidence. It does not count jsdom event dispatch as a
working control. Every automated action resolves an accessible name to an exact
semantic node id; AgencyZero checks never use coordinate-pointer activation.

## Current subject

- AgencyZero PR 186, app 0.8.37
- ps-qa PR 10 candidate, 213 checks in 24 clean-profile groups
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
| project rename, including persisted replacement | 5/5 | 32733364792 |
| inert-pencil mutation (expected red) | 0/5 | 32702341694 |
| item creation, ordering, editing and Escape | 4/4 | 32698944567 |
| project-panel row move/edit/delete | 5/5 | 32733364792 |
| item issue editor and persisted semantic link | 5/5 | 32735458366 |
| Home navigation/item edit/delete/search | 18/18 | 32709132027 |
| fork/setup dialog dismissal and workspace creation | 7/7 | 32743024916 |
| Settings menus, writes and backend round trips | 60/60 | 32715244253 |
| Analytics tabs, selected-state transitions and refresh | 8/8 | 32739466336 |
| task-log copy/expand/page/clear | 9/9 | 32707599080 |
| shell and list chrome | 11/11 | 32709136042 |
| isolated session reset | 2/2 | 32708266768 |
| theme and glass controls | 19/19 | 32703091144 |
| native shared language selector | 2/2 | 32712761929 |
| Composer controls and disconnected-agent gate | 13/13 | 32717296869 |
| recovered-session editor and reset controls | 8/8 | 32717589257 |

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
   launches a fresh exact process for each of the 24 groups.
9. Project-panel and Home item editors closed during their autofocus transition
   because blur committed immediately. They now remain open until explicit
   Enter (save) or Escape (cancel); both real-renderer groups are green.
10. Empty model menus looked interactive in environments with no alternative
    installed model. Composer and Task Manager now expose those controls as
    disabled instead of opening an empty menu.
11. Adopting a recovered session succeeded in the backend but the frontend
    returned without updating its project state, so the promised attached-id
    status did not repaint. The action now updates the local session map only
    after the durable backend write succeeds.
12. Keyboard checks resolved broad substrings by largest painted area, so
    `button:Send` selected the larger “Parse Prompt Syntax controls before
    sending” control. Keyboard input now uses the same exact-name-first,
    role-qualified semantic resolver as activation.
13. Settings still carried a duplicate assertion for the removed language menu,
    and its custom moderator-model selector did not expose options to the real
    renderer. The duplicate is gone and moderator selection now uses the same
    native semantic combobox pattern proven by the language control.
14. Exact-name priority was applied after disabled controls were removed, so an
    exact disabled `Send` still fell through to an enabled “before sending”
    substring. Exact targets now retain priority before enabled-state gating;
    the disconnected-agent Send state is recorded honestly instead of claiming
    that CI submitted a prompt to an unavailable external agent.
15. Recovered-session adoption persisted and replaced the reactive project, but
    its attached-id status remained an unlabeled nested span. It is now a
    standard live `output` whose accessible name is the exact visible status.
16. The project panel's retained value watched only the `projects` array object,
    not the active project element. Replacing a project therefore left all
    panel props stale. Its reactive source now resolves and tracks the active
    project and tab directly.
17. Item issue persistence was initially reported as 4/5 because the check
    searched for the visual shorthand `(issue #40)`. The renderer correctly
    names that external-link control from its exact `title`, `Open
    https://github.com/pathscale/WorkTable/issues/40`. The check now observes
    that semantic URL without activating the external destination and passes
    5/5. The keyed store update also mutates the stable item node instead of
    rebuilding the entire items array.
18. Dialog dismissal exposed a renderer crash in semantic inspection after a
    popover removed a layout ancestor. TRB now rejects missing or cyclic layout
    parent chains before geometry is computed and reports the node as not
    interactable instead of panicking. Dialog dismissal, Escape, welcome setup,
    and the isolated destructive fork outcome now pass 7/7.
19. Escape visually hid the shared anchored Popover but did not clear its
    owning application signal, so the same fork dialog could not reopen. The
    original vanish-only check missed that stale state. UI now captures whether
    an open-state request changes the value before mutating internal state, then
    always notifies the owner. The live outcome now requires reopen plus a
    normal second dismissal.

## Current validation checkpoint

- 32712761929: native shared UI language selector — passed
- 32717589257: direct Resume-session editor with semantic attached-state change — passed 8/8
- 32717296869: enabled Composer model-node activation and disconnected-agent Send gate — passed 13/13
- 32715244253: native Settings moderator-model selector — passed 60/60
- 32733364792: both project rename editors and project-panel row operations — passed 10/10
- 32735458366: issue editor open/cancel/reopen, backend write, and semantic link — passed 5/5
- 32739466336: Analytics tabs, exact selected-state changes, and refresh — passed 8/8
- 32743024916: dialog open/Cancel/Escape/welcome plus isolated Start fork — passed 7/7
- 32743048974: deliberate Analytics mutation — expected red, 1/8 passed; all seven
  selected-state outcomes failed while the unaffected refresh control passed
- 32744344962: deliberate stale modal-state mutation — Cancel failed as
  expected, but the first Escape-only outcome still passed because the shared
  primitive hid itself while application state remained set; this exposed a
  missing reopen assertion rather than proving the Escape detector
- 32745826995: strengthened positive dialog group — expectedly exposed the real
  stale-state regression at 6/7; isolated Start fork still passed 1/1
- 32747120204: shared UI Popover state fix, including reopen after Escape — queued
- 32747124208: isolated stale-Escape-state mutation against the UI fix — queued;
  ordinary Cancel must pass while reopen-after-Escape fails
- 32744366001: the prior 212-outcome full run — superseded by the new reopen
  assertion and automatically canceled when the strengthened same-ref run began

The strengthened focused positive and negative runs are queued. Once they are
classified, the 213-outcome candidate gets a fresh exhaustive full-control run;
the historical exact inventory above is not carried forward as its count.

No PR is updated and no candidate dependency is published until these runs are
classified. A focused failure is fixed and rerun; it is never averaged into a
pass count.

## Manual release worklist

The automated audit counts but does not activate controls that open an external
destination or native chooser the harness cannot close, or the two low-churn
restart controls that can terminate audit cleanup. Authenticated provider
Send/Run/Reply are also local manual-only; CI verifies their disconnected-agent
gates instead of holding a paid subscription:

- Add dir
- Attach files
- Attach files for the task manager
- Back up & close
- Choose…
- Choose folder
- Export JSONL
- Select backup file…
- Send / Send into the running turn
- Run an item through an authenticated agent
- Reply through an authenticated running agent
- Restart AgencyProxy
- Restart AgencyZero
- Star on GitHub
- View source

The final inventory records the exact concrete instances separately from these
label families. A person verifies them once per release.

## Acceptance contract

A control passes only when a named check drives the running rendered component
through a semantic node id and observes its promised visible, semantic, stored,
or process-level outcome. Inventory alone is not a pass. The broad sweep is a
diagnostic for newly introduced controls; the named reconciled outcomes are the
release gate.

The legacy frontend suite is manual-only. It currently has 77 files and 670
direct declarations. Delete a renderer-blind test only after its live
replacement passes and a negative mutation proves that replacement turns red.
