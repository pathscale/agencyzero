# Connecting the GUI to real data

The frontend is complete against a typed IPC surface that Rust implements one command at a
time. It talks to [`apps/gui/frontend/src/api/client.ts`](../apps/gui/frontend/src/api/client.ts);
`api/index.ts` asks Rust which commands exist (`list_capabilities`) and routes each method
to Rust or to [`api/mock.ts`](../apps/gui/frontend/src/api/mock.ts) accordingly, so the
window is honest about which half is real rather than choosing between a backend that
cannot boot it and one that forgets everything.

**Done, for this whole document, means the mock never answers.** Every task below swaps one
more command from fixture to fact; the footer says which backend is in use until they all
have.

Probing a single command as a proxy for all of them is what this replaced: implementing
`get_settings` alone used to flip the whole app onto a backend where `list_projects` did
not exist.

The phases below are ordered so the app is usable at the end of each one. Within a phase,
tasks are roughly independent.

---

## Phase 0 — the shapes and where they live

Nothing renders differently. This is the groundwork every later phase assumes.

- [ ] **Port the model into `az-core`.** The TypeScript in
      [`frontend/src/types/index.ts`](../apps/gui/frontend/src/types/index.ts) is the
      agreed shape; mirror it as serde structs with `#[serde(rename_all = "camelCase")]`,
      since that is what the frontend already reads. Enums are `#[serde(rename_all =
      "snake_case")]` — `read_only`, `logged_out`, `cancel_run`.
- [ ] **Decide the store.** One SQLite file under the app data dir is the obvious
      candidate; `agent-abstraction` already partitions sessions by project on disk
      (`<dir>/<project-slug>/<name>.json`), so the transcript may not need to live in the
      database at all. Write the decision down before building on it.
- [ ] **Pick the id scheme.** `Project.id` is documented as a stable slug and used as both
      tab identity and route key. Slugs collide; decide now whether it is a slug, a uuid,
      or a slug with a disambiguating suffix, because it is baked into every command
      signature below.
- [ ] **Set up the event bus.** A single `AppHandle::emit` wrapper typed against
      [`AppEvents`](../apps/gui/frontend/src/api/client.ts). Every mutation broadcasts,
      including ones the user just made — the frontend already treats events as the source
      of truth and updates optimistically only for the tab it owns.

## Phase 1 — the read path

After this the app boots on real data and is honest, if inert. Done — the whole read path
is served by Rust, and the window boots on the database rather than on fixtures.

- [x] `get_settings() -> GlobalSettings` — the probe. Return a persisted record, seeding
      defaults on first run: `defaultPermission: read_only`, `envPolicy: minimal`,
      `moderator.enabled: true`, `forwardProxyVars: false`.
- [x] `list_projects() -> Project[]` — sorted by `order`. Drives the tab strip and Home.
- [x] `list_items(project_id) -> ProjectItem[]` — sorted by `order`.
- [x] `list_messages(project_id) -> Message[]` — transcript order by `createdAt`.
- [x] `list_running_tasks(project_id) -> RunningTask[]` — served from an in-memory
      registry in `AppState`, not a table. A running task cannot outlive the process
      running it, so a persisted one would come back after a restart as a spinner for
      work that can never finish.
- [x] `list_task_log(project_id, limit, before?) -> { entries, total }` — note the shape:
      the panel badge shows the total while holding a page. `before` is the `finishedAt`
      cursor for older pages, and it is **exclusive**, so the row it names is not served
      twice. The frontend does not paginate yet.
- [x] `list_rate_limits() -> RateLimit[]` — empty is fine. **This command is not in the
      design's proposed surface**; it exists because `run:rate_limit` announces a *change*
      and a window opened after one arrived would otherwise show a clear header for a tab
      that is still blocked.
- [x] `list_agent_status(recheck) -> AgentStatus[]` — the real probe, cached in `kv`
      between launches because it spawns two processes per agent.

**Verify:** launch and read `logs/az-gui.log`. `boot: backend=hybrid` names the backend,
each command is logged in and out, and `boot: ready` means the read path completed. A
request with no matching reply is the one that hung.

## Phase 2 — mutations that don't need an agent

Everything the user can change by hand. Each command returns the updated entity *and*
emits its event.

- [ ] `set_settings(patch) -> GlobalSettings` — a deep merge, since the Settings screen
      sends leaf patches like `{ moderator: { model: "haiku" } }`.
- [ ] `list_agent_status(recheck: true)` — the real probe: run each CLI's version command,
      compare against the `minVersion` this build was verified against, and detect
      logged-out separately from missing. Fills the `caps` chips (fork is Claude-only;
      caller-minted session id on Claude and Copilot; agent-printed thread id on Codex).
      The exact commands, and the per-agent model catalog this should also return, are
      worked out in [`agent-model-surface.md`](agent-model-surface.md): `claude auth status`
      answers logged-out as JSON, `codex debug models` enumerates Codex, and Claude's list
      comes from the Anthropic `/v1/models` endpoint rather than from the CLI, which needs
      a credential decision that is still open.
