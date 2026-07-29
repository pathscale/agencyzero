# az-gui frontend

The AgencyZero workspace UI. SolidJS + [`@pathscale/ui`](https://github.com/pathscale/ui),
built by rsbuild into `../dist`, which Tauri serves as `frontendDist`.

Built from [`design/`](../../../design) — the static export of the design source of truth.
`design/workspace.html` is the mockup, `design/data-model.html` the spec; both are generated
from the Omelette project and re-exported rather than hand-edited.

## Run it

```bash
bun install
bun run dev          # http://localhost:3010, in a plain browser
```

Or as the real desktop app — Tauri starts this dev server itself via
`beforeDevCommand`:

```bash
cd apps/gui && cargo tauri dev
```

```bash
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun run build        # typecheck + rsbuild -> ../dist
```

`beforeDevCommand` and `beforeBuildCommand` in `../tauri.conf.json` are plain
`bun run dev` / `bun run build` because Tauri runs them **from this directory**, not from
`apps/gui` — it locates the frontend by the nearest `package.json`. A `--cwd frontend` in
there fails with `ENOENT`.

## Window chrome

The window uses `titleBarStyle: "Overlay"` with `hiddenTitle`, so there is no native title
bar and the tab strip stands in for one. That means the window is dragged from inside the
webview, which takes two things that have to stay in step:

- `data-tauri-drag-region="deep"` on the strip's root in
  [`TabStrip.tsx`](src/features/tabs/TabStrip.tsx). Tauri walks up from the click target
  and stops at the first clickable element, so tabs, "+" and the gear keep their clicks
  and only the gaps between them move the window. Keep padding on those buttons rather
  than on their wrappers — bare padding inside a tab becomes a dead strip that drags the
  window instead of switching to the tab.
- `core:window:allow-start-dragging` in
  [`../capabilities/default.json`](../capabilities/default.json). It is **not** part of
  `core:window:default`, which does grant `internal-toggle-maximize` — so without it
  double-clicking the strip zooms the window while dragging silently does nothing.

That file also has to list `core:default` itself: adding a `capabilities/` directory
replaces the capability `tauri-build` generates when there isn't one.

## Tabs

⌘1 selects the previous tab, ⌘2 the next, both wrapping
([`shortcuts.ts`](src/features/tabs/shortcuts.ts)). Cycling walks `state.tabs`, which *is*
the strip order, so a reordered tab cycles from where it now sits with nothing to keep in
step.

Dragging a tab reorders it ([`reorder.ts`](src/features/tabs/reorder.ts)) — pointer
events, not HTML5 drag-and-drop, because Tauri's webview owns native drag for file drops
and `dragstart`/`drop` are unreliable in the window this has to work in. The strip
reorders live as you drag, so the tab you are holding is always where it would land and
there is no separate drop indicator to keep truthful.

Home is index 0 and stays there. On drop, the project tabs' new order is persisted with
`reorder_projects`, which writes `Project.order` — so it survives a restart and Home
re-sorts to match. Draft and Settings tabs are window state and keep their place only
while they are open.

## Where the Rust boundary is

**Everything under `src/` is frontend.** It reaches Rust through exactly one file,
[`src/api/client.ts`](src/api/client.ts), which declares the command and event surface
proposed in `design/data-model.html`. Two implementations satisfy it:

| | |
| --- | --- |
| [`src/api/tauri.ts`](src/api/tauri.ts) | The real client: `invoke()` per command, `listen()` per event. |
| [`src/api/mock.ts`](src/api/mock.ts) | An in-memory stand-in serving the mockup's own data from [`src/api/fixtures.ts`](src/api/fixtures.ts). |

[`src/api/index.ts`](src/api/index.ts) picks one at startup. Outside the Tauri webview it is
always the mock. Inside it, it probes with `get_settings` and falls back to the mock with a
console warning if that throws — which it does today, because `az-gui` still exposes only
`greet`. **The window says so in a footer** rather than letting fixtures pass for live data.

When the Rust commands land, the probe succeeds and the app switches over. Nothing above
`src/api/` changes: no component imports `@tauri-apps/api` directly, and no component knows
which backend answered.

The mock is a stand-in, not a simulation. It will not invent an agent reply — sending a
message appends your message and stops there, because a fabricated answer is
indistinguishable from a real one in a screenshot and that is precisely the wrong thing to
ship.

## Layout

```
src/
  api/          the IPC surface: client (interface) · tauri · mock · fixtures
  stores/       workspace (tabs, projects, items, messages, tasks) · prefs (UiPrefs)
  types/        the data model from design/data-model.html
  features/     one directory per screen: tabs · home · draft · project · settings
  components/   Icon + sprite, Panel/SectionPanel, PillMenu, StatusDot
  lib/          format (times, usage) · labels (wire value -> what the user reads)
  styles/       theme.css — the palette and app tokens
```

State lives in one `WorkspaceProvider` store. Commands are fired through it and the
resulting **event** is what updates the store, so a change made by the agent and a change
made by the user land the same way — which is the whole reason every mutation is
broadcast.

## Theme

`data-theme="agencyzero"` on `<html>`, always. This is a desktop tool with a designed
palette, not a site that follows the OS.

[`src/styles/theme.css`](src/styles/theme.css) maps the 24x.ai dark palette onto
`@pathscale/ui`'s token names (`--color-base-100/200/300`, `--color-primary`, …) so
`bg-base-100` and `text-primary` resolve, then adds `--color-az-*` for what the base ladder
does not cover — the text rungs and the desk/inset surfaces. Screens use utilities
(`text-az-muted`, `bg-az-inset`); no component writes an `oklch()` triple.

Two rules the design states outright and this file enforces: the text contrast floor is
`oklch(62%)` (`--color-az-faint`), and there is no pure white — the top tier is
`oklch(86%)`.

Icons are inlined SVG symbols in [`src/components/IconSprite.tsx`](src/components/IconSprite.tsx),
transcribed from the mockup's own sprite. The design's rule is no network at runtime, so
they are not fetched from an icon package at build time either.

## Where this departs from the design, and why

- **`Project.pinned` is not in the spec's entity list**, but Home has a Pinned panel and a
  per-project pin toggle, so the field exists here. Worth adding to the spec.
- **`list_task_log` returns `{entries, total}`**, not a bare array. The panel badge reads
  "91" while holding six rows; a page cannot report the size of the thing it is a page of.
- **`list_rate_limits()` is a command this frontend added.** `run:rate_limit` announces a
  *change*; a window opened after one arrived would otherwise show a clear header for a tab
  that is still blocked.
- **A CRITICAL hold turns the tab dot red, not amber.** That is what `data-model.html` says
  (check → amber, critical → red). The `workspace-*.png` renders show api.support.cafe amber
  because the mockup drove the dot from a single `status` field that could not express both
  its rate limit and its hold.
- **The moderator note's subtitle shows the moderator's model** ("supervising · haiku") where
  the mockup shows "supervising · bypass mode". The model is what the message actually
  records; the posture on a moderator message is the *moderator's*, not the supervised run's.
- **Only `taskPlacement: "panel"` is built.** The dock and inline variants are a mockup
  tweak; the type keeps them open.
- **"Add dir" takes a typed path**, not a native folder picker — that needs the Tauri dialog
  plugin, which is not wired up.

Two TODOs stay parked exactly where the design left them: resuming after a CRITICAL halt
(needs a double-confirmation flow) and real transcript rendering for markdown, diffs and
long tool output. [`MessageBody.tsx`](src/features/project/MessageBody.tsx) handles
paragraphs, `**bold**` and `` `code` `` and nothing more, building JSX nodes rather than
assigning HTML so agent output can never become markup.

## Conventions

Follows [`docs/ui-usage.md`](https://github.com/pathscale/ui/blob/master/docs/ui-usage.md)
in the `@pathscale/ui` repo — the source of truth for how the library is consumed, shared by
every app that uses it. SolidJS (signals, `<Show>`, `<For>`, `class=`), Bun, Biome, rsbuild,
same as `24x.ai` and `support.cafe`.
