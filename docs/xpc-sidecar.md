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

## Proposal: `az-runnerd`

A small headless supervisor binary in the workspace (beside the five
existing executables) that owns agent processes, with the GUI as its client.

**Transport.** The macOS-native answer is XPC, but Rust XPC bindings are
immature and Linux is on the horizon. A Unix domain socket in the app data
directory, carrying length-framed serde JSON, gives the same process
isolation with portable code. The item keeps its XPC name; the wire is UDS.

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
