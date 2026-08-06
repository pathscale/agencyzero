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

This supervisor protects the GUI handoff only. It does not preserve active
agent runs across a restart; that remains the job of the run sidecar described
in [xpc-sidecar.md](xpc-sidecar.md).
