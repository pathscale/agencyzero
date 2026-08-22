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
readonly PRISTINE=/tmp/qa-profile-pristine
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

if [[ ! -d "$PRISTINE" ]]; then
  echo "no pristine profile at $PRISTINE" >&2
  echo "build one first, then: cp -c -R $LIVE $PRISTINE" >&2
  exit 1
fi

# Never -9: the store is single-writer and a hard kill can tear its index.
pkill -TERM -f "release/az-gui" 2>/dev/null || true
sleep 2

rm -rf "$LIVE" "$LIVE.lock"
cp -c -R "$PRISTINE" "$LIVE" 2>/dev/null || cp -R "$PRISTINE" "$LIVE"

AZ_DATA_DIR="$LIVE" TAURI_BLITZ_CONTROL_DESCRIPTOR="$DESCRIPTOR" \
  ./target/release/az-gui > /tmp/az-sweep.log 2>&1 &
readonly APP=$!

# Wait for the descriptor to be answered rather than sleeping a fixed guess:
# the app takes ~10s cold and ~4s warm, and a fixed sleep is either slow or
# flaky depending on which it is that day.
export TAURI_BLITZ_CONTROL_DESCRIPTOR="$DESCRIPTOR"
for _ in $(seq 1 40); do
  if ./target/release/blitz-bench nodes >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "== baseline =="
./target/release/blitz-bench idle 2>&1 | head -1

echo
echo "== cover =="
status=0
./target/release/blitz-bench cover ${surface:+"$surface"} || status=$?

if [[ "$keep" == 0 ]]; then
  kill -TERM "$APP" 2>/dev/null || true
  wait "$APP" 2>/dev/null || true
else
  echo
  echo "instance left up (pid $APP) against $LIVE"
fi
exit "$status"
