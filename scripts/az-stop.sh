#!/bin/sh
#
# Stop a locally built AgencyZero, and never harder than TERM.
#
# The store is single-writer. A hard kill takes it down mid-write with no chance
# to close its handles, which is why `SIGKILL` is not an option this script
# offers: not as a flag, not as a fallback, not after a timeout. If TERM does
# not land, that is a finding to report rather than something to escalate past.
#
# The pattern this exists to replace was written inline, one command at a time:
#
#     pkill -TERM -f "...az-gui"; sleep 4; pkill -9 -f "...az-gui"
#
# which reads as careful and is not: the `-9` runs on a schedule rather than on
# a decision, so it fires exactly when the app is slowest to quit, which is when
# it is most likely to be mid-write.
#
# Scope matters as much as signal. The pattern above matches *every* az-gui on
# the machine, including the owner's installed Experimental build, which is not
# ours to stop. This script only ever targets the bundle inside this checkout.
#
# Usage:
#     scripts/az-stop.sh            # stop this checkout's app, wait, report
#     scripts/az-stop.sh --quiet    # same, without the running commentary
#
# Exit status:
#     0  no instance was running, or it exited on TERM
#     1  an instance is still running after TERM: it is wedged, and the caller
#        should say so rather than reach for a bigger signal

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# The bundle this checkout builds, and nothing else. `local-delivery.sh` writes
# it here for every mode.
target="$repo_root/target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui"

quiet=0
[ "${1:-}" = "--quiet" ] && quiet=1

say() {
  [ "$quiet" -eq 1 ] || echo "$@"
}

pids=$(pgrep -f "$target" 2>/dev/null || true)
if [ -z "$pids" ]; then
  say "no instance from this checkout is running"
  exit 0
fi

say "==> asking $(echo "$pids" | tr '\n' ' ')to quit"
for pid in $pids; do
  kill -TERM "$pid" 2>/dev/null || true
done

# Ten seconds, checked twice a second: long enough for a normal quit including
# the store's own flush, short enough to stay usable in a rebuild loop.
waited=0
while [ "$waited" -lt 20 ]; do
  sleep 0.5
  waited=$((waited + 1))
  still=$(pgrep -f "$target" 2>/dev/null || true)
  [ -z "$still" ] && { say "exited on TERM"; exit 0; }
done

cat >&2 <<EOF
still running after TERM: $(pgrep -f "$target" | tr '\n' ' ')

This is the finding, not a step to work around. A process that ignores TERM is
parked somewhere it cannot service signals, and the two seen in this codebase
are worth telling apart before doing anything else:

  * parked in the GPU, under wgpu_hal::metal::Device::wait, which was the
    beachball and is fixed in ps-vello;
  * parked in __psynch_cvwait during startup, before the first frame, which is
    a deadlock rather than a stall.

Both are visible with:

    sample <pid> 5 -mayDie

Report which one it is. Do not send SIGKILL to move past it: the store is
single-writer, and a hard kill during a write is how the database gets damaged.
Only the owner decides that, per instance, each time.
EOF
exit 1
