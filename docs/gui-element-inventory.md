# GUI element inventory

Every interactive element in the window, what it does today, and what it still needs.
Companion to [`gui-wiring-plan.md`](gui-wiring-plan.md), which orders the Rust work; this
one is the checklist of surfaces that work has to reach.

Audited against `apps/gui/frontend/src` at the head of `feat/gui-frontend`.

## How to read the status column

| Status | Meaning | Work left |
| --- | --- | --- |
| **Live** | Calls the API layer. Works end to end today against the mock, and switches to Rust with no frontend change. | Rust only. |
| **Saved** | Persists correctly, but **nothing reads the value back**. The control is honest about storing your choice and silent about it having no effect. | Rust must consume it. |
| **Local** | Real behaviour, entirely in the window. Nothing to wire. | None. |
| **Display** | Renders data. Not interactive, and in some cases should become so. | Judgement call. |
| **Inert** | Has no handler. Clicking does nothing. | Frontend + Rust. |
| **Missing** | In the design or the model, not built. | Frontend + Rust. |

**Totals:** 47 wired elements (Live/Saved/Local), **7 inert**, **11 missing**, and 12 model
fields the UI never reads. The inert and missing rows are the actual backlog.

---

## Window chrome

| Element | Status | Notes |
| --- | --- | --- |
| Tab pill → select | Local | |
| Tab close × | Local | Shown on active/hover/focus; always mounted so the pill never resizes. |
| Tab drag → reorder | **Live** | `reorder_projects` on drop, writing `Project.order`. |
| Tab status dot | Display | Derived: hold > rate limit > running > quiet. |
| "+" new project | Local | Opens one draft; a second press focuses the existing one. |
| Gear → Settings tab | Local | |
| **Avatar "N"** | **Inert** | A `<div>` with hardcoded initials. No account model exists. Obvious home for sign-in / profile / theme. |
| Menu: Close Tab ⌘W | **Live** | |
| Menu: Select Previous/Next ⌘1 ⌘2 | **Live** | |
| Menu: Quit ⌘Q | **Live** | Routes to the confirmation. |
| Quit confirmation → Cancel / Quit | **Live** | Counts running tasks and held projects. |
| **Menu: New Project, Close Window** | **Missing** | No ⌘N; ⌘⇧W is unbound. |
| **Window size and position** | **Missing** | Not remembered across launches. `UiPrefs.lastTabKey` is. |

## Home

| Element | Status | Notes |
| --- | --- | --- |
| Search field | Local | Filters projects *and* item titles client-side. Correct at this scale — no `search` command needed. |
| **⌘K chip** | **Inert** | Decorative `<kbd>`. Nothing is bound to the shortcut. |
| Project group row → open tab | **Live** | |
| Pin / Unpin | **Live** | `set_project_pinned`. |
| Chevron `>` on a group row | Display | Not a button. Either make it one or drop it. |
| **Item rows under a project** | **Display** | `cursor-default`, no handler. The mockup had them clickable. Decide what a click means — open the tab focused on that item? |
| Project status suffix `(Active)` | Display | `set_project_status` exists in the store with **no UI to reach it**. |
| "New Project" button | Local | |
| Pinned panel rows | **Live** | |
| Recent panel rows | **Live** | Ordered by `lastActivityAt`. |
| **Delete a project** | **Missing** | `delete_project` is declared and reachable from the store, but nothing in the UI calls it. |

## Untitled (draft)

| Element | Status | Notes |
| --- | --- | --- |
| Composer → create project | **Live** | Send is disabled while empty (`canCreate`). |
| Failure message | **Live** | The draft stays open on error rather than losing what was typed. |
| Project name from the first reply | **Stub, Rust-side** | The mock takes the first line. The real command needs the agent to name it — Phase 3. |

## Project — header

| Element | Status | Notes |
| --- | --- | --- |
| Project name, `conversation · Claude` tag | Display | The agent is hardcoded to Claude in the tag. |
| Rate-limited pill | Display | From `list_rate_limits` + `run:rate_limit`. |
| **⋯ overflow menu** | **Inert** | The single highest-value inert control. Natural home for rename, **fork**, delete, set status, close. |

## Project — transcript

| Element | Status | Notes |
| --- | --- | --- |
| User bubble / agent prose / moderator note | Display | |
| Approve once / Deny | **Missing** | Phase 4 has no moderator run or `resolve_moderation`; production controls stay disabled. |
| Starter chips on the empty state | **Live** | Send the chip text as the first message. |
| "nd" avatar on user bubbles | Display | Hardcoded initials, same as the tab-strip avatar. |
| **Streaming text** | **Missing** | `Event::Text` deltas have nowhere to land. Needs an `AppEvents` addition or `useStreamingBuffer`. Decide before Rust emits them. |
| **Thinking blocks** | **Missing** | `Event::Thinking` has no component. |
| **Markdown, diffs, long tool output** | **Missing** | Parked TODO from the design. Today: paragraphs, `**bold**`, `` `code` `` only. |
| **Failed turns** | **Missing** | `Message.stop` and `exitCode` are modelled and never rendered — an errored turn looks like an ordinary one. |
| **`looks_like_a_format_change()`** | **Missing** | "The CLI is healthy, our parser is not" has no visible state. Not covered by the design either. |

## Project — composer

