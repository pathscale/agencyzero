# Legacy frontend suite migration

The legacy suite remains a migration inventory, not a promise to create the
same number of ps-qa checks. Parameterized cases make executed totals especially
misleading; each visible behavior gets one stronger live outcome instead.

## Conversion rule

For each user-visible behavior:

1. reproduce it against the real Blitz renderer with a restored QA profile;
2. select by accessible name and activate the resolved semantic node id;
3. assert the visible outcome and mutation-test the check red;
4. delete the equivalent renderer-blind test.

Delete a legacy test immediately when it only verifies mocks, implementation
structure, CSS source text, or a behavior already covered by a stronger live
outcome. Retain isolated logic tests for pure formatting, ordering, parsing,
pricing, and other functions whose result does not depend on rendering.

Static policy checks are not renderer tests. The former
`components/uiControlAudit.test.ts` is now the dependency-free
`scripts/check-ui-controls.ts` lint gate, so it stays automatic without running
the legacy Vitest suite or pretending a source scan verifies rendered behavior.

## The contract for a component that enters a mode

A control that swaps one thing for another - an inline editor, a disclosure, a
dialog, a picker - needs four checks, not one. Three of them are easy to write
and prove nothing on their own.

1. **It enters.** The mode's own node paints, addressed by `role:name` rather
   than by name. A name-only `Paints` is satisfied by the control that opens the
   mode, which paints whether or not anything happened.
2. **It does its work.** The typed name is accepted, the chosen value lands, the
   dialog's action runs. *This is the one that gets skipped*, and it is the only
   one that distinguishes a working component from a decorative one.
3. **It leaves by each exit.** Every way out a reader has: the confirming key,
   the abandoning key, and clicking away. A mode with no pointer exit traps
   anyone who opened it without a keyboard.
4. **It restores.** The last check puts the fixture back, so the group can run
   twice against one instance.

Check 2 is not optional and is not implied by the others. The rename group had
1, half of 3, and no 2: it opened the editor, pressed Escape, and pressed Enter
on a blank name - three checks that all end with the editor closed, which is the
state a completely inert editor is already in. Both pencils shipped unable to
accept a name while that group reported 5/5, and this had already happened once
before (see "Failures found and repaired" in `issues.md`, item 1) and regressed
because the repair was verified by the same checks that could not see it.

Mutation-test check 2 specifically. Break the commit path, not the open path,
and watch it go red.

### The four, written out for an inline editor

`06-rename.ron` is the worked example, and the shape transfers to any component
that swaps one thing for another. Read it as a template rather than as four
checks about renaming:

| | check | `expect` | why that one |
| --- | --- | --- | --- |
| 1 | `rename-opens-editor` | `PaintsNamed` on `textbox:<name>` | `role:name`, because the trigger and the field share an accessible name and a name-only `Paints` is satisfied by the trigger |
| 2 | `rename-commits-typed-name` | `Vanishes` on the field | the field survives in the tree either way, so only its box distinguishes a commit from a keystroke that was swallowed |
| 3 | `rename-escape-keeps-name`, `rename-closes-on-click-away` | `Vanishes` / `PaintsNamed` | one per exit a reader has; the pointer exit is the one usually missing |
| 4 | `rename-restores-the-original-name` | `Vanishes` | renames the row back, so the group can run twice against one instance |

Check 2 is `Vanishes` rather than an assertion about the new name because the
component's contract is that the mode closes on a successful commit. Whether the
*application* then shows the new name is a separate outcome, and
`99-rename-persists.ron` is where that belongs. Keeping them apart is what lets
the first four be written from the component alone.

### Making this mechanical rather than remembered

Today each of the four is hand-written per call site, which is why the missing
one stayed missing: nothing declares that a component *has* a mode, so nothing
can notice that its outcome check is absent.

The piece that would close it is a component identity in the semantic tree. A
PathScale/UI component already names its parts in a recipe and emits them as
`data-slot`, but the tree TRB hands to ps-qa carries only `id`, `role`, `name`,
`bounds`, `visible` and `value` - `data-slot` is dropped, and `ps-qa dom`'s
`attrs:` column is the node's value, not its attributes. Verified against the
running app: every node in the rename subtree reports `attrs: (none)`.

With the slot exposed, a component that declares a `trigger` and a `field` slot
would be enough for the harness to generate the four checks for every instance
of it, and to report a component that has a mode and no outcome check as a gap
rather than as a pass. Until then the contract above is a review rule, and the
cost of it being a review rule is documented in `issues.md` item 1: the same
component was repaired once, verified 5/5 by checks that could not see the
defect, and shipped inert again.

## Largest migration hotspots

| file | direct cases |
| --- | ---: |
| `stores/workspace.test.tsx` | 63 |
| `features/project/Composer.test.tsx` | 47 |
| `features/project/MessageBody.test.tsx` | 36 |
| `stores/models.test.tsx` | 33 |
| `lib/theme.test.ts` | 29 |
| `lib/format.test.ts` | 29 |
| `api/mock.test.ts` | 26 |
| `features/settings/SettingsTab.test.tsx` | 23 |
| `lib/stats.test.ts` | 23 |
| `features/tabs/TabStrip.test.tsx` | 22 |

## Current declaration inventory

| area | direct cases | files | likely treatment |
| --- | ---: | ---: | --- |
| `features` | 271 | 36 | replace rendered outcomes, delete mock-only cases |
| `lib` | 145 | 11 | retain genuinely pure logic |
| `stores` | 121 | 9 | retain state-machine logic; replace UI claims |
| `styles` | 71 | 8 | replace source-text claims with live paint checks |
| `api` | 36 | 3 | retain protocol transforms, delete mock choreography |
| `components` | 30 | 9 | replace renderer behavior with live checks |
| `i18n` | 3 | 2 | retain static catalogue validation |
| root app test | 2 | 1 | replace boot/render claims |

Migration order follows measured UI failures first, then uncovered reachable
controls. Native dialogs that cannot be closed and external destinations stay
in the manual release pass rather than automated activation.

The first completed removal is `features/settings/appearanceAudit.test.tsx`:
its four cases inspected the retired wheel's private DOM and inline-style
shape, while its one behavioral assertion duplicated the surviving settings
persistence case and the live `theme-colour-strength` outcome. The useful
surface-persistence test now consumes ColorSwatch's public semantic contract.

`components/EditableTitle.test.tsx` is also removed. Its five jsdom cases
could not observe layout, focus, event forwarding, or persistence and stayed
green while both live pencils were inert. The rendered rename group now proves
both editors open, Escape preserves the name, whitespace is rejected, and an
exact replacement persists (5/5 in run 32733364792).

`components/ButtonClick.test.tsx` is removed as well. Its five synthetic event
cases stayed inside jsdom and could not prove native hit testing, layout, or
application outcomes. The live replacements include the inert-pencil mutation
(0/5), current rename (5/5), the red dialog-Cancel mutation, disconnected Send
disabled-state checks, and the named semantic activations across this audit.

The fork-dialog jsdom case in `ProjectPanel.test.tsx` is removed. It reported
the complete dialog DOM as inaccessible because jsdom left UI Popover at
`visibility:hidden`; it could neither prove paint nor the native event path.
The live replacement opens the rendered dialog, changes the exact Description
textarea by semantic node id, verifies its value changes, and then starts the
fork in the following outcome.

The moderator-model DOM case is removed as a duplicate. The live
`settings-moderator-model-changes` outcome reaches the deferred Settings section,
drives its native combobox, and requires its accessible name to change.
