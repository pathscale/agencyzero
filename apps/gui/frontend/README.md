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
bun run test         # vitest, watch mode
bun run test:run     # vitest, once
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

⌘N opens a new project, ⌘W closes the tab, ⌘1 selects the previous and ⌘2 the next — both
cycling wrap. ⌃T also opens a new project, by a different route (below). These are **native menu accelerators**, defined in
[`../src/main.rs`](../src/main.rs): macOS delivers them whatever has focus, and the menu bar
is where a keybinding is discoverable. The menu items carry ids, not behaviour; Rust emits
`menu:new-project` / `menu:close-tab` / `menu:prev-tab` / `menu:next-tab` and
[`useAppShell.ts`](src/features/shell/useAppShell.ts) answers them with the same actions the
strip uses.

### Why ⌃T is not a menu item

A menu accelerator is resolved by macOS *before* the key reaches the webview. That is what
makes one reliable and discoverable — and it is also why it shadows whatever the combination
did in a text field. macOS gives every text field an emacs-style set (⌃A ⌃E ⌃B ⌃F ⌃P ⌃N ⌃K
⌃T), so **any** Ctrl-letter accelerator takes one of those away. ⌘N is the one shortcut for
"new" that costs nothing, which is why it is the menu binding.

⌃T is handled in the webview instead, on a plain keydown in
[`shortcuts.ts`](src/features/tabs/shortcuts.ts). Nothing in the menu claims it, so the key
reaches the DOM first: it fires wherever focus is — the composer included — and
`preventDefault()` stops the text field transposing. The trade is the menu-bar listing:
⌃T works everywhere but is not written down anywhere in the UI.

[`shortcuts.ts`](src/features/tabs/shortcuts.ts) binds these in the webview **only outside
Tauri**, so they work under `bun run dev` in a browser — though a browser takes ⌃T for its
own new tab before the page sees it. It is gated rather than always-on:
a menu accelerator is consumed by the menu and never reaches the webview today, but that
is macOS behaviour to rely on rather than a guarantee, and a double-fire would silently
skip a tab.

Cycling walks `state.tabs`, which *is* the strip order, so a reordered tab cycles from
where it now sits with nothing to keep in step.

Dragging a tab reorders it ([`reorder.ts`](src/features/tabs/reorder.ts)) — pointer
events, not HTML5 drag-and-drop, because Tauri's webview owns native drag for file drops
and `dragstart`/`drop` are unreliable in the window this has to work in. The strip
reorders live as you drag, so the tab you are holding is always where it would land and
there is no separate drop indicator to keep truthful.

**Pointer capture is taken on the first real move, never on `pointerdown`.** While an
element holds the pointer the browser retargets the following `click` to it, so capturing
early sends every click to the pill wrapper instead of the button inside it and selecting
a tab by clicking stops working. Taking capture only once the 5px threshold is crossed
means a plain click never captures. A finished drag deliberately does not select the tab
it moved — you were reordering, not choosing.

Once the strip overflows, chevrons appear at each end — disabled rather than hidden at the
extremes, so the row does not shift as you reach them. There is deliberately **no visible
scrollbar**: a horizontal one under the tabs is a few pixels tall *and* sits inside the
window's drag region, which makes it effectively unclickable.

Selecting a tab scrolls it into view, which is what keeps ⌘1/⌘2 usable at that width —
cycling onto a tab that is scrolled out of sight would otherwise look like nothing happened.
Each pill carries `data-tab-key` so the effect can find it.

Home is index 0 and stays there. On drop, the project tabs' new order is persisted with
`reorder_projects`, which writes `Project.order` — so it survives a restart and Home
re-sorts to match. Draft and Settings tabs are window state and keep their place only
while they are open.

A pill is the same width in every state, which matters because cycling through tabs
otherwise shoves the strip sideways on each step. Two things would resize it, and both are
handled: the close button is always mounted for a closable tab and only *revealed* on
active/hover/focus, and the label carries an always-semibold invisible ghost sharing one
grid cell with the visible copy, so the cell is sized for the bold width whatever weight
is showing.

