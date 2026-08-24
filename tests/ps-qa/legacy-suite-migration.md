# Legacy frontend suite migration

The legacy suite currently spans 78 `*.test.ts(x)` files and 674 direct
`it`/`test` declarations; parameterized cases account for the higher executed
total. This is an inventory, not a promise to create the same number of ps-qa
checks.

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
exact replacement persists (5/5 in run 32696302228).
