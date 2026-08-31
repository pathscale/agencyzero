#!/usr/bin/env sh
# Capture one performance round from a running diagnostics build.
#
# Usage: scripts/blitz-capture.sh <label> [sample-seconds]
#
# Writes <label>-frames.txt (metrics from the inspector) and <label>-sample.txt
# (symbolized stack sample) into target/perf/. Run it while the app is being
# exercised, not while it sits idle: the frame window excludes gaps over 100ms,
# so an idle capture reports nothing rather than reporting zeros.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "blitz-capture.sh currently supports macOS only (it uses the macOS sample tool)" >&2
  exit 1
fi

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
frames_tmp=$(mktemp "${TMPDIR:-/tmp}/az-frames.XXXXXX")
if "${PS_QA:-$(dirname "$0")/../../ps-observability/target/release/ps-qa}" \
  --descriptor "$repo_root/target/blitz-control.json" frames >"$frames_tmp" 2>&1; then
  frames_status=0
else
  frames_status=$?
fi
tee "$out/$label-frames.txt" <"$frames_tmp"
rm -f "$frames_tmp"

wait "$sampler"
[ "$frames_status" -eq 0 ] || exit "$frames_status"
echo "wrote $out/$label-frames.txt and $out/$label-sample.txt"