- [ ] `create_project(first_message, model?, permission?) -> { project, items }` — needs an
      agent to name the project, so it lands properly in Phase 3. Until then, deriving the
      name from the first line is what the mock does and is enough to unblock the rest.
- [x] `delete_project(id)` — clears the task log, transcript and items before the
      project row, so a failure part-way leaves it listed and retryable rather than
      orphaning rows under an id nothing points at. Home confirms in place first.
- [ ] `set_project_status(id, status)`, `set_project_pinned(id, pinned)`,
      `set_project_moderator(id, enabled)`. **`set_project_status` gates the tab
      dot's grey state**: without it every project stays `active`, so nothing ever
      reads as inactive.
- [ ] `reorder_projects(ids) -> Project[]` — already wired: dragging a tab calls this on
      drop, and Home reads the result back.
- [ ] `add_dir(project_id, path)` / `remove_dir(project_id, path)`. Consider adding the
      Tauri dialog plugin at the same time — the panel currently takes a typed path
      because there is no native folder picker.
- [ ] `create_item`, `delete_item`, `set_item_status`, `reorder_items`.
- [ ] `set_tab_model(tab_key, agent, model, permission)` — persist an unsent per-tab selection
      state. The frontend keeps this in memory and in `localStorage`; decide whether Rust
      should own it at all, or whether this command should be dropped.

**Verify:** create a project, add an item, toggle its status, drag a tab, restart the app.
Everything survives.

## Phase 3 — the agent run

The real work. This is where `agent-abstraction` enters, and where the transcript stops
being a list of user messages.

- [ ] `send_message(project_id, body, item_id?, model?, permission?) -> Message` — persist
      the user's message, emit `message:appended`, then start a `Run` with the tab's model
      and permission.
- [ ] **Map the event stream.** Per the design's `agent-abstraction → UI` table:
      - [x] `Event::Started {session, model}` — the session id is persisted on the
        **project** (not the message: it is the handle a later turn resumes with) and
        shown in the header with a copy button. Rewritten on every `Started` rather
        than only when empty, since a stale id would resume the wrong conversation.
      - `Event::Text(delta)` — append to a streaming bubble. **Never sum the deltas as the
        answer**; `Outcome::text` is the authoritative body stored as `Message.body`.
      - `Event::Thinking(text)` — a collapsed block. No frontend component yet.
      - [x] `Event::ToolCall` → `task:started` with a `RunningTask`. The row label is
        rendered from `ToolCall::input` in the agent's own shape, so the label has to be
        built Rust-side — `tool_label` shows the argument a human would have typed (the
        command, the path, the pattern) and falls back to compact JSON, never to the bare
        tool name, which cannot be told from the three identical rows above it.
      - [x] `Event::ToolResult` → `task:finished` with a `TaskLogEntry`, persisted to the
        `task_log` table so the panel survives a reload. `ok` is nullable: null means the
        agent did not say, which is **not** failure — and since a WorkTable column is not
        nullable, it is stored as `-1` unknown / `0` failed / `1` succeeded. Results are
        matched to their call by `ToolCall::id` and never by label.
      - `Event::RateLimit` → `run:rate_limit`, in the provider's own wording.
      - `Stop` + `exit_code` → `run:stopped`.
- [ ] `cancel_run(project_id)` — `Run::cancel`. Must not resolve until the process group is
      gone; the composer's Stop button is bound directly to it.
- [ ] `cancel_task(tool_call_id)` — per-row Stop. `RunningTask.toolCallId` is nullable
      because not every agent supplies one; the button is already disabled when it is null.
      **Blocked on the crate:** `agent-abstraction` cancels a `Run`, not an individual
      tool call, so there is nothing to implement this against yet. Left out of
      `IMPLEMENTED` rather than faked, so the frontend keeps serving it from fixtures and
      greys it out instead of appearing to stop something it cannot.
- [x] `clear_task_log(project_id)`.
- [x] **One authored PS surface for items and pull requests.** Standalone
      `@agency:items.*` and `@agency:pr.link` directives are the only mutations
      read from an agent reply. Checkboxes, prose, quoted examples, fenced
      examples, and bare PR URLs remain display text.
- [ ] **Streaming needs a frontend pass too.** `TranscriptPane` renders finished messages
      only. Adding a `message:delta` event means either extending `AppEvents` or reusing
      `useStreamingBuffer` from `@pathscale/ui`. Decide which before emitting deltas.
- [x] **The raw exchange is visible.** `list_agent_io(project_id)` plus an
      `agent:io` event feed an Agent I/O panel section: the request as sent, then
      every event as it arrived, then the terminal outcome. In memory and capped at
      500 lines per project — the durable copy is the log file, which survives the
      crash this would not.
- [x] **Handle `looks_like_a_format_change()`** — clean exit, empty answer, unparsed > 0.
      "The CLI is healthy, our parser is not" needs its own visible state, not a silent
      empty reply. Nothing in the design covers it.

**Verify:** send a real message, watch a tool call appear in Running and land in the Task
log, then cancel a run mid-flight and confirm the process group actually dies.

