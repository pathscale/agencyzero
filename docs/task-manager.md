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

The reply has to become rows in WorkTable. Asking a model for prose and parsing
it afterwards is how you get a to-do list that is subtly wrong. Asking for JSONL
and refusing anything else is how you get one that is either right or visibly
empty.

The user's own words go out unchanged, with `OUTPUT_CONTRACT` appended:

```
AZ-TASKS-BEGIN
{"project": "<project name>", "item": "<one short task>", "status": "pending"}
AZ-TASKS-END
```

The marked block is the authority. When `AZ-TASKS-BEGIN` appears, `harvest()`
reads only the lines between the markers — a task the model merely *quotes* in
its prose (an example, a README, a discussion of the format) cannot mutate
anything. Lines carry exactly the three fields (`deny_unknown_fields`, the
signature of JSON quoted from somewhere else), and one reply may mutate at
most 100 tasks.

Models still move, fence, or forget delimiters, so a reply with no marker at
all falls back to scanning every line — but that lenient path is additive
only: a `deleted` outside the markers is refused and counted, never applied.
A stray quoted line can at worst add a row someone deletes; it can no longer
destroy one. A line is taken when it parses as an object with a non-empty
`project` and `item`.

## Deleting, and why absence never deletes

`status: "deleted"` removes the existing task whose project and item match,
exactly. That is the only remove verb: a model asked to "delete X" will
happily re-emit the whole list without X, and treating absence as deletion
would wipe rows the user added by hand every time the model abbreviated. So
the harvester appends and deletes only what is named, and the contract tells
the model so.

To make bulk edits exact ("delete everything about cleaning junk"), every
prompt carries a live snapshot of the current projects and tasks, built from
the tables and bounded at ~6KB with an honest truncation marker. The model
sees what exists; each deletion is an explicit, auditable line in the I/O
panel.

The write path stays in the GUI on purpose. wt-tools is read-only by
construction — that is what makes it safe to run beside the GUI on a
single-writer store — so it will never grow a delete. wt-tools is the eyes;
the harvest contract is the hands; the GUI is the only writer.

Three decisions worth keeping:

- **A line that looks like JSON and does not parse is counted, not hidden.** The
  count goes to the Agent I/O panel as a `harvest` entry. A model that has
  drifted off the format otherwise produces a short list and no error anywhere,
  which looks exactly like the feature not working.
- **An unrecognised `status` becomes `pending` rather than dropping the task.**
  Losing work over a spelling is worse than a wrong column.
- **Tasks are written as items on the task manager's own project**, carrying the
  proposed project name in the title. Creating real projects from a model's
  output unasked is not something it should do on its own initiative; promoting
  a line to a project is a decision for a person.

## The project-session contract: three checkboxes

Ordinary project conversations (everything that is not the Home task manager)
speak a simpler, checklist-shaped contract, parsed from any reply:

- `- [ ] <title>` **proposes** a new pending item. An existing title is left
  alone — a proposal is not permission to clobber a row the user owns.
- `- [x] <title>` **closes** the existing item with that exact title. What
  closing means is the Settings choice (*Completed items*): mark resolved, or
  delete the row. The run-this-item prompt teaches this line, so a run started
  from an item can end by closing it.
- `- [-] <title>` **removes** the existing item outright, whatever the
  Settings say — an obsolete row is not a finished one. It never creates:
  striking something that does not exist is already true.

Titles match case-insensitively and exactly; a paraphrased title is a new
proposal, which is the append-only safety working as intended. `[x]` and `[-]`
landed in 0.1.6 and 0.1.10 respectively — an agent reading older sources will
find an append-only path and wrongly conclude the list can only grow.

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

The runs go out as `ask` — `Permission::Edit` plus `Request::approvals()`
(agent-abstraction 0.3.4). A gated call — a write, a command, a read outside
the working tree — arrives as an approval card on Home and the run waits,
mid-turn, until Allow or Deny; an abandoned question becomes a denial after 30
minutes. It cannot be ReadOnly underneath: that posture strips the mutating
tools, so nothing would ever ask, and the crate refuses the combination.

Two of the crate's caveats carried into the UI: the card shows the call's
*input*, not just the tool name, because for Bash the command lives in the
input; and silence is not proof nothing ran — Claude allows read-only commands
without asking.

`GlobalSettings.taskManager.dirs` still matters: the first entry becomes the
run's cwd, and everything inside it runs unasked. Point it at the tree the
task manager usually reads so approvals stay rare. One directory of reach for
now — the crate has no `--add-dir` passthrough yet, so additional entries are
stored but only the first takes effect until it grows one.

`crates/wt-tools` is built too: the agent can see its own projects.
