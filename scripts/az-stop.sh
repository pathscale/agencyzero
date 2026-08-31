#!/usr/bin/env sh
#
# Stop a locally built AgencyZero: TERM, and KILL only once TERM has failed.
#
# The store is single-writer, so a hard kill takes it down mid-write with no
# chance to close its handles. That is the reason for the order here, and the
# reason the wait is generous: TERM is always tried first and given ten seconds,
# which is longer than a healthy quit including the store's own flush.
#
# A process still there afterwards is not slow, it is wedged: parked somewhere
# it cannot service signals at all, which in this codebase has meant a GPU wait
# rather than anything holding the database. KILL is then the only way out, and
# the risk it carries is smaller than leaving a process that owns the store lock
# and can never release it.
#
# The pattern this exists to replace was written inline, one command at a time:
#
#     pkill -TERM -f "...az-gui"; sleep 4; pkill -9 -f "...az-gui"
#
# which reads as careful and is not. Four seconds is inside the range of a
# normal quit, so the `-9` fires on a schedule rather than on a decision, and it
# lands exactly when the app is slowest to finish writing. Scope matters as much
# as timing: matching the bare binary name also reaches the owner's installed
# Experimental build. This script waits for the answer instead of assuming it,
# and only ever targets the bundle inside this checkout.
#
# Usage:
#     scripts/az-stop.sh            # TERM, wait, KILL only if still wedged
#     scripts/az-stop.sh --quiet    # same, without the running commentary
#     scripts/az-stop.sh --no-kill  # TERM only; report a wedge, never escalate
#
# Exit status:
#     0  no instance was running, or it exited on TERM
#     1  an instance was wedged and had to be killed (reported, with where it
#        was parked), or --no-kill was given and it is still running

set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "az-stop.sh supports macOS only (it targets the local .app bundle and uses sample)" >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# The bundle this checkout builds, and nothing else. `local-delivery.sh` writes
# it here for every mode.
target="$repo_root/target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui"

quiet=0
allow_kill=1
for arg in "$@"; do
  case "$arg" in
    --quiet) quiet=1 ;;
    --no-kill) allow_kill=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

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

wedged=$(pgrep -f "$target" | tr '\n' ' ')

if [ "$allow_kill" -eq 0 ]; then
  echo "still running after TERM: $wedged" >&2
  echo "--no-kill was given, so it is left alone." >&2
  exit 1
fi

# Where it is parked, captured *before* it is killed, because the process is the
# only copy of that evidence and a wedge that is never diagnosed comes back.
# `sample` needs the process alive; once KILL lands there is nothing to ask.
for pid in $wedged; do
  say "==> $pid ignored TERM; sampling before killing it"
  if command -v sample >/dev/null 2>&1; then
    stack=$(sample "$pid" 2 -mayDie 2>/dev/null | grep -m3 -E "__semwait_signal|__psynch_cvwait|nanosleep|_MTLCommandBuffer" || true)
    [ -n "$stack" ] && say "$stack"
  fi
done

say "==> killing $wedged"
for pid in $wedged; do
  kill -KILL "$pid" 2>/dev/null || true
done

sleep 1
still=$(pgrep -f "$target" 2>/dev/null || true)
if [ -n "$still" ]; then
  echo "could not kill: $still" >&2
  exit 1
fi

cat >&2 <<EOF
killed after TERM was ignored: $wedged

A process that does not answer TERM is parked where it cannot service signals.
The two seen in this codebase:

  * a GPU wait, under wgpu_hal::metal::Device::wait or _MTLCommandBuffer status.
    This was the beachball, fixed in ps-vello by not waiting on a bump buffer
    that has already arrived. A first-frame version of it has also been seen
    after relaunching into a bundle that was still being re-signed.
  * __psynch_cvwait on the main thread, which is a deadlock rather than a stall.

The sample above says which. That is worth reporting rather than dropping: the
kill unblocks the checkout, it does not explain anything.
EOF
exit 1