Opening a tab puts the cursor in its prompt, for both a project and a new draft. `autofocus`
as an attribute is only honoured on initial page load and these mount when a tab opens, so
the browser ignores it — `Composer` calls `focus()` on mount instead.

## Quitting

Every route out — the traffic light, ⌘Q, the menu's Quit — is intercepted and routed
through one confirmation
([`CloseConfirm.tsx`](src/features/shell/CloseConfirm.tsx)), because quitting drops every
Run the window is supervising and killing a run kills its whole process group. The dialog
counts what is actually in flight rather than asking a generic "are you sure?" — a
confirmation that cannot say what you are about to lose trains you to dismiss it.

The traffic light arrives as `onCloseRequested` and is cancelled with `preventDefault`;
⌘Q and the menu item are a custom `menu:quit` event, because the predefined Quit item
exits the process without asking anyone. Confirming calls `destroy()`, not `close()` —
`close()` re-enters the same close-requested handler and the window never goes. That needs
`core:window:allow-destroy` in the capability file.

## Where the Rust boundary is

**Everything under `src/` is frontend.** It reaches Rust through exactly one file,
[`src/api/client.ts`](src/api/client.ts), which declares the command and event surface
proposed in `design/data-model.html`. Two implementations satisfy it:

| | |
| --- | --- |
| [`src/api/tauri.ts`](src/api/tauri.ts) | The real client: `invoke()` per command, `listen()` per event. |
| [`src/api/mock.ts`](src/api/mock.ts) | An in-memory stand-in serving the mockup's own data from [`src/api/fixtures.ts`](src/api/fixtures.ts). |

[`src/api/index.ts`](src/api/index.ts) picks one at startup. Outside the Tauri webview it is
always the mock. Inside it, it probes with `get_settings`, and **the kind of failure
decides**: a "command not found" error means Rust has not implemented it yet and falls back
to fixtures; anything else — a database that would not open, a rejected capability, a serde
mismatch, a panic — is rethrown and the window shows a boot error with a retry.

Falling back on every error would be fail-open: a broken backend would leave the app fully
interactive, writing to ephemeral fixture state behind a small banner, with the user
believing their projects were saved. **The window says which backend it is on** in a footer
rather than letting fixtures pass for live data.

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
- **`GlobalSettings.defaultModel` became `GlobalSettings.models`**, a
  `Record<Agent, { enabled: string[]; default: string }>`. A single default model could not
  express which models a picker should offer, and the three agents have separate catalogues
  with overlapping ids, so a Codex id and a Copilot id that read the same are different
  models. Settings picks per agent; the prompt reads the `claude` entry, and Codex and
  Copilot are collected for the code review UI. See
  [`docs/agent-model-surface.md`](../../../docs/agent-model-surface.md).
- **The composer row does not match `design/workspace.html`.** The design puts the model
  pill on the left, right after Attach. A newer reference puts posture and input controls
  left and the model on the right, with a reasoning-effort control beside it, and that is
  what is built. The mic and the chevron beside it in that reference are deliberately not
  built. Design has not caught up yet.
- **Claude's effort ladder is hardcoded, temporarily.** `agent-abstraction` 0.2.2 leaves
  `efforts` empty for every Claude entry, so `CLAUDE_EFFORTS` in
  [`workspace.tsx`](src/stores/workspace.tsx) stands in with the levels `claude --help`
  reports on 2.1.205. The catalogue is preferred whenever it answers, so this is one
  deletion once the crate carries the ladder, not a migration. **Delete it then** — a second
  copy of a model fact is exactly what the old hardcoded `MODELS` list was.
- **Nothing sends the effort yet.** `Request` in the crate has `model`, `permission`,
  `format`, `system` and `session` but no effort, so the control is a stored preference the
  run path cannot act on until the crate adds one.
