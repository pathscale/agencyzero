# The Home task manager

Home is on its way to being a project like any other: one long-running
conversation that keeps the project and item lists in order.

## Why it is a project rather than a screen

It needs a transcript, a session to resume, a model, a cost, and a raw I/O
trail. A project already has every one of those. Building a parallel set for one
screen would mean two of everything and two places for each bug to live, so Home
**is** a project, reserved under the fixed id `home-task-manager` and hidden from
the project lists.

That id is a constant rather than a generated one so it survives a restart
without a lookup, and it is prefixed differently from `proj-` so it can never
collide with a real project.

## The output contract

The reply has to become rows in WorkTable. Home once asked for an
`AZ-TASKS-BEGIN` JSONL block, while project tabs asked for checkboxes and PRs
were found by scanning prose for URLs. That was three reverse-channel
languages, two of which treated ordinary model output as executable.

Home now uses the same declared Prompt Syntax surface as every project tab:

```
<ps @agency:items.add(project: "<project name or id>", ref: "t1", title: "<one short task>", status: "new")>
<ps @agency:items.state(id: "<item id>", status: "active")>
<ps @agency:items.retire(id: "<item id>")>
<ps @agency:pr.retire(id: "<pull-request association id>")>
```

The `<ps ...>` line is the authority and is visually marked in the transcript.
Prose, quoted material, fenced examples, and URLs outside one of those lines are
inert. Each authored line ends in a receipt on the next turn, including typed
failures for an unknown verb, malformed arguments, or an unknown or ambiguous
id. A malformed authored line therefore cannot disappear as unexplained raw
text.

The Task Manager keeps one context-specific capability from the old contract.
An explicit `items.add(project: ...)` that names no existing project creates a
bare project, then adds the item. The project argument is mandatory on Home;
omitting it is a surfaced `ENTITY_NOT_FOUND`, never an item hidden under the
reserved `home-task-manager` id.

## Deleting, and why absence never deletes

`items.retire(id: ...)` removes exactly one existing item row. `pr.retire(id: ...)`
dismisses the named pull-request association and any legacy duplicates with the
same repository and PR number. These are the only remove verbs available to the
agent. A model asked to "delete X" will happily re-emit
the whole list without X, and treating absence as deletion would wipe rows the
user added by hand every time the model abbreviated. Omission therefore changes
nothing.

To make bulk edits exact ("delete everything about cleaning junk"), every
prompt carries a live snapshot of current project and item ids, built from the
tables and bounded at about 6KB with an honest truncation marker. The model sees
what exists; each deletion names the stable id that will be removed.

The write path stays in the GUI on purpose. wt-tools is read-only by
construction — that is what makes it safe to run beside the GUI on a
single-writer store — so it will never grow a delete. wt-tools is the eyes;
the declared authoring surface is the hands; the GUI is the only writer.

## The project-session contract

Ordinary project conversations use the same directives. The prompt supplies
the current ids and the declared closed verb set:

- `items.add` creates a row. Its `ref` is a temporary handle echoed beside the
  real id in the next-turn receipt. Repeating one uniquely matching title
  returns that stable id and applies the requested status; legacy duplicate
  titles are refused as ambiguous rather than choosing one.
- `items.state` moves an existing id through `new`, `planning`, `active`,
  `questions`, or `shipped`.
- `items.retire` removes exactly the named id.
- `pr.link` records an authored GitHub PR URL and may attach its number to an
  item. A URL in prose is display text only.
- `pr.retire` dismisses a tracked PR association by the stable id shown in the
  prompt. Legacy duplicate rows for that same GitHub PR are dismissed together.

`finished` and `canceled` are reserved to the owner on Home and project tabs.
Checkboxes, prose, quoted examples, fenced examples, and bare PR URLs are inert.

## Can the agent read the WorkTable store?

**Yes — through `crates/wt-tools`.**

WorkTable persists with rkyv — a binary layout with no text form. An agent
pointed at `~/Library/Application Support/com.pathscale.agencyzero/db` sees
bytes. There is no JSON export, and the files cannot be usefully grepped.

The query tool is **`crates/wt-tools`, a headless CLI** exposing read-only
queries over the tables, printing one JSON object per line to stdout and
errors to stderr with a nonzero exit:

