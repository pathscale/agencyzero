# Connecting the GUI to real data

The frontend is complete against a typed IPC surface that Rust does not implement yet. It
talks to [`apps/gui/frontend/src/api/client.ts`](../apps/gui/frontend/src/api/client.ts);
today `api/index.ts` probes `get_settings`, that throws, and the window falls back to
[`api/mock.ts`](../apps/gui/frontend/src/api/mock.ts) serving the design fixtures.

**Done, for this whole document, means the probe succeeds and the mock never loads.** Get
`get_settings` returning a real record and the app is on the Rust path — every task after
that swaps one screen at a time from fixture to fact.

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

After this the app boots on real data and is honest, if inert. **This is the phase that
turns off the mock**, so do it as one unit rather than command by command.

- [ ] `get_settings() -> GlobalSettings` — the probe. Return a persisted record, seeding
      defaults on first run: `defaultPermission: read_only`, `envPolicy: minimal`,
      `moderator.enabled: true`, `forwardProxyVars: false`.
- [ ] `list_projects() -> Project[]` — sorted by `order`. Drives the tab strip and Home.
- [ ] `list_items(project_id) -> ProjectItem[]` — sorted by `order`.
- [ ] `list_messages(project_id) -> Message[]` — transcript order by `createdAt`.
- [ ] `list_running_tasks(project_id) -> RunningTask[]` — empty until Phase 3, but the
      command has to exist or startup fails.
- [ ] `list_task_log(project_id, limit, before?) -> { entries, total }` — note the shape:
      the panel badge shows the total while holding a page. `before` is the `finishedAt`
      cursor for older pages; the frontend does not paginate yet, so `limit` alone is
      enough to start.
- [ ] `list_rate_limits() -> RateLimit[]` — empty is fine. **This command is not in the
      design's proposed surface**; it exists because `run:rate_limit` announces a *change*
      and a window opened after one arrived would otherwise show a clear header for a tab
      that is still blocked.
- [ ] `list_agent_status(recheck) -> AgentStatus[]` — see Phase 2; return a fixed
      `missing` row per agent first so Settings renders.

**Verify:** launch, confirm the footer banner is gone, and that Home, a project tab and
Settings all render from the database. `console.warn` from `api/index.ts` is the tell if
the probe is still failing.

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
- [ ] `delete_project(id)`, `set_project_status(id, status)`, `set_project_pinned(id,
      pinned)`, `set_project_moderator(id, enabled)`.
- [ ] `reorder_projects(ids) -> Project[]` — already wired: dragging a tab calls this on
      drop, and Home reads the result back.
- [ ] `add_dir(project_id, path)` / `remove_dir(project_id, path)`. Consider adding the
      Tauri dialog plugin at the same time — the panel currently takes a typed path
      because there is no native folder picker.
- [ ] `create_item`, `delete_item`, `set_item_status`, `reorder_items`.
- [ ] `set_tab_model(tab_key, model, permission)` — persistence for `UiPrefs`-adjacent tab
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
      - `Event::Started {session, model}` — persist the session id against the
        conversation; the model chip should show what was actually selected, not what was
        asked for.
      - `Event::Text(delta)` — append to a streaming bubble. **Never sum the deltas as the
        answer**; `Outcome::text` is the authoritative body stored as `Message.body`.
      - `Event::Thinking(text)` — a collapsed block. No frontend component yet.
      - `Event::ToolCall` → `task:started` with a `RunningTask`. The row label is rendered
        from `ToolCall::input` in the agent's own shape, so the label has to be built
        Rust-side.
      - `Event::ToolResult` → `task:finished` with a `TaskLogEntry`. `ok` is nullable:
        null means the agent did not say, which is **not** failure.
      - `Event::RateLimit` → `run:rate_limit`, in the provider's own wording.
      - `Stop` + `exit_code` → `run:stopped`.
- [ ] `cancel_run(project_id)` — `Run::cancel`. Must not resolve until the process group is
      gone; the composer's Stop button is bound directly to it.
- [ ] `cancel_task(tool_call_id)` — per-row Stop. `RunningTask.toolCallId` is nullable
      because not every agent supplies one; the button is already disabled when it is null.
- [ ] `clear_task_log(project_id)`.
- [ ] **Streaming needs a frontend pass too.** `TranscriptPane` renders finished messages
      only. Adding a `message:delta` event means either extending `AppEvents` or reusing
      `useStreamingBuffer` from `@pathscale/ui`. Decide which before emitting deltas.
- [ ] **Handle `looks_like_a_format_change()`** — clean exit, empty answer, unparsed > 0.
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
