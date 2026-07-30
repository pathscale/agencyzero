# Install and upgrade (self-hosting items #6 and #7)

What it takes for AgencyZero to be a real application rather than a bundle in
`target/`, and for "upgrade" to be a button rather than a ritual. Options laid
out for decision; recommendations marked.

## Where things stand

- The bundle is built to `target/release/bundle/macos/AgencyZero.app` and run
  from there. Tauri ad-hoc signs it, which satisfies Gatekeeper on the machine
  that built it and nowhere else.
- `Restart into Build on Disk` (menu + Settings) already restarts the running
  instance into whatever binary sits at the app's own path — the second half
  of every upgrade.
- The build stamp (version · commit · compile time, in About and Settings)
  makes "which build am I actually in" answerable after any restart.
- The Dev instance (`tauri.dev.conf.json`, own identifier) means an upgrade
  can be rehearsed beside the system copy without touching it.

## Install options (#27)

**A. Status quo — run from `target/`.** Free, and wrong for a system copy:
the path moves with checkouts, `cargo clean` deletes your application, and
Dock/Spotlight anchor to a build directory.

**B. Copy to `/Applications`, ad-hoc signed. ← recommended now.** A `ditto`
of the bundle. No Apple Developer account, no notarization, works
indefinitely on this machine — which is the only machine self-hosting needs.
The Dock, Spotlight and login items get a stable path; `target/` goes back to
being scratch space.

**C. Developer ID + notarization.** Needed only when the app leaves this
machine (other Macs hit Gatekeeper otherwise). $99/year account,
`codesign` + `notarytool` wired into the bundle step — Tauri supports both in
config. Not a self-hosting prerequisite; a distribution one.

## Upgrade options (#28)

The upgrade loop self-hosting wants: agent builds the bundle in `target/` →
the new bundle replaces the installed one → restart into it. The restart
exists; the middle step is the work.

**1. In-app `Install & Restart` command. ← recommended.** A Rust command
that: reads the freshly built bundle's `Info.plist`/binary build stamp,
refuses if it is not newer than the running one (the stale-build class of
bug, closed at the door); moves the installed app aside as a `.bak` (one
generation of rollback); `ditto`s the new bundle in; then the existing drain
+ `app.restart()`. Replacing a running `.app` is safe on macOS — the process
keeps its inodes — and the restart lands in the new copy. Surfaced next to
Restart in Settings.

**2. An install script the agent runs with approval.** `scripts/install.sh`
doing the same ditto+stamp check, invoked inside a session. Cheaper to build,
but the safety checks live in a script the agent can edit — the in-app
command keeps them behind the IPC boundary.

**3. Tauri updater plugin.** Signed update artifacts served over HTTPS with
version manifests. Right shape for distributing to other people, overkill for
an app that upgrades itself from its own working tree.

Recommendation: **B + 1** — install to `/Applications` once by hand, then the
in-app command owns every upgrade after that. C and 3 wait until a second
machine matters.

## The ordering caveat

An upgrade kills the runs the instance is hosting — including, in the
self-hosting case, the session that just did the building. Until the run
supervisor moves out of the GUI process (see
[`xpc-sidecar.md`](xpc-sidecar.md)), `Install & Restart` should refuse while
runs are active, the same way deletion now stops the run first.