```bash
wt-tools list-projects              # every project, ordered by position
wt-tools list-items --project ID   # items, optionally narrowed to one project
wt-tools search-items QUERY        # items whose title contains QUERY (case-insensitive)
```

It finds the store exactly the way the GUI does — the same
`location::resolve`: `AZ_DATA_DIR`, then the `data-location.json` pointer,
then the platform app-data default. A store that does not exist yet reads as
empty rather than erroring, and nothing is ever created on disk.

That keeps the binary format an implementation detail and avoids the
alternative — dumping the whole store to JSON on every turn, which is both
slow and a second copy of the truth.

One design note worth keeping: wt-tools compiles **the gui's own schema files**
(`apps/gui/src/db/schema/`) via `#[path]` includes rather than a copy. Two
declarations of a rkyv layout drift apart silently, so there is exactly one
source file per table; if the schemas are ever extracted into a shared crate,
the includes become re-exports and nothing else changes.

A CLI rather than an MCP server, deliberately. Every agent this app drives can
already run a command in its working directory; MCP would add a server
lifecycle, a registration step per agent, and a protocol between us and our own
data, and buy nothing the CLI does not — MCP earns its keep when a tool needs
state, streaming, or a session, and a read-only table query needs none of them.
If an MCP wrapper is ever wanted (for an agent that cannot run commands),
`crates/mcp-proxy` can shell out to `wt-tools` and stay thin.

One caveat the CLI inherits: WorkTable is a single-writer store, and the GUI
usually holds it. `wt-tools` therefore opens every table through worktable's
`ReadOnlyPersistenceEngine` — writes are no-ops by construction, the load path
opens files with plain `File::open`, and nothing is created or locked — so it
is safe to run while the GUI is open. The one hazard left is catching a flush
mid-write; that surfaces as a parse error and is retried a few times before
being reported.

## Settings

`GlobalSettings.taskManager` carries its own model and effort, defaulting to
`haiku` at `medium`. Deliberately not the prompt's model: this is a list keeper
that runs unattended and wants a cheap fast model far more often than a frontier
one. Sharing the prompt's setting would silently bill a to-do list at Opus rates.

`reset_task_manager` clears the stored session id so the next prompt starts a
fresh conversation. The transcript and the tasks already collected are left
alone — it is "start thinking again", not "throw away what you have".

## The screen

All built, on Home:

- The composer is the left half of the header row: one line, Enter sends, the
  draft held until the send resolves. A pulsing dot replaces the ↵ hint while
  a run is in flight.
- `Task Manager · session <uuid>` appears in faded text under the row once the
  first prompt has produced a session. The id comes from `get_task_manager` —
  the task manager has no project row, so the session the ordinary path hangs
  off `ProjectDto` needed its own command.
- Harvested tasks render in a bounded list under the composer, read-only:
  promoting one to a real project is a person's decision.
- The raw exchange sits in a Task Manager I/O panel under Recent, appearing
  once something has been sent.
- The latest reply (or the one being written) renders under the row: the
  agent's failure mode is to stop and ask, and a question that only exists in
  a diagnostic panel is a question nobody answers.
- Settings has the model/effort pickers, the working directories, and the
  Reset control, which is disabled until a conversation exists.

## Working directories, and asking instead of denying

The permission posture is selected in Settings. `Ask` is `Permission::Edit`
plus `Request::approvals()`: a gated call (a write, a command, or a read outside
the working tree) arrives as an approval card on Home and the run waits,
mid-turn, until Allow or Deny; an abandoned question becomes a denial after 30
minutes. It cannot be ReadOnly underneath: that posture strips the mutating
tools, so nothing would ever ask, and the crate refuses the combination.

Two of the crate's caveats carried into the UI: the card shows the call's
*input*, not just the tool name, because for Bash the command lives in the
input; and silence is not proof nothing ran — Claude allows read-only commands
without asking.

`GlobalSettings.taskManager.dirs` still matters: the first entry becomes the
run's cwd and every later entry is sent as another declared working root. Add
every repository the Task Manager normally works across so permission requests
stay rare. For Codex, a request for an undeclared write root names the exact
path set in its approval card; a remembered answer applies only to that same
set. Adding the path here is the persistent way to make it available from the
start of later runs.

`crates/wt-tools` is built too: the agent can see its own projects.
