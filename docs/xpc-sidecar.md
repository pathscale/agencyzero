Yes, that reply should not have disappeared. I still have the substance, so I’m reposting it below. The RTK, Ponytail, and ORG2 research is also preserved in [token-optimizations.md](/Users/revenge/code/agencyzero/docs/token-optimizations.md).

## 1. Duplicated PromptSyntax instructions

You are correct: Task Manager does not run on every project turn.

The duplication happens only when you explicitly send a Home Task Manager message:

1. Its system prompt gets the general AgencyZero PromptSyntax declaration, statuses, verbs, and examples from [projects.rs](/Users/revenge/code/agencyzero/apps/gui/src/projects.rs:867).
2. Its user prompt then gets `OUTPUT_CONTRACT`, which repeats four directives and several of the same rules from [tasks.rs](/Users/revenge/code/agencyzero/apps/gui/src/tasks.rs:28).

This is a small optimization, probably a few hundred tokens per Task Manager message. Given our recent parsing problems, I would not simply remove the examples.

The safe change is to create one canonical instruction and retain only the Task Manager-specific additions:

- `items.add` must identify a project.
- Task Manager may create a missing project.
- Existing items must be addressed by ID.
- No requested mutation means no directive.

This should be low priority because correctness matters more than the modest savings.

## 2. Filter project PR snapshots to active PRs

This does not mean deleting merged PRs.

AgencyZero stores PR records in its database. It currently inserts every tracked PR into the model prompt, including merged, closed, and dismissed PRs:

```text
Pull requests: #75 merged · #76 merged · #78 open
```

The proposed change affects only prompt generation:

- Keep every PR record in the database and UI.
- Continue using historical PRs to remember which repositories belong to the project.
- Include `OPEN` PRs in the model prompt.
- Include `unknown` PRs because they may still require attention.
- Exclude `MERGED`, `CLOSED`, and dismissed PRs from the model prompt.

AgencyZero already has a GitHub helper path using a batched `gh api graphql` query. See [prs.rs](/Users/revenge/code/agencyzero/apps/gui/src/prs.rs:220). I would not call GitHub while constructing every prompt. Prompt generation should read the most recently refreshed local state.

A larger GitHub helper could eventually own discovery, refresh, and mutations, but it is not needed for this optimization.

## 3. Ordinary project snapshots

“Snapshot” here is generated prompt text. It is not a database snapshot, screenshot, or backup.

For each ordinary project run, AgencyZero builds a system-prompt block containing:

- Open project items and IDs.
- Tracked PR numbers and states.
- The focused item, if the run originated from one.
- The PromptSyntax declaration and examples.
- One-time receipts from the preceding turn’s directives.

That is [state_snapshot](/Users/revenge/code/agencyzero/apps/gui/src/projects.rs:867).

There is a separate Task Manager snapshot containing all projects and their open items. That one already has a 6 KB ceiling in [projects.rs](/Users/revenge/code/agencyzero/apps/gui/src/projects.rs:2170).

The ordinary project snapshot has no ceiling. A project with hundreds of tasks or historical PRs could inject a large block into every model turn.

A ceiling would:

- Limit only AgencyZero-generated state text.
- Never delete or alter stored items or PRs.
- Never truncate conversation history.
- Stop only between complete rows.
- Add an honest `… (list truncated)` marker.

Filtering historical PRs probably solves most practical growth. The ceiling is a defensive backstop.

## 4. Task Manager model priority

Agreed. Task Manager should have an ordered list of eligible agent/model/effort entries instead of one hardcoded model.

The resolution rules should be:

1. Consider only models enabled in Settings.
2. Consider only installed, logged-in, connected agents.
3. Select the first eligible priority when starting a new Task Manager session.
4. Pin the selected provider and model for the session’s lifetime.
5. Never silently move an existing Claude conversation to Codex or vice versa.
6. Re-evaluate only after Task Manager reset or when no session exists.

I would migrate existing settings like this:

1. Codex / Luna / low, when Luna is enabled.
2. The currently configured Task Manager model, if it is still enabled.
3. User-configured fallback entries.

Haiku must not be resurrected after you removed it. Sonnet should not become an automatic fallback until we test whether it reliably handles PromptSyntax and multi-project maintenance.

The priority list should be user-editable because it controls billing and intelligence. Every entry carries provider, model, and effort.

If a model hits a usage limit mid-session, AgencyZero cannot seamlessly transfer the provider’s hidden context. It should offer:

> Start a new Task Manager session using the next available priority.