## Phase 4 — the moderator

A second agent run watching both the transcript and the raw event stream. It costs tokens,
which is why it has its own enable toggle at global and session level.

- [ ] Start the moderator run alongside the main one when `moderator.enabled` and the
      project has not overridden it off.
- [ ] Feed it both streams (`moderator.sees: ["transcript", "events"]`).
- [ ] Emit its notes as `Message` rows with `author: "moderator"` and a `Moderation`.
- [ ] **Holds.** `needsApproval: true` emits `moderation:blocked`; the frontend turns the
      tab dot and renders Approve once / Deny. `onCheck: hold_step` parks that one step and
      lets the rest run; `onCritical: cancel_run` kills the run and its process group.
- [ ] `resolve_moderation(message_id, approve)` — releases the held step or denies it.
- [ ] `confineToDirs` is the rule the moderator matches tool calls against. It is a
      setting, not a hard sandbox — the design is explicit that this is containment after
      the fact, not prevention.
- [ ] **Parked:** resuming after a CRITICAL halt. The killed turn is gone, so resuming
      means a fresh turn on the same session with context re-sent, behind a double
      confirmation. Not designed. Do not improvise it.

## Phase 5 — the shell

- [ ] **Desktop notifications** from `GlobalSettings.notifications` — on hold, run
      finished, task failed, rate limited, plus the sound toggle. Needs the Tauri
      notification plugin and a permission in `capabilities/default.json`.
- [ ] **`envPolicy`** — `minimal` passes only PATH, HOME and USER (the verified floor for
      all three CLIs); `inherit` passes everything. Enforced where the agent process is
      spawned.
- [ ] **`forwardProxyVars`** — off by default because HTTPS_PROXY often embeds credentials.
- [ ] **Window state** — remember size and position. `UiPrefs.lastTabKey` already restores
      the tab.
- [ ] **A native menu** with ⌘1 / ⌘2 as accelerators. They work as webview keybindings
      today ([`frontend/src/features/tabs/shortcuts.ts`](../apps/gui/frontend/src/features/tabs/shortcuts.ts));
      a menu makes them discoverable and survives focus leaving the webview.

## Phase 6 — fork

Claude only. `--fork-session` branches into a *new session id*, so a fork is a second
transcript sharing history up to a point — a new project tab, not a view of the old one.

- [ ] `fork_project(project_id, message_id) -> Project`, recording `Project.forkedFrom`.
- [ ] Return `Error::Unsupported` on Codex and Copilot, and disable the affordance up front
      from `AgentStatus.caps` rather than letting it fail at click time.
- [ ] There is no fork entry point in the UI yet — the project header's ⋯ menu is the
      obvious home.

---

## Not blocked on Rust

Frontend work that can happen in parallel:

- [ ] **Transcript rendering** — the design's second parked TODO. `Message.body` is real
      markdown and code blocks, diffs and long tool output all land there;
      [`MessageBody.tsx`](../apps/gui/frontend/src/features/project/MessageBody.tsx)
      handles paragraphs, bold and inline code and nothing else. Worth its own pass once
      real output exists to design against.
- [ ] **⌘K** — the Home search box shows the shortcut but nothing is bound to it.
- [ ] **Task log paging** — `before` exists in the command and is never sent.
- [ ] **The ⋯ menu** in the project header is inert.
- [ ] **`Tab.activeItemId`** is in the model and unused; the design left it reserved, and
      the empty state keys off the conversation being empty instead. Either give it a
      meaning or drop it.
- [ ] **Dock and inline task placement** — `UiPrefs.taskPlacement` types all three, only
      `panel` is built.


## How a project gets named

Three stages, decided 2026-07-29. The point is that the tab is never blank and
never blocks on a model call.

1. **Front of the prompt, immediately.** Derived locally from the first message
   the moment it is sent. No round trip, so the tab has a name before the agent
   has said anything. This is the same move Claude Desktop makes with its task
   list, and it is good enough on its own.
2. **A cheap second call, auto-applied.** A small model is asked for a better
   name and the project renames itself when the answer lands. Deliberately a
   *separate* call rather than a schema on the first turn: constraining the first
   response to carry a name shapes the answer the user actually asked for, and
   the naming call is cheap enough that a second one costs less than that.
3. **Manual rename, always available.** Whatever the first two produce, the name
   is the user's to change. Neither stage is authoritative.

Stage 1 must not wait on stage 2, and stage 2 must not overwrite a stage 3
rename. That ordering is the whole design: anything that blocks the tab on a
model call, or that lets a late auto-rename clobber a deliberate one, has got it
wrong.

## Where a project runs

`GlobalSettings.workspace_root`, defaulting to `$HOME/AgencyZero` and created on
explicit accept rather than on save. Empty in the record means "not chosen",
resolved at read time, so the default follows the machine rather than being
frozen into a record written on a different one.

This is what unblocked the first prompt: `Project.dirs` is empty at creation by
design (directories are added in the project's Settings section, not asked for at
init), so without a workspace root a bundled `.app` would run the agent from `/`.
