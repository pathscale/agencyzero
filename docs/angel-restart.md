# Restart angel

AgencyZero restarts in place: a build or updater replaces the binary at the
app's existing path, while the old process is still running from its open
inode. The old GUI must drain WorkTable and exit before the new GUI opens the
single-writer store. It also cannot be the process trusted to launch itself
after it exits.

The restart angel is a hidden, headless mode of `az-gui`, not another installed
binary. After a successful drain the GUI starts:

```text
az-gui --agencyzero-angel <old-pid> <absolute-path-to-az-gui>
```

The GUI then exits. The angel polls the old PID without signalling it, waits
until it disappears, launches the executable now present at the supplied path,
and exits. A 30-second deadline prevents an abandoned angel from unexpectedly
relaunching the app much later.

## Safety properties

- No angel is spawned when the table drain fails.
- A spawn failure leaves the current GUI alive and returns an error to the UI.
- The replacement starts only after the old process has released the store.
- The relaunch target is an absolute path obtained from `current_exe`, not a
  caller-provided command line.
- Standard streams are disconnected, so Finder and terminal launches behave
  identically.
- The same path handles manual restart and updater restart.

## Closed-store maintenance

The same supervisor owns manual backup and restore. These are not ordinary file
copies from the GUI:

1. The GUI refuses while an agent run is live.
2. Every WorkTable persistence worker drains.
3. The angel starts, the GUI exits, and the angel waits for the process and its
   store lock to disappear.
4. Backup copies into a unique staging directory, compares every file byte for
   byte, and only then publishes the timestamped sibling directory.
5. Restore copies and verifies the selected backup before moving the current
   store. The displaced store is retained under a unique `pre-restore` name.
6. The angel relaunches the GUI and passes the maintenance result through the
   replacement process's environment for Settings to report.

The webview supplies only an opaque backup id. Native code resolves it against
the current store's allowlisted sibling names, so an arbitrary path cannot be
turned into a restore source.

The supervisor does not preserve active agent runs across a restart; that
remains the job of the run sidecar described in [xpc-sidecar.md](xpc-sidecar.md).
