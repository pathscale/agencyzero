#!/usr/bin/env bash
#
# Every button in the app, clicked, from a profile that starts identical each
# time.
#
# # Why this is a script
#
# The sweep presses destructive controls on purpose, so it leaves the store
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
#   scripts/button-sweep.sh --keep       # leave the instance up to inspect
#
set -euo pipefail

cd "$(dirname "$0")/.."
readonly ROOT="$PWD"
readonly LIVE=/tmp/qa-profile-db
readonly DESCRIPTOR="$ROOT/target/blitz-control.json"

keep=0
surface=""
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    *) surface="$arg" ;;
  esac
done

# Never -9: the store is single-writer and a hard kill can tear its index.
pkill -TERM -f "release/az-gui" 2>/dev/null || true
sleep 2

# From the committed archive, not from whatever is left in /tmp. The sweep used
# to depend on a directory nobody could reproduce: if it was missing the run
# failed, and if it was stale the run measured a profile no longer in the tree.
"$ROOT/scripts/qa-profile-restore.sh" "$LIVE"

AZ_DATA_DIR="$LIVE" TAURI_BLITZ_CONTROL_DESCRIPTOR="$DESCRIPTOR" \
  ./target/release/az-gui > /tmp/az-sweep.log 2>&1 &
readonly APP=$!

# Wait for the descriptor to be answered rather than sleeping a fixed guess:
# the app takes ~10s cold and ~4s warm, and a fixed sleep is either slow or
# flaky depending on which it is that day.
export TAURI_BLITZ_CONTROL_DESCRIPTOR="$DESCRIPTOR"

# `ps-qa` is a published crate. `PS_QA` wins, then a sibling checkout, then an
# installed one: a working copy should beat the released binary while you are
# changing the harness itself, which is most of why you would be reading this.
readonly PS_QA_REPO="${PS_QA_REPO:-$ROOT/../ps-qa}"
if [[ -n "${PS_QA:-}" && -x "${PS_QA:-}" ]]; then
  qa="$PS_QA"
elif [[ -x "$PS_QA_REPO/target/release/ps-qa" ]]; then
  qa="$PS_QA_REPO/target/release/ps-qa"
elif command -v ps-qa >/dev/null 2>&1; then
  qa="$(command -v ps-qa)"
else
  echo "no ps-qa binary. install it:" >&2
  echo "  cargo install ps-qa --version '^0.2' --locked" >&2
  echo "or point PS_QA at one." >&2
  exit 1
fi

# The harness reads ps-qa.ron and tests/ps-qa/ relative to the working
# directory, so every invocation below runs from the repository root.
cd "$ROOT"

for _ in $(seq 1 40); do
  if "$qa" nodes >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "== baseline =="
"$qa" idle 2>&1 | head -1

echo
echo "== cover =="
status=0
"$qa" cover ${surface:+"$surface"} || status=$?

if [[ "$keep" == 0 ]]; then
  kill -TERM "$APP" 2>/dev/null || true
  wait "$APP" 2>/dev/null || true
else
  echo
  echo "instance left up (pid $APP) against $LIVE"
fi
exit "$status"
