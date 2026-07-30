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