## 5. Cache-break detector

This is mainly telemetry with subtle UX.

A cache break occurs when a long-running session previously reused a large stable prompt prefix, then unexpectedly reports little or no cache reuse. That can make the same conversation history expensive fresh input again.

The detector must ignore expected cache breaks:

- First turn.
- New or forked session.
- Model/provider change.
- Manual compaction.
- System-prompt revision.
- Workspace or permission changes that necessarily alter the prefix.

An initial rule could flag a turn when:

- The preceding turn had substantial cache reads.
- The new turn has zero or very low cache reads.
- Context did not compact.
- Provider, model, session, system revision, and permissions remained stable.

The UX should be restrained:

- Record it in the usage ledger.
- Display a small “cache rebuilt” marker beside that turn’s usage.
- Put the details in a tooltip or diagnostics panel.
- Avoid notifications unless the break repeats.

Example:

> Prompt cache rebuilt: 84K fresh input after 91K was cached on the previous turn. No session, model, or system change was detected.

Initially it diagnoses waste. Once we collect evidence, we can identify which AgencyZero-generated content is destabilizing the prefix.

## 6. What RTK does underneath

RTK sits between a shell command and the output returned to the model:

```text
Model → cargo test → hundreds of output lines
Model → rtk cargo test → failures plus a compact passing-test count
```

It executes the real command. It does not call another language model.

It applies command-specific transformations:

- Groups search matches by file.
- Collapses successful tests into counts.
- Keeps test failures and shortened traces.
- Removes Git progress noise.
- Compacts `git status`, logs, diffs, and PR listings.
- Deduplicates repeated log lines.
- Truncates verbose results.
- Saves full output for recovery for supported commands.

