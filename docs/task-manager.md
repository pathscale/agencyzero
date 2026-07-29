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
{"project": "<project name>", "item": "<one short task>", "status": "pending"}
```

`harvest()` scans every line rather than looking for a delimiter, because models
move the block, fence it, or bury it after prose, and a parser that depends on
finding a marker fails on the first reply that omits one. A line is taken when
it parses as an object with a non-empty `project` and `item`.

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

## Still to build

- The Home screen itself: a composer, the session id in faded text after the
  first prompt (`Task Manager · session <uuid>`), a bounded Recent panel, and an
  Agent I/O area beneath it.
- The Settings controls for reset and model/effort selection.

`crates/wt-tools` above is built: the agent can see its own projects.
