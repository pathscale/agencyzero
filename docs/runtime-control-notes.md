# Runtime control: wedges, Codex permissions, and the relay ahead

Notes from the 2026-08-10 debugging session. Three subjects that turned out to
share one root: the GUI, the proxy and the provider each hold a piece of the
truth about a run, and every bug here was two of them disagreeing.

## What a wedge actually is

"Wedged" covered four different failures. They need different fixes, and Reset
only addresses two of them.

| Class | What you see | Does Reset fix it? |
|---|---|---|
| 1. Stale registration: the GUI holds a run the proxy never had | Project shows a run forever; Stop and Reset appear inert | Yes, and `sync_project` now clears it without asking |
| 2. Live provider that stopped responding | Turn produces nothing, Stop is slow or silent | Yes: Reset force-evicts and the teardown reaches the proxy |
| 3. Unresumable session | Every prompt fails instantly | **No.** Nothing about the run is wrong; the session cannot be resumed from that directory |
| 4. Provider auth or quota failure | Turn fails with the provider's own message | No, and it should not: the message is the answer |

Class 1 is the one that made both buttons look broken. A proxy restart takes
every run with it, and reattach only visited runs that still existed, so a
project whose run had vanished was never revisited and kept reporting a live
run. Stop had nothing to cancel and Reset had nothing to unwedge. Both were
working perfectly on a run that was not there.

Class 3 is not a wedge at all. Claude Code keys a session to the directory it
was created in, and resuming from anywhere else returns `No conversation found
with session ID`, which fails the turn rather than starting a fresh one. The
run now takes its `cwd` from the session's own transcript and passes the
project's directories as `--add-dir`, so the session decides where it runs and
the project decides what it may touch.

### Reset's contract

Reset clears the stuck turn and **keeps the session**, so the next prompt
resumes the same conversation. It is not "start over". It:

- force-evicts the run registry entry and signals cancel, which reaches the
  proxy through `drive_run`,
- clears the partial-reply checkpoint, which is the torn tail of the killed
  turn and would otherwise splice half an answer onto the resumed conversation,
- leaves the provider-session pointer untouched.

Clearing the pointer is a different operation with a different button. Reset
used to do it, which silently abandoned conversations whose transcripts were
still on disk with nothing pointing at them.

### Testing it

A wedge is hard to produce on demand, which is why this went unverified for so
long. The cheapest reliable recipe:

1. Start a turn that runs a long command.
2. Find the provider process (`pgrep -fl claude` / `codex`) and `kill -STOP` it.
   The run now produces nothing and never ends, which is class 2 exactly.
3. Press Reset.
4. Expect, in `az-gui.log`: `stop observed in the main event loop`, then
   `tearing down the provider run`, then `teardown returned after Nms`.
5. Confirm the process group is gone (`pgrep` returns nothing). A stopped
   process that survives means the teardown did not reach it.

For class 1, stop the proxy while a run is live, then reopen the project.
Expect `releasing a run the proxy no longer has`.

`kill -STOP` is the important detail: a killed provider exits and looks like a
normal failure, while a *stopped* one reproduces the case where nothing ever
arrives and nothing ever ends.

## Codex

Codex works, but its posture is expressed twice, in two places that do not
agree. These are worth fixing before the relay makes them remote behaviour.

1. **`Auto` means different things on different transports.** The app-server
   path sets `networkAccess: true` for `Auto` and `false` for `Edit`. The
   `codex exec` path sets no network configuration at all. So the same named
   posture grants network or not depending on whether approvals happened to be
   enabled for that run. One posture, two behaviours, chosen by an unrelated
   flag.

2. **`--skip-git-repo-check` is only passed for `ReadOnly` and `Plan`.** The
   reasoning is sound: a writable run outside version control has no recovery
   path. The consequence is that `Edit` and `Auto` abort outright in any
   project directory that is not a git repository, with the CLI's own message
   rather than one that explains the rule. AgencyZero project directories are
   not required to be repositories, so this is reachable from the UI without
   doing anything wrong.

3. **`Plan` is not a plan on Codex.** Codex has no plan mode, so `Plan` maps to
   the read-only sandbox. Writes are blocked, but the model is never told to
   withhold execution, so it behaves like ReadOnly while the UI says Plan.

4. **`Ask` is not a posture, it is Edit plus a callback.** `proxy_permission`
   maps `ask` to `edit`, and approvals are enabled separately. That is the
   correct behaviour today, but it means the stored posture on a run cannot
   distinguish "Edit" from "Ask": replaying a run's metadata loses whether a
   human was in the loop. The crate's own notes already flag `Permission::Ask`
   as a 0.5 change.

5. **Resume drops `--sandbox` deliberately.** `codex exec resume` rejects the
   flag and takes `-c sandbox_mode=…` instead. This is verified and correct;
   the trap is that it is easy to "simplify" back into `--sandbox` and silently
   run continued turns under a different posture than the caller asked for.

The theme: Codex's posture is currently a function of `(permission, transport,
resuming, is-git-repo)`. Three of those four are invisible to the person
choosing the permission.

## Before the proxy talks to an authenticated relay

The protocol is in better shape for this than most: `AttachRun { after_sequence }`
plus `AckEvents` is a resumable, acknowledged journal, and `StartRun` and
`CancelRun` already carry idempotency keys, which is exactly what a lossy
network path needs. The config layer already refuses public or unauthenticated
websocket listeners. The gaps are about authority, not transport.

1. **Nothing scopes a run to a client.** Any client on the socket can
   `ListRuns` and then `CancelRun` any of them. On a local Unix socket with
   0700 permissions that is a reasonable simplification. Over a relay it means
   any authenticated tenant can enumerate and cancel every other tenant's runs.
   Runs need an owner, and every verb that names a `run_id` needs to check it.

2. **`ListRuns` is a disclosure surface.** A snapshot carries
   `workspaceRoots`, `providerSessionId`, the model, and the full metadata map
   including `projectId`. That is a description of someone's machine and their
   work. It should be filtered to the caller's own runs before it leaves the
   host, not after.

3. **Run ids are client-chosen.** They arrive as `msg-<uuid>` from the GUI. Two
   clients can collide, deliberately or accidentally, and a colliding
   `StartRun` currently reads as the idempotent retry of an existing run. The
   server should namespace ids per client, or reject ids it did not issue.

4. **The event journal contains the conversation.** `Text`, `Reasoning`,
   `ToolCall` and `ToolResult` carry prompts, file contents and command output.
   The crate is careful about this locally — arguments are tagged with
   `Sensitivity` so they can be redacted from previews — and none of that
   survives into the journal the relay would replay. Decide what a relay is
   allowed to persist, and for how long, before it persists everything.

5. **Retention is unbounded in the direction that matters.** `AckEvents`
   releases a journal, and a client that never acknowledges leaves it. Locally
   that is a disk problem. Remotely it is a per-tenant quota, and it needs a
   ceiling that is enforced rather than assumed.

6. **Approvals become a trust boundary.** `DecideApproval` is how a human
   allows a command to run. Over a relay, the decision arrives from somewhere
   else, and the run must be able to prove the decision came from the party
   entitled to make it for that run. Today it is accepted because it arrived on
   the socket.

None of these are reasons to delay the relay. They are the six places where
"local socket, one trusted client" is currently load-bearing, and every one of
them is a correctness question rather than a rewrite.
