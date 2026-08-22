#!/usr/bin/env bash
# Capture one performance round from a running diagnostics build.
#
# Usage: scripts/blitz-capture.sh <label> [sample-seconds]
#
# Writes <label>-frames.txt (metrics from the inspector) and <label>-sample.txt
# (symbolized stack sample) into target/perf/. Run it while the app is being
# exercised, not while it sits idle: the frame window excludes gaps over 100ms,
# so an idle capture reports nothing rather than reporting zeros.
set -euo pipefail

label=${1:?usage: blitz-capture.sh <label> [sample-seconds]}
seconds=${2:-20}
repo_root=$(cd "$(dirname "$0")/.." && pwd)
out="$repo_root/target/perf"
mkdir -p "$out"

pid=$(pgrep -f "AgencyZero.app/Contents/MacOS/az-gui" | head -1)
if [ -z "$pid" ]; then
  echo "no running az-gui found" >&2
  exit 1
fi
echo "pid $pid, label $label, sampling ${seconds}s"

# The sample runs first and in the background so the metrics read lands inside
# the sampled window rather than after it.
sample "$pid" "$seconds" 1 -f "$out/$label-sample.txt" >/dev/null 2>&1 &
sampler=$!

sleep 2
TAURI_BLITZ_CONTROL_DESCRIPTOR="$repo_root/target/blitz-control.json" \
  cargo run -q -p ps-qa -- frames 2>&1 | tee "$out/$label-frames.txt"

wait "$sampler"
echo "wrote $out/$label-frames.txt and $out/$label-sample.txt"