| Element | Status | Notes |
| --- | --- | --- |
| Text area, Enter to send, Shift+Enter newline | Local | Grows to 168px then scrolls. |
| Model pill | **Live** | Per tab, sticky. Offers the Claude and OpenAI models enabled in Settings, from `agent-abstraction`'s catalogue via `list_models`. The provider and model move together; Copilot remains out of scope. A tab keeps a model the selection later drops, rather than silently switching. See [`agent-model-surface.md`](agent-model-surface.md). |
| Permission pill | **Live** | Per tab, per session. `read_only` default. |
| Usage readout | Display | Last message that reported usage. |
| Send | **Live** | |
| Stop (while running) | **Live** | `cancel_run`. |
| **Attach "+"** | **Inert** | No attachment model exists at all. |
| **Mic** | **Inert** | No dictation. |
| **`/` commands** | **Missing** | The placeholder advertises them ("type / for commands") and nothing parses `/`. Either build it or change the copy. |
| **Item association** | **Missing** | `Message.itemId` is modelled as a soft link and the composer never sets it. Nothing in the UI attaches a message to an item. |

## Project — right panel

### Settings section

| Element | Status | Notes |
| --- | --- | --- |
| Working directory list | Display | |
| Add dir | **Live** | Takes a **typed path**. A native picker needs the Tauri dialog plugin. |
| Remove dir × | **Live** | |
| Moderator toggle (this session) | **Saved, disabled** | Persists, but no moderator run consumes it; production control is disabled until Phase 4. |

### Items section

| Element | Status | Notes |
| --- | --- | --- |
| Item row → cycle status | **Live** | pending → active → finished → pending. |
| New item | **Live** | |
| **Delete an item** | **Missing** | `delete_item` declared, no UI. |
| **Reorder items** | **Missing** | `reorder_items` declared, no UI. The tab strip has the drag machinery to borrow. |

### Running section

| Element | Status | Notes |
| --- | --- | --- |
| Task rows, tool name, elapsed | Display | Elapsed ticks from a shared 1s clock. |
| Stop | **Live** | `cancel_task`; disabled when the agent gave no `toolCallId`. |
| **Row → detail** | **Missing** | `ToolCall::input` never reaches the UI. Rust renders the label; the arguments are not shown anywhere. |

### Task log section

| Element | Status | Notes |
| --- | --- | --- |
| Entries with ok/fail and duration or exit code | Display | |
| Count badge | Display | Total, not page length. |
| Clear | **Live** | |
| **Row → output** | **Missing** | `TaskLogEntry.output` is fetched, capped at 1 MiB by the crate, and never displayed. |
| **Paging** | **Missing** | `list_task_log(…, before?)` takes a cursor the frontend never sends. Fixed at 40. |

## Settings tab

| Element | Status | Notes |
| --- | --- | --- |
| Agent rows: dot, version, state, caps chips | Display | |
| Re-check | **Live** | Real probe is Phase 2. |
| Default agent / model / permission | **Live** | The agent picker offers only `connected` agents. |
| Moderator: enabled, model, confine to dirs | **Saved, pending** | No moderator run consumes these settings. |
| Moderator: CHECK / CRITICAL hold behaviour | **Saved, pending** | Phase 4 is not implemented. |
| **Notifications ×5** | **Saved, pending** | Persist correctly. **Nothing sends a notification** — the section is visibly inert until the Tauri notification plugin and capability exist. |
| **Environment policy** | **Saved, pending** | Nothing applies `minimal` vs `inherit`; the section is visibly inert. |
| **Forward proxy vars** | **Saved, pending** | Same. |

The Saved rows are the ones most likely to mislead: they look wired, they persist, and they
change nothing. Worth either building the consumer or visibly marking them pending.

---

## Commands declared with no way to reach them

Each is in [`api/client.ts`](../apps/gui/frontend/src/api/client.ts) and implemented in the
mock, so wiring a UI to them is frontend-only work.

| Command | Store action? | Blocked on |
| --- | --- | --- |
| `delete_project` | yes | A UI affordance — the ⋯ menu. |
| `delete_item` | yes | An affordance on the item row. |
| `set_project_status` | yes | Where does the user change it? Home suffix, or ⋯. |
| `fork_project` | **no** | Both. Claude-only; disable from `AgentStatus.caps` rather than failing at click time. |
| `reorder_items` | **no** | Both. |

## Model fields the UI never reads

Modelled in [`types/index.ts`](../apps/gui/frontend/src/types/index.ts), populated by the
mock, and dropped on the floor. Each is either a missing feature or a field to delete.

- `Tab.activeItemId` — reserved by the design; the empty state keys off the conversation instead. Give it meaning or drop it.
- `Message.itemId` — the soft message↔item link, never set.
- `Message.stop`, `Message.exitCode` — a failed turn renders identically to a good one.
- `Moderation.policy` — which rule fired; the audit trail is invisible.
- `Usage.cacheReads` — collected, never shown.
- `Project.forkedFrom` — set by `fork_project`, displayed nowhere.
- `TaskLogEntry.output` — the observation the model saw.
- `RunningTask.input` (via `ToolCall::input`) — not even in the frontend type; the label is pre-rendered Rust-side.
- `AgentStatus.minVersion` — only surfaced in the `outdated` string.
- `UiPrefs.taskPlacement` — types `panel | dock | inline`; only `panel` is built.
- `GlobalSettings.moderator.sees` — fixed at both; no control.
- `ProjectStatus: "canceled"` — in the enum, unreachable from the UI and never rendered.

## Suggested order

Cheapest-first, and roughly by how much each removes a lie from the interface:

1. **⋯ menu** — unlocks four declared commands at once (rename, delete, status, fork later).
2. **Task log row → output** and **Running row → input** — the data is already there.
3. **Item delete and reorder** — the drag machinery exists in `features/tabs/reorder.ts`.
4. **Decide on Attach, Mic, ⌘K and `/`** — build or remove. An inert control is worse than an absent one.
5. **Notifications** — the largest Saved-but-silent group.
6. **Streaming and failed turns** — needed before Phase 3 lands, not after.