- **Only `taskPlacement: "panel"` is built.** The dock and inline variants are a mockup
  tweak; the type keeps them open.
- **"Add dir" takes a typed path**, not a native folder picker — that needs the Tauri dialog
  plugin, which is not wired up.

Two TODOs stay parked exactly where the design left them: resuming after a CRITICAL halt
(needs a double-confirmation flow) and real transcript rendering for markdown, diffs and
long tool output. [`MessageBody.tsx`](src/features/project/MessageBody.tsx) handles
paragraphs, `**bold**` and `` `code` `` and nothing more, building JSX nodes rather than
assigning HTML so agent output can never become markup.

## Tests

Vitest + jsdom + `@solidjs/testing-library`, colocated as `src/**/*.test.ts(x)` — the same
setup as `nofilter.io`. `bun run test:run`.

They run against the mock backend, which means against the design fixtures: three
projects, two tool calls running on WorkTable, a CRITICAL hold and a rate limit on
api.support.cafe. That is deliberate — the fixtures are a known, shared world, so a test
can assert "a critical hold outranks a rate limit" without building a scenario first.

What is covered, in rough order of how much it earns its keep:

| | |
| --- | --- |
| [`stores/workspace.test.tsx`](src/stores/workspace.test.tsx) | Tab order, cycling and wrap, close-falls-left, draft→project conversion, and the `tabStatus` precedence chain (hold > rate limit > running > quiet). These encode decisions, not mechanics. |
| [`features/tabs/reorder.test.ts`](src/features/tabs/reorder.test.ts) | The drag gesture, including the pointer-capture rule that a regression already broke once. |
| [`api/mock.test.ts`](src/api/mock.test.ts) | The stand-in backend: every command, the events each one broadcasts, deep-merged settings, log paging and totals. |
| [`features/project/MessageBody.test.tsx`](src/features/project/MessageBody.test.tsx) | The transcript renderer, including that agent output can never become markup. |
| [`features/tabs/TabStrip.test.tsx`](src/features/tabs/TabStrip.test.tsx) | Close buttons on every closable tab, the sizing ghost, `aria-current`, click-to-select. |
| [`lib/format.test.ts`](src/lib/format.test.ts) | Times, durations and usage, including that absent usage renders as "—" and never as zero. |

### What these cannot catch

Worth stating plainly, because a green suite here does not mean the window works.

- **jsdom has no layout.** `getBoundingClientRect` returns zeros. The tab-width fix is
  tested structurally — the close button is mounted, the ghost exists — but whether the
  strip actually stops shifting is a measurement, and jsdom cannot measure.
- **jsdom does not model pointer capture.** The click regression was the browser
  retargeting `click` to the capturing element; a jsdom test would have passed with the
  bug present. What is asserted instead is the *invariant* — capture is not taken on
  pointerdown — which does fail against the broken version. That was checked, not assumed.
- **Nothing here runs inside Tauri.** The menu, its accelerators, the drag region and the
  quit confirmation are all shell behaviour. `tauri-driver` has no macOS support
  (WKWebView exposes no WebDriver), so on this platform they are hand-tested.

The gap that would pay for itself is a real-browser layer against `bun run dev` — measure
pill widths across active states, and click a tab after a genuine pointerdown. `nofilter.io`
does exactly this in [`tests/thirtyfour/`](https://github.com/pathscale/nofilter.io/tree/master/tests/thirtyfour),
a small Rust crate driving WebDriver. Not built here yet.

## Conventions

Follows [`docs/ui-usage.md`](https://github.com/pathscale/ui/blob/master/docs/ui-usage.md)
in the `@pathscale/ui` repo — the source of truth for how the library is consumed, shared by
every app that uses it. SolidJS (signals, `<Show>`, `<For>`, `class=`), Bun, Biome, rsbuild,
same as `24x.ai` and `support.cafe`.
