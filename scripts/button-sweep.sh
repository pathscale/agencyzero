#!/usr/bin/env sh
#
# Every eligible interactive control in the app, activated by semantic node
# id from a profile that starts identical each time.
#
# # Why this is a script
#
# The sweep activates destructive controls on purpose, so it leaves the store
# different from how it found it: the first run closed eight tabs, and the
# second run could not have found them to test. A sweep whose subject changes
# underneath it is not repeatable, and a QA harness that is not repeatable
# cannot tell a fix from a coincidence.
#
# So the profile is restored from a pristine clone before every run. On APFS
# `cp -c` is a copy-on-write clone, which is why restoring 114M is instant
# rather than a thing you would skip to save time.
#
#   scripts/button-sweep.sh              # every surface
#   scripts/button-sweep.sh home         # one surface
#
set -eu

cd "$(dirname "$0")/.."
readonly ROOT="$PWD"
readonly LIVE=/tmp/qa-profile-db
readonly DESCRIPTOR="$ROOT/target/blitz-control.json"

surface=${1:-}
if [ "$#" -gt 1 ]; then
  echo "usage: scripts/button-sweep.sh [surface]" >&2
  exit 2
fi

# Never kill by executable name: another build or the owner's stable instance
# may use the same name. A pre-existing lock means this disposable profile is
# already owned, so stop before deleting anything under that process.
if [ -e "$LIVE.lock" ]; then
  echo "$LIVE.lock already exists; stop its exact owner before running the sweep" >&2
  exit 1
fi

# From the committed archive, not from whatever is left in /tmp. The sweep used
# to depend on a directory nobody could reproduce: if it was missing the run
# failed, and if it was stale the run measured a profile no longer in the tree.
"$ROOT/scripts/qa-profile-restore.sh" "$LIVE"

HOME="${LIVE}-home" AZ_DATA_DIR="$LIVE" AZ_QA_WORKSPACE_ROOT="${LIVE}-workspace" \
  ./target/release/az-gui --blitz-control > /tmp/az-sweep.log 2>&1 &
readonly APP=$!

# Only this child belongs to the sweep. TERM gets a bounded grace period so
# the store can close; KILL is the last resort for a wedged shutdown, and is
# still scoped to the exact pid captured above.
cleanup() {
  if ! kill -0 "$APP" 2>/dev/null; then return; fi
  kill -TERM "$APP" 2>/dev/null || true
  cleanup_attempt=0
  while [ "$cleanup_attempt" -lt 50 ]; do
    if ! kill -0 "$APP" 2>/dev/null; then break; fi
    sleep 0.1
    cleanup_attempt=$((cleanup_attempt + 1))
  done
  if kill -0 "$APP" 2>/dev/null; then
    echo "az-gui pid $APP did not exit after TERM; sending KILL" >&2
    kill -KILL "$APP" 2>/dev/null || true
  fi
  wait "$APP" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for the descriptor to be answered rather than sleeping a fixed guess:
# the app takes ~10s cold and ~4s warm, and a fixed sleep is either slow or
# flaky depending on which it is that day.
#
# The harness takes the descriptor as an argument rather than from the
# environment, so an exported path left over from an earlier run cannot quietly
# attach this one to a different process.

# `ps-qa` is a published crate. `PS_QA` wins, then a sibling checkout, then an
# installed one: a working copy should beat the released binary while you are
# changing the harness itself, which is most of why you would be reading this.
readonly PS_QA_REPO="${PS_QA_REPO:-$ROOT/../ps-observability}"
if [ -n "${PS_QA:-}" ] && [ -x "${PS_QA:-}" ]; then
  qa="$PS_QA"
elif [ -x "$PS_QA_REPO/target/release/ps-qa" ]; then
  qa="$PS_QA_REPO/target/release/ps-qa"
elif command -v ps-qa >/dev/null 2>&1; then
  qa="$(command -v ps-qa)"
else
  echo "no ps-qa binary. install it:" >&2
  echo "  cargo install ps-qa" >&2
  echo "or point PS_QA at one." >&2
  exit 1
fi

# The harness reads ps-qa.ron and tests/ps-qa/ relative to the working
# directory, so every invocation below runs from the repository root.
cd "$ROOT"

attached=0
attach_attempt=0
while [ "$attach_attempt" -lt 40 ]; do
  if "$qa" nodes --descriptor "$DESCRIPTOR" >/dev/null 2>&1; then
    attached=1
    break
  fi
  sleep 1
  attach_attempt=$((attach_attempt + 1))
done
if [ "$attached" -eq 0 ]; then
  echo "ps-qa could not attach to az-gui pid $APP" >&2
  exit 1
fi

echo "== baseline =="
"$qa" idle --descriptor "$DESCRIPTOR" 2>&1 | head -1

echo
echo "== cover =="
status=0
"$qa" cover ${surface:+"$surface"} --descriptor "$DESCRIPTOR" || status=$?

exit "$status"