RTK claims up to 90 percent less shell output, not 90 percent fewer session tokens or 90 percent lower cost. It estimates tokens as bytes divided by four. [RTK explains that distinction](https://github.com/rtk-ai/rtk#how-savings-work).

For Sol/Codex:

- Codex does not have RTK’s transparent pre-tool hook.
- RTK’s Codex integration currently relies on instructions.
- AgencyZero Experimental could detect RTK and append a small instruction telling Codex to use supported `rtk` commands.
- We should not modify your global `AGENTS.md`.
- Examples would be `rtk cargo test`, `rtk git status`, and `rtk grep`.

For Claude:

- RTK supports Claude’s `PreToolUse` hook.
- Bash commands can be transparently rewritten before execution.
- Built-in Claude Read, Grep, and Glob tools do not pass through the Bash hook.
- AgencyZero should ideally pass a per-run Claude hook configuration rather than execute `rtk init -g` and mutate your global settings.

The A/B should record:

- Fresh input.
- Cache reads and writes.
- Output tokens.
- Wall time.
- Command count.
- Retries.
- Correctness and final diff.
- How often the agent opens recovery output.
- How often filtering causes the agent to rerun a command.

The main risk is omitted detail causing rediscovery. Full-output recovery is essential.

## 7. ACP with usage telemetry

ACP provides a common transport, but its stable usage telemetry is less detailed than the native data AgentAbstraction already extracts.

Current AgentAbstraction telemetry:

- Claude: fresh input, cache reads, cache writes, output, current context, context window, and cost.
- Codex: fresh input, cache reads, output, current context, and context window.

Stable ACP `usage_update` provides:

- Current context used.
- Context-window size.
- Optional cumulative cost.

Cached tokens count toward context occupancy, but ACP does not yet standardize the complete end-turn fresh/cache/output breakdown. [The ACP usage specification](https://agentclientprotocol.com/rfds/session-usage) explicitly separates that future work.

I would implement:

1. An optional ACP v1 transport in AgentAbstraction.
2. Spawn the selected ACP adapter over stdio.
3. Perform capability negotiation.
4. Map session creation, loading, resume, prompts, updates, permissions, cancellation, directories, and tools into AgentAbstraction’s existing types.
5. Map ACP `usage_update.used`, `size`, and `cost` into normalized `Usage`.
6. Preserve richer native telemetry when using native transports.
7. Test the maintained [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp).
8. Test the [Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp).
9. Initially expose ACP through AgencyZero Experimental.
10. Promote it only after it has parity for permissions, PromptSyntax streaming, sessions, directories, interruption, and usage.

This belongs in AgentAbstraction as an optional standards-based transport. AgentAbstraction does not need to depend on `agent-experimental`.

ACP gives us interoperability and a consistent baseline. It should not replace richer provider-native paths prematurely.

## 8. Can we stay on ACP v1?

Yes. ACP v1 is the correct target.

ACP v1 is current and stable. ACP v2 remains draft. Current v1 already provides:

- Prompt turns and streaming updates.
- Tool-call and permission events.
- Cancellation.
- Session load and resume.
- Additional workspace directories on lifecycle calls.
- Context and cost usage updates.
- Optional client filesystem and terminal methods.

See the [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview) and [session setup](https://agentclientprotocol.com/protocol/v1/session-setup).

There are two limitations:

- Features are capability-negotiated and optional. A field existing in the specification does not mean every adapter implements it.
- ACP supports cancellation, but it does not standardize Codex-style mid-turn steering/injection.

We should therefore support ACP v1 while retaining native Codex App Server steering.

I would not make RTK depend on ACP v1’s client terminal surface. Some adapters may never use it, and ACP v2 is reconsidering filesystem and terminal ownership.

## 9. Ponytail

Ponytail is a behavioral policy, not a context compressor.

Its decision ladder is approximately:

1. Avoid implementing unnecessary functionality.
2. Reuse existing project code.
3. Prefer the standard library or platform.
4. Reuse installed dependencies.
5. Only then write the minimum new implementation.

AgencyZero could expose this as an opt-in project policy called something like **Minimal implementation**.

It must remain optional because it can encourage under-building. Security, validation, error handling, accessibility, and required tests must remain outside the simplification target.

An A/B test on Sol and Opus should measure:

- Correctness.
- Security and accessibility regressions.
- Added and removed lines.
- Tool-call count.
- Fresh/cache/output tokens.
- Wall time.
- Whether the model omitted required scope.

Ponytail reported fewer tokens in its own benchmark, but most large wins came from tasks where the model avoided custom code and reused a native platform capability. It is evidence for a task policy, not universal compression.

## 10. Where ORG2 sits

ORG2 operates deeper than most of the low-hanging AgencyZero work.

| Layer | Mechanisms | AgencyZero can do it now? |
|---|---|---|
| Host prompt | PR filtering, bounded snapshots, stable prefixes, cache diagnostics | Yes |
| Tool output | RTK filtering, aggregate budgets, screenshot retention, recovery files | Partially |
| Internal transcript | Remove old tool results and time-aware microcompaction | Not safely |
| Long-term memory | Incremental memory and tiered compaction | Partially |
| Agent behavior | Ponytail minimal-implementation policy | Yes, opt-in |

ORG2 owns its agent harness and therefore owns what history gets sent back to its model.

AgencyZero currently does not own Claude Code or Codex’s private model transcript. It cannot safely remove old tool results from that hidden history merely because the UI received a copy.

Portable ORG2 ideas include:

- Preserve stable prompt prefixes.
- Detect unexpected cache breaks.
- Bound AgencyZero-owned screenshots and attachments.
- Use semantic output filtering with recovery files.
- Track whether knowledge checkpoints prevent later rediscovery.
- Apply cheap structural cleanup before expensive summarization where AgencyZero owns the material.

Not immediately portable:

- Rewriting Claude/Codex internal tool history.
- Replacing old provider transcript entries.
- ORG2-style microcompaction inside an opaque native session.

ACP does not automatically give the client ownership of the agent’s model transcript. It streams a presentation of events, but the agent still controls what is sent back to its model.

## Revised execution priority

1. Active-only PR prompt filtering.
2. Defensive ordinary snapshot ceiling.
3. Cache-break telemetry and subtle UX.
4. Task Manager model priority list, with Luna/low first when enabled.
5. RTK opt-in A/B on Sol and then Opus.
6. Ponytail opt-in A/B.
7. ACP v1 transport in AgentAbstraction.
8. ORG2-style limits for data AgencyZero genuinely owns.
9. Defer internal transcript microcompaction until we have an agent transport that explicitly permits it.

I would not prioritize PromptSyntax deduplication yet. Its savings are small and its correctness risk is currently higher than its value.


# The run sidecar (self-hosting item: XPC sidecar architecture)

A proposal. Nothing here is built.

## The problem it exists to solve

Every agent process is a child of the GUI process, and `Run`'s teardown kills
the process group when its handle drops. That is the right safety default —
no orphaned agents — but it welds run lifetime to window lifetime:

- **Upgrades kill runs.** `Restart into Build on Disk` ends every live
  session, including — in the self-hosting loop — the very session that just
  built the new bundle. The app cannot rebuild itself while it is the thing
  hosting the build.
- A GUI crash takes every agent down with it.
- A long unattended run (the moderator future) has no home that outlives the
  window.

## Why the host process cannot do this alone

The constraint is an OS fact, not an architecture taste. An agent process's
output reaches us through pipes whose read ends are file descriptors *in the
process that spawned it*. When that process exits — and `Restart into Build
on Disk` is an exit — its descriptors are closed with it. The restarted GUI
is a new process: it can find the orphaned agent's PID, but it cannot
re-open a pipe whose read end died; the stream is simply gone. (The crate's
`detach()` exists and keeps the agent *alive* through this, but alive and
unobservable: no events, no approvals, no outcome.)

So whoever holds the pipes has to be a process that survives the restart.
The GUI can still be the one that *spawns* that process — no launchd, no
installation step — it just cannot *be* it.

## Proposal: `az-runnerd`

A small headless supervisor binary in the workspace (beside the five
existing executables) that owns agent processes, with the GUI as its client.

**Transport: what XPC would actually buy, and cost.** XPC comes in two
shapes. An **XPC service** (bundled in `Contents/XPCServices/`) has its
lifecycle managed by launchd *on behalf of the client app*: launched on
connection, eligible for termination when idle or when the client goes away.
That lifecycle is precisely the wrong one — the whole requirement is a
broker that outlives its client. The shape with an independent lifetime is a
**launchd agent** exposing a Mach service, which means registration
(`SMAppService` / a plist in `~/Library/LaunchAgents`) — an install-time
step that couples this item to signing and installation (#27) before phase
one can even be tested.

On the API side, the comfortable XPC layer is `NSXPCConnection`
(Objective-C: typed remote proxies from a protocol). From Rust there is no
equivalent: the available crates bind the C `libxpc` surface, so every
message is a hand-assembled `xpc_dictionary` — meaning we would write the
message-framing and serialization layer ourselves *on top of* the FFI. XPC's
remaining exclusives — launchd lifecycle management and entitlement-based
peer verification — matter for privileged helpers talking across trust
boundaries, not for a single-user app talking to a child it spawned, where
filesystem permissions on the socket already gate access.

A Unix domain socket in the app data directory carrying length-framed serde
JSON keeps the same process isolation, costs one dependency we already have
(serde), works identically on the future Linux target, and lets the GUI
spawn the daemon on demand with no registration step. The item keeps its
XPC name; the wire is UDS.

**Split of responsibilities.**

| Concern | Owner |
|---|---|
| Spawning, streaming, cancelling runs (`agent-abstraction`) | sidecar |
| Approval questions and remembered-rule auto-allows | sidecar asks, GUI answers |
| WorkTable writes (messages, ledger, harvest) | GUI, unchanged |
| Event spool while no GUI is attached | sidecar, one file per run |

The single-writer store rule survives intact: the sidecar persists nothing
into WorkTable. It emits events; the GUI persists them. While the GUI is away
(restarting into a new build), events spool to disk; on reattach the GUI
drains the spool in order and then follows the live stream. An approval that
arrives while nobody is attached waits, exactly like an unanswered card —
and this is the hook the future moderator plugs into.

**Lifecycle.** Started on demand by the GUI (not launchd, at first): first
run request spawns the daemon if the socket is dead; the daemon exits itself
when it has had no runs and no client for some minutes. It survives the GUI
restarting; it does not try to survive logout.

**What changes in the GUI.** `drive_run`'s event loop stays almost
verbatim — it just reads from the socket instead of from `Run` directly. The
run registry, cancellation, one-run-per-project reservation, approval
one-shots and tombstone checks all keep their shapes; the reservation's
release just waits on the sidecar's confirmation instead of `Run::cancel()`.

## Phases

1. **Seam first.** Extract today's spawn/stream/cancel into a `Runner` trait
   with the current in-process implementation behind it. Pure refactor, no
   behaviour change, merge on its own.
2. **The daemon.** `az-runnerd` implementing the same trait over the socket,
   plus the spool and reattach protocol. The GUI picks in-process or socket
   by a setting, so the old path stays one toggle away.
3. **Upgrade integration.** `Install & Restart`
   ([install-and-upgrade.md](install-and-upgrade.md)) stops refusing while
   runs are active: runs keep going in the sidecar, the new GUI reattaches,
   and the self-hosting loop closes — the app can rebuild itself *from a
   session it is hosting*.

Phase 1 is a day and is worth doing early; it is also the seam the moderator
run path (#24) wants. Phases 2–3 are the real project and should wait until
install/upgrade (#27/#28) is in, since phase 3 is its payoff.
